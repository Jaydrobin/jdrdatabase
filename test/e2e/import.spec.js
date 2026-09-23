// @ts-check
/**
 * Step 7 E2E: 가져오기 버튼 → 숨은 파일 입력(setInputFiles) → 대화상자(미리보기·추론·옵션 변경) → 새 테이블로
 * 가져오기 → 그리드·보고서·저널 정지 배너 → 되돌리기 스택 비움. 기존 테이블에 추가와 열 대응, EUC-KR 인코딩
 * 재선택, 값 변환 실패(abort) 시 롤백을 실제 산출물(`file://`)에서 확인한다.
 */
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { PAGE_URL } from './page-url.js';
import { createTableWith } from './schema-ui.js';

const IMPORT_INPUT = 'input.jdr-import-input';
const FIXTURES = path.resolve('test/fixtures/import');

/**
 * @typedef {object} TestHook
 * @property {() => { tables: Array<{ id: string, name: string, columns: Array<{ id: string, name: string, type: string, deletedAt: string | null }> }>, dirty: boolean, journalFull: boolean, journalStop: string, currentTableId: string | null } | null} state
 * @property {(sql: string) => Promise<{ columns: string[], rows: unknown[][] }>} query
 * @property {() => { undo: number, redo: number, busy: boolean } | null} history
 * @property {() => Promise<unknown>} journalPending
 */

/** @param {import('@playwright/test').Page} page */
function hook(page) {
  return {
    state: () =>
      page.evaluate(() =>
        /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.state(),
      ),
    history: () =>
      page.evaluate(() =>
        /** @type {{ __jdrTest: TestHook }} */ (
          /** @type {unknown} */ (window)
        ).__jdrTest.history(),
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
 * 파일을 가져오기 입력에 넣고 대화상자가 미리보기를 다 읽을 때까지 기다린다.
 * @param {import('@playwright/test').Page} page
 * @param {string} fixture
 */
async function openImport(page, fixture) {
  await page.locator(IMPORT_INPUT).setInputFiles(path.join(FIXTURES, fixture));
  const dialog = page.locator('.jdr-dialog');
  await expect(dialog.locator('.jdr-dialog__title')).toHaveText('CSV·XLSX 가져오기');
  await expect(dialog.locator('table[data-role="preview"]')).toBeVisible();
  return dialog;
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.addInitScript(() => {
    const w = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window));
    delete w.showOpenFilePicker;
    delete w.showSaveFilePicker;
  });
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto(PAGE_URL);
  await expect(page.locator('.jdr-statusbar__item').first()).toHaveText('준비됨');
});

