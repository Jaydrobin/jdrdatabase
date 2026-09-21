// @ts-check
/**
 * Step 5 E2E: 편집. 인라인 편집(한글 IME 시뮬레이션, 타이핑 시작, 검증 실패, 취소, 다른 곳 클릭),
 * 불리언 토글, 되돌리기·다시 실행(셀·스키마, 단축키·버튼), 1,000 × 20 TSV 붙여넣기 → 되돌리기 →
 * 다시 실행, 행 추가·삭제, 범위 지우기, 장문 편집기, 복사. 실제 산출물(`file://`)에서 확인한다.
 * 클립보드는 컨텍스트에 권한을 주고 실제 Ctrl+C·Ctrl+V로 검사한다.
 */
import { expect, test } from '@playwright/test';
import { delayTransport } from './delay-transport.js';
import { PAGE_URL } from './page-url.js';

/**
 * @typedef {object} TestHook
 * @property {() => { tables: Array<{ id: string, name: string, columns: Array<{ id: string, name: string }> }>, dirty: boolean } | null} state
 * @property {(cmd: unknown) => Promise<{ affected: number }>} apply
 * @property {(sql: string) => Promise<{ columns: string[], rows: unknown[][] }>} query
 * @property {() => { undo: number, redo: number, busy: boolean } | null} history
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
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
async function createTable(page, name) {
  await page.click('[data-action="table-create"]');
  await page.locator('.jdr-dialog input').fill(name);
  await page.locator('.jdr-dialog').getByRole('button', { name: '만들기' }).click();
  await expect(page.locator('.jdr-grid__empty')).toHaveText(
    '열이 없습니다. 사이드바의 "+ 열"로 추가하세요.',
  );
}

/**
 * 텍스트·정수·장문·불리언 열과 행 20개.
 * @param {import('@playwright/test').Page} page
 */
async function seed(page) {
  await createTable(page, '고객');
  await addColumn(page, '이름', '텍스트');
  await addColumn(page, '나이', '정수');
  await addColumn(page, '본문', '장문');
  await addColumn(page, '활성', '참/거짓');
  const state = await hook(page).state();
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
  return { table, name, age, body, active };
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {number} row
 * @param {number} col
 */
function cell(page, row, col) {
  return page.locator(`.jdr-grid__row[data-row="${row}"] .jdr-grid__cell[data-col="${col}"]`);
}

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1400, height: 720 });
  await page.addInitScript(delayTransport);
  await page.goto(PAGE_URL);
  await expect(page.locator('.jdr-statusbar__item').first()).toHaveText('준비됨');
});

test('인라인 편집: 한글 IME 시뮬레이션으로 확정, 조합 중의 Enter는 확정하지 않는다', async ({
  page,
}) => {
  await seed(page);
  await cell(page, 0, 0).click();
  await page.keyboard.press('Enter');
  const input = page.locator('.jdr-editor input');
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('이름1');
  await expect(input).toBeFocused();

  // 조합 시작 → 글자 삽입 → 조합 중의 Enter(isComposing) → 편집기 유지 → 조합 끝 → Enter → 확정.
  await input.fill('');
  await input.dispatchEvent('compositionstart');
  await page.keyboard.insertText('한');
  await input.evaluate((el) => {
    el.dispatchEvent(
      new KeyboardEvent('keydown', {
        key: 'Enter',
        isComposing: true,
        bubbles: true,
        cancelable: true,
      }),
    );
  });
  await expect(input).toBeVisible();
  await page.keyboard.insertText('글');
  await input.dispatchEvent('compositionend');
  await expect(input).toHaveValue('한글');
  await page.keyboard.press('Enter');
  await expect(page.locator('.jdr-editor')).toBeHidden();
  await expect(cell(page, 0, 0)).toHaveText('한글');
  // Enter 확정은 커서를 한 칸 아래로 옮기고 포커스는 그리드로 돌아온다.
  await expect(page.locator('.jdr-grid__cell--active')).toHaveText('이름2');
  await expect(page.locator('.jdr-grid__scroller')).toBeFocused();
  await expect(page.locator('.jdr-toolbar__dirty')).toHaveText('●');
  const rows = await hook(page).query(
    `SELECT count(*) FROM "${(await hook(page).state())?.tables[0]?.id}" WHERE "_updated_at" IS NOT NULL`,
  );
  expect(rows.rows[0]?.[0]).toBe(1);
});

