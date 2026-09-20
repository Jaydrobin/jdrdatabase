// @ts-check
/**
 * 가상 그리드의 순수 계산(Step 4 완료 기준): computeRange 경계(첫 행, 마지막 행, 뷰포트보다 적은 행 수),
 * 스크롤 스케일링, 열 배치와 열 범위.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BUFFER_ROWS,
  canvasHeightFor,
  computeColumnRange,
  computeRange,
  contentToScroll,
  layoutColumns,
  MAX_CANVAS_HEIGHT,
  ROW_HEIGHT,
  ROW_NUMBER_WIDTH,
  scrollToContent,
} from '../../../../src/ui/grid/grid.js';

const rh = ROW_HEIGHT;

test('computeRange: 첫 행 — scrollTop 0이면 0행부터 버퍼 없이 시작한다', () => {
  const r = computeRange(0, 320, { rowCount: 1000, rowHeight: rh });
  assert.equal(r.start, 0);
  assert.equal(r.first, 0);
  assert.equal(r.offsetY, 0);
  // 보이는 10행 + 1 + 버퍼
  assert.equal(r.end, 11 + BUFFER_ROWS);
});

test('computeRange: 마지막 행 — 끝까지 내리면 마지막 행이 포함되고 rowCount를 넘지 않는다', () => {
  const rowCount = 1000;
  const vp = 320;
  const maxScroll = rowCount * rh - vp;
  const r = computeRange(maxScroll, vp, { rowCount, rowHeight: rh });
  assert.equal(r.end, rowCount);
  assert.equal(r.first, rowCount - 10);
  assert.equal(r.offsetY, r.first * rh);
  // 넘치는 스크롤 값도 같은 결과
  assert.deepEqual(computeRange(maxScroll + 999, vp, { rowCount, rowHeight: rh }), r);
});

test('computeRange: 뷰포트보다 적은 행 수 — 전부 그리고 end는 rowCount', () => {
  const r = computeRange(0, 320, { rowCount: 5, rowHeight: rh });
  assert.deepEqual(r, { start: 0, end: 5, first: 0, offsetY: 0 });
  assert.deepEqual(computeRange(0, 320, { rowCount: 0, rowHeight: rh }), {
    start: 0,
    end: 0,
    first: 0,
    offsetY: 0,
  });
});

test('computeRange: 중간 — 행 경계에 걸친 scrollTop은 offsetY가 행의 시작으로 맞는다', () => {
  const r = computeRange(3 * rh + 7, 320, { rowCount: 1000, rowHeight: rh, buffer: 2 });
  assert.equal(r.first, 3);
  assert.equal(r.offsetY, 3 * rh);
  assert.equal(r.start, 1);
  assert.equal(r.end, 3 + 11 + 2);
});

test('스크롤 스케일링: 1,000만 px를 넘는 테이블은 캔버스를 상한에서 자르고 끝 행에 닿는다', () => {
  const rowCount = 1_000_000;
  const layout = { rowCount, rowHeight: rh };
  assert.equal(rowCount * rh > MAX_CANVAS_HEIGHT, true);
  assert.equal(canvasHeightFor(layout), MAX_CANVAS_HEIGHT);
  const vp = 320;
  const maxScroll = MAX_CANVAS_HEIGHT - vp;
  const top = computeRange(0, vp, layout);
  assert.equal(top.first, 0);
  const bottom = computeRange(maxScroll, vp, layout);
  assert.equal(bottom.end, rowCount);
  assert.equal(bottom.first, rowCount - 10);
  // 그려지는 행의 y는 뷰포트 안에 있다: offsetY ∈ [scrollTop - rh, scrollTop]
  assert.ok(bottom.offsetY <= maxScroll && bottom.offsetY > maxScroll - rh);
  const mid = computeRange(maxScroll / 2, vp, layout);
  assert.ok(Math.abs(mid.first - rowCount / 2) <= 6);
  // 환산 함수는 서로 역함수다
  const content = scrollToContent(1234.5, vp, layout);
  assert.ok(Math.abs(contentToScroll(content, vp, layout) - 1234.5) < 1e-6);
  // 스케일링이 없는 테이블에서는 항등
  assert.equal(scrollToContent(500, vp, { rowCount: 1000, rowHeight: rh }), 500);
  assert.equal(contentToScroll(500, vp, { rowCount: 1000, rowHeight: rh }), 500);
});

test('layoutColumns/computeColumnRange: 행 번호 열 뒤로 누적 위치, 고정 열은 범위에서 빠진다', () => {
  const widths = [100, 200, 150, 300];
  const laid = layoutColumns(widths);
  assert.deepEqual(laid.lefts, [
    ROW_NUMBER_WIDTH,
    ROW_NUMBER_WIDTH + 100,
    ROW_NUMBER_WIDTH + 300,
    ROW_NUMBER_WIDTH + 450,
  ]);
  assert.equal(laid.total, ROW_NUMBER_WIDTH + 750);
  const cols = { lefts: laid.lefts, widths, frozen: 0 };
  assert.deepEqual(computeColumnRange(0, 200, cols), { start: 0, end: 2 });
  assert.deepEqual(computeColumnRange(ROW_NUMBER_WIDTH + 320, 100, cols), { start: 2, end: 3 });
  assert.deepEqual(computeColumnRange(0, 10_000, cols), { start: 0, end: 4 });
  assert.deepEqual(computeColumnRange(0, 200, { ...cols, frozen: 2 }), { start: 2, end: 2 });
  assert.deepEqual(computeColumnRange(0, 200, { lefts: [], widths: [], frozen: 1 }), {
    start: 0,
    end: 0,
  });
});
