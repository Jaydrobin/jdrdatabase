// @ts-check
/**
 * Step 4 완료 기준: 30만 행 × 20열(장문 2열) DB에서 스크롤 프레임당 렌더 16 ms 이하, 창 질의 50 ms 이하.
 * 렌더 시간은 테스트 빌드의 `performance.measure('jdr:grid.render')`, 창 질의 시간은 Worker가
 * `query.window` 결과에 실어 보낸 `elapsedMs`(그리드 통계 `maxQueryMs`)로 잰다.
 */
import { expect, test } from '@playwright/test';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FIXTURE_PATH, FIXTURE_ROWS } from './fixture.js';

const PAGE_URL = pathToFileURL(path.resolve('dist/test/jdrdatabase.html')).href;
/** 8장 예산. */
const RENDER_BUDGET_MS = 16;
const QUERY_BUDGET_MS = 50;
/** 스크롤 시뮬레이션: 무작위 위치 점프와 연속 스크롤. */
const JUMPS = 40;
const WHEEL_STEPS = 120;

/**
 * @typedef {object} TestHook
 * @property {() => { tables: Array<{ id: string }> } | null} state
 * @property {() => { renders: number, lastRenderMs: number, queries: number, maxQueryMs: number, lastQueryMs: number, rowCount: number, domRows: number } | null} grid
 */

/**
 * @param {number[]} values
 * @param {number} p
 */
function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p))] ?? 0;
}

test('30만 행 스크롤: 프레임 렌더 p95 16 ms 이하, 창 질의 최대 50 ms 이하', async ({ page }) => {
  const size = (await stat(FIXTURE_PATH)).size;
  await page.setViewportSize({ width: 1400, height: 900 });
  await page.addInitScript(() => {
    const w = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window));
    delete w.showOpenFilePicker;
    delete w.showSaveFilePicker;
  });
  await page.goto(PAGE_URL);
  await expect(page.locator('.jdr-statusbar__item').first()).toHaveText('준비됨');

  const openStarted = Date.now();
  await page.locator('input.jdr-file-input').setInputFiles(FIXTURE_PATH);
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText(
    `행 ${FIXTURE_ROWS.toLocaleString('ko-KR')}개`,
    { timeout: 300_000 },
  );
  const openMs = Date.now() - openStarted;
  await expect(page.locator('.jdr-grid__row[data-row="0"]')).toBeVisible();

  // 측정 시작: 지금까지의 렌더 항목은 버린다.
  await page.evaluate(() => performance.clearMeasures('jdr:grid.render'));
  const scroller = page.locator('.jdr-grid__scroller');
  const maxScroll = await scroller.evaluate((el) => el.scrollHeight - el.clientHeight);

  // 1) 무작위 점프: 캐시에 없는 블록을 계속 요청한다(창 질의 시간).
  let seed = 7;
  for (let i = 0; i < JUMPS; i += 1) {
    seed = (seed * 48271) % 2147483647;
    const top = Math.floor((seed / 2147483647) * maxScroll);
    await scroller.evaluate((el, value) => {
      el.scrollTop = value;
    }, top);
    await page.waitForTimeout(60);
  }
  // 2) 연속 휠 스크롤: 프레임마다 렌더가 일어난다(렌더 시간).
  await scroller.evaluate((el) => {
    el.scrollTop = 0;
  });
  await scroller.hover();
  for (let i = 0; i < WHEEL_STEPS; i += 1) {
    await page.mouse.wheel(0, 96);
    await page.waitForTimeout(16);
  }
  await page.waitForTimeout(300);

  const renders = await page.evaluate(() =>
    performance.getEntriesByName('jdr:grid.render').map((e) => e.duration),
  );
  const stats = await page.evaluate(() =>
    /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.grid(),
  );
  const p50 = percentile(renders, 0.5);
  const p95 = percentile(renders, 0.95);
  const max = Math.max(...renders);
  console.log(
    JSON.stringify(
      {
        fixture: { rows: FIXTURE_ROWS, bytes: size },
        openMs,
        render: {
          samples: renders.length,
          p50: +p50.toFixed(2),
          p95: +p95.toFixed(2),
          max: +max.toFixed(2),
        },
        query: {
          count: stats?.queries,
          maxMs: +(stats?.maxQueryMs ?? 0).toFixed(2),
          lastMs: +(stats?.lastQueryMs ?? 0).toFixed(2),
        },
        domRows: stats?.domRows,
      },
      null,
      2,
    ),
  );
  expect(renders.length).toBeGreaterThan(50);
  expect(stats?.rowCount).toBe(FIXTURE_ROWS);
  expect(stats?.queries ?? 0).toBeGreaterThan(JUMPS / 2);
  expect(p95).toBeLessThanOrEqual(RENDER_BUDGET_MS);
  expect(stats?.maxQueryMs ?? Infinity).toBeLessThanOrEqual(QUERY_BUDGET_MS);
});
