// @ts-check
/**
 * Step 6 완료 기준: 30만 행에서 trigram 검색 200 ms 이하, 인덱스 없이 LIKE 1초 이하(`query.count`의
 * `elapsedMs`). 8장의 "정렬 변경(인덱스 없음) 1초 이하"(`query.window` 첫 응답)도 함께 잰다.
 * 검색 인덱스 생성 시간은 판정 없이 기록만 한다.
 */
import { expect, test } from '@playwright/test';
import { PAGE_URL } from '../e2e/page-url.js';
import { FIXTURE_PATH, FIXTURE_ROWS } from './fixture.js';
import { budget, record } from './report.js';

/** DESIGN.md Step 6 완료 기준·8장 예산. */
const LIKE_BUDGET_MS = 1_000;
const FTS_BUDGET_MS = 200;
const SORT_BUDGET_MS = 1_000;

/**
 * @typedef {object} TestHook
 * @property {() => { tables: Array<{ id: string, columns: Array<{ id: string, type: string }> }> } | null} state
 * @property {(op: string, args: unknown) => Promise<unknown>} call
 */

/**
 * @param {number[]} values
 * @returns {number}
 */
function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor((sorted.length - 1) / 2)] ?? 0;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} op
 * @param {unknown} args
 * @returns {Promise<unknown>}
 */
function call(page, op, args) {
  return page.evaluate(
    ([o, a]) =>
      /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.call(
        /** @type {string} */ (o),
        a,
      ),
    [op, args],
  );
}

test('30만 행 검색: LIKE 1초 이하, 검색 인덱스 뒤 trigram 200 ms 이하, 정렬 첫 응답 1초 이하', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1400, height: 900 });
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
  const state = await page.evaluate(() =>
    /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.state(),
  );
  const table = state?.tables[0];
  if (!table) throw new Error('fixture table missing');
  const intColumn = table.columns.find((c) => c.type === 'integer');
  const textColumn = table.columns.find((c) => c.type === 'text');
  if (!intColumn || !textColumn) throw new Error('fixture columns missing');

  /** @type {(q: string) => Promise<{ count: number, elapsedMs: number }>} */
  const countSearch = async (q) =>
    /** @type {{ count: number, elapsedMs: number }} */ (
      await call(page, 'query.count', { tableId: table.id, viewSpec: { search: q } })
    );

  // 1) 인덱스 없음: LIKE 폴백. 검색어는 텍스트·장문 열에 고루 있는 단어.
  const like = await countSearch('grape 7');
  // 짧은 검색어(trigram 불가)의 LIKE 폴백은 한 번 재면 700~1,000 ms 사이에서 흔들린다(CI 실측 713·716·968).
  // 행 수 캐시가 같은 검색어를 다시 재지 않으므로 서로 다른 무일치 두 글자 검색어 3개의 중앙값으로 잰다.
  /** @type {Array<{ count: number, elapsedMs: number }>} */
  const likeShorts = [];
  for (const term of ['멜', '팥', '쑥']) likeShorts.push(await countSearch(term));
  const likeShortMs = median(likeShorts.map((r) => r.elapsedMs));

  // 2) 인덱스 생성(판정 없이 기록).
  const indexStarted = Date.now();
  await call(page, 'search.enable', { tableId: table.id });
  const indexMs = Date.now() - indexStarted;

  // 3) 인덱스 있음: trigram(3자 이상). 같은 검색어라도 쓰기 뒤라 행 수 캐시는 다시 센다.
  const fts = await countSearch('grape 7');
  const ftsKorean = await countSearch('바나나 1');
  const ftsMiss = await countSearch('없는단어');

  // 4) 정렬 변경(인덱스 없음): 정수 열·텍스트 열 내림차순의 첫 창.
  /** @type {(colId: string) => Promise<{ elapsedMs: number, rows: unknown[] }>} */
  const sortedWindow = async (colId) =>
    /** @type {{ elapsedMs: number, rows: unknown[] }} */ (
      await call(page, 'query.window', {
        tableId: table.id,
        viewSpec: { sort: [{ colId, dir: 'desc' }] },
        offset: 0,
        limit: 200,
        seq: 1,
      })
    );
  const sortInt = await sortedWindow(intColumn.id);
  const sortText = await sortedWindow(textColumn.id);
  const sortedCount = /** @type {{ count: number, elapsedMs: number }} */ (
    await call(page, 'query.count', {
      tableId: table.id,
      viewSpec: {
        filter: { logic: 'and', conditions: [{ colId: intColumn.id, op: '>', value: '500000' }] },
      },
    })
  );

  console.log(
    JSON.stringify(
      {
        rows: FIXTURE_ROWS,
        like: { count: like.count, ms: +like.elapsedMs.toFixed(1) },
        likeShort: {
          counts: likeShorts.map((r) => r.count),
          samplesMs: likeShorts.map((r) => +r.elapsedMs.toFixed(1)),
          ms: +likeShortMs.toFixed(1),
        },
        indexBuildMs: indexMs,
        fts: { count: fts.count, ms: +fts.elapsedMs.toFixed(1) },
        ftsKorean: { count: ftsKorean.count, ms: +ftsKorean.elapsedMs.toFixed(1) },
        ftsMiss: { count: ftsMiss.count, ms: +ftsMiss.elapsedMs.toFixed(1) },
        sortInt: { ms: +sortInt.elapsedMs.toFixed(1), rows: sortInt.rows.length },
        sortText: { ms: +sortText.elapsedMs.toFixed(1), rows: sortText.rows.length },
        filterCount: { count: sortedCount.count, ms: +sortedCount.elapsedMs.toFixed(1) },
      },
      null,
      2,
    ),
  );
  expect(like.count).toBeGreaterThan(0);
  expect(fts.count).toBe(like.count);
  expect(ftsMiss.count).toBe(0);
  await record(
    'search',
    {
      likeMs: +like.elapsedMs.toFixed(1),
      likeShortMs: +likeShortMs.toFixed(1),
      indexBuildMs: indexMs,
      ftsMs: +fts.elapsedMs.toFixed(1),
      ftsKoreanMs: +ftsKorean.elapsedMs.toFixed(1),
      sortIntMs: +sortInt.elapsedMs.toFixed(1),
      sortTextMs: +sortText.elapsedMs.toFixed(1),
      filterCountMs: +sortedCount.elapsedMs.toFixed(1),
    },
    { rows: FIXTURE_ROWS, likeCount: like.count, ftsCount: fts.count },
  );
  budget(like.elapsedMs, LIKE_BUDGET_MS, 'LIKE 검색(ms)');
  budget(likeShortMs, LIKE_BUDGET_MS, 'LIKE 짧은 검색어 중앙값(ms)');
  budget(fts.elapsedMs, FTS_BUDGET_MS, 'trigram 검색(ms)');
  budget(ftsKorean.elapsedMs, FTS_BUDGET_MS, 'trigram 한글 검색(ms)');
  budget(sortInt.elapsedMs, SORT_BUDGET_MS, '정렬 변경(정수) 첫 창(ms)');
  budget(sortText.elapsedMs, SORT_BUDGET_MS, '정렬 변경(텍스트) 첫 창(ms)');
});
