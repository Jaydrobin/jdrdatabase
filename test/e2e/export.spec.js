// @ts-check
/**
 * Step 9 E2E(폴백 경로): CSV·XLSX 내보내기(다운로드) → 다시 가져오기 왕복, `.db.gz` 저장 → 열기 왕복, 설정
 * 대화상자(기기 이름·자동 저장·압축 저장), 상태바. 파일 선택기는 자동화할 수 없으므로 `<a download>`와
 * `<input type="file">` 폴백을 쓴다(CLAUDE.md 6장). `CompressionStream`의 `file://` 가용성 실측이기도 하다.
 */
import { expect, test } from '@playwright/test';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PAGE_URL = pathToFileURL(path.resolve('dist/test/jdrdatabase.html')).href;
const FIXTURES = path.resolve('test/fixtures/import');
const IMPORT_INPUT = 'input.jdr-import-input';
const FILE_INPUT = 'input.jdr-file-input';

/**
 * @typedef {object} TestHook
 * @property {() => { tables: Array<{ id: string, name: string, columns: Array<{ id: string, name: string, type: string, deletedAt: string | null }> }>, meta: Record<string, string>, dirty: boolean, gzip: boolean, saving: boolean, backupNote: string, file: { name: string | null } } | null} state
 * @property {(sql: string) => Promise<{ columns: string[], rows: unknown[][] }>} query
 */

