// @ts-check
/**
 * Step 4 E2E: 가상 그리드(읽기 전용). 테이블·열을 UI로 만들고 행 5,000개를 넣은 뒤,
 * 행 가상화(DOM 행 수 상한), 행 번호, 끝까지 스크롤, 장문 미리보기·길이 배지, 열 너비 조절,
 * 열 고정, 키보드 이동, 빈 상태(열 없음·테이블 삭제)를 실제 산출물(`file://`)에서 확인한다.
 */
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PAGE_URL = pathToFileURL(path.resolve('dist/test/jdrdatabase.html')).href;
const ROWS = 5_000;

/**
 * @typedef {object} TestHook
 * @property {() => { tables: Array<{ id: string, name: string, columns: Array<{ id: string, name: string }> }> } | null} state
 * @property {(cmd: unknown) => Promise<{ affected: number }>} apply
 * @property {() => { renders: number, lastRenderMs: number, queries: number, maxQueryMs: number, rowCount: number, domRows: number } | null} grid
 */

/** @param {import('@playwright/test').Page} page */
function hook(page) {
  return {
    state: () =>
      page.evaluate(() =>
        /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.state(),
      ),
    grid: () =>
      page.evaluate(() =>
        /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.grid(),
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
 * 테이블 하나(텍스트·정수·장문·날짜·불리언)를 만들고 행을 넣는다. 100번째마다 장문 셀이 1,600자다.
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
  await addColumn(page, '가입', '날짜');
  await addColumn(page, '활성', '참/거짓');
  const state = await hook(page).state();
  const table = state?.tables[0];
  if (!table) throw new Error('table missing');
  const [name, age, body, joined, active] = table.columns.map((c) => c.id);
  const sql = `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${ROWS}) INSERT INTO "${table.id}" ("${name}", "${age}", "${body}", "${joined}", "${active}") SELECT '이름' || i, i * 3, CASE WHEN i % 100 = 0 THEN replace(hex(zeroblob(400)), '00', '가나다라') ELSE '짧은 글 ' || i END, '2024-01-01', i % 2 FROM n`;
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
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText(
    `행 ${ROWS.toLocaleString('ko-KR')}개`,
  );
  return table;
}

/** @param {import('@playwright/test').Page} page */
function visibleRows(page) {
  return page.locator('.jdr-grid__row:not([hidden])');
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 720 });
  await page.goto(PAGE_URL);
  await expect(page.locator('.jdr-statusbar__item').first()).toHaveText('준비됨');
  await expect(page.locator('.jdr-grid__empty')).toHaveText(
    '왼쪽에서 테이블을 선택하거나 "+ 테이블"로 만드세요.',
  );
});

test('행 가상화: 5,000행에서 DOM 행은 가시 범위 + 버퍼뿐이고 끝까지 스크롤하면 마지막 행이 보인다', async ({
  page,
}) => {
  await seed(page);
  await expect(visibleRows(page).first()).toBeVisible();
  const domRows = await visibleRows(page).count();
  expect(domRows).toBeGreaterThan(10);
  expect(domRows).toBeLessThan(60);
  await expect(page.locator('.jdr-grid__row[data-row="0"]')).toContainText('1이름13짧은 글 1');
  await expect(page.locator('.jdr-grid__row[data-row="0"] .jdr-grid__cell--rownum')).toHaveText(
    '1',
  );

  // 캔버스 높이는 행 수 × 32 px(스케일링 없음).
  const canvasHeight = await page
    .locator('.jdr-grid__canvas')
    .evaluate((el) => Number.parseFloat(getComputedStyle(el).height));
  expect(canvasHeight).toBe(ROWS * 32);

  await page.locator('.jdr-grid__scroller').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  const last = page.locator(`.jdr-grid__row[data-row="${ROWS - 1}"]`);
  await expect(last).toBeVisible();
  await expect(last.locator('.jdr-grid__cell--rownum')).toHaveText(ROWS.toLocaleString('ko-KR'));
  await expect(last).toContainText(`이름${ROWS}`);
  expect(await visibleRows(page).count()).toBeLessThan(60);
  // 0행 요소는 풀로 돌아가 숨겨졌을 뿐 새로 만들지 않는다(행 풀 재사용).
  await expect(page.locator('.jdr-grid__row[data-row="0"]:not([hidden])')).toHaveCount(0);

  const stats = await hook(page).grid();
  expect(stats?.rowCount).toBe(ROWS);
  // 첫 창과 마지막 창: 블록 캐시 덕에 같은 블록을 두 번 묻지 않는다.
  expect(stats?.queries ?? 0).toBeLessThanOrEqual(4);
});

