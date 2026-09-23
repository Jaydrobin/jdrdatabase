// @ts-check
/**
 * Step 3·12 E2E: "+ 테이블"(기본 열 30개)로 테이블 2개를 만들고 머리글(이름 편집기·열 메뉴)과 사이드바로
 * 이름·타입·순서·삭제를 바꾼 뒤 저장(다운로드) → 다시 열기(setInputFiles) → 같은 스키마.
 * 그리고 스키마 변경이 저널에 남아 탭을 다시 열면 복구된다(Step 2 완료 기준을 실제 커맨드로 확인).
 */
import { expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PAGE_URL } from './page-url.js';
import { changeTypeUi, createTableUi, headerCell, openColumnMenu } from './schema-ui.js';

const FILE_INPUT_CLASS = 'jdr-file-input';

/**
 * @typedef {object} ColumnSnapshot
 * @property {string} id
 * @property {string} name
 * @property {string} type
 * @property {string | null} deletedAt
 */
/**
 * @typedef {object} StateSnapshot
 * @property {{ name: string | null }} file
 * @property {Record<string, string>} meta
 * @property {Array<{ id: string, name: string, strict: boolean, columns: ColumnSnapshot[] }>} tables
 * @property {boolean} dirty
 */
/**
 * @typedef {object} TestHook
 * @property {() => StateSnapshot | null} state
 * @property {(sql: string) => Promise<{ columns: string[], rows: unknown[][] }>} query
 * @property {() => Promise<unknown>} journalPending
 */

/** @param {import('@playwright/test').Page} page */
async function state(page) {
  return page.evaluate(() =>
    /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.state(),
  );
}

/** @param {import('@playwright/test').Page} page */
async function waitReady(page) {
  await expect(page.locator('.jdr-statusbar__item').first()).toHaveText('준비됨');
  await expect.poll(async () => (await state(page))?.meta.db_id ?? '').toMatch(/^[0-9a-f-]{36}$/);
}

/**
 * 테이블별 살아 있는 열(이름·타입, 표시 순서)과 소프트 삭제된 열 이름. 타입 변경은 새 물리 열을 만들고 옛 열을
 * 같은 위치에 소프트 삭제로 남기므로(4.2) 삭제된 열은 순서 없이 이름 목록으로 본다.
 * @param {StateSnapshot | null} s
 */
function schemaOf(s) {
  return (s?.tables ?? []).map((t) => ({
    name: t.name,
    strict: t.strict,
    columns: t.columns.filter((c) => c.deletedAt === null).map((c) => [c.name, c.type]),
    deleted: t.columns
      .filter((c) => c.deletedAt !== null)
      .map((c) => c.name)
      .sort(),
  }));
}

/**
 * 머리글 이름을 더블클릭해 이름 편집기로 바꾼다.
 * @param {import('@playwright/test').Page} page
 * @param {string} from
 * @param {string} to
 */
async function renameInHeader(page, from, to) {
  await headerCell(page, from).locator('.jdr-grid__hname').dblclick();
  const editor = page.locator('.jdr-grid__hrename');
  await expect(editor).toBeFocused();
  await expect(editor).toHaveValue(from);
  await editor.fill(to);
  await page.keyboard.press('Enter');
  await expect(editor).toHaveCount(0);
  await expect(headerCell(page, to)).toHaveCount(1);
}

/** 기본 열 이름 `열 1` ~ `열 30`. */
const DEFAULT_COLUMNS = Array.from({ length: 30 }, (_, i) => [`열 ${i + 1}`, 'text']);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window));
    delete w.showOpenFilePicker;
    delete w.showSaveFilePicker;
  });
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto(PAGE_URL);
  await waitReady(page);
});

