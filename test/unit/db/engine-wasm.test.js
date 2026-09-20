// @ts-check
/**
 * wasm 구현에만 해당하는 검사. 공통 계약은 engine-contract.test.js에 있다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectEngine } from '../../../src/db/engine.js';
import { WASM_MAX_FILE_BYTES, WASM_WARN_FILE_BYTES } from '../../../src/db/engine-wasm.js';
import { GB, MB } from '../../../src/util/bytes.js';
import { AppError } from '../../../src/util/errors.js';
import { loadWasmBinary, openWasmEngine } from './helpers.js';

test('capabilities: D-15의 wasm 상한과 저장 방식', async () => {
  const engine = await openWasmEngine();
  assert.deepEqual(engine.capabilities(), {
    mode: 'wasm',
    maxFileBytes: 1.5 * GB,
    warnFileBytes: 700 * MB,
    persistence: 'snapshot',
    cancellable: true,
    fts5: true,
  });
  assert.equal(WASM_MAX_FILE_BYTES, 1.5 * GB);
  assert.equal(WASM_WARN_FILE_BYTES, 700 * MB);
  await engine.close();
});

test('init: wasmBinary가 없거나 깨지면 E_ENV_NO_WASM', async () => {
  const engine = selectEngine('wasm');
  await assert.rejects(
    engine.init({}),
    (err) => err instanceof AppError && err.code === 'E_ENV_NO_WASM',
  );
});

test('init 결과: sqlite 버전과 compile_options', async () => {
  const engine = selectEngine('wasm');
  const info = await engine.init({ wasmBinary: await loadWasmBinary() });
  assert.match(info.sqliteVersion, /^3\.\d+\.\d+$/);
  assert.ok(info.compileOptions.includes('ENABLE_FTS5'));
  assert.ok(info.compileOptions.includes('THREADSAFE=0'));
});

test('selectEngine: native는 Step 11 전까지 E_UNSUPPORTED, 모르는 모드도 거부', () => {
  assert.throws(
    () => selectEngine('native'),
    (err) => err instanceof AppError && err.code === 'E_UNSUPPORTED',
  );
  assert.throws(
    () => selectEngine(/** @type {never} */ ('other')),
    (err) => err instanceof AppError && err.code === 'E_UNSUPPORTED',
  );
});

test('open: 경로 객체는 wasm에서 E_UNSUPPORTED, 상한 초과 크기는 E_FILE_TOO_LARGE', async () => {
  const engine = await openWasmEngine();
  await assert.rejects(
    engine.open({ originalPath: '/tmp/x.db' }),
    (err) => err instanceof AppError && err.code === 'E_UNSUPPORTED',
  );
  const huge = /** @type {Uint8Array} */ (
    /** @type {unknown} */ ({ byteLength: WASM_MAX_FILE_BYTES + 1 })
  );
  Object.setPrototypeOf(huge, Uint8Array.prototype);
  await assert.rejects(
    engine.open(huge),
    (err) => err instanceof AppError && err.code === 'E_FILE_TOO_LARGE',
  );
  await engine.close();
});

test('snapshot: 트랜잭션 안에서는 거부, saveTo는 E_UNSUPPORTED', async () => {
  const engine = await openWasmEngine();
  await assert.rejects(
    engine.transaction(() => engine.snapshot()),
    (err) =>
      err instanceof AppError &&
      err.code === 'E_DB_QUERY' &&
      /inside transaction/.test(err.message),
  );
  await assert.rejects(
    engine.saveTo('/tmp/x.db', { mtime: 0, size: 0 }),
    (err) => err instanceof AppError && err.code === 'E_UNSUPPORTED',
  );
  await engine.close();
});

test('statement 캐시: 64개를 넘어도 오래된 것이 정리되고 결과는 유지된다', async () => {
  const engine = await openWasmEngine();
  for (let i = 0; i < 80; i += 1) {
    assert.deepEqual(engine.exec(`SELECT ${i} AS n`).rows, [[i]]);
  }
  assert.deepEqual(engine.exec('SELECT 0 AS n').rows, [[0]]);
  await engine.close();
});
