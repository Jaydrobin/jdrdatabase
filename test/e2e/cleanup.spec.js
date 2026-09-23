// @ts-check
/**
 * Step 13 E2E(브라우저 모드): 열 삭제 → 설정 → 데이터베이스 정리 → 저장(다운로드 폴백) → 다시 열기 → 물리 열이 없다(D-17).
 * 설정의 "이 브라우저의 직전 저장본 모두 지우기" → "직전 저장본이 없습니다"(D-18). 정리 대화상자·확인 줄의 axe 검사.
 */
import { AxeBuilder } from '@axe-core/playwright';
import { expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PAGE_URL } from './page-url.js';
import { createTableWith, headerCell, openColumnMenu } from './schema-ui.js';

const FILE_INPUT = 'input.jdr-file-input';

/**
 * @typedef {object} StateSnapshot
 * @property {Array<{ id: string, name: string, columns: Array<{ id: string, name: string, deletedAt: string | null }> }>} tables
 * @property {Record<string, string>} meta
 * @property {boolean} dirty
 */

/**
 * @typedef {object} TestHook
 * @property {() => StateSnapshot | null} state
 * @property {(sql: string) => Promise<{ columns: string[], rows: unknown[][] }>} query
 * @property {(cmd: unknown) => Promise<{ affected: number }>} apply
 * @property {() => { undo: number, redo: number } | null} history
 */

/** @param {import('@playwright/test').Page} page */
async function state(page) {
  return page.evaluate(() =>
    /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.state(),
  );
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} sql
 */
async function query(page, sql) {
  return page.evaluate(
    (q) =>
      /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.query(q),
    sql,
  );
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} tableId
 * @returns {Promise<string[]>}
 */
async function physicalColumns(page, tableId) {
  const r = await query(page, `SELECT name FROM pragma_table_info('${tableId}') ORDER BY cid`);
  return r.rows.map((row) => String(row[0]));
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {string} screen
 */
async function audit(page, screen) {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const blocking = result.violations.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  );
  expect(
    blocking.map((v) => ({ id: v.id, nodes: v.nodes.map((n) => n.target.join(' ')) })),
    `${screen}: critical·serious 위반`,
  ).toEqual([]);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    const w = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window));
    delete w.showOpenFilePicker;
    delete w.showSaveFilePicker;
  });
  await page.goto(PAGE_URL);
  await expect(page.locator('.jdr-statusbar__item').first()).toHaveText('준비됨');
  await expect.poll(async () => (await state(page))?.meta.db_id ?? '').toMatch(/^[0-9a-f-]{36}$/);
});

