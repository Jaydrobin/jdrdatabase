// @ts-check
import { defineConfig } from '@playwright/test';

/**
 * 성능 측정(DESIGN.md 8장, Step 4 완료 기준). `npm run test:perf`.
 * 30만 행 DB 픽스처(`scripts/gen-fixture.mjs --db`)를 열어 스크롤 프레임 렌더와 창 질의 시간을 잰다.
 * 픽스처 생성과 300 MB 파일 열기가 분 단위라 기본 E2E(`npm run test:e2e`)와 분리한다. CI는 별도 `perf` 잡에서
 * `JDR_PERF_COMPARE=1`로 돌려 절대 예산 대신 `test/perf/perf-baseline.json` 대비 30% 회귀를 판정한다(Step 10).
 */
export default defineConfig({
  testDir: 'test/perf',
  globalSetup: './test/perf/global-setup.js',
  globalTeardown: './test/perf/global-teardown.js',
  fullyParallel: false,
  retries: 0,
  workers: 1,
  timeout: 600_000,
  reporter: [['list']],
  use: {
    browserName: 'chromium',
    headless: true,
  },
});