test('"+ 테이블" 두 번, 머리글·사이드바로 이름·타입·순서·삭제를 바꾸고 저장 → 다시 열기 → 같은 스키마', async ({
  page,
}) => {
  await expect(page.locator('.jdr-sidebar__empty')).toHaveText(
    '테이블이 없습니다. "+ 테이블"로 만드세요.',
  );
  await createTableUi(page, '고객');
  await expect
    .poll(async () => schemaOf(await state(page)))
    .toEqual([{ name: '고객', strict: true, columns: DEFAULT_COLUMNS, deleted: [] }]);
  // 머리글: 이름 편집기, 열 메뉴의 타입 변경(정수·선택).
  await renameInHeader(page, '열 1', '이름');
  await renameInHeader(page, '열 2', '나이');
  await changeTypeUi(page, '나이', '정수');
  await renameInHeader(page, '열 3', '등급');
  await changeTypeUi(page, '등급', '선택', ['일반', 'VIP']);

  // 두 번째 테이블은 미리 채운 이름(`테이블 1`)을 Enter로 그대로 받는다.
  await page.click('[data-action="table-create"]');
  await expect(page.locator('.jdr-dialog input')).toHaveValue('테이블 1');
  await page.keyboard.press('Enter');
  await expect(page.locator('.jdr-sidebar__table--active .jdr-sidebar__table-name')).toHaveText(
    '테이블 1',
  );
  // 사이드바 경로(이름 대화상자, 타입 대화상자, 순서)와 열 메뉴의 삭제.
  await page
    .locator('.jdr-sidebar__column', { hasText: /^열 1텍스트/ })
    .first()
    .locator('[data-action="column-rename"]')
    .click();
  const renameDialog = page.locator('.jdr-dialog');
  await renameDialog.locator('input').fill('주문일');
  await renameDialog.getByRole('button', { name: '확인' }).click();
  await expect(headerCell(page, '주문일')).toHaveCount(1);
  await page
    .locator('.jdr-sidebar__column', { hasText: '주문일' })
    .locator('[data-action="column-type"]')
    .click();
  const typeDialog = page.locator('.jdr-dialog');
  await typeDialog.locator('select').first().selectOption({ label: '날짜' });
  await typeDialog.getByRole('button', { name: '변환' }).click();
  await expect(typeDialog).toHaveCount(0);
  await page
    .locator('.jdr-sidebar__column:not(.jdr-sidebar__column--deleted)', { hasText: /^열 3텍스트/ })
    .locator('[data-action="column-up"]')
    .click();
  await expect
    .poll(async () =>
      schemaOf(await state(page))[1]
        ?.columns.slice(0, 3)
        .map((c) => c[0]),
    )
    .toEqual(['주문일', '열 3', '열 2']);
  const menu = await openColumnMenu(page, '열 2');
  await menu.getByRole('menuitem', { name: '열 삭제…' }).click();
  await page.locator('.jdr-dialog').getByRole('button', { name: '삭제' }).click();
  await expect(headerCell(page, '열 2')).toHaveCount(0);

  const beforeSave = schemaOf(await state(page));
  expect(beforeSave).toEqual([
    {
      name: '고객',
      strict: true,
      columns: [
        ['이름', 'text'],
        ['나이', 'integer'],
        ['등급', 'select'],
        ...DEFAULT_COLUMNS.slice(3),
      ],
      deleted: ['나이', '등급'],
    },
    {
      name: '테이블 1',
      strict: true,
      columns: [['주문일', 'date'], ['열 3', 'text'], ...DEFAULT_COLUMNS.slice(3)],
      deleted: ['열 2', '주문일'],
    },
  ]);
  expect((await state(page))?.dirty).toBe(true);

  const downloadPromise = page.waitForEvent('download');
  await page.click('[data-action="save"]');
  const download = await downloadPromise;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jdr-e2e-'));
  const saved = path.join(dir, download.suggestedFilename());
  await download.saveAs(saved);
  await expect.poll(async () => (await state(page))?.dirty).toBe(false);
  const dbId = (await state(page))?.meta.db_id;

  await page.click('[data-action="new"]');
  await expect.poll(async () => (await state(page))?.tables.length).toBe(0);
  await page.locator(`input.${FILE_INPUT_CLASS}`).setInputFiles(saved);
  await expect.poll(async () => (await state(page))?.meta.db_id).toBe(dbId);
  expect(schemaOf(await state(page))).toEqual(beforeSave);
  await expect(page.locator('.jdr-sidebar__table-name')).toHaveCount(2);
  // 물리 테이블도 STRICT이고 시스템 열을 가진다.
  const ddl = await page.evaluate(() =>
    /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.query(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name LIKE 't\\_%' ESCAPE '\\' ORDER BY name",
    ),
  );
  expect(ddl.rows.length).toBe(2);
  for (const row of ddl.rows) expect(String(row[0])).toMatch(/"id" INTEGER PRIMARY KEY.*STRICT$/);
});

