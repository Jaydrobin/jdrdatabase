// @ts-check
import { expect, test } from '@playwright/test';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/** `npm run test:e2e`가 먼저 만든 테스트 빌드. 릴리스 빌드와 훅 유무만 다르다. */
const DIST_TEST_HTML = path.resolve('dist/test/jdrdatabase.html');
const PAGE_URL = pathToFileURL(DIST_TEST_HTML).href;

test('file://로 열면 제목이 표시되고 네트워크 요청이 없다', async ({ page }) => {
  /** @type {string[]} */
  const requests = [];
  page.on('request', (req) => requests.push(req.url()));
  /** @type {string[]} */
  const errors = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto(PAGE_URL);
  await expect(page).toHaveTitle('jdrdatabase');
  await expect(page.locator('.jdr-app__title')).toHaveText('jdrdatabase');
  await expect(page.locator('.jdr-statusbar__item').first()).toHaveText('준비됨');

  const hook = await page.evaluate(() => {
    const w = /** @type {{ __jdrTest?: { version?: string } }} */ (/** @type {unknown} */ (window));
    return w.__jdrTest;
  });
  expect(typeof hook?.version).toBe('string');

  expect(errors).toEqual([]);
  // 허용: 문서 자체(file://)와 Worker 소스의 Blob URL(blob:). 그 밖의 스킴(http, https, data 등)은 0건이어야 한다.
  expect(requests.filter((u) => !u.startsWith('file://') && !u.startsWith('blob:'))).toEqual([]);
  expect(requests.some((u) => u.startsWith('blob:'))).toBe(true);
});
