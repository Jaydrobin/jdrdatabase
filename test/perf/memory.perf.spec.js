// @ts-check
/**
 * 메모리 프로파일(Step 10): 열기 → CSV 가져오기 → 저장(다운로드) → 새로 만들기를 한 사이클로 반복하고,
 * 사이클마다 GC 뒤의 메인 스레드 JS 힙과 렌더러 RSS(Worker의 wasm 메모리 포함)를 잰다.
 * 두 번째 사이클 대비 마지막 사이클의 증가가 JS 힙 10 MB 또는 RSS 15%를 넘으면 실패(캐시·행 풀·statement
 * 캐시 누수). 첫 사이클은 wasm 메모리·코드 캐시가 커지는 워밍업이라 기준에서 뺀다. Worker의 JS 힙은 CDP로
 * 붙을 수 없어(전용 Worker) 따로 재지 않고 RSS에 포함된 것으로 본다.
 * 픽스처는 작게(2만 행 DB, 5천 행 CSV) 두어 사이클을 수 초로 유지한다.
 */
import { expect, test } from '@playwright/test';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { generate, generateDb } from '../../scripts/gen-fixture.mjs';
import { PAGE_URL } from '../e2e/page-url.js';
import { jsHeapAfterGc, rendererRss } from './process-memory.js';
import { record } from './report.js';

const DB_ROWS = 20_000;
const CSV_ROWS = 5_000;
const CYCLES = 6;
const DB_PATH = path.resolve(`test/fixtures/generated/memory-${DB_ROWS}.db`);
const CSV_PATH = path.resolve(`test/fixtures/generated/memory-${CSV_ROWS}.csv`);
const HEAP_GROWTH_LIMIT = 10 * 1024 * 1024;
const RSS_GROWTH_RATIO = 0.15;

/**
 * @param {string} file
 */
async function exists(file) {
  return stat(file).then(
    (s) => s.isFile() && s.size > 0,
    () => false,
  );
}

test.beforeAll(async () => {
  if (!(await exists(DB_PATH))) {
    await generateDb({ rows: DB_ROWS, cols: 20, long: 2, out: DB_PATH });
  }
  if (!(await exists(CSV_PATH))) {
    await generate({ rows: CSV_ROWS, cols: 20, long: 2, longMin: 20, longMax: 60, out: CSV_PATH });
  }
});

test('열기 → 가져오기 → 저장 → 새로 만들기 반복: JS 힙·RSS가 자라지 않는다', async ({
  page,
  browser,
}) => {
  test.setTimeout(600_000);
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => {
    const w = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window));
    delete w.showOpenFilePicker;
    delete w.showSaveFilePicker;
  });
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto(PAGE_URL);
  await expect(page.locator('.jdr-statusbar__item').first()).toHaveText('준비됨');

  /** @type {number[]} */
  const heap = [];
  /** @type {number[]} */
  const rss = [];
  for (let cycle = 0; cycle < CYCLES; cycle += 1) {
    await page.locator('input.jdr-file-input').setInputFiles(DB_PATH);
    if (cycle > 0) {
      // 앞 사이클의 저장이 revision 1을 known_revisions에 남겼으므로 revision 0인 픽스처는 "오래된 파일" 경고를 낸다.
      const behind = page.locator('.jdr-dialog');
      await expect(behind.locator('.jdr-dialog__title')).toHaveText('오래된 파일일 수 있습니다');
      await behind.getByRole('button', { name: '그대로 열기' }).click();
    }
    await expect(page.locator('.jdr-grid__rowcount')).toHaveText(
      `행 ${DB_ROWS.toLocaleString('ko-KR')}개`,
      { timeout: 120_000 },
    );
    // 스크롤로 블록 캐시·행 풀을 채운다(누수가 있다면 여기서 쌓인다).
    const scroller = page.locator('.jdr-grid__scroller');
    for (let i = 0; i < 10; i += 1) {
      await scroller.evaluate((el, step) => {
        el.scrollTop = ((el.scrollHeight - el.clientHeight) * step) / 10;
      }, i);
      await page.waitForTimeout(40);
    }

    await page.locator('input.jdr-import-input').setInputFiles(CSV_PATH);
    const dialog = page.locator('.jdr-dialog');
    await expect(dialog.locator('table[data-role="preview"]')).toBeVisible({ timeout: 60_000 });
    await dialog.locator('input[data-field="tableName"]').fill(`imported${cycle}`);
    await dialog.getByRole('button', { name: '가져오기' }).click();
    await expect(dialog.locator('.jdr-dialog__title')).toHaveText('가져오기 결과', {
      timeout: 120_000,
    });
    await dialog.getByRole('button', { name: '확인' }).click();
    await expect(page.locator('.jdr-dialog')).toHaveCount(0);

    const downloadPromise = page.waitForEvent('download', { timeout: 120_000 });
    await page.click('[data-action="save"]');
    const download = await downloadPromise;
    await download.cancel();
    await expect(page.locator('.jdr-toolbar__dirty')).toBeHidden();

    await page.click('[data-action="new"]');
    await expect(page.locator('.jdr-toolbar__file')).toHaveText('새 데이터베이스');
    await expect(page.locator('.jdr-sidebar__table')).toHaveCount(0);

    // 다운로드 폴백은 Blob URL을 10초 뒤에 해제한다(io/filesystem.js `download`). 그 전에 재면 직전 저장본들의
    // Blob(각 20 MB 안팎)이 RSS에 남아 누수처럼 보이므로 해제를 기다린 뒤 잰다.
    await page.waitForTimeout(11_000);
    heap.push(await jsHeapAfterGc(page));
    rss.push(await rendererRss(browser));
    console.log(
      `[perf:memory] cycle ${cycle + 1}: heap ${(heap[cycle] / 1048576).toFixed(1)} MB, rss ${(rss[cycle] / 1048576).toFixed(1)} MB`,
    );
  }

  const heapBase = heap[1] ?? 0;
  const heapLast = heap[CYCLES - 1] ?? 0;
  const rssBase = rss[1] ?? 0;
  const rssLast = rss[CYCLES - 1] ?? 0;
  const heapGrowth = heapLast - heapBase;
  const rssGrowth = rssLast - rssBase;
  await record(
    'memory',
    { heapLastBytes: heapLast, rssLastBytes: rssLast },
    {
      cycles: CYCLES,
      dbRows: DB_ROWS,
      csvRows: CSV_ROWS,
      heapBytes: heap,
      rssBytes: rss,
      heapGrowthBytes: heapGrowth,
      rssGrowthBytes: rssGrowth,
    },
  );
  expect(
    heapGrowth,
    `JS 힙이 사이클 2→${CYCLES}에서 ${heapGrowth} bytes 늘었다`,
  ).toBeLessThanOrEqual(HEAP_GROWTH_LIMIT);
  if (rssBase > 0) {
    expect(
      rssGrowth,
      `렌더러 RSS가 사이클 2→${CYCLES}에서 ${rssGrowth} bytes 늘었다`,
    ).toBeLessThanOrEqual(rssBase * RSS_GROWTH_RATIO);
  } else {
    console.log('[perf:memory] 렌더러 RSS는 Linux에서만 잰다(미측정)');
  }
});
