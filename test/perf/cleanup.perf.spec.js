// @ts-check
/**
 * 데이터베이스 정리(Step 13, 8장 "예산 없음, 기록만"): 30만 행 픽스처에서 장문 열 하나를 소프트 삭제한 뒤 `cleanup.run`
 * (테이블 재작성 + VACUUM)에 걸린 시간과 그동안의 렌더러 메모리 최고 수위(R10)를 남긴다. 판정은 하지 않는다.
 * 최고 수위는 기준선 비교의 바이트 항목(`…Bytes`)이 되지 않도록 `info`에 둔다.
 */
import { expect, test } from '@playwright/test';
import { stat } from 'node:fs/promises';
import { PAGE_URL } from '../e2e/page-url.js';
import { FIXTURE_PATH, FIXTURE_ROWS, warmCache } from './fixture.js';
import { peakRssDuring, rendererRss } from './process-memory.js';
import { record } from './report.js';

/**
 * @typedef {object} TestHook
 * @property {() => { tables: Array<{ id: string, columns: Array<{ id: string, type: string }> }> } | null} state
 * @property {(op: string, args: unknown) => Promise<unknown>} call
 */

test('30만 행: 장문 열 하나를 지운 뒤 데이터베이스 정리 시간과 렌더러 메모리 최고 수위(기록만)', async ({
  page,
  browser,
}) => {
  test.setTimeout(900_000);
  const size = (await stat(FIXTURE_PATH)).size;
  await warmCache(FIXTURE_PATH);
  await page.addInitScript(() => {
    const w = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window));
    delete w.showOpenFilePicker;
    delete w.showSaveFilePicker;
  });
  await page.goto(PAGE_URL);
  await expect(page.locator('.jdr-statusbar__item').first()).toHaveText('준비됨');
  await page.locator('input.jdr-file-input').setInputFiles(FIXTURE_PATH);
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText(
    `행 ${FIXTURE_ROWS.toLocaleString('ko-KR')}개`,
    { timeout: 300_000 },
  );
  const rssOpened = await rendererRss(browser);
  const state = await page.evaluate(() =>
    /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.state(),
  );
  const table = state?.tables[0];
  const longColumn = table?.columns.find((c) => c.type === 'longtext');
  if (!table || !longColumn) throw new Error('fixture table/longtext column missing');

  await page.evaluate(
    ([tableId, columnId]) =>
      /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.call(
        'schema.softDeleteColumn',
        { tableId, columnId },
      ),
    [table.id, longColumn.id],
  );

  const work = () =>
    page.evaluate(
      async ([tableId, columnId]) => {
        const hook = /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window))
          .__jdrTest;
        const started = performance.now();
        const result =
          /** @type {{ removedColumns: number, vacuumed: boolean, vacuumError: { code: string } | null, bytesBefore: number, bytesAfter: number }} */ (
            await hook.call('cleanup.run', { columns: [{ tableId, columnId }] })
          );
        return { ms: performance.now() - started, result };
      },
      [table.id, longColumn.id],
    );
  const { result: run, peakRss, samples, method } = await peakRssDuring(browser, work);
  expect(run.result.removedColumns).toBe(1);

  await record(
    'cleanup-300k',
    { cleanupMs: +run.ms.toFixed(0) },
    {
      rows: FIXTURE_ROWS,
      fixtureBytes: size,
      rssOpened,
      cleanupHwm: peakRss,
      rssSamples: samples,
      peakMethod: method,
      vacuumed: run.result.vacuumed,
      vacuumError: run.result.vacuumError?.code ?? null,
      bytesBefore: run.result.bytesBefore,
      bytesAfter: run.result.bytesAfter,
    },
  );
  console.log(
    `[perf] 기록만: 정리 ${run.ms.toFixed(0)} ms, 렌더러 최고 수위 ${(peakRss / 1048576).toFixed(0)} MiB(${method}), ${run.result.bytesBefore} → ${run.result.bytesAfter} bytes`,
  );
});
