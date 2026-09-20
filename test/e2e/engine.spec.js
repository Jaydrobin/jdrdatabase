// @ts-check
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PAGE_URL = pathToFileURL(path.resolve('dist/test/jdrdatabase.html')).href;

/**
 * @typedef {object} TestHook
 * @property {Promise<{ transportKind: string, sqliteVersion: string }>} ready
 * @property {(transport: 'auto' | 'inline', sql: string | string[]) => Promise<{ transportKind: string, columns: string[], rows: unknown[][] }>} exec
 */

test.beforeEach(async ({ page }) => {
  await page.goto(PAGE_URL);
});

test('Blob Worker 안에서 SQLite Wasm이 기동하고 상태바에 Worker 모드가 표시된다', async ({
  page,
}) => {
  const ready = await page.evaluate(
    () => /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.ready,
  );
  expect(ready.transportKind).toBe('worker');
  expect(ready.sqliteVersion).toMatch(/^3\.\d+\.\d+$/);
  await expect(page.locator('.jdr-statusbar__item').nth(1)).toHaveText('Worker 모드');
  await expect(page.locator('.jdr-statusbar__item').nth(2)).toHaveText(
    `SQLite ${ready.sqliteVersion}`,
  );
});

test('Worker 모드에서 SELECT 1', async ({ page }) => {
  const result = await page.evaluate(() =>
    /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.exec(
      'auto',
      'SELECT 1 AS one',
    ),
  );
  expect(result.transportKind).toBe('worker');
  expect(result).toMatchObject({ columns: ['one'], rows: [[1]] });
});

test('인라인(단일 스레드) 모드에서 SELECT 1', async ({ page }) => {
  const result = await page.evaluate(() =>
    /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.exec(
      'inline',
      'SELECT 1 AS one',
    ),
  );
  expect(result.transportKind).toBe('inline');
  expect(result).toMatchObject({ columns: ['one'], rows: [[1]] });
});

test('빌드된 wasm이 ENABLE_FTS5로 컴파일되어 있다', async ({ page }) => {
  const result = await page.evaluate(() =>
    /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.exec(
      'auto',
      "SELECT count(*) FROM pragma_compile_options WHERE compile_options = 'ENABLE_FTS5'",
    ),
  );
  expect(result.rows).toEqual([[1]]);
});

test('FTS5 trigram 부분 일치가 Blob Worker 안에서 동작한다', async ({ page }) => {
  // D-02(sql.js → 공식 SQLite Wasm)의 근거가 브라우저에서의 FTS5이므로, 컴파일 옵션이 아니라
  // 실제 trigram 질의를 file:// 문서의 Worker 안에서 실행해 확인한다.
  const result = await page.evaluate(() =>
    /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.exec(
      'auto',
      [
        "CREATE VIRTUAL TABLE f USING fts5(body, tokenize = 'trigram')",
        "INSERT INTO f VALUES ('서울특별시 강남구')",
        "INSERT INTO f VALUES ('부산광역시 해운대구')",
        "SELECT body FROM f WHERE f MATCH '강남구'",
      ],
    ),
  );
  expect(result.transportKind).toBe('worker');
  expect(result.rows).toEqual([['서울특별시 강남구']]);
});
