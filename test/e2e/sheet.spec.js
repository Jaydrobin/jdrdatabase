// @ts-check
/**
 * Step 12 E2E(D-16): 기본 시트(열 30개), 빈 행 30줄과 빈 행 확정, 대화상자 없는 "+ 열"과 머리글 이름 편집기
 * (한글 IME), 열 메뉴(우클릭·Shift+F10)와 선택 항목 예시, 정렬 버튼. 그리고 빈 행의 예외 처리(검증 실패,
 * 빈 행이 꺼지는 전환, 붙여넣기의 빈 줄, 빈 행에 걸친 선택)를 실제 산출물(`file://`)에서 확인한다.
 */
import { expect, test } from '@playwright/test';
import { PAGE_URL } from './page-url.js';
import { createTableUi, createTableWith, headerCell, openColumnMenu } from './schema-ui.js';

/**
 * @typedef {object} TestHook
 * @property {() => { tables: Array<{ id: string, name: string, columns: Array<{ id: string, name: string, type: string, deletedAt: string | null }> }>, currentTableId?: string } | null} state
 * @property {(sql: string) => Promise<{ columns: string[], rows: unknown[][] }>} query
 * @property {() => { sort: Array<{ colId: string, dir: string }> } | null} view
 * @property {() => { undo: number, redo: number, busy: boolean } | null} history
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
 * 지금 테이블의 행을 id 순으로(열 id 순서대로 값).
 * @param {import('@playwright/test').Page} page
 * @param {string[]} colNames
 */
async function rowsOf(page, colNames) {
  const table = (await hook(page).state())?.tables.at(-1);
  if (!table) throw new Error('table missing');
  const ids = colNames.map((n) => {
    const col = table.columns.find((c) => c.name === n && c.deletedAt === null);
    if (!col) throw new Error(`column ${n} missing`);
    return `"${col.id}"`;
  });
  const result = await hook(page).query(
    `SELECT "id", ${ids.join(', ')} FROM "${table.id}" ORDER BY "id" LIMIT 100`,
  );
  return result.rows;
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} row
 * @param {number} col
 */
function cell(page, row, col) {
  return page.locator(
    `.jdr-grid__row[data-row="${row}"]:not([hidden]) .jdr-grid__cell[data-col="${col}"]`,
  );
}

/** @param {import('@playwright/test').Page} page */
function rowCount(page) {
  return page.locator('.jdr-grid__rowcount');
}

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 800 });
  await page.addInitScript(() => {
    const w = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window));
    delete w.showOpenFilePicker;
    delete w.showSaveFilePicker;
  });
  await page.goto(PAGE_URL);
  await expect(page.locator('.jdr-statusbar__item').first()).toHaveText('준비됨');
});