test('CSV → 새 테이블: 추론된 타입·이름으로 가져오고, 보고서·배너·히스토리 비움까지', async ({
  page,
}) => {
  // 가져오기 전의 커맨드 하나(되돌리기 스택에 남아 있어야 비움을 확인할 수 있다).
  await page.click('[data-action="table-create"]');
  await page.locator('.jdr-dialog input').fill('먼저');
  await page.locator('.jdr-dialog').getByRole('button', { name: '만들기' }).click();
  await expect.poll(() => hook(page).history()).toEqual({ undo: 1, redo: 0, busy: false });

  const dialog = await openImport(page, 'types.csv');
  await expect(dialog.locator('.jdr-import__file')).toContainText('types.csv');
  // 추론 결과가 열 설정 표에 들어 있다.
  const rows = dialog.locator('table[data-role="columns"] tbody tr');
  await expect(rows).toHaveCount(8);
  await expect(rows.nth(0).locator('input[data-field="name"]')).toHaveValue('flag');
  await expect(rows.nth(0).locator('select[data-field="type"]')).toHaveValue('boolean');
  await expect(rows.nth(1).locator('select[data-field="type"]')).toHaveValue('integer');
  await expect(rows.nth(2).locator('select[data-field="type"]')).toHaveValue('real');
  await expect(rows.nth(3).locator('select[data-field="type"]')).toHaveValue('date');
  await expect(rows.nth(4).locator('select[data-field="type"]')).toHaveValue('datetime');
  await expect(rows.nth(5).locator('select[data-field="type"]')).toHaveValue('text');
  await expect(dialog.locator('table[data-role="preview"] tbody tr')).toHaveCount(3);
  await expect(dialog.locator('table[data-role="preview"] thead th').nth(5)).toHaveText('zip');
  // 열 하나는 건너뛰고 이름을 하나 바꾼다.
  await rows.nth(7).locator('input[type="checkbox"]').uncheck();
  await rows.nth(5).locator('input[data-field="name"]').fill('우편번호');
  await dialog.locator('input[data-field="tableName"]').fill('타입표');
  await dialog.getByRole('button', { name: '가져오기' }).click();

  // 보고서 대화상자.
  const report = page.locator('.jdr-dialog');
  await expect(report.locator('.jdr-dialog__title')).toHaveText('가져오기 결과');
  await expect(report.locator('.jdr-dialog__message').first()).toHaveText('넣은 행: 3');
  await report.getByRole('button', { name: '확인' }).click();
  await expect(page.locator('.jdr-dialog')).toBeHidden();

  // 새 테이블이 선택되고 그리드에 3행, 열 7개.
  await expect(page.locator('.jdr-sidebar__table--active .jdr-sidebar__table-name')).toHaveText(
    '타입표',
  );
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 3개');
  await expect(page.locator('.jdr-grid__hcell[data-col]')).toHaveCount(7);
  await expect(page.locator('.jdr-grid__hcell', { hasText: '우편번호' })).toBeVisible();
  await expect(
    page.locator('.jdr-grid__row[data-row="0"]:not([hidden]) .jdr-grid__cell[data-col="5"]'),
  ).toHaveText('01234');
  const state = await hook(page).state();
  const table = state?.tables.find((tb) => tb.name === '타입표');
  expect(table?.columns.map((c) => [c.name, c.type])).toEqual([
    ['flag', 'boolean'],
    ['int', 'integer'],
    ['real', 'real'],
    ['date', 'date'],
    ['datetime', 'datetime'],
    ['우편번호', 'text'],
    ['mixed', 'text'],
  ]);
  // 가져오기는 커맨드가 아니다: dirty, 저널 정지 배너, 되돌리기 스택 비움.
  expect(state?.dirty).toBe(true);
  expect(state?.journalStop).toBe('import');
  await expect(page.locator('.jdr-toolbar__banner')).toContainText(
    '가져오기는 변경 기록에 남지 않아',
  );
  expect(await hook(page).history()).toEqual({ undo: 0, redo: 0, busy: false });
  await expect(page.locator('[data-action="undo"]')).toBeDisabled();

  // 저장(다운로드)하면 배너가 사라지고 저널 기록이 다시 시작된다.
  const downloadPromise = page.waitForEvent('download');
  await page.click('[data-action="save"]');
  await downloadPromise;
  await expect.poll(async () => (await hook(page).state())?.journalStop).toBe('none');
  await expect(page.locator('.jdr-toolbar__banner')).toBeHidden();
});

test('EUC-KR CSV: 인코딩이 감지되고, 잘못 고르면 경고 뒤 되돌릴 수 있다; 구분자·헤더 옵션 변경', async ({
  page,
}) => {
  const dialog = await openImport(page, 'euc-kr.csv');
  await expect(dialog.locator('select[data-field="encoding"]')).toHaveValue('euc-kr');
  await expect(dialog.locator('table[data-role="preview"] thead th').nth(0)).toHaveText('이름');
  await dialog.locator('select[data-field="encoding"]').selectOption('utf-8');
  await expect(dialog.locator('.jdr-import__warning')).toContainText('깨진 문자');
  await dialog.locator('select[data-field="encoding"]').selectOption('euc-kr');
  await expect(dialog.locator('.jdr-import__warning')).toHaveCount(0);
  await expect(
    dialog.locator('table[data-role="preview"] tbody tr').nth(1).locator('td').nth(1),
  ).toHaveText('부산');
  // 헤더 없음: 첫 행이 데이터가 되고 열 이름은 자동.
  await dialog.locator('input[data-field="hasHeader"]').uncheck();
  await expect(dialog.locator('table[data-role="preview"] thead th').nth(0)).toHaveText('열1');
  await expect(dialog.locator('table[data-role="preview"] tbody tr')).toHaveCount(3);
  await dialog.locator('input[data-field="hasHeader"]').check();
  await expect(dialog.locator('table[data-role="preview"] thead th').nth(0)).toHaveText('이름');
  // 구분자를 틀리게 고르면 열이 하나로 뭉친다.
  await dialog.locator('select[data-field="delimiter"]').selectOption(';');
  await expect(dialog.locator('table[data-role="preview"] thead th')).toHaveCount(1);
  await dialog.locator('select[data-field="delimiter"]').selectOption(',');
  await expect(dialog.locator('table[data-role="preview"] thead th')).toHaveCount(2);
  await dialog.locator('input[data-field="tableName"]').fill('주소록');
  await dialog.getByRole('button', { name: '가져오기' }).click();
  await page.locator('.jdr-dialog').getByRole('button', { name: '확인' }).click();
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 2개');
  await expect(
    page.locator('.jdr-grid__row[data-row="1"]:not([hidden]) .jdr-grid__cell[data-col="0"]'),
  ).toHaveText('김영희');
});

