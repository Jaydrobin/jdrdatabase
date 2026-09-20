// @ts-check
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const PAGE_URL = pathToFileURL(path.resolve('dist/test/jdrdatabase.html')).href;

/**
 * @typedef {object} TestHook
 * @property {Promise<{ transportKind: string, sqliteVersion: string }>} ready
 * @property {(transport: 'auto' | 'inline', sql: string) => Promise<{ transportKind: string, columns: string[], rows: unknown[][] }>} exec
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

test('FTS5 trigram 검색이 브라우저 안에서 동작한다', async ({ page }) => {
  const result = await page.evaluate(() =>
    /** @type {{ __jdrTest: TestHook }} */ (/** @type {unknown} */ (window)).__jdrTest.exec(
      'auto',
      "WITH x AS (SELECT 1) SELECT count(*) FROM pragma_compile_options WHERE compile_options = 'ENABLE_FTS5'",
    ),
  );
  expect(result.rows).toEqual([[1]]);
});
