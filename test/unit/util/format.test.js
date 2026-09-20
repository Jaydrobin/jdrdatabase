// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatInteger } from '../../../src/util/format.js';

test('formatInteger: 천 단위 구분, 소수 버림, 비유한수는 빈 문자열', () => {
  assert.equal(formatInteger(0), '0');
  assert.equal(formatInteger(1234567), '1,234,567');
  assert.equal(formatInteger(12.9), '12');
  assert.equal(formatInteger(Number.NaN), '');
  assert.equal(formatInteger(Number.POSITIVE_INFINITY), '');
});
