// @ts-check
/**
 * 브라우저 프로세스 메모리 측정(Step 10, 8장 "최대 힙"과 메모리 프로파일).
 * - 렌더러 RSS: CDP `SystemInfo.getProcessInfo`로 렌더러 프로세스 id를 얻어 Linux `/proc/<pid>/status`의 VmRSS를
 *   읽는다. Worker의 wasm 메모리는 페이지와 같은 렌더러 프로세스에 있으므로 여기에 포함된다.
 * - 메인 스레드 JS 힙: 페이지 CDP 세션의 `HeapProfiler.collectGarbage` 뒤 `Performance.getMetrics`의 JSHeapUsedSize.
 * Linux가 아니면 RSS는 0으로 돌려주고(측정 불가) 호출자가 판정을 건너뛴다.
 */
import { readFile } from 'node:fs/promises';

/**
 * @param {number} pid
 * @returns {Promise<number>} bytes. 읽을 수 없으면 0
 */
async function rssOf(pid) {
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const match = /^VmRSS:\s+(\d+)\s+kB/m.exec(status);
    return match ? Number(match[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

/**
 * 렌더러 프로세스 중 가장 큰 RSS(bytes). 탭이 하나이므로 페이지의 렌더러가 가장 크다.
 * @param {import('@playwright/test').Browser} browser
 * @returns {Promise<number>}
 */
export async function rendererRss(browser) {
  if (process.platform !== 'linux') return 0;
  const session = await browser.newBrowserCDPSession();
  try {
    const { processInfo } = await session.send('SystemInfo.getProcessInfo');
    const renderers = processInfo.filter((p) => p.type === 'renderer');
    const sizes = await Promise.all(renderers.map((p) => rssOf(p.id)));
    return Math.max(0, ...sizes);
  } finally {
    await session.detach();
  }
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
 * 작업이 끝날 때까지 간격마다 렌더러 RSS를 재어 최대값을 돌려준다.
 * @template T
 * @param {import('@playwright/test').Browser} browser
 * @param {Promise<T>} work
 * @param {number} [intervalMs]
 * @returns {Promise<{ result: T, peakRss: number, samples: number }>}
 */
export async function peakRssDuring(browser, work, intervalMs = 100) {
  let peak = await rendererRss(browser);
  let samples = 1;
  let done = false;
  const settled = work.finally(() => {
    done = true;
  });
  while (!done) {
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
    peak = Math.max(peak, await rendererRss(browser));
    samples += 1;
  }
  const result = await settled;
  peak = Math.max(peak, await rendererRss(browser));
  return { result, peakRss: peak, samples };
}
