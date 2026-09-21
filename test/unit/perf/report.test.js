// @ts-check
/**
 * 성능 기준선 비교(test/perf/report.js)의 판정 규칙: 기준선 × 러너 속도 비 × 1.3 + 잡음 바닥(ms 5, bytes 16 MiB)을 넘어야 회귀.
 * CI에서 셀 편집 왕복 1.3 ms → 1.9 ms가 "46% 회귀"로 실패한 것을 재현한다(잡음 바닥 전에는 실패).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { speedRatio } from '../../perf/calibrate.js';
import {
  NOISE_FLOOR_BYTES,
  NOISE_FLOOR_MS,
  compareWithBaseline,
  isGated,
  noiseFloor,
} from '../../perf/report.js';

test('compareWithBaseline: 비율과 잡음 바닥을 둘 다 넘어야 회귀', () => {
  const baseline = {
    'app-300k': { exportCsvMs: 17_760, peakRssBytes: 876_531_712 },
    search: { likeMs: 687.4 },
  };
  const ok = compareWithBaseline(baseline, [
    { name: 'app-300k', metrics: { exportCsvMs: 20_000, peakRssBytes: 890_000_000 } },
    { name: 'search', metrics: { likeMs: 800 } },
    { name: 'import-csv', metrics: { importMs: 900 } },
  ]);
  assert.deepEqual(ok.regressions, []);
  assert.equal(ok.compared, 3);
  assert.deepEqual(ok.skipped, ['import-csv.importMs']);

  const bad = compareWithBaseline(baseline, [
    { name: 'app-300k', metrics: { exportCsvMs: 26_000, peakRssBytes: 1_160_000_000 } },
    { name: 'search', metrics: { likeMs: 900 } },
  ]);
  assert.deepEqual(
    bad.regressions.map((r) => r.split(':')[0]),
    ['app-300k.exportCsvMs', 'app-300k.peakRssBytes', 'search.likeMs'],
  );
  assert.equal(noiseFloor('anythingMs'), NOISE_FLOOR_MS);
  assert.equal(noiseFloor('peakRssBytes'), NOISE_FLOOR_BYTES);

  // 느린 러너(속도 비 1.4)에서는 기대값이 그만큼 늘어난다. 같은 값이 비 1에서는 회귀, 1.4에서는 아니다.
  const slow = compareWithBaseline(baseline, [{ name: 'search', metrics: { likeMs: 900 } }], 1.4);
  assert.deepEqual(slow.regressions, []);
  const same = compareWithBaseline(baseline, [{ name: 'search', metrics: { likeMs: 900 } }], 1);
  assert.equal(same.regressions.length, 1);
});

test('isGated/compareWithBaseline: 브라우저 쪽 지연 항목은 기록만 하고 판정하지 않는다', () => {
  // 같은 앱 코드의 CI 실행 다섯 번에서 지연 항목은 1.5~3.9배 흔들렸고(보정값은 1.29배), 그 때문에 문서만
  // 바꾼 커밋이 두 번 빨강이 됐다(renderMaxMs, readyMs). 8장의 절대 예산으로만 본다.
  for (const [name, key] of [
    ['app', 'readyMs'],
    ['grid', 'renderP95Ms'],
    ['grid', 'queryMaxMs'],
    ['grid', 'openMs'],
    ['app-300k', 'editMaxMs'],
    ['app-300k', 'snapshotMs'],
    ['app-300k', 'saveMs'],
    ['search', 'sortIntMs'],
    ['import-csv', 'previewMs'],
  ]) {
    assert.equal(isGated(name, key), false, `${name}.${key}는 판정 대상이 아니어야 한다`);
  }
  // 수 초 이상 이어지는 wasm CPU 작업과 모든 바이트 항목은 판정한다.
  for (const [name, key] of [
    ['import-csv', 'importMs'],
    ['import-xlsx', 'importMs'],
    ['import-xlsx', 'previewMs'],
    ['search', 'indexBuildMs'],
    ['search', 'likeMs'],
    ['app-300k', 'exportCsvMs'],
    ['app-300k', 'peakRssBytes'],
    ['memory', 'rssLastBytes'],
  ]) {
    assert.equal(isGated(name, key), true, `${name}.${key}는 판정 대상이어야 한다`);
  }

  // 판정하지 않는 항목은 기준선에 값이 있어도 회귀를 내지 않고 `recorded`로만 돌아온다.
  const baseline = { app: { readyMs: 279.5 }, grid: { renderP95Ms: 0.9 } };
  const result = compareWithBaseline(
    baseline,
    [
      { name: 'app', metrics: { readyMs: 490 } },
      { name: 'grid', metrics: { renderP95Ms: 10.6 } },
    ],
    1.29,
  );
  assert.deepEqual(result.regressions, []);
  assert.equal(result.compared, 0);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.recorded, ['app.readyMs', 'grid.renderP95Ms']);
});

test('compareWithBaseline: 러너 속도 보정은 시간 항목에만 적용한다', () => {
  // 보정값은 CPU 고정 작업을 잰 것이라 메모리에는 뜻이 없다. 바이트 항목에 곱하면 양쪽으로 틀린다.
  const baseline = {
    memory: { rssLastBytes: 318_459_904 },
    'app-300k': { peakRssBytes: 856_301_568 },
  };

  // 빠른 기계(비 0.7): 코드가 그대로라 측정값이 기준선과 같은데도 회귀로 잡혔다.
  const unchanged = [{ name: 'memory', metrics: { rssLastBytes: 318_459_904 } }];
  assert.deepEqual(compareWithBaseline(baseline, unchanged, 0.7).regressions, []);
  assert.deepEqual(compareWithBaseline(baseline, unchanged, 1.4).regressions, []);

  // 느린 기계(비 1.38): 8장 예산(1.2 GB)을 넘는 1.4 GB짜리 메모리 회귀가 기대값 안으로 들어와 통과했다.
  const regressed = [{ name: 'app-300k', metrics: { peakRssBytes: 1_400_000_000 } }];
  for (const scale of [1, 1.38, 2]) {
    assert.equal(
      compareWithBaseline(baseline, regressed, scale).regressions.length,
      1,
      `속도 비 ${scale}에서도 메모리 회귀를 잡아야 한다`,
    );
  }
});

test('speedRatio: 기준선·현재 보정값의 비를 [0.5, 2]로 자르고, 없으면 1', () => {
  assert.equal(speedRatio(600, 840), 1.4);
  assert.equal(speedRatio(600, 300), 0.5);
  assert.equal(speedRatio(600, 3000), 2);
  assert.equal(speedRatio(undefined, 700), 1);
  assert.equal(speedRatio(600, undefined), 1);
});
