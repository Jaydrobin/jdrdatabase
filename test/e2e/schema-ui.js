// @ts-check
/**
 * E2E 공용: 테이블·열 만들기(D-16 이후).
 *
 * - "+ 테이블"은 기본 열 30개를 만든다. 특정 열 구성이 필요한 spec(편집·그리드·뷰·가져오기)은 테스트 훅
 *   `__jdrTest.createTable`(스토어의 `createTable`)로 그 열만 가진 테이블을 만든다.
 * - 열을 UI로 더하는 spec은 실제 경로를 쓴다: "+ 열" → 머리글 이름 편집기 → Enter, 타입은 열 메뉴의
 *   "타입 변경…". 타입 변경은 새 물리 열을 만들고 옛 열을 소프트 삭제하므로(4.2) 텍스트가 아닌 열을 UI로
 *   더하면 삭제된 열이 하나 남는다.
 */
import { expect } from '@playwright/test';

/**
 * 논리 타입 → 타입 선택 상자의 문구(ko.js의 `type.*`).
 * @type {Record<string, string>}
 */
export const TYPE_LABELS = {
  text: '텍스트',
  longtext: '장문',
  integer: '정수',
  real: '실수',
  boolean: '참/거짓',
  date: '날짜',
  datetime: '날짜시간',
  select: '선택',
};

/**
 * @typedef {object} ColumnSpec
 * @property {string} name
 * @property {string} type 논리 타입
 * @property {{ choices: string[] }} [options]
 */

/**
 * 훅으로 열을 정해 테이블을 만들고, 사이드바에서 그 테이블이 골라졌는지 확인한다.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {ColumnSpec[]} columns
 */
export async function createTableWith(page, name, columns) {
  await page.evaluate(
    ({ tableName, cols }) =>
      /** @type {{ __jdrTest: { createTable: (n: string, c: unknown) => Promise<string | null> } }} */ (
        /** @type {unknown} */ (window)
      ).__jdrTest.createTable(tableName, cols),
    { tableName: name, cols: columns },
  );
  await expect(page.locator('.jdr-sidebar__table--active .jdr-sidebar__table-name')).toHaveText(
    name,
  );
}

/**
 * "+ 테이블" → 이름 입력 → Enter. 기본 열 30개를 가진 테이블이 만들어진다.
 * @param {import('@playwright/test').Page} page
 * @param {string} [name] 없으면 미리 채운 이름(`테이블 n`)을 그대로 쓴다
 */
export async function createTableUi(page, name) {
  await page.click('[data-action="table-create"]');
  const dialog = page.locator('.jdr-dialog');
  await expect(dialog.locator('.jdr-dialog__title')).toHaveText('새 테이블');
  if (name !== undefined) await dialog.locator('input').fill(name);
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);
}

/**
 * 머리글 칸(이름이 정확히 `name`인 열).
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
export function headerCell(page, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return page
    .locator('.jdr-grid__hcell[data-col]')
    .filter({ has: page.locator('.jdr-grid__hname', { hasText: new RegExp(`^${escaped}$`) }) });
}

/**
 * 그 열의 머리글을 우클릭해 열 메뉴를 연다.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
export async function openColumnMenu(page, name) {
  await headerCell(page, name).click({ button: 'right' });
  const menu = page.locator('.jdr-menu[role="menu"]');
  await expect(menu).toBeVisible();
  return menu;
}

/**
 * 열 메뉴의 "타입 변경…"으로 타입을 바꾼다.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string} typeLabel
 * @param {string[]} [choices]
 */
export async function changeTypeUi(page, name, typeLabel, choices) {
  const menu = await openColumnMenu(page, name);
  await menu.getByRole('menuitem', { name: '타입 변경…' }).click();
  const dialog = page.locator('.jdr-dialog');
  await expect(dialog.locator('.jdr-dialog__title')).toHaveText(`"${name}" 열의 타입 변경`);
  await dialog.locator('select').first().selectOption({ label: typeLabel });
  if (choices) await dialog.locator('textarea').fill(choices.join('\n'));
  await dialog.getByRole('button', { name: '변환' }).click();
  await expect(dialog).toHaveCount(0);
}

/**
 * "+ 열" → 머리글 이름 편집기에 이름 입력 → Enter. 텍스트가 아니면 열 메뉴로 타입을 바꾼다.
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string} [typeLabel] 기본 텍스트
 * @param {string[]} [choices]
 */
export async function addColumnUi(page, name, typeLabel = '텍스트', choices) {
  await page.click('[data-action="column-add"]');
  const editor = page.locator('.jdr-grid__hrename');
  await expect(editor).toBeFocused();
  await editor.fill(name);
  await page.keyboard.press('Enter');
  await expect(editor).toHaveCount(0);
  await expect(headerCell(page, name)).toHaveCount(1);
  if (typeLabel !== '텍스트') await changeTypeUi(page, name, typeLabel, choices);
}