/** @param {import('@playwright/test').Page} page */
function hook(page) {
  return {
    state: () =>
      page.evaluate(() =>
        /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.state(),
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
 * types.csv를 새 테이블로 가져온다(7열: flag·int·real·date·datetime·zip·mixed·empty 중 empty 제외 없이 8열).
 * @param {import('@playwright/test').Page} page
 * @param {string} file
 * @param {string} tableName
 */
async function importNew(page, file, tableName) {
  await page.locator(IMPORT_INPUT).setInputFiles(file);
  const dialog = page.locator('.jdr-dialog');
  await expect(dialog.locator('.jdr-dialog__title')).toHaveText('CSV·XLSX 가져오기');
  await expect(dialog.locator('table[data-role="preview"]')).toBeVisible();
  await dialog.locator('input[data-field="tableName"]').fill(tableName);
  await dialog.getByRole('button', { name: '가져오기' }).click();
  const report = page.locator('.jdr-dialog');
  await expect(report.locator('.jdr-dialog__title')).toHaveText('가져오기 결과');
  await report.getByRole('button', { name: '확인' }).click();
  await expect(page.locator('.jdr-dialog')).toBeHidden();
}

/**
 * 테이블의 사용자 열 값 전부(id 순).
 * @param {import('@playwright/test').Page} page
 * @param {string} name
 */
async function dump(page, name) {
  const state = await hook(page).state();
  const table = state?.tables.find((tb) => tb.name === name);
  if (!table) throw new Error(`table ${name} not found`);
  const cols = table.columns.filter((c) => c.deletedAt === null);
  const sql = `SELECT ${cols.map((c) => `"${c.id}"`).join(', ')} FROM "${table.id}" ORDER BY "id" LIMIT 1000`;
  const { rows } = await hook(page).query(sql);
  return { types: cols.map((c) => [c.name, c.type]), rows };
}

/** @returns {Promise<string>} */
async function tmpDir() {
  // 비ASCII 경로는 setInputFiles가 조용히 무시하므로 ASCII 임시 디렉터리를 쓴다(세션 B 실측).
  return mkdtemp(path.join(os.tmpdir(), 'jdr-e2e-'));
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

test('CSV 내보내기(다운로드) → 다시 가져오기: 타입·값이 같다(날짜·불리언·NULL·선행 0 텍스트)', async ({
  page,
}) => {
  // 헤드리스 Chromium은 비ASCII 이름의 <a download>를 'download'로 보고하므로(실측) 테이블 이름은 ASCII로 둔다.
  await importNew(page, path.join(FIXTURES, 'types.csv'), 'src');
  const before = await dump(page, 'src');
  expect(before.rows.length).toBe(3);

  await page.click('[data-action="export"]');
  const dialog = page.locator('.jdr-dialog');
  await expect(dialog.locator('.jdr-dialog__title')).toHaveText('"src" 내보내기');
  await expect(dialog.locator('[data-role="export-count"]')).toHaveText('내보낼 행 3개 · 열 8개');
  await expect(dialog.locator('select[data-field="format"]')).toHaveValue('csv');
  await expect(dialog.locator('input[data-field="formulaGuard"]')).toBeChecked();
  await expect(dialog.locator('input[data-field="applyView"]')).toBeChecked();
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '내보내기' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('src.csv');
  await expect(page.locator('.jdr-dialog')).toBeHidden();
  await expect(page.locator('.jdr-toast--info').last()).toContainText(
    '3행을 src.csv(으)로 내보냈습니다',
  );
  const dir = await tmpDir();
  const saved = path.join(dir, 'roundtrip.csv');
  await download.saveAs(saved);
  const text = await readFile(saved);
  expect([...text.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
  expect(text.toString('utf8').slice(1).split('\r\n')[0]).toBe(
    'flag,int,real,date,datetime,zip,mixed,empty',
  );
  // 가져오기로 dirty이고, 내보내기는 그것을 바꾸지 않는다.
  expect((await hook(page).state())?.dirty).toBe(true);

  await importNew(page, saved, '왕복');
  const after = await dump(page, '왕복');
  expect(after.types).toEqual(before.types);
  expect(after.rows).toEqual(before.rows);
});

test('XLSX 내보내기 → 다시 가져오기: 날짜·일시·불리언이 같은 타입으로 돌아온다', async ({
  page,
}) => {
  await importNew(page, path.join(FIXTURES, 'types.csv'), 'src');
  const before = await dump(page, 'src');
  await page.click('[data-action="export"]');
  const dialog = page.locator('.jdr-dialog');
  await dialog.locator('select[data-field="format"]').selectOption('xlsx');
  await expect(dialog.locator('select[data-field="encoding"]')).toBeHidden();
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '내보내기' }).click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('src.xlsx');
  const dir = await tmpDir();
  const saved = path.join(dir, 'roundtrip.xlsx');
  await download.saveAs(saved);
  await importNew(page, saved, '왕복');
  const after = await dump(page, '왕복');
  expect(after.types).toEqual(before.types);
  expect(after.rows).toEqual(before.rows);
});

test('내보내기: 뷰의 필터·정렬·숨김을 적용하고, 끄면 전체 테이블', async ({ page }) => {
  await importNew(page, path.join(FIXTURES, 'types.csv'), '원본');
  // 검색어로 행을 좁힌다(LIKE 폴백).
  await page.locator('[data-action="search"]').fill('01234');
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 1개');
  await page.click('[data-action="export"]');
  const dialog = page.locator('.jdr-dialog');
  await expect(dialog.locator('[data-role="export-count"]')).toHaveText('내보낼 행 1개 · 열 8개');
  await dialog.locator('input[data-field="applyView"]').uncheck();
  await expect(dialog.locator('[data-role="export-count"]')).toHaveText('내보낼 행 3개 · 열 8개');
  await dialog.locator('input[data-field="applyView"]').check();
  await dialog.locator('select[data-field="encoding"]').selectOption('utf-8');
  const downloadPromise = page.waitForEvent('download');
  await dialog.getByRole('button', { name: '내보내기' }).click();
  const download = await downloadPromise;
  const dir = await tmpDir();
  const saved = path.join(dir, 'filtered.csv');
  await download.saveAs(saved);
  const lines = (await readFile(saved, 'utf8')).split('\r\n');
  expect(lines[0]?.charCodeAt(0)).not.toBe(0xfeff);
  expect(lines).toEqual([
    'flag,int,real,date,datetime,zip,mixed,empty',
    'true,1,1.5,2024-01-01,2024-01-01T10:20:30,01234,1,',
    '',
  ]);
});

test('.db.gz 저장 → 열기 왕복: 설정에서 압축 저장을 켜면 다운로드가 gzip이고, 열면 같은 db_id·데이터', async ({
  page,
}) => {
  await importNew(page, path.join(FIXTURES, 'types.csv'), '원본');
  const dbId = (await hook(page).state())?.meta.db_id;
  await page.click('[data-action="settings"]');
  const dialog = page.locator('.jdr-dialog');
  await expect(dialog.locator('.jdr-dialog__title')).toHaveText('설정');
  await expect(dialog.locator('input[data-field="saveGzip"]')).toBeEnabled();
  await dialog.locator('input[data-field="saveGzip"]').check();
  await dialog.locator('input[data-field="deviceName"]').fill('테스트-PC');
  await expect(dialog.locator('select[data-field="autosave"]')).toHaveValue('0');
  await expect(dialog.locator('[data-role="backup-info"]')).toContainText('직전 저장본이 없습니다');
  await expect(dialog.locator('[data-action="backup-restore"]')).toBeDisabled();
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(page.locator('.jdr-dialog')).toBeHidden();
  await expect(page.locator('.jdr-toast--info').last()).toContainText('설정을 저장했습니다');

  const downloadPromise = page.waitForEvent('download');
  await page.click('[data-action="save"]');
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('database.db.gz');
  const dir = await tmpDir();
  const saved = path.join(dir, 'database.db.gz');
  await download.saveAs(saved);
  const bytes = await readFile(saved);
  expect([bytes[0], bytes[1]]).toEqual([0x1f, 0x8b]);
  await expect.poll(async () => (await hook(page).state())?.dirty).toBe(false);
  const afterSave = await hook(page).state();
  expect(afterSave?.gzip).toBe(true);
  expect(afterSave?.meta.saved_by).toBe('테스트-PC');
  expect(afterSave?.meta.revision).toBe('1');

  await page.click('[data-action="new"]');
  await expect.poll(async () => (await hook(page).state())?.meta.db_id).not.toBe(dbId);
  await page.locator(FILE_INPUT).setInputFiles(saved);
  await expect.poll(async () => (await hook(page).state())?.meta.db_id).toBe(dbId);
  const reopened = await hook(page).state();
  expect(reopened?.gzip).toBe(true);
  expect(reopened?.file.name).toBe('database.db.gz');
  expect(reopened?.meta.revision).toBe('1');
  await expect(page.locator('.jdr-grid__rowcount')).toHaveText('행 3개');
  const after = await dump(page, '원본');
  expect(after.rows.length).toBe(3);

  // 설정은 IDB에 남아 다시 열어도 유지된다.
  await page.reload();
  await expect(page.locator('.jdr-statusbar__item').first()).toHaveText('준비됨');
  await page.click('[data-action="settings"]');
  await expect(page.locator('.jdr-dialog input[data-field="deviceName"]')).toHaveValue('테스트-PC');
  await expect(page.locator('.jdr-dialog input[data-field="saveGzip"]')).toBeChecked();
  await page.locator('.jdr-dialog').getByRole('button', { name: '취소' }).click();
});

test('설정: 빈 기기 이름은 저장할 수 없고, 취소하면 바뀌지 않는다', async ({ page }) => {
  await page.click('[data-action="settings"]');
  const dialog = page.locator('.jdr-dialog');
  await dialog.locator('input[data-field="deviceName"]').fill('   ');
  await dialog.getByRole('button', { name: '저장' }).click();
  await expect(dialog.locator('.jdr-dialog__error')).toHaveText('기기 이름을 입력하세요.');
  await dialog.locator('input[data-field="deviceName"]').fill('버림');
  await dialog.getByRole('button', { name: '취소' }).click();
  await expect(page.locator('.jdr-dialog')).toBeHidden();
  const downloadPromise = page.waitForEvent('download');
  await page.click('[data-action="save"]');
  await downloadPromise;
  await expect.poll(async () => (await hook(page).state())?.meta.saved_by).toMatch(/^기기-/);
});