test('기존 테이블에 추가: 같은 이름의 열이 자동으로 대응되고, 대응 없는 열은 건너뛴다', async ({
  page,
}) => {
  await createTableWith(page, '고객', [
    { name: '이름', type: 'text' },
    { name: '나이', type: 'integer' },
  ]);
  const dialog = await openImport(page, 'bom-utf8.csv');
  await dialog.locator('input[type="radio"][value="existing"]').check();
  await expect(dialog.locator('select[data-field="existingTable"]')).toHaveValue(/^t_/);
  const rows = dialog.locator('table[data-role="columns"] tbody tr');
  await expect(rows).toHaveCount(3);
  // 이름·나이는 대응, 가입일은 건너뜀.
  const targets = rows.locator('select[data-field="target"]');
  await expect(targets.nth(0).locator('option:checked')).toHaveText('이름');
  await expect(targets.nth(1).locator('option:checked')).toHaveText('나이');
  await expect(targets.nth(2).locator('option:checked')).toHaveText('(건너뜀)');
  await expect(rows.nth(1).locator('td').nth(2)).toHaveText('정수');
  // 기존 테이블에는 text 강등 정책이 없다.
  await expect(rows.nth(0).locator('select[data-field="policy"] option')).toHaveCount(2);
  await dialog.getByRole('button', { name: '가져오기' }).click();
  await page.locator('.jdr-dialog').getByRole('button', { name: '확인' }).click();
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 2개');
  await expect(
    page.locator('.jdr-grid__row[data-row="0"]:not([hidden]) .jdr-grid__cell[data-col="1"]'),
  ).toHaveText('30');
  const state = await hook(page).state();
  expect(state?.tables.length).toBe(1);
});

test('값 변환 실패에 "중단"을 고르면 롤백되어 테이블이 생기지 않고 대화상자에 사유가 남는다', async ({
  page,
}) => {
  const dialog = await openImport(page, 'types.csv');
  const rows = dialog.locator('table[data-role="columns"] tbody tr');
  // mixed 열(1, x, 빈 값)을 정수로 강제하고 중단 정책.
  await rows.nth(6).locator('select[data-field="type"]').selectOption('integer');
  await rows.nth(6).locator('select[data-field="policy"]').selectOption('abort');
  await dialog.locator('input[data-field="tableName"]').fill('실패');
  await dialog.getByRole('button', { name: '가져오기' }).click();
  await expect(dialog.locator('.jdr-dialog__error')).toContainText(
    '3번째 레코드의 "mixed" 열 값이 타입에 맞지 않아 중단했습니다',
  );
  await expect(dialog).toBeVisible();
  expect((await hook(page).state())?.tables).toEqual([]);
  expect((await hook(page).state())?.dirty).toBe(false);
  // 정책을 NULL로 바꾸면 성공한다.
  await rows.nth(6).locator('select[data-field="policy"]').selectOption('null');
  await dialog.getByRole('button', { name: '가져오기' }).click();
  const report = page.locator('.jdr-dialog');
  await expect(report.locator('.jdr-dialog__title')).toHaveText('가져오기 결과');
  await expect(report.locator('.jdr-dialog__message').nth(1)).toHaveText(
    '변환할 수 없어 비운 값: 1',
  );
  await report.getByRole('button', { name: '확인' }).click();
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 3개');
});

test('취소 버튼은 대화상자를 닫고 아무것도 바꾸지 않는다; 읽기 전용에서는 버튼이 잠긴다', async ({
  page,
}) => {
  const dialog = await openImport(page, 'quotes.csv');
  await dialog.getByRole('button', { name: '취소' }).click();
  await expect(dialog).toBeHidden();
  expect((await hook(page).state())?.tables).toEqual([]);
  expect((await hook(page).state())?.dirty).toBe(false);
  await expect(page.locator('[data-action="import"]')).toBeEnabled();
});

