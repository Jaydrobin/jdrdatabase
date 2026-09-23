// @ts-check
/**
 * 자동 이름(D-16, Step 12 완료 기준): 빈 목록, 중간 번호 빈자리, 소프트 삭제된 이름 건너뜀, 여러 개.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nextNames } from '../../../src/util/names.js';

test('nextNames: 빈 목록이면 1부터 차례로', () => {
  assert.deepEqual(nextNames('열 {n}', new Set(), 1), ['열 1']);
  assert.deepEqual(nextNames('열 {n}', new Set(), 3), ['열 1', '열 2', '열 3']);
  assert.deepEqual(nextNames('열 {n}', new Set(), 0), []);
});

test('nextNames: 중간 번호의 빈자리를 먼저 채운다', () => {
  const taken = new Set(['열 1', '열 2', '열 4', '열 6']);
  assert.deepEqual(nextNames('열 {n}', taken, 1), ['열 3']);
  assert.deepEqual(nextNames('열 {n}', taken, 3), ['열 3', '열 5', '열 7']);
});

test('nextNames: 소프트 삭제된 열의 이름도 taken에 넣으면 건너뛴다', () => {
  // 삭제한 `열 5`의 이름을 새 열이 가져가면 그 열을 복원할 수 없다(restoreColumn이 거부).
  const live = ['열 1', '열 2', '열 3', '열 4', '열 6'];
  const deleted = ['열 5'];
  assert.deepEqual(nextNames('열 {n}', new Set(live), 1), ['열 5']);
  assert.deepEqual(nextNames('열 {n}', new Set([...live, ...deleted]), 1), ['열 7']);
});

test('nextNames: 형식 문자열의 앞뒤 문구를 그대로 두고, 같은 문구의 다른 이름과는 무관', () => {
  const taken = new Set(['Column 1', '열 1', 'Column 1 ']);
  assert.deepEqual(nextNames('Column {n}', taken, 2), ['Column 2', 'Column 3']);
  assert.deepEqual(nextNames('테이블 {n}', new Set(['테이블 1']), 1), ['테이블 2']);
});

test('nextNames: {n}이 없는 형식은 거부한다(모든 번호가 같은 이름이 된다)', () => {
  assert.throws(() => nextNames('열', new Set(), 1), RangeError);
});
