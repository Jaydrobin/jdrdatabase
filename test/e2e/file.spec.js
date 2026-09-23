// @ts-check
/**
 * Step 2 E2E(폴백 경로): 새 DB → 저장(다운로드) → 다시 열기(파일 선택기) → 메타 동일.
 * 네이티브 파일 선택기는 자동화할 수 없으므로 `addInitScript`로 File System Access API를 감춰
 * `<input type="file">`·`<a download>` 폴백을 타게 하고, 파일은 `setInputFiles`로 넣는다(CLAUDE.md 6장).
 * (Playwright의 filechooser 가로채기는 이 환경에서 change 대신 cancel을 내는 경우가 있어 쓰지 않는다.)
 */
import { expect, test } from '@playwright/test';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { PAGE_URL } from './page-url.js';

const FIXTURES = path.resolve('test/fixtures');
/** 폴백 열기 경로의 숨은 입력 요소(io/filesystem.js의 FILE_INPUT_CLASS와 같은 값). E2E는 산출물만 열므로 소스를 import하지 않는다. */
const FILE_INPUT_CLASS = 'jdr-file-input';

/**
 * @typedef {object} StateSnapshot
 * @property {{ name: string | null, hasHandle: boolean, size: number }} file
 * @property {Record<string, string>} meta
 * @property {unknown[]} tables
 * @property {boolean} dirty
 * @property {string} readOnly
 */

/**
 * @typedef {object} TestHook
 * @property {Promise<{ transportKind: string, sqliteVersion: string }>} ready
 * @property {() => StateSnapshot | null} state
 * @property {() => boolean} idbAvailable
 * @property {() => boolean} tabLockAvailable
 * @property {() => Promise<unknown>} journalPending
 * @property {(cmd: unknown) => Promise<{ affected: number }>} apply
 * @property {(sql: string) => Promise<{ columns: string[], rows: unknown[][] }>} query
 */

/** @param {import('@playwright/test').Page} page */
async function state(page) {
  return page.evaluate(() => {
    const hook = /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest;
    return hook.state();
  });
}

/** @param {import('@playwright/test').Page} page */
async function waitReady(page) {
  await expect(page.locator('.jdr-statusbar__item').first()).toHaveText('준비됨');
  await expect.poll(async () => (await state(page))?.meta.db_id ?? '').toMatch(/^[0-9a-f-]{36}$/);
}

const CREATE_T = {
  type: 'table.create',
  tableId: null,
  do: [
    { sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT) STRICT' },
    { sql: 'INSERT INTO t (s) VALUES (?)', params: ['하나'] },
  ],
  undo: [{ sql: 'DROP TABLE t' }],
  summary: 'create t',
};

test.beforeEach(async ({ page }) => {
  // 폴백 경로 강제: 파일 선택기 API를 감춘다.
  await page.addInitScript(() => {
    const w = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window));
    delete w.showOpenFilePicker;
    delete w.showSaveFilePicker;
  });
  // beforeunload 확인 창은 받아들인다(재시작 시나리오).
  page.on('dialog', (dialog) => void dialog.accept());
  await page.goto(PAGE_URL);
  await waitReady(page);
});

test('file://에서 IndexedDB와 BroadcastChannel을 쓸 수 있다(지원 매트릭스 실측)', async ({
  page,
}) => {
  const available = await page.evaluate(() => {
    const hook = /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest;
    return { idb: hook.idbAvailable(), tabLock: hook.tabLockAvailable() };
  });
  expect(available).toEqual({ idb: true, tabLock: true });
  await expect(page.locator('.jdr-statusbar__item--note')).toHaveText('');
});

test('새 DB → 저장(다운로드) → 다시 열기 → 같은 db_id와 revision', async ({ page }) => {
  const initial = await state(page);
  expect(initial?.file.name).toBeNull();
  expect(initial?.meta.revision).toBe('0');
  await expect(page.locator('.jdr-toolbar__file')).toHaveText('새 데이터베이스');

  const dbId = initial?.meta.db_id;
  const downloadPromise = page.waitForEvent('download');
  await page.click('[data-action="save"]');
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toBe('database.db');
  // 임시 경로는 이름이 무작위이므로 제안된 이름으로 저장해 다시 열 때 파일 이름이 유지되게 한다.
  // 테스트 제목이 든 outputPath는 비ASCII 문자를 포함하고, 그 경로를 setInputFiles에 주면 Chromium이
  // change 이벤트 없이 조용히 무시한다(실측). ASCII 임시 디렉터리를 쓴다.
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jdr-e2e-'));
  const saved = path.join(dir, download.suggestedFilename());
  await download.saveAs(saved);

  await expect.poll(async () => (await state(page))?.meta.revision).toBe('1');
  const afterSave = await state(page);
  expect(afterSave?.file.name).toBe('database.db');
  expect(afterSave?.file.hasHandle).toBe(false);
  expect(afterSave?.dirty).toBe(false);
  await expect(page.locator('.jdr-toast--info')).toContainText('다운로드했습니다');

  // 새 DB로 바꾼 뒤 내려받은 파일을 다시 연다.
  await page.click('[data-action="new"]');
  await expect.poll(async () => (await state(page))?.meta.db_id).not.toBe(dbId);

  await page.locator(`input.${FILE_INPUT_CLASS}`).setInputFiles(saved);

  await expect.poll(async () => (await state(page))?.meta.db_id).toBe(dbId);
  const reopened = await state(page);
  expect(reopened?.meta.revision).toBe('1');
  expect(reopened?.meta.saved_by).toMatch(/^기기-/);
  expect(reopened?.file.name).toBe('database.db');
  await expect(page.locator('.jdr-toolbar__file')).toHaveText('database.db');
});