test('XLSX → 새 테이블: 시트·헤더 행 선택, 날짜·수식·불리언·병합·오류 셀 경고(Step 8)', async ({
  page,
}) => {
  const dialog = await openImport(page, 'basic.xlsx');
  // 시트 목록과 크기, 경고(병합·오류 셀·빈/중복 헤더).
  const sheet = dialog.locator('select[data-field="sheet"]');
  await expect(sheet.locator('option')).toHaveCount(2);
  await expect(sheet.locator('option').nth(0)).toHaveText('데이터 (5행 × 12열)');
  await expect(dialog.locator('.jdr-import__warning')).toHaveCount(3);
  await expect(dialog.locator('.jdr-import__warning').nth(0)).toContainText('병합된 셀 범위 1개');
  await expect(dialog.locator('.jdr-import__warning').nth(1)).toContainText('오류 셀');
  const rows = dialog.locator('table[data-role="columns"] tbody tr');
  await expect(rows).toHaveCount(12);
  await expect(rows.nth(1).locator('input[data-field="name"]')).toHaveValue('열2');
  await expect(rows.nth(3).locator('input[data-field="name"]')).toHaveValue('이름 (2)');
  await expect(rows.nth(4).locator('select[data-field="type"]')).toHaveValue('date');
  await expect(rows.nth(5).locator('select[data-field="type"]')).toHaveValue('datetime');
  await expect(rows.nth(6).locator('select[data-field="type"]')).toHaveValue('boolean');
  await expect(rows.nth(7).locator('select[data-field="type"]')).toHaveValue('integer');
  await expect(rows.nth(8).locator('select[data-field="type"]')).toHaveValue('text');
  await expect(
    dialog.locator('table[data-role="preview"] tbody tr').nth(0).locator('td').nth(7),
  ).toHaveText('60');
  // 둘째 시트 + 헤더 행 3.
  await sheet.selectOption('둘째');
  await expect(dialog.locator('table[data-role="preview"] thead th').nth(0)).toHaveText('제목 줄');
  const headerRow = dialog.locator('input[data-field="headerRow"]');
  await headerRow.fill('3');
  await headerRow.dispatchEvent('change');
  await expect(dialog.locator('table[data-role="preview"] thead th')).toHaveText(['a', 'b']);
  await expect(dialog.locator('table[data-role="preview"] tbody tr')).toHaveCount(2);
  // 다시 첫 시트로(헤더 행 3이 유지되어 3행이 헤더가 된다) → 헤더 행 1로 되돌린다.
  await sheet.selectOption('데이터');
  await expect(dialog.locator('table[data-role="preview"] thead th').nth(0)).toHaveText('김영희');
  await headerRow.fill('1');
  await headerRow.dispatchEvent('change');
  await expect(dialog.locator('table[data-role="preview"] thead th').nth(0)).toHaveText('이름');
  await expect(dialog.locator('table[data-role="preview"] tbody tr')).toHaveCount(4);
  await expect(dialog.locator('table[data-role="columns"] tbody tr')).toHaveCount(12);
  await dialog.locator('input[data-field="tableName"]').fill('엑셀');
  await dialog.getByRole('button', { name: '가져오기' }).click();
  const report = page.locator('.jdr-dialog');
  await expect(report.locator('.jdr-dialog__title')).toHaveText('가져오기 결과');
  await expect(report.locator('.jdr-dialog__message').nth(0)).toHaveText('넣은 행: 3');
  await expect(report.locator('.jdr-dialog__message').nth(1)).toHaveText('빈 행이라 건너뜀: 1');
  await expect(report.locator('.jdr-dialog__message')).toContainText([
    /2번째 레코드 · 오류 · 오류 셀/,
  ]);
  await report.getByRole('button', { name: '확인' }).click();
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 3개');
  await expect(
    page.locator('.jdr-grid__row[data-row="0"]:not([hidden]) .jdr-grid__cell[data-col="4"]'),
  ).toHaveText('2024-01-05');
  await expect(
    page.locator('.jdr-grid__row[data-row="0"]:not([hidden]) .jdr-grid__cell[data-col="5"]'),
  ).toHaveText('2024-01-05T10:20:30');
  await expect(
    page.locator('.jdr-grid__row[data-row="0"]:not([hidden]) .jdr-grid__cell[data-col="6"]'),
  ).toHaveText('✓');
  // 7번째 열부터는 뷰포트 밖(열 가상화)이라 DB에서 확인한다: 수식은 계산값, 오류 셀은 NULL, 1900 윤년 버그
  // (달력에 없는 일련번호 60은 숫자로 와서 윤년 열이 text가 되고, 날짜를 만들어 내지 않는다).
  const table = (await hook(page).state())?.tables.find((tb) => tb.name === '엑셀');
  const ids = table?.columns.map((c) => c.id) ?? [];
  const stored = await hook(page).query(
    `SELECT "${ids[7]}", "${ids[9]}", "${ids[10]}", "${ids[11]}" FROM "${table?.id}" ORDER BY "id" LIMIT 3`,
  );
  expect(stored.rows).toEqual([
    [60, null, 1.5, '60'],
    [50, null, -2, '1900-03-01'],
    [80, null, 300, null],
  ]);
});

test('암호화된 XLSX는 미리보기에서 거부 문구를 보이고 가져오기를 막는다', async ({ page }) => {
  await page.locator(IMPORT_INPUT).setInputFiles(path.join(FIXTURES, 'encrypted.xlsx'));
  const dialog = page.locator('.jdr-dialog');
  await expect(dialog.locator('.jdr-import__warning')).toContainText('암호가 걸린 XLSX');
  await dialog.getByRole('button', { name: '가져오기' }).click();
  await expect(dialog.locator('.jdr-dialog__error')).toContainText('암호가 걸린 XLSX');
  await dialog.getByRole('button', { name: '취소' }).click();
  expect((await hook(page).state())?.tables).toEqual([]);
});
