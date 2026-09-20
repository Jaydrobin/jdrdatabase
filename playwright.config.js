// @ts-check
import { defineConfig } from '@playwright/test';

/**
 * E2E는 빌드된 단일 파일 산출물(테스트 빌드)을 file://로 연다(CLAUDE.md 6장).
 * 소스를 서빙하지 않으며, 테스트 빌드는 `npm run test:e2e`가 먼저 만든다.
 */
export default defineConfig({
  testDir: 'test/e2e',
  fullyParallel: false,
  retries: 0,
  reporter: process.env.CI ? [['list'], ['github']] : [['list']],
  use: {
    browserName: 'chromium',
    headless: true,
  },
});