test('"+ 테이블" → Enter → 열 30개·빈 행 30줄 → 세 번째 빈 행에 입력하면 행 3개(값은 3행) → 되돌리기 → 행 0개', async ({
  page,
}) => {
  await createTableUi(page);
  await expect(page.locator('.jdr-sidebar__table--active .jdr-sidebar__table-name')).toHaveText(
    '테이블 1',
  );
  await expect
    .poll(async () => (await hook(page).state())?.tables[0]?.columns.map((c) => c.name))
    .toEqual(Array.from({ length: 30 }, (_, i) => `열 ${i + 1}`));
  await expect(headerCell(page, '열 1')).toHaveCount(1);
  await expect(rowCount(page)).toHaveText('행 0개');
  // 빈 행 30줄: 머리글 + 빈 행이 aria-rowcount, 행 번호는 1부터, 행 수 표시는 실제 행만.
  await expect(page.locator('[role="grid"]')).toHaveAttribute('aria-rowcount', '31');
  const ghost = page.locator('.jdr-grid__row--ghost:not([hidden])');
  await expect(ghost.first()).toBeVisible();
  await expect(page.locator('.jdr-grid__row[data-row="2"] .jdr-grid__cell--rownum')).toHaveText(
    '3',
  );
  const canvasHeight = await page
    .locator('.jdr-grid__canvas')
    .evaluate((el) => Number.parseFloat(getComputedStyle(el).height));
  expect(canvasHeight).toBe(30 * 32);

  // 세 번째 빈 행의 두 번째 열에서 바로 타이핑 → Enter. (Playwright의 `keyboard.type`은 자판에 없는 글자에
  // keydown을 내지 않으므로 타이핑 시작은 ASCII로 하고 한글은 편집기 안에서 넣는다.)
  await cell(page, 2, 1).click();
  await page.keyboard.type('3');
  await page.keyboard.insertText('째');
  await page.keyboard.press('Enter');
  await expect(rowCount(page)).toHaveText('행 3개');
  await expect(cell(page, 2, 1)).toHaveText('3째');
  expect(await rowsOf(page, ['열 1', '열 2'])).toEqual([
    [1, null, null],
    [2, null, null],
    [3, null, '3째'],
  ]);
  await expect(page.locator('.jdr-grid__row[data-row="2"]')).not.toHaveClass(
    /jdr-grid__row--ghost/,
  );
  await expect(page.locator('.jdr-grid__row[data-row="3"]')).toHaveClass(/jdr-grid__row--ghost/);
  // Enter 확정은 커서를 아래(빈 행)로 옮긴다.
  await expect(page.locator('.jdr-grid__cell--active')).toHaveAttribute('data-col', '1');

  // 되돌리기 한 번에 만든 행이 모두 사라진다.
  await page.keyboard.press('Control+z');
  await expect(rowCount(page)).toHaveText('행 0개');
  expect(await rowsOf(page, ['열 1'])).toEqual([]);
});