test('타이핑으로 편집 시작, 검증 실패는 편집기를 유지, Esc는 취소, 다른 곳 클릭은 확정 시도 후 되돌림', async ({
  page,
}) => {
  await seed(page);
  await cell(page, 1, 1).click();
  await expect(page.locator('.jdr-grid__cell--active')).toHaveText('6');
  // 셀에서 바로 타이핑: 첫 글자가 초기값이 된다.
  await page.keyboard.type('42');
  const input = page.locator('.jdr-editor input');
  await expect(input).toHaveValue('42');
  await page.keyboard.press('Enter');
  await expect(cell(page, 1, 1)).toHaveText('42');

  // 정수 열에 문자: 편집기가 닫히지 않고 오류가 보인다.
  await cell(page, 2, 1).click();
  await page.keyboard.type('abc');
  await page.keyboard.press('Enter');
  await expect(input).toBeVisible();
  await expect(page.locator('.jdr-editor__error')).toHaveText('정수가 아닙니다.');
  await expect(input).toHaveAttribute('aria-invalid', 'true');
  await page.keyboard.press('Escape');
  await expect(page.locator('.jdr-editor')).toBeHidden();
  await expect(cell(page, 2, 1)).toHaveText('9');

  // 잘못된 값을 둔 채 다른 곳 클릭: 원래 값으로 되돌리고 알린다.
  await cell(page, 3, 1).click();
  await page.keyboard.type('x');
  await cell(page, 5, 0).click();
  await expect(page.locator('.jdr-editor')).toBeHidden();
  await expect(cell(page, 3, 1)).toHaveText('12');
  await expect(page.locator('.jdr-toast--info')).toContainText('원래 값으로 되돌렸습니다');

  // 올바른 값을 둔 채 다른 곳 클릭: 확정된다.
  await cell(page, 4, 1).click();
  await page.keyboard.type('77');
  await cell(page, 6, 0).click();
  await expect(cell(page, 4, 1)).toHaveText('77');

  // 불리언은 Enter로 뒤집는다.
  await expect(cell(page, 0, 3)).toHaveText('✓');
  await cell(page, 0, 3).click();
  await page.keyboard.press('Enter');
  await expect(cell(page, 0, 3)).toHaveText('✗');
});

test('되돌리기·다시 실행: 셀 편집과 열 추가를 단축키와 버튼으로', async ({ page }) => {
  await seed(page);
  await cell(page, 0, 0).click();
  await page.keyboard.type('changed');
  await page.keyboard.press('Enter');
  await expect(cell(page, 0, 0)).toHaveText('changed');
  expect(await hook(page).history()).toEqual({ undo: 1, redo: 0, busy: false });

  await page.keyboard.press('Control+z');
  await expect(cell(page, 0, 0)).toHaveText('이름1');
  expect(await hook(page).history()).toEqual({ undo: 0, redo: 1, busy: false });
  await page.keyboard.press('Control+y');
  await expect(cell(page, 0, 0)).toHaveText('changed');

  // 스키마 커맨드(열 추가)도 히스토리에 들어온다.
  await addColumn(page, '비고', '텍스트');
  await expect(page.locator('.jdr-grid__hcell[data-col="4"]')).toHaveText('비고');
  await page.click('[data-action="undo"]');
  await expect(page.locator('.jdr-grid__hcell[data-col="4"]')).toHaveCount(0);
  await expect(page.locator('.jdr-sidebar__column-name', { hasText: '비고' })).toHaveCount(0);
  await page.click('[data-action="redo"]');
  await expect(page.locator('.jdr-grid__hcell[data-col="4"]')).toHaveText('비고');
  await expect(page.locator('[data-action="redo"]')).toBeDisabled();
  await expect(page.locator('[data-action="undo"]')).toBeEnabled();
});

test('1,000 × 20 TSV 붙여넣기 → 되돌리기 → 다시 실행', async ({ page }) => {
  test.setTimeout(120_000);
  await createTable(page, '표');
  for (let i = 0; i < 20; i += 1) await addColumn(page, `열${i + 1}`, '텍스트');
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 0개');

  const tsv = Array.from({ length: 1000 }, (_, r) =>
    Array.from({ length: 20 }, (__, c) => `값${r + 1}-${c + 1}`).join('\t'),
  ).join('\n');
  await page.evaluate((text) => navigator.clipboard.writeText(text), tsv);

  await page.locator('.jdr-grid__scroller').focus();
  await page.keyboard.press('Control+v');
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 1,000개');
  await expect(cell(page, 0, 0)).toHaveText('값1-1');
  await page.locator('.jdr-grid__scroller').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
    el.scrollLeft = el.scrollWidth;
  });
  await expect(cell(page, 999, 19)).toHaveText('값1000-20');
  await expect(page.locator('.jdr-toast--info').last()).toContainText('1,000행 × 20열');
  // 테이블 생성 1건 + 열 추가 20건 + 붙여넣기 1건.
  expect(await hook(page).history()).toEqual({ undo: 22, redo: 0, busy: false });

  await page.keyboard.press('Control+z');
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 0개');
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 1,000개');
  await expect(cell(page, 0, 19)).toHaveText('값1-20');
  const state = await hook(page).state();
  const table = state?.tables[0];
  const count = await hook(page).query(`SELECT count(*), min("id"), max("id") FROM "${table?.id}"`);
  expect(count.rows[0]).toEqual([1000, 1, 1000]);
});

