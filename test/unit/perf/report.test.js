// @ts-check
/**
 * 성능 기준선 비교(test/perf/report.js)의 판정 규칙: 기준선 × 1.3 + 잡음 바닥(ms 5, bytes 16 MiB)을 넘어야 회귀.
 * CI에서 셀 편집 왕복 1.3 ms → 1.9 ms가 "46% 회귀"로 실패한 것을 재현한다(잡음 바닥 전에는 실패).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
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
});
