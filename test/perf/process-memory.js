// @ts-check
/**
 * 브라우저 프로세스 메모리 측정(Step 10, 8장 "최대 힙"과 메모리 프로파일).
 * - 렌더러 RSS: CDP `SystemInfo.getProcessInfo`로 렌더러 프로세스 id를 얻어 Linux `/proc/<pid>/status`의 VmRSS를
 *   읽는다. Worker의 wasm 메모리는 페이지와 같은 렌더러 프로세스에 있으므로 여기에 포함된다. 작업 동안의 최대값은
 *   VmHWM(최고 수위)으로 잰다(`peakRssDuring`).
 * - 메인 스레드 JS 힙: 페이지 CDP 세션의 `HeapProfiler.collectGarbage` 뒤 `Performance.getMetrics`의 JSHeapUsedSize.
 * Linux가 아니면 RSS는 0으로 돌려주고(측정 불가) 호출자가 판정을 건너뛴다.
 */
import { readFile, writeFile } from 'node:fs/promises';

/**
 * `/proc/<pid>/status`의 킬로바이트 항목(bytes로).
 * @param {number} pid
 * @param {'VmRSS' | 'VmHWM'} [key]
 * @returns {Promise<number>} bytes. 읽을 수 없으면 0
 */
async function rssOf(pid, key = 'VmRSS') {
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const match = new RegExp(`^${key}:\\s+(\\d+)\\s+kB`, 'm').exec(status);
    return match ? Number(match[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

/**
 * 렌더러 프로세스 id들.
 * @param {import('@playwright/test').Browser} browser
 * @returns {Promise<number[]>}
 */
async function rendererPids(browser) {
  const session = await browser.newBrowserCDPSession();
  try {
    const { processInfo } = await session.send('SystemInfo.getProcessInfo');
    return processInfo.filter((p) => p.type === 'renderer').map((p) => p.id);
  } finally {
    await session.detach();
  }
}

/**
 * 렌더러 프로세스 중 가장 큰 RSS(bytes). 탭이 하나이므로 페이지의 렌더러가 가장 크다.
 * @param {import('@playwright/test').Browser} browser
 * @returns {Promise<number>}
 */
export async function rendererRss(browser) {
  if (process.platform !== 'linux') return 0;
  const sizes = await Promise.all((await rendererPids(browser)).map((pid) => rssOf(pid)));
  return Math.max(0, ...sizes);
}

/**
 * GC 뒤의 메인 스레드 JS 힙 사용량(bytes).
 * @param {import('@playwright/test').Page} page
 * @returns {Promise<number>}
 */
export async function jsHeapAfterGc(page) {
  const session = await page.context().newCDPSession(page);
  try {
    await session.send('HeapProfiler.enable');
    await session.send('HeapProfiler.collectGarbage');
    await session.send('Performance.enable');
    const { metrics } = await session.send('Performance.getMetrics');
    return metrics.find((m) => m.name === 'JSHeapUsedSize')?.value ?? 0;
  } finally {
    await session.detach();
  }
}

/**
 * 작업 동안 렌더러 RSS의 최대값. Linux의 최고 수위(`VmHWM`)를 작업 직전에 `clear_refs`로 되돌려 두고 작업 뒤에
 * 읽으므로 짧게 튀는 값도 놓치지 않는다. 되돌릴 수 없으면(권한 등) 간격 표본의 최대값으로 내려간다.
 * 표본만으로는 저장(스냅샷)의 짧은 봉우리를 잡을지가 표본이 떨어지는 시점에 달려, 같은 코드가 857 MB와
 * 1,164 MB를 오갔다(세션 L).
 * @template T
 * @param {import('@playwright/test').Browser} browser
 * @param {Promise<T> | (() => Promise<T>)} work 함수로 주면 수위를 되돌린 뒤에 시작한다
 * @param {number} [intervalMs]
 * @returns {Promise<{ result: T, peakRss: number, samples: number, method: 'hwm' | 'sample' }>}
 */
export async function peakRssDuring(browser, work, intervalMs = 100) {
  const pids = process.platform === 'linux' ? await rendererPids(browser) : [];
  let hwmReset = pids.length > 0;
  for (const pid of pids) {
    try {
      // 5: 프로세스의 최고 RSS 수위(VmHWM)를 지금 RSS로 되돌린다(Linux 4.0+, proc(5)).
      await writeFile(`/proc/${pid}/clear_refs`, '5');
    } catch {
      hwmReset = false;
    }
  }
  let peak = await rendererRss(browser);
  let samples = 1;
  let done = false;
  const running = typeof work === 'function' ? work() : work;
  const settled = running.finally(() => {
    done = true;
  });
  while (!done) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    peak = Math.max(peak, await rendererRss(browser));
    samples += 1;
  }
  const result = await settled;
  peak = Math.max(peak, await rendererRss(browser));
  if (hwmReset) {
    const hwm = await Promise.all(pids.map((pid) => rssOf(pid, 'VmHWM')));
    peak = Math.max(peak, ...hwm);
  }
  return { result, peakRss: peak, samples, method: hwmReset ? 'hwm' : 'sample' };
}
