// @ts-check
/**
 * Step 10 접근성: axe(WCAG 2.1 A·AA)를 빈 앱, 그리드, 대화상자들, 장문·인라인 편집기에서 돌려
 * critical·serious 위반 0건을 확인한다(완료 기준은 critical 0건. serious는 명도 대비·ARIA 오용이라 함께 0으로 둔다).
 * moderate·minor는 판정하지 않고 출력만 한다. 그 밖에 그리드의 ARIA 속성, 대화상자 포커스 트랩, 키보드 포커스
 * 가시성(활성 셀 외곽선)을 직접 확인한다.
 */
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { PAGE_URL } from './page-url.js';
import { createTableWith, headerCell } from './schema-ui.js';

const FIXTURES = path.resolve('test/fixtures/import');
const TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'];

/**
 * @typedef {object} TestHook
 * @property {() => { tables: Array<{ id: string, name: string, columns: Array<{ id: string, name: string }> }> } | null} state
 * @property {(cmd: unknown) => Promise<{ affected: number }>} apply
 */

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} screen
 */
async function audit(page, screen) {
  const result = await new AxeBuilder({ page }).withTags(TAGS).analyze();
  const blocking = result.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  );
  const rest = result.violations.filter((v) => !blocking.includes(v));
  if (rest.length > 0) {
    console.log(
      `[a11y] ${screen}: ${rest.map((v) => `${v.impact} ${v.id} ×${v.nodes.length}`).join(', ')}`,
    );
  }
  expect(
    blocking.map((v) => ({
      id: v.id,
      impact: v.impact,
      nodes: v.nodes.map((n) => n.target.join(' ')),
    })),
    `${screen}: critical·serious 위반`,
  ).toEqual([]);
}

/**
 * 텍스트·정수·장문·불리언 열과 행 20개(edit.spec.js와 같은 표본).
 * @param {import('@playwright/test').Page} page
 */