test('장문 셀은 256자 미리보기 + 말줄임 + 길이 배지', async ({ page }) => {
  await seed(page);
  await page.locator('.jdr-grid__scroller').evaluate((el) => {
    el.scrollTop = 95 * 32;
  });
  const row = page.locator('.jdr-grid__row[data-row="99"]');
  await expect(row).toBeVisible();
  const cell = row.locator('.jdr-grid__cell[data-col="2"]');
  await expect(cell.locator('.jdr-grid__badge')).toHaveText('1,600자');
  const text = await cell.evaluate((el) => el.firstChild?.nodeValue ?? '');
  expect(text.length).toBe(257);
  expect(text.endsWith('…')).toBe(true);
  // 짧은 값에는 배지가 없다.
  await expect(
    page.locator('.jdr-grid__row[data-row="98"] .jdr-grid__cell[data-col="2"] .jdr-grid__badge'),
  ).toHaveCount(0);
  // 타입별 정렬: 정수는 오른쪽, 불리언은 가운데.
  await expect(row.locator('.jdr-grid__cell[data-col="1"]')).toHaveAttribute('data-align', 'right');
  await expect(row.locator('.jdr-grid__cell[data-col="4"]')).toHaveAttribute(
    'data-align',
    'center',
  );
  await expect(row.locator('.jdr-grid__cell[data-col="4"]')).toHaveText('✗');
});

test('열 너비 조절: 머리글 손잡이를 끌면 열과 그 뒤 열의 위치가 바뀌고 스토어 뷰 상태에 남는다', async ({
  page,
}) => {
  await seed(page);
  const header = page.locator('.jdr-grid__hcell[data-col="0"]');
  const before = await header.boundingBox();
  const nextBefore = await page.locator('.jdr-grid__hcell[data-col="1"]').boundingBox();
  if (!before || !nextBefore) throw new Error('header not laid out');
  expect(before.width).toBe(160);
  const handle = header.locator('.jdr-grid__resizer');
  const box = await handle.boundingBox();
  if (!box) throw new Error('resizer not laid out');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 100, box.y + box.height / 2, { steps: 5 });
  await page.mouse.up();
  await expect.poll(async () => (await header.boundingBox())?.width).toBe(260);
  await expect
    .poll(async () => (await page.locator('.jdr-grid__hcell[data-col="1"]').boundingBox())?.x)
    .toBe(nextBefore.x + 100);
  await expect
    .poll(
      async () =>
        (
          await page
            .locator('.jdr-grid__row[data-row="0"] .jdr-grid__cell[data-col="0"]')
            .boundingBox()
        )?.width,
    )
    .toBe(260);
  // 다른 테이블로 갔다 돌아와도 너비가 남는다(메모리 뷰 상태).
  await page.click('[data-action="table-create"]');
  await page.locator('.jdr-dialog input').fill('임시');
  await page.locator('.jdr-dialog').getByRole('button', { name: '만들기' }).click();
  await expect(page.locator('.jdr-grid__empty')).toBeVisible();
  await page.click('.jdr-sidebar__table-name:has-text("고객")');
  await expect.poll(async () => (await header.boundingBox())?.width).toBe(260);
});

