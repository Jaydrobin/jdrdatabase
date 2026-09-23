// @ts-check
/**
 * 성능 측정값 기록(Step 10). 각 perf spec은 `record(name, metrics)`로 결과를 `test-results/perf/<name>.json`에
 * 남기고, `global-teardown.js`가 모아 요약을 찍고 기준선(`perf-baseline.json`)과 비교한다.
 * 값은 전부 "낮을수록 좋은" 숫자(ms, bytes)이며, 판정에 쓰지 않는 참고값은 `info`에 둔다.
 */
import { expect } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export const REPORT_DIR = path.resolve('test-results/perf');
export const BASELINE_PATH = path.resolve('test/perf/perf-baseline.json');
/** global-setup이 남기는 러너 속도 보정값(`{ calibrationMs }`). */
export const CALIBRATION_PATH = path.join(REPORT_DIR, 'calibration.json');
/** CLAUDE.md 6장: 기준선 대비 30% 이상 회귀는 실패. */
export const REGRESSION_RATIO = 1.3;
/**
 * 비율 판정에 더하는 잡음 바닥. 1~2 ms짜리 측정(셀 편집 왕복)은 타이머 해상도만으로 30%가 흔들리므로,
 * 비율을 넘고 **또한** 이만큼 이상 늘어야 회귀로 본다. ms 항목 5 ms, bytes 항목 16 MiB.
 */
export const NOISE_FLOOR_MS = 5;
export const NOISE_FLOOR_BYTES = 16 * 1024 * 1024;

/**
 * @param {string} key 측정 항목 이름(`…Ms` 또는 `…Bytes`)
 * @returns {number}
 */
export function noiseFloor(key) {
  return isBytes(key) ? NOISE_FLOOR_BYTES : NOISE_FLOOR_MS;
}

/**
 * 메모리·크기 항목인가. 러너 속도 보정(calibrate.js)은 CPU가 얼마나 빠른가를 잰 값이므로 시간 항목에만
 * 적용한다. 바이트 항목에 곱하면 양쪽으로 틀린다: 느린 기계에서는 8장 예산(1.2 GB)을 넘는 메모리 회귀가
 * 기대값 안으로 들어와 통과하고, 빠른 기계에서는 코드가 그대로인데도 `memory.rssLastBytes`가 회귀로 잡힌다.
 * @param {string} key
 * @returns {boolean}
 */
export function isBytes(key) {
  return key.endsWith('Bytes');
}

/**
 * 기준선 비교로 판정하는 항목(`<spec>.<키>`). 여기에 없는 측정값은 요약·로그에는 그대로 남지만 회귀 판정에는
 * 쓰지 않고, 8장의 절대 예산으로만 본다(DESIGN.md 8장).
 *
 * 넣는 기준은 "러너가 바뀌어도 보정으로 설명되는가" 하나다.
 * - 바이트 항목: 기계 속도와 무관하므로 보정 없이 견준다(`isBytes`).
 * - 수 초 이상 이어지는 wasm CPU 작업(가져오기, 인덱스 만들기, 내보내기, 전체 훑기): `calibrate.js`의 고정
 *   작업과 성질이 같아 보정 비가 실제로 맞는다.
 *
 * 빼는 것은 브라우저 쪽 1초 미만 지연(앱 시작, 프레임, 왕복, 창 질의, 스냅샷)이다. 앱 코드가 똑같은 CI 실행
 * 다섯 번에서 이 항목들은 1.5~3.9배까지 흔들렸는데(`editMaxMs` 3.92배, `renderP95Ms` 2.56배, `readyMs`
 * 1.75배) 같은 실행의 처리량 항목은 1.22배, 보정값은 1.29배였다. I/O·GC·프로세스 경합이 CPU 처리량보다
 * 훨씬 크게 흔들리는데 보정은 CPU 처리량만 재기 때문이다(세션 H 점검 실측).
 */
export const GATED_METRICS = new Set([
  'import-csv.importMs',
  'import-xlsx.importMs',
  'import-xlsx.previewMs',
  'search.indexBuildMs',
  'search.likeMs',
  'search.likeShortMs',
  'app-300k.exportCsvMs',
]);

/**
 * `<spec>.<키>`가 기준선 비교 대상인가. 바이트 항목은 이름만으로 늘 대상이다.
 * @param {string} name spec 이름
 * @param {string} key 측정 항목 이름
 * @returns {boolean}
 */
