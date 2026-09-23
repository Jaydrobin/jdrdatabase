// @ts-check
/**
 * 러너 속도 보정(Step 10). GitHub 러너는 실행마다 다른 기계에 배정되어 같은 코드의 측정값이 1.4배쯤 흔들린다
 * (세션 H 실측: LIKE 검색 731 ms ↔ 532 ms, 정렬 74 ms ↔ 45 ms). 기준선 비교 전에 고정된 CPU 작업을 같은 wasm
 * 엔진으로 돌려 걸린 시간을 재고, 기준선을 잴 때의 값과의 비로 기대값을 늘리거나 줄인다(global-teardown.js).
 * 잡음이 아니라 기계 속도만 보정하는 것이므로 비는 [0.5, 2]로 자른다.
 */
import { openWasmEngine } from '../unit/db/helpers.js';

const ROWS = 100_000;
const QUERIES = 5;

/**
 * 고정 작업: 10만 행 삽입(runBatch) + LIKE 전체 훑기 5회. 걸린 시간(ms).
 * @returns {Promise<number>}
 */
export async function calibrate() {
  const engine = await openWasmEngine();
  try {
    await engine.transaction(() =>
      engine.exec('CREATE TABLE calib (id INTEGER PRIMARY KEY, s TEXT, n INTEGER) STRICT'),
    );
    /** @type {import('../../src/db/engine.js').SqlParams[]} */
    const params = [];
    for (let i = 0; i < ROWS; i += 1) params.push([`row ${i} 가나다 ${(i * 7919) % 1000}`, i]);
    const started = performance.now();
    // runBatch는 1만 건까지 받는다(E_BATCH_TOO_LARGE). 1만 건씩 나눠 보낸다.
    for (let at = 0; at < params.length; at += 10_000) {
      await engine.runBatch(
        'INSERT INTO calib (s, n) VALUES (?, ?)',
        params.slice(at, at + 10_000),
      );
    }
    for (let i = 0; i < QUERIES; i += 1) {
      engine.exec("SELECT count(*) FROM calib WHERE s LIKE '%멜%' OR n % 7 = ?", [i]);
    }
    return performance.now() - started;
  } finally {
    await engine.close();
  }
}

/**
 * 보정 비(지금 / 기준선). 기준선에 보정값이 없으면 1.
 * @param {number | undefined} baseline 기준선을 잴 때의 calibrate() 값
 * @param {number | undefined} now 이번 실행의 값
 * @returns {number}
 */
export function speedRatio(baseline, now) {
  if (!baseline || !now || baseline <= 0 || now <= 0) return 1;
  return Math.min(2, Math.max(0.5, now / baseline));
}