test('"+ 열" → 열 31과 머리글 이름 편집기 → 한글 IME로 확정. 삭제한 열 5의 이름은 새 열이 쓰지 않는다', async ({
  page,
}) => {
  await createTableUi(page, '시트');
  await expect(headerCell(page, '열 30')).toHaveCount(1);
  await page.click('[data-action="column-add"]');
  const editor = page.locator('.jdr-grid__hrename');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue('열 31');
  // 이름 전체가 선택되어 있어 바로 타이핑하면 바뀐다.
  expect(
    await editor.evaluate((el) => [
      /** @type {HTMLInputElement} */ (el).selectionStart,
      /** @type {HTMLInputElement} */ (el).selectionEnd,
    ]),
  ).toEqual([0, '열 31'.length]);

  // 조합 시작 → 글자 → 조합 중의 Enter(isComposing)는 확정하지 않는다 → 조합 끝 → Enter.
  await editor.dispatchEvent('compositionstart');
  await page.keyboard.insertText('메');
  await editor.evaluate((el) => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(editor).toBeVisible();
  await page.keyboard.insertText('모');
  await editor.dispatchEvent('compositionend');
  await expect(editor).toHaveValue('메모');
  await page.keyboard.press('Enter');
  await expect(editor).toHaveCount(0);
  await expect(headerCell(page, '메모')).toHaveCount(1);
  await expect(page.locator('.jdr-grid__scroller')).toBeFocused();
  // 추가와 이름 짓기는 한 동작이다: 되돌리기 한 번에 열이 사라지고, 다시 실행 한 번에 이름까지 돌아온다.
  await page.keyboard.press('Control+z');
  await expect(headerCell(page, '메모')).toHaveCount(0);
  await expect(headerCell(page, '열 31')).toHaveCount(0);
  await page.keyboard.press('Control+y');
  await expect(headerCell(page, '메모')).toHaveCount(1);

  // 열 5를 지운 뒤 "+ 열": 자동 이름은 소프트 삭제된 이름도 건너뛴다.
  const menu = await openColumnMenu(page, '열 5');
  await menu.getByRole('menuitem', { name: '열 삭제…' }).click();
  await page.locator('.jdr-dialog').getByRole('button', { name: '삭제' }).click();
  await expect(headerCell(page, '열 5')).toHaveCount(0);
  await page.click('[data-action="column-add"]');
  await expect(editor).toHaveValue('열 31');
  // Esc는 자동 이름을 그대로 둔다.
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
  await expect(headerCell(page, '열 31')).toHaveCount(1);
  // 이름을 빼앗기지 않았으므로 열 5를 복원할 수 있다.
  await page
    .locator('.jdr-sidebar__column--deleted', { hasText: '열 5' })
    .locator('[data-action="column-restore"]')
    .click();
  await expect(headerCell(page, '열 5')).toHaveCount(1);
  expect((await hook(page).state())?.tables[0]?.columns.filter((c) => c.name === '열 5')).toEqual([
    expect.objectContaining({ deletedAt: null }),
  ]);
});

test('머리글 이름 편집기: 겹치는 이름은 편집기를 열어 둔 채 오류, 포커스 이탈로 확정하지 못하면 원래 이름', async ({
  page,
}) => {
  await createTableWith(page, '고객', [
    { name: '이름', type: 'text' },
    { name: '나이', type: 'integer' },
  ]);
  const editor = page.locator('.jdr-grid__hrename');
  await headerCell(page, '나이').locator('.jdr-grid__hname').dblclick();
  await expect(editor).toBeFocused();
  await editor.fill('이름');
  await page.keyboard.press('Enter');
  await expect(page.locator('.jdr-grid__hrename-error')).toHaveText('같은 이름이 이미 있습니다.');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveAttribute('aria-invalid', 'true');
  // 다른 곳을 눌러 떠나면 원래 이름으로 두고 알린다.
  await cell(page, 0, 0).click();
  await expect(editor).toHaveCount(0);
  await expect(
    page.locator('.jdr-toast--info', { hasText: '원래 값으로 되돌렸습니다' }),
  ).toBeVisible();
  await expect(headerCell(page, '나이')).toHaveCount(1);
  // 너비 조절 손잡이의 더블클릭은 이름 편집이 아니다.
  await headerCell(page, '나이').locator('.jdr-grid__resizer').dblclick();
  await expect(editor).toHaveCount(0);
  // 포커스 이탈로 확정: 유효한 이름은 저장된다.
  await headerCell(page, '나이').locator('.jdr-grid__hname').dblclick();
  await editor.fill('연령');
  await cell(page, 0, 0).click();
  await expect(headerCell(page, '연령')).toHaveCount(1);
});

test('열 메뉴(우클릭·Shift+F10): 타입을 선택으로 바꾸고 예시가 보이는 입력칸에 항목 입력, 정렬 버튼 순환', async ({
  page,
}) => {
  await createTableUi(page, '작업');
  await expect(headerCell(page, '열 2')).toHaveCount(1);

  // 우클릭 → "타입 변경…" → 선택. 입력칸은 흐린 예시와 설명 줄을 늘 보인다.
  const menu = await openColumnMenu(page, '열 2');
  await expect(menu.getByRole('menuitem')).toHaveText([
    '이름 바꾸기',
    '타입 변경…',
    '오름차순 정렬',
    '내림차순 정렬',
    '정렬 해제',
    '열 숨기기',
    '열 삭제…',
  ]);
  await expect(menu.getByRole('menuitem', { name: '이름 바꾸기' })).toBeFocused();
  await menu.getByRole('menuitem', { name: '타입 변경…' }).click();
  const dialog = page.locator('.jdr-dialog');
  await dialog.locator('select').first().selectOption({ label: '선택' });
  const choices = dialog.locator('textarea');
  await expect(choices).toBeVisible();
  await expect(choices).toHaveAttribute('placeholder', '진행 중\n완료\n보류');
  const hintId = await choices.getAttribute('aria-describedby');
  expect(hintId).toBeTruthy();
  await expect(page.locator(`#${hintId}`)).toHaveText(
    '셀에서는 여기 적은 값 중 하나만 고를 수 있습니다. 한 줄에 하나씩 적습니다.',
  );
  await expect(page.locator(`#${hintId}`)).toBeVisible();
  await choices.fill('진행 중\n완료\n보류');
  await dialog.getByRole('button', { name: '변환' }).click();
  await expect(dialog).toHaveCount(0);
  await expect
    .poll(
      async () =>
        (await hook(page).state())?.tables[0]?.columns.find(
          (c) => c.name === '열 2' && c.deletedAt === null,
        )?.type,
    )
    .toBe('select');

  // 키보드: 활성 셀에서 Shift+F10 → 그 열의 메뉴 → ↓↓ Enter = 오름차순 정렬. Esc로 닫으면 그리드로 돌아온다.
  await cell(page, 0, 0).click();
  await page.keyboard.press('Shift+F10');
  const keyMenu = page.locator('.jdr-menu[role="menu"]');
  await expect(keyMenu).toHaveAttribute('aria-label', '열 1 열 메뉴');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(keyMenu.getByRole('menuitem', { name: '오름차순 정렬' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(keyMenu).toHaveCount(0);
  await expect(headerCell(page, '열 1')).toHaveAttribute('aria-sort', 'ascending');
  await expect(page.locator('.jdr-grid__scroller')).toBeFocused();
  // 정렬이 있는 뷰에는 빈 행이 없다.
  await expect(page.locator('.jdr-grid__row--ghost:not([hidden])')).toHaveCount(0);
  await page.keyboard.press('ContextMenu');
  await expect(keyMenu).toBeVisible();
  await keyMenu.getByRole('menuitem', { name: '정렬 해제' }).click();
  await expect(headerCell(page, '열 1')).not.toHaveAttribute('aria-sort', /.+/);
  await expect(page.locator('.jdr-grid__row--ghost').first()).toBeVisible();

  // 열 메뉴의 정렬은 다른 열의 정렬을 지우지 않는다: 없는 열은 끝에 붙고, 있는 열은 그 자리에서 방향만.
  const sortOf = async () =>
    ((await hook(page).view())?.sort ?? []).map((s) => [s.colId, s.dir].join(':'));
  const idOf = async (/** @type {string} */ name) =>
    (await hook(page).state())?.tables[0]?.columns.find(
      (c) => c.name === name && c.deletedAt === null,
    )?.id ?? '';
  const [id1, id3] = [await idOf('열 1'), await idOf('열 3')];
  await (
    await openColumnMenu(page, '열 1')
  )
    .getByRole('menuitem', { name: '내림차순 정렬' })
    .click();
  await (
    await openColumnMenu(page, '열 3')
  )
    .getByRole('menuitem', { name: '오름차순 정렬' })
    .click();
  expect(await sortOf()).toEqual([`${id1}:desc`, `${id3}:asc`]);
  await (
    await openColumnMenu(page, '열 1')
  )
    .getByRole('menuitem', { name: '오름차순 정렬' })
    .click();
  expect(await sortOf()).toEqual([`${id1}:asc`, `${id3}:asc`]);
  await (await openColumnMenu(page, '열 1')).getByRole('menuitem', { name: '정렬 해제' }).click();
  expect(await sortOf()).toEqual([`${id3}:asc`]);
  await (await openColumnMenu(page, '열 3')).getByRole('menuitem', { name: '정렬 해제' }).click();
  expect(await sortOf()).toEqual([]);

  // 정렬 버튼: 클릭은 없음 → 오름 → 내림 → 없음, Shift+클릭은 보조 정렬.
  const sort1 = headerCell(page, '열 1').locator('[data-hbtn="sort"]');
  const sort3 = headerCell(page, '열 3').locator('[data-hbtn="sort"]');
  await sort1.click();
  await expect(headerCell(page, '열 1')).toHaveAttribute('aria-sort', 'ascending');
  await sort1.click();
  await expect(headerCell(page, '열 1')).toHaveAttribute('aria-sort', 'descending');
  await sort3.click({ modifiers: ['Shift'] });
  await expect(sort3.locator('.jdr-grid__hsort')).toHaveText('▲2');
  expect((await hook(page).view())?.sort.map((s) => s.dir)).toEqual(['desc', 'asc']);
  // Shift 없는 클릭은 v1처럼 그 열 하나의 순환이다. 내림 → 없음이면 정렬이 모두 풀린다.
  await sort1.click();
  await expect(page.locator('.jdr-grid__hsort')).toHaveCount(0);
  expect((await hook(page).view())?.sort).toEqual([]);
  await expect(page.locator('.jdr-grid__row--ghost:not([hidden])').first()).toBeVisible();
});

test('빈 행 예외: 검증 실패는 행을 만들지 않음, 불리언, 빈 행에서 시작한 붙여넣기, 빈 행에 걸친 지우기·복사', async ({
  page,
}) => {
  await createTableWith(page, '혼합', [
    { name: '글', type: 'text' },
    { name: '수', type: 'integer' },
    { name: '참', type: 'boolean' },
  ]);
  await expect(rowCount(page)).toHaveText('행 0개');

  // 정수 열에 문자: 편집기를 닫지 않고, 커맨드는 검증을 통과한 뒤에만 만들므로 행이 생기지 않는다.
  await cell(page, 1, 1).click();
  await page.keyboard.type('abc');
  await page.keyboard.press('Enter');
  await expect(page.locator('.jdr-editor__error')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('.jdr-editor')).toBeHidden();
  await expect(rowCount(page)).toHaveText('행 0개');

  // 빈 칸의 불리언을 Enter로 켜면 두 번째 빈 행까지 행 2개, 값은 2행에 참.
  await cell(page, 1, 2).click();
  await page.keyboard.press('Enter');
  await expect(rowCount(page)).toHaveText('행 2개');
  expect(await rowsOf(page, ['참'])).toEqual([
    [1, null],
    [2, 1],
  ]);

  // 빈 행(5번째 줄)에서 붙여넣기: 사이의 빈 줄 2개도 만들고 값은 5·6행. 되돌리기 한 번에 모두 사라진다.
  await page.evaluate(() => navigator.clipboard.writeText('가\t1\n나\t2'));
  await cell(page, 4, 0).click();
  await page.keyboard.press('Control+v');
  await expect(rowCount(page)).toHaveText('행 6개');
  expect(await rowsOf(page, ['글', '수'])).toEqual([
    [1, null, null],
    [2, null, null],
    [3, null, null],
    [4, null, null],
    [5, '가', 1],
    [6, '나', 2],
  ]);
  await page.keyboard.press('Control+z');
  await expect(rowCount(page)).toHaveText('행 2개');
  await page.keyboard.press('Control+y');
  await expect(rowCount(page)).toHaveText('행 6개');

  // 실제 행 6줄 + 빈 행 2줄에 걸친 선택: 지우기는 실제 행만, 행을 만들지 않는다.
  await cell(page, 4, 0).click();
  await cell(page, 7, 1).click({ modifiers: ['Shift'] });
  await page.keyboard.press('Control+c');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('가\t1\n나\t2\n\t\n\t');
  await page.keyboard.press('Delete');
  await expect(cell(page, 4, 0)).toHaveText('');
  await expect(rowCount(page)).toHaveText('행 6개');
  // 선택이 빈 행뿐이면 지우기·행 삭제는 아무것도 하지 않는다.
  await cell(page, 8, 0).click();
  await page.keyboard.press('Delete');
  await page.keyboard.press('Control+Shift+Delete');
  await expect(rowCount(page)).toHaveText('행 6개');
});

test('빈 행이 꺼지는 전환: 빈 행의 장문 편집기는 정렬을 켜면 닫히고 알린다(행은 생기지 않음)', async ({
  page,
}) => {
  await createTableWith(page, '메모', [
    { name: '제목', type: 'text' },
    { name: '본문', type: 'longtext' },
  ]);
  await cell(page, 0, 1).dblclick();
  const panel = page.locator('.jdr-longtext');
  await expect(panel).toBeVisible();
  await expect(panel.locator('textarea')).toHaveValue('');
  await panel.locator('textarea').fill('버려질 글');
  // 도구 모음의 정렬 대화상자로 정렬을 켠다(장문 편집기는 포커스 이탈로 확정하지 않는다).
  await page.click('[data-action="sort"]');
  const dialog = page.locator('.jdr-dialog');
  await dialog.getByRole('button', { name: '+ 정렬 추가' }).click();
  await dialog.locator('.jdr-dialog__row select').nth(0).selectOption({ label: '제목' });
  await dialog.getByRole('button', { name: '적용' }).click();
  await expect(panel).toBeHidden();
  await expect(
    page.locator('.jdr-toast--info', { hasText: '빈 행의 입력을 닫았습니다' }),
  ).toBeVisible();
  await expect(page.locator('.jdr-grid__row--ghost:not([hidden])')).toHaveCount(0);
  await expect(rowCount(page)).toHaveText('행 0개');

  // 정렬을 풀면 빈 행이 돌아오고, 빈 행의 장문 편집기 확정은 그 줄까지 행을 만든다.
  await page.click('[data-action="view-clear"]');
  await expect(page.locator('.jdr-grid__row--ghost').first()).toBeVisible();
  await cell(page, 1, 1).dblclick();
  await panel.locator('textarea').fill('둘째 줄 본문');
  await page.keyboard.press('Control+Enter');
  await expect(panel).toBeHidden();
  await expect(rowCount(page)).toHaveText('행 2개');
  expect(await rowsOf(page, ['본문'])).toEqual([
    [1, null],
    [2, '둘째 줄 본문'],
  ]);
});

test('모두 선택(Ctrl+A)은 실제 행만 고른다: 복사에 빈 행이 섞이지 않고, 빈 행 자리 끝의 빈 줄은 붙여넣어도 행을 만들지 않는다', async ({
  page,
}) => {
  await createTableWith(page, '목록', [
    { name: '글', type: 'text' },
    { name: '수', type: 'integer' },
  ]);
  await cell(page, 0, 0).click();
  await page.keyboard.type('x1');
  await page.keyboard.press('Enter');
  await expect(rowCount(page)).toHaveText('행 1개');
  await page.keyboard.type('x2');
  await page.keyboard.press('Enter');
  await expect(rowCount(page)).toHaveText('행 2개');

  // Ctrl+A → 복사 → 붙여넣기: 빈 행 30줄이 복사되어 실제 행 30개가 생기던 결함(리뷰 N1).
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+c');
  await expect(page.locator('.jdr-toast--info', { hasText: '2행 × 2열을 복사' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe('x1\t\nx2\t');
  await page.keyboard.press('Control+v');
  await expect(
    page.locator('.jdr-toast--info', { hasText: '2행 × 2열을 붙여넣었습니다' }),
  ).toBeVisible();
  await expect(rowCount(page)).toHaveText('행 2개');

  // 빈 행에 걸친 선택의 복사는 빈 행을 빈 칸으로 낸다(D-16). 그것을 빈 행에 붙여넣으면 값이 든 줄만 행이 되고
  // 끝의 빈 줄은 버린다.
  await cell(page, 0, 0).click();
  await cell(page, 3, 1).click({ modifiers: ['Shift'] });
  await page.keyboard.press('Control+c');
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe('x1\t\nx2\t\n\t\n\t');
  await cell(page, 2, 0).click();
  await page.keyboard.press('Control+v');
  await expect(rowCount(page)).toHaveText('행 4개');
  expect(await rowsOf(page, ['글', '수'])).toEqual([
    [1, 'x1', null],
    [2, 'x2', null],
    [3, 'x1', null],
    [4, 'x2', null],
  ]);
  // 값이 든 줄 사이의 빈 줄은 자리를 지키므로 행이 된다.
  await page.evaluate(() => navigator.clipboard.writeText('a\n\nb\n\n'));
  await cell(page, 4, 0).click();
  await page.keyboard.press('Control+v');
  await expect(rowCount(page)).toHaveText('행 7개');
  expect((await rowsOf(page, ['글'])).slice(4)).toEqual([
    [5, 'a'],
    [6, null],
    [7, 'b'],
  ]);

  // 행이 없는 테이블의 Ctrl+A는 첫 칸만 고른다(빈 행을 고르지 않는다).
  await createTableWith(page, '빈 표', [{ name: '글', type: 'text' }]);
  await expect(rowCount(page)).toHaveText('행 0개');
  await cell(page, 3, 0).click();
  await page.keyboard.press('Control+a');
  await expect(page.locator('.jdr-grid__cell--active')).toHaveCount(1);
  await expect(page.locator('.jdr-grid__row[data-row="0"] .jdr-grid__cell--active')).toHaveCount(1);
  await expect(page.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(1);
});

test('"+ 열" 이름 편집기에 입력한 채 도구 모음의 되돌리기: 열이 사라지고 다시 실행하면 이름까지 돌아온다', async ({
  page,
}) => {
  await createTableWith(page, '표', [{ name: '열 1', type: 'text' }]);
  await page.click('[data-action="column-add"]');
  const editor = page.locator('.jdr-grid__hrename');
  await expect(editor).toBeFocused();
  await page.keyboard.type('memo');
  // 버튼의 pointerdown이 포커스 이탈 확정을 시작하고 click이 되돌리기를 부른다(리뷰 N2).
  await page.click('[data-action="undo"]');
  await expect(headerCell(page, 'memo')).toHaveCount(0);
  await expect(headerCell(page, '열 2')).toHaveCount(0);
  await expect(page.locator('[data-action="redo"]')).toBeEnabled();
  await page.click('[data-action="redo"]');
  await expect(headerCell(page, 'memo')).toHaveCount(1);
  await expect(page.locator('[data-action="redo"]')).toBeDisabled();
});

test('빈 행의 장문 편집기가 열린 사이 그 자리에 행이 생기면, 확정은 그 행의 셀 편집으로 저장된다', async ({
  page,
}) => {
  await createTableWith(page, '메모', [
    { name: '제목', type: 'text' },
    { name: '본문', type: 'longtext' },
  ]);
  await cell(page, 0, 1).dblclick();
  const panel = page.locator('.jdr-longtext');
  await expect(panel).toBeVisible();
  await panel.locator('textarea').fill('긴 글 내용');
  // 편집기를 연 채로 세 번째 빈 행에 입력해 첫 줄까지 행을 만든다.
  await cell(page, 2, 0).click();
  await page.keyboard.type('x');
  await page.keyboard.press('Enter');
  await expect(rowCount(page)).toHaveText('행 3개');
  // 확정: 패널이 멈추지 않고 1행의 본문에 저장된다(리뷰 N3).
  await panel.locator('[data-action="longtext-save"]').click();
  await expect(panel).toBeHidden();
  await expect(rowCount(page)).toHaveText('행 3개');
  expect(await rowsOf(page, ['제목', '본문'])).toEqual([
    [1, null, '긴 글 내용'],
    [2, null, null],
    [3, 'x', null],
  ]);
  // 되돌리기 한 번은 그 셀 편집만 되돌린다.
  await page.click('[data-action="undo"]');
  await expect.poll(async () => (await rowsOf(page, ['본문']))[0]).toEqual([1, null]);
  await expect(rowCount(page)).toHaveText('행 3개');
});

test('빈 행 편집 중 정렬 버튼을 누르면 포커스 이탈 확정이 행을 만들고, "저장되지 않았다"고 알리지 않는다', async ({
  page,
}) => {
  await createTableWith(page, '정렬', [
    { name: '글', type: 'text' },
    { name: '수', type: 'integer' },
  ]);
  // 토스트는 몇 초 뒤 사라지므로 나타난 문구를 모두 모아 둔다(사라질 때까지 기다리는 검사로는 잡지 못한다).
  await page.evaluate(() => {
    const w = /** @type {{ __toastLog?: string[] }} */ (/** @type {unknown} */ (window));
    const log = /** @type {string[]} */ ([]);
    w.__toastLog = log;
    new MutationObserver((records) => {
      for (const r of records) {
        for (const node of r.addedNodes) {
          if (node instanceof HTMLElement && node.matches('.jdr-toast')) {
            log.push(node.textContent ?? '');
          }
        }
      }
    }).observe(document.body, { childList: true, subtree: true });
  });
  await cell(page, 2, 0).click();
  await page.keyboard.type('hello');
  await headerCell(page, '글').locator('[data-hbtn="sort"]').click();
  await expect(rowCount(page)).toHaveText('행 3개');
  expect(await rowsOf(page, ['글'])).toEqual([
    [1, null],
    [2, null],
    [3, 'hello'],
  ]);
  // 확정은 저장되었다. 빈 행의 입력을 버렸다는 안내가 나오면 사용자가 다시 입력해 행이 겹친다(리뷰 N4).
  await expect(page.locator('.jdr-editor')).toBeHidden();
  const toasts = await page.evaluate(
    () =>
      /** @type {{ __toastLog?: string[] }} */ (/** @type {unknown} */ (window)).__toastLog ?? [],
  );
  expect(toasts.filter((text) => text.includes('빈 행의 입력을 닫았습니다'))).toEqual([]);
});
