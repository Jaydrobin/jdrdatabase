// @ts-check
/**
 * perf spec들이 남긴 `test-results/perf/*.json`을 모아 요약을 찍고, `JDR_PERF_COMPARE=1`이면 기준선과
 * 비교해 30% 이상 회귀가 있으면 실패시킨다(CLAUDE.md 6장). 기준선에 없는 항목은 건너뛰고 이름을 찍는다.
 * 요약 JSON은 그대로 `perf-baseline.json`의 `metrics`에 옮겨 적을 수 있는 형태다.
 */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { BASELINE_PATH, COMPARE_ENV, REPORT_DIR, compareWithBaseline } from './report.js';

/** @typedef {import('./report.js').PerfReport} PerfReport */

export default async function globalTeardown() {
  /** @type {PerfReport[]} */
  const reports = [];
  /** @type {string[]} */
  let files = [];
  try {
    files = (await readdir(REPORT_DIR)).filter((f) => f.endsWith('.json') && f !== 'summary.json');
  } catch {
    files = [];
  }
  for (const file of files.sort()) {
    reports.push(JSON.parse(await readFile(path.join(REPORT_DIR, file), 'utf8')));
  }
  if (reports.length === 0) {
    console.log('[perf] 기록된 측정값이 없습니다');
    return;
  }
  /** @type {Record<string, Record<string, number>>} */
  const summary = {};
  for (const report of reports) summary[report.name] = report.metrics;
  await writeFile(path.join(REPORT_DIR, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(
    `[perf] summary (perf-baseline.json의 metrics 형식):\n${JSON.stringify(summary, null, 2)}`,
  );

  if (process.env[COMPARE_ENV] !== '1') return;
  /** @type {{ environment: string, metrics: Record<string, Record<string, number>> }} */
  const baseline = JSON.parse(await readFile(BASELINE_PATH, 'utf8'));
  const { regressions, compared, skipped } = compareWithBaseline(baseline.metrics, reports);
  console.log(
    `[perf] 기준선(${baseline.environment}) 비교: ${compared}개 항목, 건너뜀 ${skipped.length}개${skipped.length ? ` (${skipped.join(', ')})` : ''}`,
  );
  if (regressions.length > 0) {
    throw new Error(`[perf] 기준선 대비 30% 이상 회귀:\n${regressions.join('\n')}`);
  }
  console.log('[perf] 회귀 없음');
}
