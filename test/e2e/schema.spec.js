// @ts-check
/**
 * Step 3 E2E: 테이블 2개, 열 5개를 UI로 만들고 저장(다운로드) → 다시 열기(setInputFiles) → 같은 스키마.
 * 그리고 스키마 변경이 저널에 남아 탭을 다시 열면 복구된다(Step 2 완료 기준을 실제 커맨드로 확인).
 */
import { expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PAGE_URL = pathToFileURL(path.resolve('dist/test/jdrdatabase.html')).href;
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
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
async function createTable(page, name) {
  await page.click('[data-action="table-create"]');
  const dialog = page.locator('.jdr-dialog');
  await expect(dialog.locator('.jdr-dialog__title')).toHaveText('새 테이블');
  await dialog.locator('input').fill(name);
  await dialog.getByRole('button', { name: '만들기' }).click();
  await expect(page.locator('.jdr-sidebar__table--active .jdr-sidebar__table-name')).toHaveText(
    name,
  );
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 * @param {string} typeLabel
 * @param {string[]} [choices]
 */
async function addColumn(page, name, typeLabel, choices) {
  await page.click('[data-action="column-add"]');
  const dialog = page.locator('.jdr-dialog');
  await expect(dialog.locator('.jdr-dialog__title')).toHaveText('열 추가');
  await dialog.locator('input').fill(name);
  await dialog.locator('select').selectOption({ label: typeLabel });
  if (choices) await dialog.locator('textarea').fill(choices.join('\n'));
  await dialog.getByRole('button', { name: '추가' }).click();
  await expect(page.locator('.jdr-sidebar__column-name', { hasText: name })).toBeVisible();
}

/** @param {StateSnapshot | null} s */
function schemaOf(s) {
  return (s?.tables ?? []).map((t) => ({
    name: t.name,
    strict: t.strict,
    columns: t.columns.map((c) => [c.name, c.type, c.deletedAt === null]),
  }));
}

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

test('테이블 2개·열 5개 만들고 저장 → 다시 열기 → 같은 스키마', async ({ page }) => {
  await expect(page.locator('.jdr-sidebar__empty')).toHaveText(
    '테이블이 없습니다. "+ 테이블"로 만드세요.',
  );
  await createTable(page, '고객');
  await addColumn(page, '이름', '텍스트');
  await addColumn(page, '나이', '정수');
  await addColumn(page, '등급', '선택', ['일반', 'VIP']);
  await createTable(page, '주문');
  await addColumn(page, '주문일', '날짜');
  await addColumn(page, '금액', '실수');

  // 이름 바꾸기, 순서, 소프트 삭제도 한 번씩 거친다.
  await page.click('.jdr-sidebar__table-name:has-text("고객")');
  await page.click('[data-action="column-rename"][data-column-id]:near(:text("나이"))');
  const renameDialog = page.locator('.jdr-dialog');
  await renameDialog.locator('input').fill('연령');
  await renameDialog.getByRole('button', { name: '확인' }).click();
  await expect(page.locator('.jdr-sidebar__column-name', { hasText: '연령' })).toBeVisible();
  await page
    .locator('.jdr-sidebar__column', { hasText: '등급' })
    .locator('[data-action="column-up"]')
    .click();
  await expect
    .poll(async () => schemaOf(await state(page))[0]?.columns.map((c) => c[0]))
    .toEqual(['이름', '등급', '연령']);
  await page
    .locator('.jdr-sidebar__column', { hasText: '연령' })
    .locator('[data-action="column-delete"]')
    .click();
  await page.locator('.jdr-dialog').getByRole('button', { name: '삭제' }).click();
  await expect(page.locator('.jdr-sidebar__column--deleted')).toHaveCount(1);

  const beforeSave = schemaOf(await state(page));
  expect(beforeSave).toEqual([
    {
      name: '고객',
      strict: true,
      columns: [
        ['이름', 'text', true],
        ['등급', 'select', true],
        ['연령', 'integer', false],
      ],
    },
    {
      name: '주문',
      strict: true,
      columns: [
        ['주문일', 'date', true],
        ['금액', 'real', true],
      ],
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
  await createTable(page, '메모');
  await addColumn(page, '본문', '장문');
  await expect.poll(async () => (await state(page))?.dirty).toBe(true);
  const dbId = (await state(page))?.meta.db_id;

  await page.reload();
  const dialog = page.locator('.jdr-dialog');
  await expect(dialog.locator('.jdr-dialog__title')).toHaveText('저장되지 않은 변경 복구');
  await expect(dialog.locator('.jdr-dialog__message').first()).toContainText('변경 2건');
  await dialog.getByRole('button', { name: '복구' }).click();
  await expect.poll(async () => (await state(page))?.meta.db_id).toBe(dbId);
  expect(schemaOf(await state(page))).toEqual([
    { name: '메모', strict: true, columns: [['본문', 'longtext', true]] },
  ]);
  await expect(page.locator('.jdr-sidebar__table-name')).toHaveText('메모');
  expect((await state(page))?.dirty).toBe(true);
});

test('외부 SQLite 파일의 테이블은 읽기 전용 배지가 붙고 열 추가가 막힌다', async ({ page }) => {
  await page
    .locator(`input.${FILE_INPUT_CLASS}`)
    .setInputFiles(path.resolve('test/fixtures/external.db'));
  await page.locator('.jdr-dialog').getByRole('button', { name: '메타 정보 추가' }).click();
  await expect(page.locator('.jdr-sidebar__badge')).toHaveCount(2);
  await expect(page.locator('[data-action="column-add"]')).toBeDisabled();
  await expect(page.locator('[data-action="column-rename"]')).toHaveCount(0);
});