/**
 * 두 번째 탭을 첫 탭과 같은 조건(폴백 경로, 확인 창 수락)으로 연다. 같은 컨텍스트의 페이지라 원점이 같아
 * BroadcastChannel과 IndexedDB를 첫 탭과 실제로 공유한다.
 * @param {import('@playwright/test').BrowserContext} context
 */
async function openSecondTab(context) {
  const other = await context.newPage();
  await other.addInitScript(() => {
    const w = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (window));
    delete w.showOpenFilePicker;
    delete w.showSaveFilePicker;
  });
  other.on('dialog', (dialog) => void dialog.accept());
  await other.goto(PAGE_URL);
  await waitReady(other);
  return other;
}

test('두 탭: 같은 파일을 연 뒤 탭은 읽기 전용이고, 앞 탭을 닫거나 새로 고친 뒤에는 잠금이 남지 않는다', async ({
  page,
  context,
}) => {
  // 파일을 만든다. 새 DB는 잠금을 쥐지 않으므로(store.newDatabase) 파일을 열어야 잠금이 생긴다.
  const downloadPromise = page.waitForEvent('download');
  await page.click('[data-action="save"]');
  const download = await downloadPromise;
  const dir = await mkdtemp(path.join(os.tmpdir(), 'jdr-e2e-'));
  const saved = path.join(dir, download.suggestedFilename());
  await download.saveAs(saved);
  await expect.poll(async () => (await state(page))?.meta.revision).toBe('1');
  const dbId = (await state(page))?.meta.db_id;

  // A: 파일을 연다 → 잠금을 쥔다.
  await page.locator(`input.${FILE_INPUT_CLASS}`).setInputFiles(saved);
  await expect.poll(async () => (await state(page))?.file.name).toBe('database.db');
  expect((await state(page))?.readOnly).toBe('none');

  // B: 같은 파일을 연다 → 읽기 전용, 안내, 저장·가져오기 잠김.
  const other = await openSecondTab(context);
  await other.locator(`input.${FILE_INPUT_CLASS}`).setInputFiles(saved);
  await expect.poll(async () => (await state(other))?.meta.db_id).toBe(dbId);
  expect((await state(other))?.readOnly).toBe('otherTab');
  await expect(other.locator('.jdr-toast--info')).toContainText(
    '다른 탭이 이 데이터베이스를 편집 중이어서 읽기 전용으로 열었습니다.',
  );
  await expect(other.locator('.jdr-toolbar__readonly')).toHaveText('읽기 전용');
  await expect(other.locator('[data-action="save"]')).toBeDisabled();
  // 앞 탭은 그대로 쓸 수 있다.
  expect((await state(page))?.readOnly).toBe('none');

  // A를 닫으면 잠금이 풀린다: B가 다시 열면 쓸 수 있다.
  await page.close({ runBeforeUnload: true });
  await other.locator(`input.${FILE_INPUT_CLASS}`).setInputFiles(saved);
  await expect.poll(async () => (await state(other))?.readOnly).toBe('none');
  await expect(other.locator('.jdr-toolbar__readonly')).toHaveText('');
  await expect(other.locator('[data-action="save"]')).toBeEnabled();

  // 새로 고친 탭은 새로 고치기 전의 자기 자신을 "다른 탭"으로 보지 않는다.
  await other.reload();
  await waitReady(other);
  await other.locator(`input.${FILE_INPUT_CLASS}`).setInputFiles(saved);
  await expect.poll(async () => (await state(other))?.meta.db_id).toBe(dbId);
  expect((await state(other))?.readOnly).toBe('none');
});