test('스키마 변경은 저널에 남아 탭을 다시 열면 복구된다', async ({ page }) => {
  await createTableUi(page, '메모');
  await renameInHeader(page, '열 1', '본문');
  await expect.poll(async () => (await state(page))?.dirty).toBe(true);
  const dbId = (await state(page))?.meta.db_id;

  await page.reload();
  const dialog = page.locator('.jdr-dialog');
  await expect(dialog.locator('.jdr-dialog__title')).toHaveText('저장되지 않은 변경 복구');
  // 테이블 생성(기본 열 포함) 1건 + 이름 바꾸기 1건.
  await expect(dialog.locator('.jdr-dialog__message').first()).toContainText('변경 2건');
  await dialog.getByRole('button', { name: '복구' }).click();
  await expect.poll(async () => (await state(page))?.meta.db_id).toBe(dbId);
  // db_id는 빈 DB를 만든 직후 서고, 테이블 목록은 저널 재생이 끝난 뒤에야 채워진다. 끝날 때까지 기다린다.
  await expect
    .poll(async () => schemaOf(await state(page)))
    .toEqual([
      {
        name: '메모',
        strict: true,
        columns: [['본문', 'text'], ...DEFAULT_COLUMNS.slice(1)],
        deleted: [],
      },
    ]);
  await expect(page.locator('.jdr-sidebar__table-name')).toHaveText('메모');
  expect((await state(page))?.dirty).toBe(true);
});

test('외부 SQLite 파일의 테이블은 읽기 전용 배지가 붙고 변경·삭제가 막힌다', async ({ page }) => {
  await page
    .locator(`input.${FILE_INPUT_CLASS}`)
    .setInputFiles(path.resolve('test/fixtures/external.db'));
  await page.locator('.jdr-dialog').getByRole('button', { name: '메타 정보 추가' }).click();
  await expect(page.locator('.jdr-sidebar__badge')).toHaveCount(2);
  await expect(page.locator('[data-action="column-add"]')).toBeDisabled();
  await expect(page.locator('[data-action="column-rename"]')).toHaveCount(0);
  // 되돌릴 수 없는 삭제는 읽기 전용 테이블에 내놓지 않는다(표시 이름 변경은 남는다).
  await expect(page.locator('[data-action="table-drop"]')).toHaveCount(0);
  await expect(page.locator('[data-action="table-rename"]')).toHaveCount(2);
  // 머리글(D-16): 이름 더블클릭은 편집기 대신 안내, 열 메뉴는 정렬·숨기기만 켜진다. 빈 행은 없다.
  await page.locator('.jdr-sidebar__table-name').first().click();
  const first = page.locator('.jdr-grid__hcell[data-col="0"]');
  await first.locator('.jdr-grid__hname').dblclick();
  await expect(page.locator('.jdr-grid__hrename')).toHaveCount(0);
  await expect(
    page.locator('.jdr-toast--info', {
      hasText: '읽기 전용으로 열린 데이터베이스는 변경하거나 저장할 수 없습니다.',
    }),
  ).toBeVisible();
  await first.click({ button: 'right' });
  const menu = page.locator('.jdr-menu[role="menu"]');
  const enabled = await menu
    .locator('[role="menuitem"]:not([disabled])')
    .evaluateAll((items) => items.map((el) => el.getAttribute('data-key')));
  expect(enabled).toEqual(['sortAsc', 'sortDesc', 'hide']);
  await page.keyboard.press('Escape');
  await expect(page.locator('.jdr-grid__row--ghost')).toHaveCount(0);
});