test('붙여넣기: 기존 행 덮어쓰기 + 경계 밖 행 자동 추가 + 넘치는 열은 버리고 안내, 잘못된 값은 전체 거부', async ({
  page,
}) => {
  await seed(page);
  // 19번째 행, 두 번째 열부터 3행 × 5열: 열은 2개가 넘치고 행은 1개가 새로 생긴다.
  await cell(page, 18, 1).click();
  await page.evaluate(() =>
    navigator.clipboard.writeText('1\t본문A\t1\tx\ty\n2\t본문B\t0\tx\ty\n3\t본문C\t1\tx\ty'),
  );
  await page.keyboard.press('Control+v');
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 21개');
  await expect(cell(page, 18, 1)).toHaveText('1');
  await expect(cell(page, 19, 2)).toHaveText('본문B');
  await expect(cell(page, 20, 1)).toHaveText('3');
  await expect(cell(page, 20, 2)).toHaveText('본문C');
  await expect(cell(page, 20, 3)).toHaveText('✓');
  await expect(page.locator('.jdr-toast--info', { hasText: '열 2개가' })).toBeVisible();
  // 붙여넣은 범위(3 × 3, 활성 셀 제외)와 그 행 번호 칸이 선택 표시된다.
  await expect(page.locator('.jdr-grid__cell--selected')).toHaveCount(3 * 3 - 1 + 3);

  // 정수 열에 문자가 든 붙여넣기는 아무것도 바꾸지 않는다.
  await cell(page, 0, 1).click();
  await page.evaluate(() => navigator.clipboard.writeText('10\n둘\n30'));
  await page.keyboard.press('Control+v');
  await expect(page.locator('.jdr-toast--error')).toContainText('E_VALUE_INVALID');
  await expect(page.locator('.jdr-toast--info', { hasText: '2번째 행의 "나이" 열' })).toBeVisible();
  await expect(cell(page, 0, 1)).toHaveText('3');
  await expect(cell(page, 2, 1)).toHaveText('9');

  // 앵커가 첫 행이 아니면 알리는 행 번호도 그리드의 행 번호여야 한다. 붙여넣기 데이터 안에서의
  // 순번을 그대로 쓰면(2번째 행) 사용자가 그리드에서 그 행을 찾을 수 없다.
  await cell(page, 5, 1).click();
  await page.evaluate(() => navigator.clipboard.writeText('10\n둘\n30'));
  await page.keyboard.press('Control+v');
  await expect(page.locator('.jdr-toast--info', { hasText: '7번째 행의 "나이" 열' })).toBeVisible();
  await expect(cell(page, 5, 1)).toHaveText('18');
});

test('행 추가·행 삭제·범위 지우기와 되돌리기', async ({ page }) => {
  await seed(page);
  await page.click('[data-action="row-insert"]');
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 21개');
  await expect(cell(page, 20, 0)).toHaveText('');
  await expect(page.locator('.jdr-grid__cell--active').locator('..')).toHaveAttribute(
    'data-row',
    '20',
  );

  // 행 번호 클릭 + Shift 클릭으로 행 2~4를 고르고 삭제한다.
  await page.locator('.jdr-grid__row[data-row="1"] .jdr-grid__cell--rownum').click();
  await page
    .locator('.jdr-grid__row[data-row="3"] .jdr-grid__cell--rownum')
    .click({ modifiers: ['Shift'] });
  await expect(page.locator('.jdr-grid__cell--rownum.jdr-grid__cell--selected')).toHaveCount(3);
  await page.click('[data-action="row-delete"]');
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 18개');
  await expect(cell(page, 1, 0)).toHaveText('이름5');
  await page.keyboard.press('Control+z');
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 21개');
  await expect(cell(page, 1, 0)).toHaveText('이름2');
  await expect(cell(page, 3, 0)).toHaveText('이름4');

  // Shift+화살표로 범위를 넓히고 Delete로 비운다.
  await cell(page, 0, 0).click();
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(page.locator('.jdr-grid__cell--selected')).toHaveCount(3 + 2);
  await page.keyboard.press('Delete');
  await expect(cell(page, 0, 0)).toHaveText('');
  await expect(cell(page, 1, 1)).toHaveText('');
  await expect(cell(page, 2, 0)).toHaveText('이름3');
  await page.keyboard.press('Control+z');
  await expect(cell(page, 0, 0)).toHaveText('이름1');
  await expect(cell(page, 1, 1)).toHaveText('6');
});

