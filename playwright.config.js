// @ts-check
import { defineConfig } from '@playwright/test';
import { HTTP_PORT, PAGE_URL, USE_HTTP } from './test/e2e/page-url.js';

/**
 * E2E는 빌드된 단일 파일 산출물(테스트 빌드)을 file://로 연다(CLAUDE.md 6장).
 * 소스를 서빙하지 않는다. 테스트 빌드는 globalSetup이 만들므로 `npx playwright test`로 하나만
 * 돌려도 지금 소스가 검사된다.
 * `JDR_E2E_HTTP=1`이면 같은 파일을 `scripts/serve-dist.mjs`의 http://localhost로 열어 지원 매트릭스의
 * http 열을 실측한다(Step 10). 산출물은 그대로이고 URL만 다르다.
 */
export default defineConfig({
  testDir: 'test/e2e',
  globalSetup: './test/e2e/global-setup.js',
  ...(USE_HTTP
    ? {
        webServer: {
          command: `node scripts/serve-dist.mjs ${HTTP_PORT}`,
          url: PAGE_URL,
          reuseExistingServer: false,
          timeout: 30_000,
        },
      }
    : {}),
  fullyParallel: false,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    browserName: 'chromium',
    headless: true,
  },
});