test('SQLite가 아닌 파일과 손상 파일은 오류 코드로 거부하고 새 DB로 돌아간다', async ({ page }) => {
  for (const [file, code] of [
    ['not-sqlite.txt', 'E_FILE_NOT_SQLITE'],
    ['corrupt.db', 'E_FILE_CORRUPT'],
  ]) {
    await page.locator(`input.${FILE_INPUT_CLASS}`).setInputFiles(path.join(FIXTURES, file));
    await expect(page.locator('.jdr-toast--error').last()).toContainText(code);
    const s = await state(page);
    expect(s?.file.name).toBeNull();
    expect(s?.meta.db_id).toMatch(/^[0-9a-f-]{36}$/);
  }
});

test('다른 도구가 만든 SQLite 파일은 확인 뒤 메타를 추가해 연다', async ({ page }) => {
  await page.locator(`input.${FILE_INPUT_CLASS}`).setInputFiles(path.join(FIXTURES, 'external.db'));
  const dialog = page.locator('.jdr-dialog');
  await expect(dialog.locator('.jdr-dialog__title')).toHaveText('다른 도구가 만든 SQLite 파일');
  await dialog.getByRole('button', { name: '메타 정보 추가' }).click();
  await expect.poll(async () => (await state(page))?.file.name).toBe('external.db');
  const tables = await page.evaluate(() =>
    /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.query(
      'SELECT id, strict FROM _jdr_tables ORDER BY position',
    ),
  );
  expect(tables.rows).toEqual([
    ['users', 0],
    ['posts', 0],
  ]);
});

test('미저장 변경은 저널에 남아 탭을 다시 열면 복구된다', async ({ page }) => {
  const dbId = (await state(page))?.meta.db_id;
  await page.evaluate(
    (cmd) =>
      /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.apply(cmd),
    CREATE_T,
  );
  await expect.poll(async () => (await state(page))?.dirty).toBe(true);
  await expect(page.locator('.jdr-toolbar__dirty')).toHaveText('●');

  await page.reload();
  const dialog = page.locator('.jdr-dialog');
  await expect(dialog.locator('.jdr-dialog__title')).toHaveText('저장되지 않은 변경 복구');
  await expect(dialog.locator('.jdr-dialog__message').first()).toContainText('변경 1건');
  await dialog.getByRole('button', { name: '복구' }).click();

  await expect.poll(async () => (await state(page))?.dirty).toBe(true);
  expect((await state(page))?.meta.db_id).toBe(dbId);
  const rows = await page.evaluate(() =>
    /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.query(
      'SELECT s FROM t',
    ),
  );
  expect(rows.rows).toEqual([['하나']]);

  // 버리기를 고르면 저널이 비고 다음 시작에서는 묻지 않는다.
  await page.reload();
  await expect(page.locator('.jdr-dialog__title')).toHaveText('저장되지 않은 변경 복구');
  await page.locator('.jdr-dialog').getByRole('button', { name: '버리기' }).click();
  await expect
    .poll(() =>
      page.evaluate(() =>
        /** @type {{ __jdrTest: TestHook }} */ (
          /** @type {unknown} */ (window)
        ).__jdrTest.journalPending(),
      ),
    )
    .toBeNull();
  await page.reload();
  await waitReady(page);
  await expect(page.locator('.jdr-dialog')).toHaveCount(0);
});

test('모달이 열려 있는 동안 Ctrl+S는 동작하지 않는다', async ({ page }) => {
  // 저널 복구 대화상자는 열기 흐름 한가운데서 뜬다. 그 답을 기다리는 중의 저장은 파일 상태와
  // 저널을 반쯤 열린 DB 기준으로 바꾼다. 모달 뒤에서 앱이 움직이면 안 된다.
  await page.evaluate(
    (cmd) =>
      /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.apply(cmd),
    CREATE_T,
  );
  await expect.poll(async () => (await state(page))?.dirty).toBe(true);
  await page.reload();
  const dialog = page.locator('.jdr-dialog');
  await expect(dialog.locator('.jdr-dialog__title')).toHaveText('저장되지 않은 변경 복구');

  const before = await state(page);
  await page.keyboard.press('Control+s');
  await page.waitForTimeout(400);
  // 대화상자는 그대로 떠 있고, 아직 답하지 않은 DB가 저장되지도 않았다.
  await expect(dialog).toHaveCount(1);
  const after = await state(page);
  expect(after?.meta.revision).toBe(before?.meta.revision);
  expect(after?.meta.saved_by).toBeUndefined();

  // 대화상자를 닫고 복구가 끝나면 단축키가 다시 동작한다(재생 중에는 저장이 E_DB_BUSY로 막힌다).
  await dialog.getByRole('button', { name: '복구' }).click();
  await expect(page.locator('.jdr-dialog')).toHaveCount(0);
  await expect(page.locator('.jdr-toast')).toContainText('변경 1건을 복구했습니다');
  await expect.poll(async () => (await state(page))?.dirty).toBe(true);
  await page.keyboard.press('Control+s');
  await expect.poll(async () => (await state(page))?.dirty).toBe(false);
  expect((await state(page))?.meta.revision).toBe('1');
});