test('열 삭제 → 설정 → 데이터베이스 정리 → 저장 → 다시 열기 → 물리 열이 없고 남은 값은 그대로', async ({
  page,
}) => {
  await createTableWith(page, '정리', [
    { name: '남김', type: 'text' },
    { name: '지움', type: 'longtext' },
  ]);
  const table = (await state(page))?.tables.find((t) => t.name === '정리');
  const keep = table?.columns[0]?.id ?? '';
  const gone = table?.columns[1]?.id ?? '';
  const tableId = table?.id ?? '';
  await page.evaluate(
    ({ id, a, b }) =>
      /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.apply({
        type: 'row.insert',
        tableId: id,
        do: [
          {
            batch: {
              sql: `INSERT INTO "${id}" ("${a}", "${b}") VALUES (?, ?)`,
              paramsList: [
                ['하나', '가'.repeat(5000)],
                ['둘', '나'.repeat(5000)],
              ],
            },
          },
        ],
        undo: [{ sql: `DELETE FROM "${id}"` }],
        summary: 'rows',
      }),
    { id: tableId, a: keep, b: gone },
  );
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 2개');

  // 열 삭제 확인 문구가 정리 위치를 가리킨다(D-17).
  const menu = await openColumnMenu(page, '지움');
  await menu.getByRole('menuitem', { name: '열 삭제…' }).click();
  const confirm = page.locator('.jdr-dialog');
  await expect(confirm).toContainText('설정의 "데이터베이스 정리…"에서만 완전히 지워집니다');
  await confirm.getByRole('button', { name: '삭제' }).click();
  await expect(headerCell(page, '지움')).toHaveCount(0);
  expect(await physicalColumns(page, tableId)).toContain(gone);

  await page.click('[data-action="settings"]');
  const settings = page.locator('.jdr-dialog');
  await expect(settings.locator('.jdr-dialog__title')).toHaveText('설정');
  const open = settings.locator('[data-action="cleanup-open"]');
  await expect(open).toBeEnabled();
  await open.click();

  const dialog = page.locator('.jdr-dialog');
  await expect(dialog.locator('.jdr-dialog__title')).toHaveText('데이터베이스 정리');
  const list = dialog.locator('[data-role="cleanup-list"]');
  await expect(list.locator('legend')).toHaveText('정리');
  await expect(list.locator(`input[data-column="${gone}"]`)).toBeChecked();
  await expect(list).toContainText('지움 · 장문');
  await expect(dialog.locator('[data-role="cleanup-size"]')).toContainText('줄일 수 있는 빈 공간');
  await expect(dialog).toContainText('되돌릴 수 없습니다');
  await expect(dialog).toContainText('직전 저장본');
  await expect(dialog).toContainText('파일은 저장해야 작아집니다');
  await expect(dialog.locator('[data-role="cleanup-memory"]')).toBeHidden();
  await audit(page, '정리 대화상자');
  await dialog.getByRole('button', { name: '정리', exact: true }).click();
  await expect(page.locator('.jdr-dialog')).toHaveCount(0);
  await expect(page.locator('.jdr-toast--info').last()).toContainText('삭제한 열 1개를 지웠습니다');

  expect(await physicalColumns(page, tableId)).toEqual(['id', '_created_at', '_updated_at', keep]);
  const after = await state(page);
  expect(after?.dirty).toBe(true);
  expect(after?.tables.find((t) => t.id === tableId)?.columns.map((c) => c.id)).toEqual([keep]);
  // 되돌릴 수 없는 정리는 히스토리를 비운다.
  const history = await page.evaluate(() =>
    /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.history(),
  );
  expect(history?.undo).toBe(0);
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 2개');

  // 저장(다운로드) → 새 DB → 그 파일을 다시 연다.
  const downloadPromise = page.waitForEvent('download');
  await page.click('[data-action="save"]');
  const download = await downloadPromise;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jdr-cleanup-'));
  const saved = path.join(dir, download.suggestedFilename());
  await download.saveAs(saved);
  await expect.poll(async () => (await state(page))?.dirty).toBe(false);
  const dbId = (await state(page))?.meta.db_id;
  await page.click('[data-action="new"]');
  await expect.poll(async () => (await state(page))?.meta.db_id).not.toBe(dbId);
  await page.locator(FILE_INPUT).setInputFiles(saved);
  await expect.poll(async () => (await state(page))?.meta.db_id).toBe(dbId);
  expect(await physicalColumns(page, tableId)).toEqual(['id', '_created_at', '_updated_at', keep]);
  const values = await query(page, `SELECT "${keep}" FROM "${tableId}" ORDER BY id`);
  expect(values.rows).toEqual([['하나'], ['둘']]);

  // 더 정리할 삭제된 열이 없어도 브라우저 모드는 빈 공간 줄이기로 정리를 열 수 있다.
  await page.click('[data-action="settings"]');
  await expect(page.locator('.jdr-dialog [data-action="cleanup-open"]')).toBeEnabled();
  await page.keyboard.press('Escape');
});

