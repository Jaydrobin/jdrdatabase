// @ts-check
import { defineConfig } from '@playwright/test';

/**
 * E2E는 빌드된 단일 파일 산출물(테스트 빌드)을 file://로 연다(CLAUDE.md 6장).
 * 소스를 서빙하지 않는다. 테스트 빌드는 globalSetup이 만들므로 `npx playwright test`로 하나만
 * 돌려도 지금 소스가 검사된다.
 */
export default defineConfig({
  testDir: 'test/e2e',
  globalSetup: './test/e2e/global-setup.js',
  fullyParallel: false,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    browserName: 'chromium',
    headless: true,
  },
});
