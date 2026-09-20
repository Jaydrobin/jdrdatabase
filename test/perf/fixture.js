// @ts-check
import path from 'node:path';

/** 성능 픽스처 행 수. `JDR_PERF_ROWS`로 줄여 빠르게 돌릴 수 있다(예산 판정은 30만 행에서만 의미가 있다). */
export const FIXTURE_ROWS = Number(process.env.JDR_PERF_ROWS ?? 300_000);
export const FIXTURE_PATH = path.resolve(`test/fixtures/generated/bench-${FIXTURE_ROWS}.db`);