test('직전 저장본 모두 지우기: 확인 줄의 개수·사용량 → 지우면 "직전 저장본이 없습니다"', async ({
  page,
}) => {
  const dbId = (await state(page))?.meta.db_id ?? '';
  // 저장 직전 백업은 파일 선택기 저장에서만 생긴다(자동화 불가). IDB에 직접 두 파일의 보관본을 넣는다.
  await page.evaluate(
    (id) =>
      new Promise((resolve, reject) => {
        const request = indexedDB.open('jdrdatabase', 1);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const tx = db.transaction('backups', 'readwrite');
          const store = tx.objectStore('backups');
          store.put({ name: '이 파일.db', bytes: new Uint8Array(1024), at: Date.now() }, id);
          store.put({ name: '다른 파일.db', bytes: new Uint8Array(2048), at: Date.now() }, 'other');
          tx.oncomplete = () => {
            db.close();
            resolve(undefined);
          };
          tx.onerror = () => reject(tx.error);
        };
      }),
    dbId,
  );

  await page.click('[data-action="settings"]');
  const dialog = page.locator('.jdr-dialog');
  await expect(dialog.locator('[data-role="backup-info"]')).toContainText('이 파일.db');
  const clear = dialog.locator('[data-action="backup-clear-all"]');
  await expect(clear).toBeVisible();
  await clear.click();
  const confirm = dialog.locator('[data-role="backup-clear"]');
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('직전 저장본 2개(모든 파일)를 지웁니다');
  await expect(confirm).toContainText('이 앱이 쓰는 저장 공간');
  await audit(page, '설정의 확인 줄');
  // 취소하면 아무것도 지우지 않는다.
  await confirm.getByRole('button', { name: '취소' }).click();
  await expect(confirm).toBeHidden();
  await expect(dialog.locator('[data-role="backup-info"]')).toContainText('이 파일.db');

  await clear.click();
  await confirm.locator('[data-action="backup-clear-ok"]').click();
  await expect(dialog.locator('[data-role="backup-info"]')).toContainText('직전 저장본이 없습니다');
  await expect(dialog.locator('[data-action="backup-restore"]')).toBeDisabled();
  await expect(clear).toBeHidden();
  await expect(page.locator('.jdr-toast--info').last()).toContainText(
    '직전 저장본 2개를 지웠습니다',
  );
  await page.keyboard.press('Escape');

  // 다시 열어도 없다.
  await page.click('[data-action="settings"]');
  await expect(page.locator('.jdr-dialog [data-role="backup-info"]')).toContainText(
    '직전 저장본이 없습니다',
  );
  await expect(page.locator('.jdr-dialog [data-action="backup-clear-all"]')).toBeHidden();
  await page.keyboard.press('Escape');
});

test('정리 대화상자: 빈 기기 이름이면 설정에 머물고, 체크를 풀면 그 열은 남아 복원할 수 있다', async ({
  page,
}) => {
  await createTableWith(page, '표', [
    { name: 'a', type: 'text' },
    { name: 'b', type: 'text' },
    { name: 'c', type: 'text' },
  ]);
  const table = (await state(page))?.tables.find((t) => t.name === '표');
  const [, b, c] = (table?.columns ?? []).map((col) => col.id);
  for (const name of ['b', 'c']) {
    const menu = await openColumnMenu(page, name);
    await menu.getByRole('menuitem', { name: '열 삭제…' }).click();
    await page.locator('.jdr-dialog').getByRole('button', { name: '삭제' }).click();
    await expect(headerCell(page, name)).toHaveCount(0);
  }

  await page.click('[data-action="settings"]');
  const settings = page.locator('.jdr-dialog');
  await settings.locator('input[data-field="deviceName"]').fill('  ');
  await settings.locator('[data-action="cleanup-open"]').click();
  await expect(settings.locator('.jdr-dialog__error')).toHaveText('기기 이름을 입력하세요.');
  await expect(settings.locator('.jdr-dialog__title')).toHaveText('설정');
  // 이름을 고친 뒤 저장만 누르면 정리 대화상자가 열리지 않는다.
  await settings.locator('input[data-field="deviceName"]').fill('정리-PC');
  await settings.getByRole('button', { name: '저장' }).click();
  await expect(page.locator('.jdr-dialog')).toHaveCount(0);

  await page.click('[data-action="settings"]');
  await page.locator('.jdr-dialog [data-action="cleanup-open"]').click();
  const dialog = page.locator('.jdr-dialog');
  await expect(dialog.locator('.jdr-dialog__title')).toHaveText('데이터베이스 정리');
  await dialog.locator(`input[data-column="${b}"]`).uncheck();
  await dialog.getByRole('button', { name: '정리', exact: true }).click();
  await expect(page.locator('.jdr-dialog')).toHaveCount(0);
  const after = (await state(page))?.tables.find((t) => t.name === '표');
  expect(after?.columns.map((col) => [col.id, col.deletedAt !== null])).toEqual([
    [table?.columns[0]?.id, false],
    [b, true],
  ]);
  expect(c).toBeTruthy();
  // 남은 삭제된 열은 사이드바에서 복원할 수 있다.
  await page
    .locator('.jdr-sidebar__column--deleted', { hasText: /^b/ })
    .locator('[data-action="column-restore"]')
    .click();
  await expect(headerCell(page, 'b')).toHaveCount(1);
});
