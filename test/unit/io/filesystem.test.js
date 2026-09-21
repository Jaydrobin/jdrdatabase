// @ts-check
/**
 * 파일 시스템 추상화 중 DOM 없이 동작하는 부분(Step 9): gzip 압축·해제 왕복, 매직 판별, 다운로드 싱크.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  gunzip,
  gzip,
  gzipSupported,
  isGzip,
  MIME_BY_KIND,
  openSink,
} from '../../../src/io/filesystem.js';
import { AppError } from '../../../src/util/errors.js';

test('gzip → gunzip 왕복, 매직 판별, 손상은 E_FILE_CORRUPT', async () => {
  assert.equal(gzipSupported(), true, 'Node 22는 CompressionStream을 가진다');
  const original = new Uint8Array(200_000);
  for (let i = 0; i < original.length; i += 1) original[i] = i % 7;
  const packed = await gzip(original);
  assert.equal(isGzip(packed), true);
  assert.equal(isGzip(original), false);
  assert.ok(packed.byteLength < original.byteLength / 10, '반복 데이터는 크게 줄어든다');
  assert.deepEqual(await gunzip(packed), original);
  const broken = packed.slice(0, 40);
  await assert.rejects(
    gunzip(broken),
    (err) => err instanceof AppError && err.code === 'E_FILE_CORRUPT',
  );
});

test('openSink(download): abort 뒤에는 아무것도 내려받지 않는다', async () => {
  const sink = await openSink({ kind: 'download', name: 'x.csv' }, MIME_BY_KIND.csv);
  await sink.write(new Uint8Array([1]));
  await sink.abort();
  // close는 부르지 않는다(abort 경로). document가 없는 Node에서 download가 불리면 예외가 났을 것이다.
  assert.ok(true);
});
