// @ts-check
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  AppError,
  deserializeError,
  ERROR_CODES,
  isAppError,
  isErrorCode,
  serializeError,
  toAppError,
} from '../../../src/util/errors.js';

test('AppError: 코드·detail·recoverable 기본값·cause 보존', () => {
  const cause = new TypeError('boom');
  const err = new AppError('E_FILE_WRITE', 'write failed', { detail: { path: 'a.db' }, cause });
  assert.equal(err.name, 'AppError');
  assert.equal(err.code, 'E_FILE_WRITE');
  assert.equal(err.recoverable, true);
  assert.deepEqual(err.detail, { path: 'a.db' });
  assert.equal(err.cause, cause);
  assert.equal(new AppError('E_ENV_NO_WASM', 'x').recoverable, false);
  assert.equal(new AppError('E_RESULT_TOO_LARGE', 'x').recoverable, false);
  assert.equal(new AppError('E_ENV_NO_WASM', 'x', { recoverable: true }).recoverable, true);
});

test('toAppError: AppError는 그대로, 그 밖은 E_UNKNOWN으로 감싸고 cause 보존', () => {
  const app = new AppError('E_DB_QUERY', 'q');
  assert.equal(toAppError(app), app);
  const wrapped = toAppError(new RangeError('bad'));
  assert.equal(wrapped.code, 'E_UNKNOWN');
  assert.equal(wrapped.message, 'bad');
  assert.ok(wrapped.cause instanceof RangeError);
  assert.equal(toAppError('str', 'E_DB_QUERY', 'custom').message, 'custom');
});

test('serializeError/deserializeError: 왕복 후 같은 코드·메시지·detail·recoverable', () => {
  const err = new AppError('E_DB_BUSY', 'busy', { detail: { running: 'import.run' } });
  const wire = serializeError(err);
  assert.deepEqual(wire, {
    code: 'E_DB_BUSY',
    message: 'busy',
    recoverable: true,
    detail: { running: 'import.run' },
  });
  assert.deepEqual(structuredClone(wire), wire);
  const back = deserializeError(wire);
  assert.ok(isAppError(back));
  assert.equal(back.code, 'E_DB_BUSY');
  assert.equal(back.message, 'busy');
  assert.deepEqual(back.detail, { running: 'import.run' });
  assert.equal(back.recoverable, true);
});

test('serializeError: 일반 예외는 E_UNKNOWN + cause 요약, Error detail은 이름·메시지만', () => {
  const wire = serializeError(new SyntaxError('oops'));
  assert.equal(wire.code, 'E_UNKNOWN');
  assert.equal(wire.recoverable, false);
  assert.deepEqual(wire.detail, { cause: { name: 'SyntaxError', message: 'oops' } });
  const withErrorDetail = serializeError(
    new AppError('E_DB_QUERY', 'q', { detail: new Error('d') }),
  );
  assert.deepEqual(withErrorDetail.detail, { name: 'Error', message: 'd' });
});

test('deserializeError: 모르는 코드나 잘못된 값은 E_UNKNOWN', () => {
  const unknown = deserializeError({ code: 'E_NOPE', message: 'm', detail: 1 });
  assert.equal(unknown.code, 'E_UNKNOWN');
  assert.deepEqual(unknown.detail, { originalCode: 'E_NOPE', detail: 1 });
  assert.equal(deserializeError('junk').code, 'E_UNKNOWN');
  assert.equal(deserializeError(null).message, 'null');
});

test('ERROR_CODES: 중복 없이 E_ 접두사, isErrorCode', () => {
  assert.equal(new Set(ERROR_CODES).size, ERROR_CODES.length);
  for (const code of ERROR_CODES) assert.match(code, /^E_[A-Z_]+$/);
  assert.equal(isErrorCode('E_DB_QUERY'), true);
  assert.equal(isErrorCode('nope'), false);
});

test('DESIGN.md 7장 표가 모든 오류 코드를 담는다 (CLAUDE.md 7.1)', async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
  const design = await readFile(path.join(root, 'DESIGN.md'), 'utf8');
  const chapter = design.slice(design.indexOf('## 7.'), design.indexOf('## 8.'));
  assert.ok(chapter.length > 0, 'DESIGN.md에서 7장을 찾지 못함');
  // 한 행이 `E_A` / `E_B`처럼 코드를 둘 담기도 하므로 행 단위가 아니라 코드 단위로 모은다.
  const documented = new Set(
    chapter
      .split('\n')
      .filter((line) => line.startsWith('| `E_'))
      .flatMap((line) => [...line.matchAll(/`(E_[A-Z_]+)`/g)].map((m) => m[1])),
  );
  const missing = ERROR_CODES.filter((code) => !documented.has(code));
  assert.deepEqual(missing, [], `7장 표에 없는 코드: ${missing.join(', ')}`);
  const extra = [...documented].filter(
    (code) => !ERROR_CODES.includes(/** @type {never} */ (code)),
  );
  assert.deepEqual(extra, [], `util/errors.js에 없는 코드: ${extra.join(', ')}`);
});
