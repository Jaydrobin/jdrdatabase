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
/** CLAUDE.md 6장: 기준선 대비 30% 이상 회귀는 실패. */
export const REGRESSION_RATIO = 1.3;
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
 * 기준선 비교. `baseline`에 없는 항목은 건너뛴다(새 측정값은 다음 기준선 갱신에서 들어간다).
 * @param {Record<string, Record<string, number>>} baseline spec 이름 → metrics
 * @param {PerfReport[]} reports
 * @returns {{ regressions: string[], compared: number, skipped: string[] }}
 */
export function compareWithBaseline(baseline, reports) {
  /** @type {string[]} */
  const regressions = [];
  /** @type {string[]} */
  const skipped = [];
  let compared = 0;
  for (const report of reports) {
    const base = baseline[report.name];
    for (const [key, value] of Object.entries(report.metrics)) {
      const ref = base?.[key];
      if (typeof ref !== 'number') {
        skipped.push(`${report.name}.${key}`);
        continue;
      }
      compared += 1;
      if (value > ref * REGRESSION_RATIO) {
        regressions.push(
          `${report.name}.${key}: ${value} > ${ref} × ${REGRESSION_RATIO} (${((value / ref - 1) * 100).toFixed(0)}% 회귀)`,
        );
      }
    }
  }
  return { regressions, compared, skipped };
}