test('장문 편집기: 전문을 읽어 열고 확정하면 미리보기가 바뀌며, 행이 삭제되면 닫힌다', async ({
  page,
}) => {
  await seed(page);
  // 2행의 본문은 1,600자라 그리드에는 256자 + 배지만 보인다.
  await expect(cell(page, 1, 2).locator('.jdr-grid__badge')).toHaveText('1,600자');
  await cell(page, 1, 2).dblclick();
  const panel = page.locator('.jdr-longtext');
  await expect(panel).toBeVisible();
  const textarea = panel.locator('textarea');
  await expect(textarea).toBeFocused();
  expect((await textarea.inputValue()).length).toBe(1600);
  await expect(panel.locator('.jdr-longtext__where')).toHaveText('고객 · 본문 · 2행');

  await textarea.fill('새 본문');
  await panel.locator('[data-action="longtext-save"]').click();
  await expect(panel).toBeHidden();
  await expect(cell(page, 1, 2)).toHaveText('새 본문');
  await expect(cell(page, 1, 2).locator('.jdr-grid__badge')).toHaveCount(0);
  await page.keyboard.press('Control+z');
  await expect(cell(page, 1, 2).locator('.jdr-grid__badge')).toHaveText('1,600자');

  // 열어 둔 채로 그 행을 지우면 편집기가 닫히고 안내한다.
  await cell(page, 4, 2).dblclick();
  await expect(panel).toBeVisible();
  await page.locator('.jdr-grid__row[data-row="4"] .jdr-grid__cell--rownum').click();
  await page.click('[data-action="row-delete"]');
  await expect(panel).toBeHidden();
  await expect(
    page.locator('.jdr-toast--info', { hasText: '편집하던 행이 삭제되어' }),
  ).toBeVisible();

  // 짧은 텍스트 셀은 인라인 편집기가 전문을 그대로 연다.
  await cell(page, 0, 2).click();
  await page.keyboard.press('F2');
  await expect(page.locator('.jdr-longtext')).toBeVisible();
  await expect(page.locator('.jdr-longtext textarea')).toHaveValue('짧은 글 1');
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
});

test('복사: 범위를 Ctrl+C로 복사하면 클립보드에 TSV가 들어간다', async ({ page }) => {
  await seed(page);
  await cell(page, 0, 0).click();
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Control+c');
  await expect(page.locator('.jdr-toast--info', { hasText: '2행 × 2열을 복사' })).toBeVisible();
  const text = await page.evaluate(() => navigator.clipboard.readText());
  expect(text).toBe('이름1\t3\n이름2\t6');
});

