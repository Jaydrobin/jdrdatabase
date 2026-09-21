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