test('열 고정: 고정 열은 가로 스크롤에도 왼쪽에 남고, 행 번호 열은 항상 보인다', async ({
  page,
}) => {
  await seed(page);
  const scroller = page.locator('.jdr-grid__scroller');
  // 창을 좁혀 가로 스크롤이 생기게 한다(사이드바 320 px + 그리드 480 px < 열 5개 × 160 px + 행 번호 64 px).
  await page.setViewportSize({ width: 800, height: 720 });
  await page.selectOption('.jdr-grid__frozen-select', '2');
  await expect(page.locator('.jdr-grid__hcell--frozen')).toHaveCount(2);
  await expect(page.locator('.jdr-grid__row[data-row="0"] .jdr-grid__cell--frozen')).toHaveCount(2);
  await scroller.evaluate((el) => {
    el.scrollLeft = 300;
  });
  const scrollerBox = await scroller.boundingBox();
  const rownum = await page.locator('.jdr-grid__hcell--rownum').boundingBox();
  const frozen = await page.locator('.jdr-grid__hcell--frozen').first().boundingBox();
  if (!scrollerBox || !rownum || !frozen) throw new Error('not laid out');
  await expect
    .poll(async () => (await page.locator('.jdr-grid__hcell--rownum').boundingBox())?.x)
    .toBe(scrollerBox.x);
  expect(frozen.x).toBe(scrollerBox.x + 64);
  // 고정되지 않은 첫 열(2번)은 왼쪽으로 밀려났다.
  const third = await page.locator('.jdr-grid__hcell[data-col="2"]').boundingBox();
  expect(third?.x).toBe(scrollerBox.x + 64 + 320 - 300);
  await page.selectOption('.jdr-grid__frozen-select', '0');
  await expect(page.locator('.jdr-grid__hcell--frozen')).toHaveCount(0);
});

test('키보드: 화살표·PageDown·Ctrl+End로 이동하면 활성 셀이 따라가고 그리드가 스크롤된다', async ({
  page,
}) => {
  await seed(page);
  await page.locator('.jdr-grid').focus();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowRight');
  const activeCell = page.locator('.jdr-grid__cell--active');
  await expect(activeCell).toHaveAttribute('data-col', '1');
  await expect(activeCell).toHaveText('6');
  await page.keyboard.press('PageDown');
  await expect
    .poll(async () => Number(await activeCell.evaluate((el) => el.parentElement?.dataset.row)))
    .toBeGreaterThan(10);
  await page.keyboard.press('Control+End');
  await expect(activeCell).toHaveAttribute('data-col', '4');
  await expect
    .poll(async () => activeCell.evaluate((el) => el.parentElement?.dataset.row))
    .toBe(String(ROWS - 1));
  await expect(page.locator(`.jdr-grid__row[data-row="${ROWS - 1}"]`)).toBeVisible();
  await page.keyboard.press('Control+Home');
  await expect
    .poll(async () => activeCell.evaluate((el) => el.parentElement?.dataset.row))
    .toBe('0');
  // 셀 클릭으로도 활성 셀이 바뀐다.
  await page.locator('.jdr-grid__row[data-row="3"] .jdr-grid__cell[data-col="2"]').click();
  await expect(activeCell).toHaveText('짧은 글 4');
});

test('빈 상태: 열을 모두 삭제하면 "열이 없습니다", 테이블을 삭제하면 테이블 선택 안내로 돌아간다', async ({
  page,
}) => {
  await page.click('[data-action="table-create"]');
  await page.locator('.jdr-dialog input').fill('메모');
  await page.locator('.jdr-dialog').getByRole('button', { name: '만들기' }).click();
  await addColumn(page, '본문', '장문');
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 0개');
  await expect(page.locator('.jdr-grid__hcell[data-col="0"]')).toHaveText('본문');
  await page.locator('[data-action="column-delete"]').click();
  await page.locator('.jdr-dialog').getByRole('button', { name: '삭제' }).click();
  await expect(page.locator('.jdr-grid__empty')).toHaveText(
    '열이 없습니다. 사이드바의 "+ 열"로 추가하세요.',
  );
  await expect(page.locator('.jdr-grid')).toHaveCount(0);
  await page.locator('[data-action="column-restore"]').click();
  await expect(page.locator('.jdr-grid__hcell[data-col="0"]')).toHaveText('본문');
  await page.locator('[data-action="table-drop"]').click();
  await page
    .locator('.jdr-dialog')
    .getByRole('button', { name: '되돌릴 수 없음을 알고 삭제' })
    .click();
  await expect(page.locator('.jdr-grid__empty')).toHaveText(
    '왼쪽에서 테이블을 선택하거나 "+ 테이블"로 만드세요.',
  );
  await expect(page.locator('.jdr-app__title')).toBeVisible();
});
