// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  base64ToBytes,
  bytesToBase64,
  estimateCloneBytes,
  formatBytes,
  GB,
  KB,
  MB,
} from '../../../src/util/bytes.js';

test('base64 왕복: 빈 배열, 1~3바이트 패딩, 큰 배열, 공백 포함 입력', () => {
  for (const len of [0, 1, 2, 3, 4, 70_000]) {
    const src = new Uint8Array(len);
    for (let i = 0; i < len; i += 1) src[i] = (i * 31 + 7) & 0xff;
    const b64 = bytesToBase64(src);
    assert.equal(b64, Buffer.from(src).toString('base64'));
    const back = base64ToBytes(b64);
    assert.deepEqual(Array.from(back), Array.from(src));
    assert.ok(back.buffer instanceof ArrayBuffer);
  }
  assert.deepEqual(Array.from(base64ToBytes('AQ ID\nBA==')), [1, 2, 3, 4]);
});

test('formatBytes', () => {
  assert.equal(formatBytes(0), '0 B');
  assert.equal(formatBytes(1023), '1023 B');
  assert.equal(formatBytes(1.5 * KB), '1.5 KB');
  assert.equal(formatBytes(700 * MB), '700.0 MB');
  assert.equal(formatBytes(1.5 * GB), '1.50 GB');
  assert.equal(formatBytes(Infinity), 'Infinity');
});

test('estimateCloneBytes: 문자열은 2바이트/코드유닛, 바이너리는 길이, 중첩 합산', () => {
  assert.equal(estimateCloneBytes('abc'), 16 + 6);
  assert.equal(estimateCloneBytes(new Uint8Array(100)), 116);
  assert.equal(estimateCloneBytes([1, 'ab']), 16 + 8 + 20);
  assert.ok(estimateCloneBytes({ k: 'v' }) > 16);
  assert.equal(estimateCloneBytes(null), 8);
});
