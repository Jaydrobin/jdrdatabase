// @ts-check
/**
 * 선택 모델(Step 5): 활성 셀·앵커·범위, 행 선택, 경계 맞춤.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createSelection } from '../../../../src/ui/grid/selection.js';

test('setActive는 범위를 셀 하나로, extendTo는 앵커에서 직사각형으로', () => {
  const sel = createSelection();
  sel.setBounds(100, 5);
  sel.setActive(3, 2);
  assert.deepEqual(sel.getRange(), { r0: 3, r1: 3, c0: 2, c1: 2 });
  assert.equal(sel.isSingle(), true);
  sel.extendTo(1, 4);
  assert.deepEqual(sel.getRange(), { r0: 1, r1: 3, c0: 2, c1: 4 });
  assert.deepEqual(sel.getActive(), { row: 1, col: 4 });
  assert.equal(sel.contains(2, 3), true);
  assert.equal(sel.contains(0, 3), false);
  assert.equal(sel.isRowSelection(), false);
  sel.setActive(0, 0);
  assert.equal(sel.isSingle(), true);
});

test('selectRows·selectAll은 모든 열을 덮고 isRowSelection이 참', () => {
  const sel = createSelection();
  sel.setBounds(10, 3);
  sel.selectRows(7, 4);
  assert.deepEqual(sel.getRange(), { r0: 4, r1: 7, c0: 0, c1: 2 });
  assert.equal(sel.isRowSelection(), true);
  assert.deepEqual(sel.getActive(), { row: 4, col: 0 });
  sel.selectAll();
  assert.deepEqual(sel.getRange(), { r0: 0, r1: 9, c0: 0, c1: 2 });
  // 셀 하나가 모든 열인 테이블(열 1개)도 행 선택이다.
  sel.setBounds(10, 1);
  sel.setActive(2, 0);
  assert.equal(sel.isRowSelection(), true);
  sel.setBounds(10, 0);
  assert.equal(sel.isRowSelection(), false);
});

test('setBounds는 선택을 안으로 맞추고, 빈 그리드는 (0,0)', () => {
  const sel = createSelection();
  sel.setBounds(100, 5);
  sel.setActive(50, 4);
  sel.extendTo(80, 4);
  sel.setBounds(60, 3);
  assert.deepEqual(sel.getRange(), { r0: 50, r1: 59, c0: 2, c1: 2 });
  sel.setBounds(0, 0);
  assert.deepEqual(sel.getActive(), { row: 0, col: 0 });
  sel.setActive(5, 5);
  assert.deepEqual(sel.getActive(), { row: 0, col: 0 });
  sel.reset();
  assert.deepEqual(sel.getRange(), { r0: 0, r1: 0, c0: 0, c1: 0 });
});
