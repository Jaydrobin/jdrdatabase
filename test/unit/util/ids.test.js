// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isColumnId, isTableId, newColumnId, newTableId } from '../../../src/util/ids.js';

test('newTableId/newColumnId: 접두사 + 8자리 16진수, 충돌 시 재생성', () => {
  const t = newTableId();
  const c = newColumnId();
  assert.match(t, /^t_[0-9a-f]{8}$/);
  assert.match(c, /^c_[0-9a-f]{8}$/);
  assert.equal(isTableId(t), true);
  assert.equal(isColumnId(c), true);
  assert.equal(isTableId('users'), false);
  assert.equal(isColumnId('c_xyz'), false);

  const existing = new Set();
  for (let i = 0; i < 200; i += 1) {
    const id = newColumnId(existing);
    assert.equal(existing.has(id), false);
    existing.add(id);
  }
});