export function isGated(name, key) {
  return isBytes(key) || GATED_METRICS.has(`${name}.${key}`);
}
/** CI에서 기준선 비교를 켜는 환경 변수. 로컬 기본 실행은 8장의 절대 예산으로만 판정한다. */
export const COMPARE_ENV = 'JDR_PERF_COMPARE';
/** 절대 예산으로 판정하는가(로컬). CI(기준선 비교)에서는 예산 초과를 기록만 한다(DESIGN.md 8장). */
export const STRICT_BUDGET = process.env[COMPARE_ENV] !== '1';

/**
 * 8장 예산 판정. 로컬에서는 넘으면 실패, CI에서는 기록만(기준선 비교가 판정한다).
 * @param {number} value
 * @param {number} limit
 * @param {string} label
 */
export function budget(value, limit, label) {
  const ok = value <= limit;
  console.log(`[perf:budget] ${label}: ${value} ${ok ? '<=' : '>'} ${limit}${ok ? '' : ' (초과)'}`);
  if (STRICT_BUDGET) expect(value, `${label} 예산 ${limit} 초과`).toBeLessThanOrEqual(limit);
}

/**
 * @typedef {object} PerfReport
 * @property {string} name spec 이름(`grid`, `search`, …)
 * @property {Record<string, number>} metrics 낮을수록 좋은 측정값. 기준선 비교 대상
 * @property {Record<string, unknown>} [info] 참고값(행 수, 바이트, 개수). 비교하지 않는다
 */

/**
 * 측정값을 기록한다. 같은 이름으로 다시 부르면 덮어쓴다.
 * @param {string} name
 * @param {Record<string, number>} metrics
 * @param {Record<string, unknown>} [info]
 */
export async function record(name, metrics, info = {}) {
  await mkdir(REPORT_DIR, { recursive: true });
  /** @type {PerfReport} */
  const report = { name, metrics, info };
  await writeFile(path.join(REPORT_DIR, `${name}.json`), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`[perf:${name}] ${JSON.stringify({ ...metrics, ...info })}`);
}

/**
 * 기준선 비교. 판정 대상은 `isGated`가 고르고(나머지는 `recorded`로 이름만 돌려준다), 그중 `baseline`에 없는
 * 항목은 건너뛴다(`skipped`. 새 측정값은 다음 기준선 갱신에서 들어간다).
 * 회귀 = 기준선 × 러너 속도 비(`scale`, calibrate.js. 시간 항목에만) × 1.3 + 잡음 바닥을 넘는 값.
 * @param {Record<string, Record<string, number>>} baseline spec 이름 → metrics
 * @param {PerfReport[]} reports
 * @param {number} [scale] 이번 러너가 기준선 러너보다 느린 비(1이면 같은 속도). 바이트 항목에는 쓰지 않는다
 * @returns {{ regressions: string[], compared: number, skipped: string[], recorded: string[] }}
 */
export function compareWithBaseline(baseline, reports, scale = 1) {
  /** @type {string[]} */
  const regressions = [];
  /** @type {string[]} */
  const skipped = [];
  /** @type {string[]} */
  const recorded = [];
  let compared = 0;
  for (const report of reports) {
    const base = baseline[report.name];
    for (const [key, value] of Object.entries(report.metrics)) {
      if (!isGated(report.name, key)) {
        recorded.push(`${report.name}.${key}`);
        continue;
      }
      const ref = base?.[key];
      if (typeof ref !== 'number') {
        skipped.push(`${report.name}.${key}`);
        continue;
      }
      compared += 1;
      // 바이트 항목은 기계 속도와 무관하다(위 `isBytes`).
      const keyScale = isBytes(key) ? 1 : scale;
      const expected = ref * keyScale;
      const limit = expected * REGRESSION_RATIO + noiseFloor(key);
      if (value > limit) {
        regressions.push(
          `${report.name}.${key}: ${value} > ${ref} × ${keyScale.toFixed(2)} × ${REGRESSION_RATIO} + ${noiseFloor(key)} (${((value / expected - 1) * 100).toFixed(0)}% 회귀)`,
        );
      }
    }
  }
  return { regressions, compared, skipped, recorded };
}
