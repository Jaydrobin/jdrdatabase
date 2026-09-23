// @ts-check
/**
 * 8장의 나머지 항목(Step 10): 앱 시작(빈 DB), 셀 편집 반영, 300 MB 저장(스냅샷), 저장 시점 최대 메모리,
 * 30만 행 CSV 내보내기(예산 없음, 기록만). 열기·스크롤·창 질의는 grid.perf.spec.js, 검색·정렬은
 * search.perf.spec.js, 가져오기는 import*.perf.spec.js가 잰다.
 */
import { expect, test } from '@playwright/test';
import { stat } from 'node:fs/promises';
import { PAGE_URL } from '../e2e/page-url.js';
import { FIXTURE_PATH, FIXTURE_ROWS, warmCache } from './fixture.js';
import { peakRssDuring, rendererRss } from './process-memory.js';
import { budget, record } from './report.js';

/** 8장 예산. */
const APP_READY_BUDGET_MS = 1_500;
const EDIT_BUDGET_MS = 30;
const SAVE_BUDGET_MS = 5_000;
const HEAP_BUDGET_BYTES = 1.2 * 1024 * 1024 * 1024;

/**
 * @typedef {object} TestHook
 * @property {() => { tables: Array<{ id: string, columns: Array<{ id: string, type: string }> }>, meta: Record<string, string> } | null} state
 * @property {(op: string, args: unknown) => Promise<unknown>} call
 */

/** @param {import('@playwright/test').Page} page */
async function hideFsa(page) {
  await page.addInitScript(() => {
    const w = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window));
    delete w.showOpenFilePicker;
    delete w.showSaveFilePicker;
  });
}

test('앱 시작(빈 DB): 문서 시작부터 "준비됨"까지 1.5초 이하', async ({ page }) => {
  await hideFsa(page);
  /** @type {number[]} */
  const samples = [];
  for (let i = 0; i < 3; i += 1) {
    await page.goto(PAGE_URL);
    await expect(page.locator('.jdr-statusbar__item').first()).toHaveText('준비됨');
    const readyMs = await page.evaluate(
      () => performance.getEntriesByName('jdr:app.ready')[0]?.startTime ?? -1,
    );
    expect(readyMs).toBeGreaterThan(0);
    samples.push(+readyMs.toFixed(1));
  }
  // 첫 실행은 캐시가 없어 느리다. 최소값이 아니라 중앙값으로 판정한다.
  const median = [...samples].sort((a, b) => a - b)[1] ?? samples[0] ?? 0;
  await record('app', { readyMs: median }, { readySamples: samples });
  budget(median, APP_READY_BUDGET_MS, '앱 시작(ms)');
});

test('30만 행: 셀 편집 30 ms 이하, 스냅샷 저장 5초 이하, 저장 시점 렌더러 메모리 1.2 GB 이하, CSV 내보내기(기록)', async ({
  page,
  browser,
}) => {
  test.setTimeout(900_000);
  const size = (await stat(FIXTURE_PATH)).size;
  await warmCache(FIXTURE_PATH);
  await hideFsa(page);
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto(PAGE_URL);
  await expect(page.locator('.jdr-statusbar__item').first()).toHaveText('준비됨');
  const rssIdle = await rendererRss(browser);

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
  const textColumn = table?.columns.find((c) => c.type === 'text');
  if (!table || !textColumn) throw new Error('fixture table/column missing');

  // 1) 셀 편집 반영: command.apply 왕복(테스트 훅에서 직접 호출. 스토어·저널은 거치지 않는다).
  /** @type {number[]} */
  const editSamples = [];
  for (let i = 0; i < 5; i += 1) {
    const ms = await page.evaluate(
      async ([tableId, colId, row]) => {
        const hook = /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window))
          .__jdrTest;
        const sql = `UPDATE "${tableId}" SET "${colId}" = ?, "_updated_at" = ? WHERE "id" = ?`;
        const now = new Date().toISOString();
        const cmd = {
          type: 'cell.edit',
          tableId,
          do: [{ sql, params: [`perf ${row}`, now, row] }],
          undo: [{ sql, params: ['', now, row] }],
          summary: 'perf edit',
        };
        const started = performance.now();
        await hook.call('command.apply', { cmd });
        return performance.now() - started;
      },
      /** @type {[string, string, number]} */ ([table.id, textColumn.id, 1000 + i]),
    );
    editSamples.push(+ms.toFixed(2));
  }
  const editMax = Math.max(...editSamples);

  // 2) 저장: db.snapshot 왕복(revision 갱신 + 직렬화 + 300 MB transfer). 그동안의 렌더러 RSS 최고 수위가 8장의 "최대 힙".
  // 작업은 함수로 넘겨 최고 수위를 되돌린 뒤에 시작한다.
  const snapshotWork = () =>
    page.evaluate(async () => {
      const hook = /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window))
        .__jdrTest;
      const started = performance.now();
      const result = /** @type {{ bytes: Uint8Array }} */ (
        await hook.call('db.snapshot', { bumpRevision: true, savedBy: 'perf' })
      );
      return { ms: performance.now() - started, bytes: result.bytes.byteLength };
    });
  const {
    result: snapshot,
    peakRss,
    samples,
    method: peakMethod,
  } = await peakRssDuring(browser, snapshotWork);
  expect(snapshot.bytes).toBeGreaterThan(size * 0.9);

  // 3) 실제 저장 경로(도구 모음 저장 → 다운로드 폴백). 디스크 쓰기 대신 Blob 다운로드까지.
  const saveStarted = Date.now();
  const downloadPromise = page.waitForEvent('download', { timeout: 300_000 });
  await page.click('[data-action="save"]');
  const download = await downloadPromise;
  const saveMs = Date.now() - saveStarted;
  expect(download.suggestedFilename()).toMatch(/\.db$/);
  await download.cancel();

  // 4) CSV 내보내기(예산 없음): 내보내기 대화상자 → 다운로드 완료.
  await page.click('[data-action="export"]');
  const dialog = page.locator('.jdr-dialog');
  await expect(dialog.locator('select[data-field="format"]')).toHaveValue('csv');
  const exportStarted = Date.now();
  const exportDownload = page.waitForEvent('download', { timeout: 600_000 });
  await dialog.getByRole('button', { name: '내보내기' }).click();
  const csv = await exportDownload;
  const exportPath = await csv.path();
  const exportMs = Date.now() - exportStarted;
  const exportBytes = exportPath ? (await stat(exportPath)).size : 0;

  await record(
    'app-300k',
    {
      editMaxMs: editMax,
      snapshotMs: +snapshot.ms.toFixed(0),
      saveMs,
      saveHwmBytes: peakRss,
      exportCsvMs: exportMs,
    },
    {
      rows: FIXTURE_ROWS,
      fixtureBytes: size,
      editSamples,
      snapshotBytes: snapshot.bytes,
      rssIdle,
      rssOpened,
      rssSamples: samples,
      peakMethod,
      exportBytes,
    },
  );
  budget(editMax, EDIT_BUDGET_MS, '셀 편집 반영 최대(ms)');
  budget(snapshot.ms, SAVE_BUDGET_MS, '300 MB 스냅샷(ms)');
  if (peakRss > 0) budget(peakRss, HEAP_BUDGET_BYTES, '저장 시점 렌더러 RSS(bytes)');
  else console.log('[perf:budget] 렌더러 RSS는 Linux에서만 잰다(미측정)');
});
