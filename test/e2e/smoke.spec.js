// @ts-check
import { expect, test } from '@playwright/test';
import { PAGE_ORIGIN_PREFIX, PAGE_URL } from './page-url.js';

/** `npm run test:e2e`가 먼저 만든 테스트 빌드(`page-url.js`. 릴리스 빌드와 훅 유무만 다르다). */

test('산출물을 열면 제목이 표시되고 네트워크 요청이 없다(file:// 또는 JDR_E2E_HTTP=1의 http://localhost)', async ({
  page,
}) => {
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
  // 허용: 문서 자체(file:// 또는 서빙 원점)와 Worker 소스의 Blob URL(blob:). 그 밖의 요청은 0건이어야 한다.
  expect(
    requests.filter((u) => !u.startsWith(PAGE_ORIGIN_PREFIX) && !u.startsWith('blob:')),
  ).toEqual([]);
  expect(requests.some((u) => u.startsWith('blob:'))).toBe(true);
});
