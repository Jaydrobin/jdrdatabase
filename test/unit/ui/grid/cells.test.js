// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { alignOf, displayText, ELLIPSIS, preview } from '../../../../src/ui/grid/cells.js';

/**
 * @param {import('../../../../src/db/values.js').LogicalType} type
 * @returns {import('../../../../src/db/tables.js').ColumnInfo}
 */
function column(type) {
  return {
    id: 'c_00000001',
    name: 'c',
    type,
    position: 0,
    width: 160,
    options: null,
    deletedAt: null,
  };
}

test('preview: 길이가 미리보기를 넘을 때만 말줄임', () => {
  assert.deepEqual(preview('abc', null), { text: 'abc', truncated: false });
  assert.deepEqual(preview('abc', 3), { text: 'abc', truncated: false });
  assert.deepEqual(preview('abc', 1_000_000), { text: `abc${ELLIPSIS}`, truncated: true });
});

test('alignOf: 숫자는 오른쪽, 불리언은 가운데, 나머지는 왼쪽', () => {
  assert.equal(alignOf('integer'), 'right');
  assert.equal(alignOf('real'), 'right');
  assert.equal(alignOf('boolean'), 'center');
  assert.equal(alignOf('text'), 'left');
  assert.equal(alignOf('date'), 'left');
});

test('displayText: NULL은 빈 문자열, 불리언은 기호, bigint·소수 자릿수', () => {
  assert.equal(displayText(column('text'), null), '');
  assert.equal(displayText(column('boolean'), 1), '✓');
  assert.equal(displayText(column('boolean'), 0), '✗');
  assert.equal(displayText(column('integer'), 9007199254740993n), '9007199254740993');
  const real = { ...column('real'), options: { decimals: 2 } };
  assert.equal(displayText(real, 1.005), '1.00');
  assert.equal(displayText(column('text'), "O'Brien"), "O'Brien");
});
