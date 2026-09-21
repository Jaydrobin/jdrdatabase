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
  noiseFloor,
} from '../../perf/report.js';

test('compareWithBaseline: 비율과 잡음 바닥을 둘 다 넘어야 회귀', () => {
  const baseline = {
    'app-300k': { editMaxMs: 1.3, snapshotMs: 135, peakRssBytes: 876_531_712 },
    grid: { queryMaxMs: 34.1 },
  };
  const ok = compareWithBaseline(baseline, [
    { name: 'app-300k', metrics: { editMaxMs: 1.9, snapshotMs: 175, peakRssBytes: 890_000_000 } },
    { name: 'grid', metrics: { queryMaxMs: 44 } },
    { name: 'search', metrics: { likeMs: 900 } },
  ]);
  assert.deepEqual(ok.regressions, []);
  assert.equal(ok.compared, 4);
  assert.deepEqual(ok.skipped, ['search.likeMs']);

  const bad = compareWithBaseline(baseline, [
    { name: 'app-300k', metrics: { editMaxMs: 7, snapshotMs: 181, peakRssBytes: 1_160_000_000 } },
    { name: 'grid', metrics: { queryMaxMs: 49 } },
  ]);
  assert.deepEqual(
    bad.regressions.map((r) => r.split(':')[0]),
    ['app-300k.editMaxMs', 'app-300k.snapshotMs', 'app-300k.peakRssBytes'],
  );
  assert.equal(noiseFloor('anythingMs'), NOISE_FLOOR_MS);
  assert.equal(noiseFloor('peakRssBytes'), NOISE_FLOOR_BYTES);

  // 느린 러너(속도 비 1.4)에서는 기대값이 그만큼 늘어난다. 같은 값이 비 1에서는 회귀, 1.4에서는 아니다.
  const slow = compareWithBaseline(baseline, [{ name: 'grid', metrics: { queryMaxMs: 55 } }], 1.4);
  assert.deepEqual(slow.regressions, []);
  const same = compareWithBaseline(baseline, [{ name: 'grid', metrics: { queryMaxMs: 55 } }], 1);
  assert.equal(same.regressions.length, 1);
});

test('speedRatio: 기준선·현재 보정값의 비를 [0.5, 2]로 자르고, 없으면 1', () => {
  assert.equal(speedRatio(600, 840), 1.4);
  assert.equal(speedRatio(600, 300), 0.5);
  assert.equal(speedRatio(600, 3000), 2);
  assert.equal(speedRatio(undefined, 700), 1);
  assert.equal(speedRatio(600, undefined), 1);
});