test('붙여넣기는 선택 범위의 왼쪽 위에서 시작한다(복사한 자리에 그대로 붙여넣기)', async ({
  page,
}) => {
  await seed(page);
  // 아래로 끌어 고른 범위는 활성 셀이 오른쪽 아래에 있다. 붙여넣기가 활성 셀에서 시작하면
  // 복사한 범위를 그 자리에 다시 붙여넣는 것만으로 값이 한 칸 밀리고 행이 늘어난다.
  await cell(page, 0, 0).click();
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Control+c');
  await expect(page.locator('.jdr-toast--info', { hasText: '2행 × 1열을 복사' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('이름1\n이름2');

  await page.keyboard.press('Control+v');
  await expect(
    page.locator('.jdr-toast--info', { hasText: '2행 × 1열을 붙여넣었습니다' }),
  ).toBeVisible();
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 20개');
  await expect(cell(page, 0, 0)).toHaveText('이름1');
  await expect(cell(page, 1, 0)).toHaveText('이름2');
  await expect(cell(page, 2, 0)).toHaveText('이름3');

  // Ctrl+A로 고른 범위도 마찬가지로 첫 행·첫 열에서 시작한다.
  await page.keyboard.press('Control+a');
  await page.keyboard.press('Control+v');
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 20개');
  await expect(cell(page, 0, 0)).toHaveText('이름1');
  await expect(cell(page, 1, 0)).toHaveText('이름2');
});

test('접근성: 선택한 범위의 칸이 aria-selected로 드러난다', async ({ page }) => {
  await seed(page);
  const grid = page.locator('[role="grid"]');
  await expect(grid).toHaveAttribute('aria-multiselectable', 'true');

  await cell(page, 0, 0).click();
  await expect(page.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(1);

  // 2행 × 2열로 넓히면 네 칸 모두 선택된 것으로 노출된다(활성 셀 포함).
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowRight');
  await expect(page.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(4);
  await expect(cell(page, 1, 1)).toHaveAttribute('aria-selected', 'true');
  await expect(cell(page, 2, 0)).not.toHaveAttribute('aria-selected', 'true');

  // 범위를 셀 하나로 줄이면 다시 하나만 남는다.
  await page.keyboard.press('Escape');
  await expect(page.locator('[role="gridcell"][aria-selected="true"]')).toHaveCount(1);
});

test('편집기는 고정 열에서도 셀을 따라간다(가로 스크롤·열 너비 변경)', async ({ page }) => {
  await page.setViewportSize({ width: 700, height: 600 });
  const { table } = await seed(page);
  // 첫 열을 고정하면 그 칸은 가로 스크롤에도 왼쪽에 남는다. 편집기는 열 때 잰 캔버스 좌표에
  // 머물러 있었으므로 캔버스와 함께 밀려나 편집 중인 칸에서 떨어졌다(실측 300 px).
  await page.locator('.jdr-grid__frozen-select').selectOption('1');
  await cell(page, 0, 0).click();
  await page.keyboard.press('Enter');
  const editor = page.locator('.jdr-editor');
  await expect(editor).toBeVisible();

  /** 편집기와 편집 중인 칸의 x 좌표 차이. */
  const gap = async () => {
    const e = await editor.boundingBox();
    const c = await cell(page, 0, 0).boundingBox();
    if (!e || !c) throw new Error('box missing');
    return Math.abs(e.x - c.x);
  };
  expect(await gap()).toBeLessThan(2);

  await page.locator('.jdr-grid__scroller').evaluate((el) => {
    el.scrollLeft = 300;
  });
  await expect.poll(gap).toBeLessThan(2);
  await expect(editor).toBeVisible();

  // 확정하면 고정 열의 그 칸에 값이 들어간다.
  await editor.locator('input').fill('고정편집');
  await page.keyboard.press('Enter');
  await expect(cell(page, 0, 0)).toHaveText('고정편집');
  const rows = await hook(page).query(`SELECT count(*) FROM "${table.id}" WHERE "id" = 1`);
  expect(rows.rows[0][0]).toBe(1);
});

test('낡은 블록의 셀은 전문을 읽고 연다(되돌린 값이 다시 적용되지 않는다)', async ({ page }) => {
  const { table, name } = await seed(page);
  const cellValue = async () =>
    (await hook(page).query(`SELECT "${name}" FROM "${table.id}" WHERE "id" = 1`)).rows[0][0];

  // 셀을 고친다. 단일 셀 편집은 캐시를 직접 고치므로(patchCell) 블록이 낡지 않는다.
  await cell(page, 0, 0).click();
  await page.keyboard.press('Enter');
  await page.locator('.jdr-editor input').fill('바뀐값');
  await page.keyboard.press('Enter');
  await expect(cell(page, 0, 0)).toHaveText('바뀐값');
  expect(await cellValue()).toBe('바뀐값');

  // 되돌리기는 `markStale`로 블록을 낡게 만들고 다시 읽는다. 그 다시 읽기를 늦춰
  // "DB는 이미 옛 값인데 화면은 아직 새 값"인 구간을 결정적으로 만든다.
  await page.evaluate(() => {
    /** @type {import('./delay-transport.js').DelayWindow} */ (
      /** @type {unknown} */ (window)
    ).__jdrDelayOp = { op: 'query.window', ms: 4000 };
  });
  await page.keyboard.press('Control+z');
  await expect.poll(cellValue).toBe('이름1');
  await expect(cell(page, 0, 0)).toHaveText('바뀐값', { timeout: 1000 });

  // 이 구간에서 편집기를 열면 캐시의 '바뀐값'이 아니라 DB의 '이름1'이 실려야 한다.
  await cell(page, 0, 0).click();
  await page.keyboard.press('Enter');
  const input = page.locator('.jdr-editor input');
  await expect(input).toBeVisible();
  await expect(input).toHaveValue('이름1');

  // 아무것도 고치지 않고 확정하면 아무 일도 일어나지 않는다(되돌리기가 유지된다).
  const before = await hook(page).history();
  await page.keyboard.press('Enter');
  await expect(input).toBeHidden();
  expect(await cellValue()).toBe('이름1');
  expect(await hook(page).history()).toEqual(before);
});