async function seed(page) {
  await createTableWith(page, '고객', [
    { name: '이름', type: 'text' },
    { name: '나이', type: 'integer' },
    { name: '본문', type: 'longtext' },
    { name: '활성', type: 'boolean' },
  ]);
  const state = await page.evaluate(() =>
    /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.state(),
  );
  const table = state?.tables[0];
  if (!table) throw new Error('table missing');
  const [name, age, body, active] = table.columns.map((c) => c.id);
  const sql = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 20) INSERT INTO "${table.id}" ("id", "${name}", "${age}", "${body}", "${active}") SELECT i, '이름' || i, i * 3, CASE WHEN i = 2 THEN replace(hex(zeroblob(400)), '00', '가나다라') ELSE '짧은 글 ' || i END, i % 2 FROM n`;
  await page.evaluate(
    (statement) =>
      /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.apply({
        type: 'test.insert',
        tableId: null,
        do: [{ sql: statement }],
        undo: [],
        summary: 'seed',
      }),
    sql,
  );
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 20개');
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} row
 * @param {number} col
 */
function cell(page, row, col) {
  return page.locator(`.jdr-grid__row[data-row="${row}"] .jdr-grid__cell[data-col="${col}"]`);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 720 });
  await page.addInitScript(() => {
    const w = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window));
    delete w.showOpenFilePicker;
    delete w.showSaveFilePicker;
  });
  await page.goto(PAGE_URL);
  await expect(page.locator('.jdr-statusbar__item').first()).toHaveText('준비됨');
});

test('axe: 빈 앱, 테이블 만들기 대화상자, 그리드, 타입 변경·정렬·필터·내보내기·설정 대화상자, 장문·인라인 편집기', async ({
  page,
}) => {
  await audit(page, '빈 앱');

  await page.click('[data-action="table-create"]');
  await expect(page.locator('.jdr-dialog')).toBeVisible();
  await audit(page, '테이블 만들기 대화상자');
  await page.keyboard.press('Escape');
  await expect(page.locator('.jdr-dialog')).toHaveCount(0);

  await seed(page);
  await cell(page, 0, 0).click();
  await audit(page, '그리드(활성 셀 있음)');

  /** @type {Array<[string, string]>} */
  const dialogs = [
    // 열 추가는 대화상자가 없다(D-16). 타입 변경 대화상자에는 선택 항목의 예시·설명 줄이 있다.
    ['column-type', '타입 변경'],
    ['sort', '정렬'],
    ['filter', '필터'],
    ['export', '내보내기'],
    ['settings', '설정'],
  ];
  for (const [action, label] of dialogs) {
    await page.locator(`[data-action="${action}"]`).first().click();
    await expect(page.locator('.jdr-dialog')).toBeVisible();
    await audit(page, `${label} 대화상자`);
    await page.keyboard.press('Escape');
    await expect(page.locator('.jdr-dialog')).toHaveCount(0);
  }

  // 장문 편집기(사이드 패널)
  await cell(page, 1, 2).dblclick();
  await expect(page.locator('.jdr-longtext')).toBeVisible();
  await audit(page, '장문 편집기');
  await page.keyboard.press('Escape');

  // 인라인 편집기
  await cell(page, 0, 0).click();
  await page.keyboard.press('Enter');
  await expect(page.locator('.jdr-editor input')).toBeVisible();
  await audit(page, '인라인 편집기');
  await page.keyboard.press('Escape');
});

test('axe: 가져오기 대화상자(미리보기·열 매핑 표)와 가져오기 결과', async ({ page }) => {
  await page.locator('input.jdr-import-input').setInputFiles(path.join(FIXTURES, 'types.csv'));
  const dialog = page.locator('.jdr-dialog');
  await expect(dialog.locator('table[data-role="preview"]')).toBeVisible();
  await audit(page, '가져오기 대화상자');
  await dialog.getByRole('button', { name: '가져오기' }).click();
  await expect(dialog.locator('.jdr-dialog__title')).toHaveText('가져오기 결과');
  await audit(page, '가져오기 결과');
  await dialog.getByRole('button', { name: '확인' }).click();
  await expect(page.locator('.jdr-dialog')).toHaveCount(0);
  await audit(page, '가져온 테이블 그리드');
});

test('그리드 ARIA: role=grid, aria-rowcount·aria-colcount, 활성 셀 aria-selected, 키보드 포커스 외곽선', async ({
  page,
}) => {
  await seed(page);
  const grid = page.locator('[role="grid"]');
  // 머리글 1 + 실제 행 20 + 빈 행 30(D-16).
  await expect(grid).toHaveAttribute('aria-rowcount', '51');
  await expect(grid).toHaveAttribute('aria-colcount', '5');
  await expect(grid).toHaveAttribute('aria-label', /.+/);
  await cell(page, 2, 1).click();
  await expect(cell(page, 2, 1)).toHaveAttribute('aria-selected', 'true');
  await expect(cell(page, 2, 1)).toHaveAttribute('aria-colindex', '3');
  await expect(page.locator('.jdr-grid__row[data-row="2"]')).toHaveAttribute('aria-rowindex', '4');
  await page.keyboard.press('ArrowDown');
  await expect(cell(page, 3, 1)).toHaveAttribute('aria-selected', 'true');
  await expect(cell(page, 2, 1)).not.toHaveAttribute('aria-selected', 'true');

  // 키보드로 포커스가 옮겨 오면(:focus-visible) 활성 셀에 외곽선이 보인다. 상태바 → Shift+Tab 등 경로와 무관하게
  // 키보드 이벤트 뒤의 포커스는 focus-visible이다.
  await page.keyboard.press('ArrowUp');
  const outline = await cell(page, 2, 1).evaluate((el) => {
    const style = getComputedStyle(el);
    return { width: style.outlineWidth, style: style.outlineStyle };
  });
  expect(outline.style).not.toBe('none');
  expect(Number.parseFloat(outline.width)).toBeGreaterThanOrEqual(2);
});

test('대화상자: 포커스 트랩(Tab이 안에서 순환), Esc로 닫히고 포커스가 여는 요소로 돌아온다', async ({
  page,
}) => {
  await seed(page);
  const opener = page.locator('[data-action="table-create"]');
  await opener.focus();
  await page.keyboard.press('Enter');
  const dialog = page.locator('.jdr-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog).toHaveAttribute('aria-modal', 'true');
  await expect(dialog).toHaveAttribute('aria-labelledby', /.+/);
  await expect(dialog.locator('input').first()).toBeFocused();

  const focusable = await dialog.evaluate(
    (el) =>
      el.querySelectorAll(
        'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])',
      ).length,
  );
  // 요소 수만큼 Tab을 누르면 처음으로 돌아온다. 그 사이의 포커스는 모두 대화상자 안이다.
  for (let i = 0; i < focusable; i += 1) {
    await page.keyboard.press('Tab');
    const inside = await page.evaluate(
      () => document.activeElement?.closest('.jdr-dialog') !== null,
    );
    expect(inside, `Tab ${i + 1}번째 포커스가 대화상자 밖`).toBe(true);
  }
  await expect(dialog.locator('input').first()).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  const last = await page.evaluate(() => document.activeElement?.closest('.jdr-dialog') !== null);
  expect(last).toBe(true);

  await page.keyboard.press('Escape');
  await expect(page.locator('.jdr-dialog')).toHaveCount(0);
  await expect(opener).toBeFocused();
});

test('axe(D-16): 열 메뉴·머리글 이름 편집기·빈 행이 열린 상태에서 critical·serious 0건', async ({
  page,
}) => {
  await seed(page);
  // 빈 행이 보이도록 끝으로 내린다.
  await cell(page, 0, 0).click();
  await page.keyboard.press('Control+End');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.jdr-grid__row--ghost').first()).toBeVisible();
  await expect(page.locator('.jdr-grid__row--ghost').first()).toHaveAttribute(
    'aria-label',
    /빈 행/,
  );
  await audit(page, '빈 행');

  await page.keyboard.press('Shift+F10');
  const menu = page.locator('.jdr-menu[role="menu"]');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem').first()).toBeFocused();
  await audit(page, '열 메뉴');
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(page.locator('.jdr-grid__scroller')).toBeFocused();

  await headerCell(page, '나이').locator('.jdr-grid__hname').dblclick();
  const editor = page.locator('.jdr-grid__hrename');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveAttribute('aria-label', '나이 열 이름');
  await audit(page, '머리글 이름 편집기');
  // 검증 실패 문구가 보이는 상태도 검사한다.
  await editor.fill('이름');
  await page.keyboard.press('Enter');
  await expect(page.locator('.jdr-grid__hrename-error')).toHaveText('같은 이름이 이미 있습니다.');
  await audit(page, '머리글 이름 편집기(오류)');
  await page.keyboard.press('Escape');
  await expect(editor).toHaveCount(0);
});
