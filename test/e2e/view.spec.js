// @ts-check
/**
 * Step 6 E2E: 정렬(머리글 클릭·Shift+클릭·대화상자), 필터 대화상자(타입 검증 거부, OR, 0건 빈 상태와
 * "필터 지우기"), 검색(LIKE 폴백과 와일드카드 이스케이프, 검색 인덱스 만들기·되돌리기), 열 숨김,
 * 삭제된 열의 정렬 항목 제거, 그리고 정렬·필터·검색·숨김·너비 조합을 뷰로 저장 → 파일 저장(다운로드) →
 * 다시 열기 → 뷰 선택 → 복원. 실제 산출물(`file://`)에서 확인한다.
 */
import { expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PAGE_URL = pathToFileURL(path.resolve('dist/test/jdrdatabase.html')).href;
const FILE_INPUT_CLASS = 'jdr-file-input';
const ROWS = 200;

/**
 * @typedef {object} TestHook
 * @property {() => { tables: Array<{ id: string, name: string, ftsEnabled: boolean, columns: Array<{ id: string, name: string }> }>, dirty: boolean } | null} state
 * @property {(cmd: unknown) => Promise<{ affected: number }>} apply
 * @property {(sql: string) => Promise<{ columns: string[], rows: unknown[][] }>} query
 * @property {() => { undo: number, redo: number, busy: boolean } | null} history
 * @property {() => { sort: Array<{ colId: string, dir: string }>, filter: unknown, search: string, hidden: string[], widths: Record<string, number>, viewId: string | null } | null} view
 */

/** @param {import('@playwright/test').Page} page */
function hook(page) {
  return {
    state: () =>
      page.evaluate(() =>
        /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.state(),
      ),
    view: () =>
      page.evaluate(() =>
        /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.view(),
      ),
    /** @param {string} sql */
    query: (sql) =>
      page.evaluate(
        (q) =>
          /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.query(
            q,
          ),
        sql,
      ),
  };
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string} typeLabel
 */
async function addColumn(page, name, typeLabel) {
  await page.click('[data-action="column-add"]');
  const dialog = page.locator('.jdr-dialog');
  await dialog.locator('input').fill(name);
  await dialog.locator('select').selectOption({ label: typeLabel });
  await dialog.getByRole('button', { name: '추가' }).click();
  await expect(page.locator('.jdr-sidebar__column-name', { hasText: name })).toBeVisible();
}

/**
 * 텍스트·정수·장문·불리언 열과 행 200개(+ 와일드카드가 든 이름 1개).
 * @param {import('@playwright/test').Page} page
 */
async function seed(page) {
  await page.click('[data-action="table-create"]');
  await page.locator('.jdr-dialog input').fill('고객');
  await page.locator('.jdr-dialog').getByRole('button', { name: '만들기' }).click();
  await expect(page.locator('.jdr-grid__empty')).toHaveText(
    '열이 없습니다. 사이드바의 "+ 열"로 추가하세요.',
  );
  await addColumn(page, '이름', '텍스트');
  await addColumn(page, '나이', '정수');
  await addColumn(page, '본문', '장문');
  await addColumn(page, '활성', '참/거짓');
  const state = await hook(page).state();
  const table = state?.tables[0];
  if (!table) throw new Error('table missing');
  const [name, age, body, active] = table.columns.map((c) => c.id);
  const sql = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS}) INSERT INTO "${table.id}" ("id", "${name}", "${age}", "${body}", "${active}") SELECT i, '이름' || i, i * 3, '짧은 글 ' || i, i % 2 FROM n`;
  const extra = `INSERT INTO "${table.id}" ("id", "${name}", "${age}") VALUES (?, ?, ?)`;
  await page.evaluate(
    ([statement, extraSql, extraId]) =>
      /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.apply({
        type: 'test.insert',
        tableId: null,
        do: [{ sql: statement }, { sql: extraSql, params: [extraId, '50%_특가', null] }],
        undo: [],
        summary: 'seed',
      }),
    [sql, extra, ROWS + 1],
  );
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText(`행 ${ROWS + 1}개`);
  return { table, name, age, body, active };
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} row
 * @param {number} col
 */
function cell(page, row, col) {
  // 풀로 돌아간(숨겨진) 행 요소도 마지막 행 번호를 달고 있으므로 보이는 행만 고른다.
  return page.locator(
    `.jdr-grid__row[data-row="${row}"]:not([hidden]) .jdr-grid__cell[data-col="${col}"]`,
  );
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
function header(page, name) {
  return page.locator('.jdr-grid__hcell', { hasText: name });
}

/**
 * 필터 대화상자에 조건 하나를 넣고 적용한다. 대화상자는 열려 있어야 한다.
 * @param {import('@playwright/test').Page} page
 * @param {{ column: string, op: string, value?: string, logic?: string }} cond
 * @param {'apply' | 'keep'} [outcome] `keep`이면 검증 실패로 닫히지 않는 것을 기대한다
 */
async function addCondition(page, cond, outcome = 'apply') {
  const dialog = page.locator('.jdr-dialog');
  await dialog.getByRole('button', { name: '+ 조건 추가' }).click();
  const row = dialog.locator('.jdr-dialog__row').last();
  await row.locator('select').nth(0).selectOption({ label: cond.column });
  await row.locator('select').nth(1).selectOption({ label: cond.op });
  if (cond.value !== undefined) await row.locator('input').fill(cond.value);
  if (cond.logic) await dialog.locator('.jdr-dialog__label select').selectOption(cond.logic);
  await dialog.getByRole('button', { name: '적용' }).click();
  if (outcome === 'apply') await expect(dialog).toBeHidden();
  else await expect(dialog).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 720 });
  await page.addInitScript(() => {
    const w = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window));
    delete w.showOpenFilePicker;
    delete w.showSaveFilePicker;
  });
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto(PAGE_URL);
  await expect(page.locator('.jdr-statusbar__item').first()).toHaveText('준비됨');
});

test('정렬: 머리글 클릭은 오름 → 내림 → 없음, Shift+클릭은 보조 정렬, 대화상자로도 바꾼다', async ({
  page,
}) => {
  await seed(page);
  const age = header(page, '나이');
  await age.click();
  await expect(age).toHaveAttribute('aria-sort', 'ascending');
  await expect(age.locator('.jdr-grid__hsort')).toHaveText('▲');
  // 빈 값(50%_특가 행)은 오름차순에서도 마지막이다.
  await expect(cell(page, 0, 1)).toHaveText('3');
  await expect(page.locator('[data-action="sort"]')).toHaveText('정렬 (1)…');

  await age.click();
  await expect(age).toHaveAttribute('aria-sort', 'descending');
  await expect(cell(page, 0, 1)).toHaveText(String(ROWS * 3));
  await expect(cell(page, 0, 0)).toHaveText(`이름${ROWS}`);

  // Shift+클릭: 활성 열이 보조 정렬로 붙고 순번이 보인다.
  await header(page, '활성').click({ modifiers: ['Shift'] });
  await expect(age.locator('.jdr-grid__hsort')).toHaveText('▼1');
  await expect(header(page, '활성').locator('.jdr-grid__hsort')).toHaveText('▲2');
  await expect(page.locator('[data-action="sort"]')).toHaveText('정렬 (2)…');
  expect((await hook(page).view())?.sort.map((s) => s.dir)).toEqual(['desc', 'asc']);

  await age.click();
  await expect(age.locator('.jdr-grid__hsort')).toHaveCount(0);
  await expect(header(page, '활성').locator('.jdr-grid__hsort')).toHaveCount(0);
  await expect(cell(page, 0, 0)).toHaveText('이름1');

  // 대화상자: 이름 내림차순(텍스트는 대소문자 무시 정렬).
  await page.click('[data-action="sort"]');
  const dialog = page.locator('.jdr-dialog');
  await dialog.getByRole('button', { name: '+ 정렬 추가' }).click();
  await dialog.locator('.jdr-dialog__row select').nth(0).selectOption({ label: '이름' });
  await dialog.locator('.jdr-dialog__row select').nth(1).selectOption({ label: '내림차순' });
  await dialog.getByRole('button', { name: '적용' }).click();
  await expect(header(page, '이름')).toHaveAttribute('aria-sort', 'descending');
  await expect(cell(page, 0, 0)).toHaveText('이름99');
  await page.click('[data-action="view-clear"]');
  await expect(page.locator('[data-action="sort"]')).toHaveText('정렬…');
  await expect(cell(page, 0, 0)).toHaveText('이름1');
});

test('필터: 조건 적용, 타입에 맞지 않는 값은 거부, OR 결합, 0건이면 빈 상태와 "필터 지우기"', async ({
  page,
}) => {
  await seed(page);
  await page.click('[data-action="filter"]');
  await addCondition(page, { column: '나이', op: '보다 큼', value: '590' });
  // i * 3 > 590 → i = 197..200.
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 4개');
  await expect(cell(page, 0, 0)).toHaveText('이름197');
  await expect(page.locator('[data-action="filter"]')).toHaveText('필터 (1)…');

  // 정수 열에 문자: 대화상자가 닫히지 않고 사유를 보인다. 취소하면 필터는 그대로다.
  await page.click('[data-action="filter"]');
  const dialog = page.locator('.jdr-dialog');
  await dialog.locator('.jdr-dialog__row input').fill('abc');
  await dialog.getByRole('button', { name: '적용' }).click();
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('.jdr-dialog__error')).toHaveText('"나이" 열의 값: 정수가 아닙니다.');
  await dialog.getByRole('button', { name: '취소' }).click();
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 4개');

  // OR: 나이 > 590(197~200) 또는 이름이 '이름1'로 시작(이름1, 10~19, 100~199 = 111). 겹치는 197~199를
  // 빼면 112.
  await page.click('[data-action="filter"]');
  await addCondition(page, { column: '이름', op: '시작', value: '이름1', logic: 'or' });
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 112개');
  await expect(page.locator('[data-action="filter"]')).toHaveText('필터 (2)…');

  // 필터가 있는 뷰에서 행을 추가하면 보이지 않을 수 있음을 안내한다.
  await page.click('[data-action="row-insert"]');
  await expect(page.locator('.jdr-toast--info', { hasText: '새 행이 지금 뷰에' })).toBeVisible();

  // 0건: 빈 상태와 "필터 지우기" 버튼.
  await page.click('[data-action="filter"]');
  await page.locator('.jdr-dialog').getByRole('button', { name: '필터 지우기' }).click();
  await expect(page.locator('[data-action="filter"]')).toHaveText('필터…');
  await page.click('[data-action="filter"]');
  await addCondition(page, { column: '나이', op: '보다 큼', value: '100000' });
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 0개');
  await expect(page.locator('.jdr-grid__nomatch')).toBeVisible();
  await page.click('[data-action="clear-filters"]');
  await expect(page.locator('.jdr-grid__nomatch')).toBeHidden();
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText(`행 ${ROWS + 2}개`);
});

test('검색: LIKE 폴백과 와일드카드 이스케이프, 검색 인덱스 만들기 → 같은 결과, 되돌리기·다시 실행', async ({
  page,
}) => {
  const { table } = await seed(page);
  const search = page.locator('[data-action="search"]');
  await search.fill('이름12');
  await search.press('Enter');
  // 이름12, 이름120~129.
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 11개');
  await expect(page.locator('[data-action="view-clear"]')).toBeVisible();

  // `%`·`_`가 든 검색어는 이스케이프되어 그 글자 그대로만 맞는다.
  await search.fill('50%_');
  await search.press('Enter');
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 1개');
  await expect(cell(page, 0, 0)).toHaveText('50%_특가');

  // 디바운스: 입력만 해도 300 ms 뒤 반영된다.
  await search.fill('글 19');
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 11개');

  // 인덱스가 없을 때의 결과 수를 기억해 두고 인덱스를 만든다.
  await page.click('[data-action="search-index"]');
  await expect(
    page.locator('.jdr-toast--info', { hasText: '검색 인덱스를 만들었습니다' }),
  ).toBeVisible();
  await expect(page.locator('[data-action="search-index"]')).toHaveText('검색 인덱스 삭제');
  const objects = await hook(page).query(
    `SELECT count(*) FROM sqlite_master WHERE name LIKE '\\_jdr\\_fts\\_${table.id}%' ESCAPE '\\'`,
  );
  expect(Number(objects.rows[0]?.[0])).toBeGreaterThanOrEqual(4);
  expect((await hook(page).state())?.tables[0]?.ftsEnabled).toBe(true);

  // 인덱스가 있어도 결과는 같다(3자 이상은 FTS, 2자는 LIKE).
  await search.fill('글 19');
  await search.press('Enter');
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 11개');
  await search.fill('이름12');
  await search.press('Enter');
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 11개');
  await search.fill('12');
  await search.press('Enter');
  // '12'가 든 이름: 12, 112, 120~129 = 12개.
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 12개');

  // 편집이 인덱스를 따라간다: 셀을 바꾸면 검색 결과가 바뀐다.
  await search.fill('changed');
  await search.press('Enter');
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 0개');
  await page.click('[data-action="clear-filters"]');
  await expect(search).toHaveValue('');
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText(`행 ${ROWS + 1}개`);
  await cell(page, 0, 0).click();
  await page.keyboard.type('changed');
  await page.keyboard.press('Enter');
  await expect(cell(page, 0, 0)).toHaveText('changed');
  await search.fill('changed');
  await search.press('Enter');
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 1개');
  await page.click('[data-action="view-clear"]');
  await expect(search).toHaveValue('');

  // 인덱스 생성은 커맨드라 되돌리기·다시 실행을 탄다(셀 편집 하나 뒤에 있다).
  await page.keyboard.press('Control+z');
  await expect(cell(page, 0, 0)).toHaveText('이름1');
  await page.keyboard.press('Control+z');
  await expect(page.locator('[data-action="search-index"]')).toHaveText('검색 인덱스 만들기');
  expect((await hook(page).state())?.tables[0]?.ftsEnabled).toBe(false);
  await page.keyboard.press('Control+y');
  await expect(page.locator('[data-action="search-index"]')).toHaveText('검색 인덱스 삭제');
  await page.click('[data-action="search-index"]');
  await expect(
    page.locator('.jdr-toast--info', { hasText: '검색 인덱스를 삭제했습니다' }),
  ).toBeVisible();
  await expect(page.locator('[data-action="search-index"]')).toHaveText('검색 인덱스 만들기');
});

test('정렬·필터·검색·숨김·너비 조합을 뷰로 저장 → 파일 저장 → 다시 열기 → 뷰 선택 → 복원', async ({
  page,
}) => {
  const { name, body } = await seed(page);
  // 정렬: 나이 내림차순. 필터: 나이 > 300(i > 100). 검색: '이름19' → 190~199(이름19는 필터에 걸림).
  await header(page, '나이').click();
  await header(page, '나이').click();
  await page.click('[data-action="filter"]');
  await addCondition(page, { column: '나이', op: '보다 큼', value: '300' });
  const search = page.locator('[data-action="search"]');
  await search.fill('이름19');
  await search.press('Enter');
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 10개');
  await expect(cell(page, 0, 0)).toHaveText('이름199');
  // 열 숨김(사이드바)과 너비.
  await page.locator(`button[data-action="column-visibility"][data-column-id="${body}"]`).click();
  await expect(page.locator('.jdr-grid__hcell[data-col]')).toHaveCount(3);
  await expect(
    page.locator(`button[data-action="column-visibility"][data-column-id="${body}"]`),
  ).toHaveText('표시');
  const nameHeader = page.locator('.jdr-grid__hcell[data-col="0"]');
  const box = await nameHeader.boundingBox();
  if (!box) throw new Error('header box missing');
  await page.mouse.move(box.x + box.width - 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 100, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect
    .poll(async () => Math.round((await nameHeader.boundingBox())?.width ?? 0))
    .toBeGreaterThan(250);
  const widened = Math.round((await nameHeader.boundingBox())?.width ?? 0);

  // 뷰 저장.
  await page.click('[data-action="view-save"]');
  await page.locator('.jdr-dialog input').fill('보고');
  await page.locator('.jdr-dialog').getByRole('button', { name: '저장' }).click();
  await expect(page.locator('.jdr-toast--info', { hasText: '뷰 "보고"' })).toBeVisible();
  await expect(page.locator('[data-action="view-select"]')).toHaveValue(/^v_/);
  const rows = await hook(page).query('SELECT name, spec FROM _jdr_views');
  expect(rows.rows.length).toBe(1);
  expect(rows.rows[0]?.[0]).toBe('보고');
  const spec = JSON.parse(String(rows.rows[0]?.[1]));
  expect(spec.search).toBe('이름19');
  expect(spec.hidden).toEqual([body]);
  expect(spec.widths[name]).toBe(widened);

  // 파일 저장(다운로드) → 새 DB → 다시 열기.
  const downloadPromise = page.waitForEvent('download');
  await page.click('[data-action="save"]');
  const download = await downloadPromise;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jdr-e2e-'));
  const saved = path.join(dir, download.suggestedFilename());
  await download.saveAs(saved);
  await expect.poll(async () => (await hook(page).state())?.dirty).toBe(false);
  await page.click('[data-action="new"]');
  await expect(page.locator('.jdr-grid__empty')).toBeVisible();
  await page.locator(`input.${FILE_INPUT_CLASS}`).setInputFiles(saved);
  await expect(page.locator('.jdr-toolbar__file')).toHaveText('database.db');
  await page.locator('.jdr-sidebar__table-name', { hasText: '고객' }).click();
  // 새로 연 파일의 뷰 상태는 비어 있다.
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText(`행 ${ROWS + 1}개`);
  await expect(page.locator('.jdr-grid__hcell[data-col]')).toHaveCount(4);
  await expect(page.locator('[data-action="view-select"] option')).toHaveCount(2);

  // 뷰 선택 → 정렬·필터·검색·숨김·너비가 돌아온다.
  await page.locator('[data-action="view-select"]').selectOption({ label: '보고' });
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 10개');
  await expect(cell(page, 0, 0)).toHaveText('이름199');
  await expect(header(page, '나이')).toHaveAttribute('aria-sort', 'descending');
  await expect(page.locator('[data-action="filter"]')).toHaveText('필터 (1)…');
  await expect(search).toHaveValue('이름19');
  await expect(page.locator('.jdr-grid__hcell[data-col]')).toHaveCount(3);
  await expect
    .poll(async () => Math.round((await nameHeader.boundingBox())?.width ?? 0))
    .toBe(widened);

  // 뷰 삭제는 커맨드다: 되돌리면 목록에 돌아온다.
  await page.click('[data-action="view-delete"]');
  await page.locator('.jdr-dialog').getByRole('button', { name: '삭제' }).click();
  await expect(page.locator('[data-action="view-select"] option')).toHaveCount(1);
  await page.click('[data-action="undo"]');
  await expect(page.locator('[data-action="view-select"] option')).toHaveCount(2);
});

test('정렬 대상 열을 삭제하면 뷰에서 그 정렬 항목이 빠지고 안내한다', async ({ page }) => {
  const { age } = await seed(page);
  await header(page, '나이').click();
  await expect(page.locator('[data-action="sort"]')).toHaveText('정렬 (1)…');
  await page.locator('.jdr-sidebar__column-name', { hasText: '나이' }).click();
  await page.locator(`button[data-action="column-delete"][data-column-id="${age}"]`).click();
  await page.locator('.jdr-dialog').getByRole('button', { name: '삭제' }).click();
  await expect(
    page.locator('.jdr-toast--info', { hasText: '정렬·필터·숨김 항목을 뷰에서 제거' }),
  ).toBeVisible();
  await expect(page.locator('[data-action="sort"]')).toHaveText('정렬…');
  await expect(page.locator('.jdr-grid__hsort')).toHaveCount(0);
  await expect(cell(page, 0, 0)).toHaveText('이름1');
});

test('편집 중 머리글 클릭(정렬): 입력은 blur로 확정된 뒤 정렬이 걸린다', async ({ page }) => {
  const { table, name } = await seed(page);
  // 그리드가 다시 마운트되며 편집기를 닫는 경로다. 닫히기 전에 blur 확정이 먼저 일어나야
  // Step 5의 "다른 곳 클릭 → 확정 시도"가 지켜진다(입력이 조용히 사라지지 않는다).
  await cell(page, 0, 0).dblclick();
  await expect(page.locator('.jdr-editor input')).toBeVisible();
  await page.locator('.jdr-editor input').fill('머리글클릭확정');
  await header(page, '나이').click();
  await expect(header(page, '나이')).toHaveAttribute('aria-sort', 'ascending');
  await expect(page.locator('.jdr-editor')).toBeHidden();
  const stored = await hook(page).query(`SELECT "${name}" FROM "${table.id}" WHERE "id" = 1`);
  expect(stored.rows[0]?.[0]).toBe('머리글클릭확정');
});

// --- 임시 진단(세션 F 점검 후속). 원인을 특정하면 이 블록을 통째로 지운다. ---
// 바로 위 검사가 CI에서만 간헐적으로 실패한다. 조건을 똑같이 맞추려고 같은 파일·같은 seed로 두고
// 맨 뒤에 붙인다(실패는 언제나 스위트의 마지막 검사에서 났다). 단언하지 않고 증거만 로그로 남긴다.
// 증거는 전부 페이지 안에서 이벤트로 모으므로 경합 구간에 왕복이 끼어들지 않는다.
//  H1 경합(확정됐는데 질의가 빨랐다) → later가 뒤늦게 기대값
//  H2 되돌림(applyCellEdit false)   → edit.reverted 토스트
//  H3 입력이 옛 값으로 되돌아감      → blur 시점 값이 옛 값
//  H4 blur 미발생                    → blur 기록 없음
function installProbe() {
  /** @type {Array<Record<string, unknown>>} */
  const diag = [];
  /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window)).__jdrDiag = diag;
  const at = () => Math.round(performance.now());
  /** @param {HTMLElement} root */
  const wire = (root) => {
    const found = [
      ...(root.matches?.('.jdr-editor input, .jdr-editor textarea') ? [root] : []),
      ...(root.querySelectorAll?.('.jdr-editor input, .jdr-editor textarea') ?? []),
    ];
    for (const el of found) {
      const field = /** @type {HTMLInputElement} */ (el);
      diag.push({ at: at(), ev: 'field-added', value: field.value });
      field.addEventListener(
        'blur',
        () => diag.push({ at: at(), ev: 'blur', value: field.value }),
        true,
      );
      field.addEventListener('input', () =>
        diag.push({ at: at(), ev: 'input', value: field.value }),
      );
    }
  };
  new MutationObserver((muts) => {
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        if (n.className && String(n.className).includes('jdr-toast')) {
          diag.push({ at: at(), ev: 'toast', text: (n.textContent ?? '').slice(0, 60) });
        }
        wire(n);
      }
      for (const n of m.removedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        if (n.matches?.('.jdr-editor input, .jdr-editor textarea')) {
          diag.push({
            at: at(),
            ev: 'field-removed',
            value: /** @type {HTMLInputElement} */ (n).value,
          });
        } else if (n.querySelector?.('.jdr-editor input, .jdr-editor textarea')) {
          diag.push({ at: at(), ev: 'field-removed-subtree' });
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });
}

for (let probe = 1; probe <= 6; probe += 1) {
  test(`DIAG ${probe}: 편집 중 머리글 클릭(정렬)`, async ({ page }) => {
    /** @type {string[]} */
    const pageErrors = [];
    page.on('pageerror', (err) => pageErrors.push(String(err.message).slice(0, 200)));
    const { table, name } = await seed(page);
    await page.evaluate(installProbe);
    await cell(page, 0, 0).dblclick();
    await expect(page.locator('.jdr-editor input')).toBeVisible();
    await page.locator('.jdr-editor input').fill('머리글클릭확정');
    await header(page, '나이').click();
    await expect(header(page, '나이')).toHaveAttribute('aria-sort', 'ascending');
    await expect(page.locator('.jdr-editor')).toBeHidden();
    const sql = `SELECT "${name}" FROM "${table.id}" WHERE "id" = 1`;
    const immediate = (await hook(page).query(sql)).rows[0]?.[0];
    const diag = await page.evaluate(
      () => /** @type {{ __jdrDiag: unknown }} */ (/** @type {unknown} */ (window)).__jdrDiag,
    );
    await page.waitForTimeout(1500);
    const later = (await hook(page).query(sql)).rows[0]?.[0];
    console.log(
      `DIAG-${probe} ${JSON.stringify({ ok: immediate === '머리글클릭확정', immediate, later, pageErrors, diag })}`,
    );
  });
}
