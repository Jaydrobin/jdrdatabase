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

test('statement 캐시: 쓰기 실패로 reset이 던져도 캐시와 결과가 일관된다', async () => {
  const engine = await openWasmEngine();
  await engine.transaction(() => {
    engine.run('CREATE TABLE t (a INTEGER) STRICT');
  });
  // oo1의 reset()은 직전 step()의 결과 코드를 다시 검사하므로 쓰기 실패 뒤에는 항상 던진다.
  // 그 경로가 statement를 캐시에서 빼고 finalize까지 하는지 확인한다(빼기만 하면 sqlite3_stmt가 남는다).
  for (let i = 0; i < 50; i += 1) {
    await assert.rejects(
      engine.transaction(() => engine.run(`INSERT INTO t VALUES (?) /* ${i} */`, ['not-an-int'])),
      (err) => err instanceof AppError && err.code === 'E_DB_QUERY',
    );
  }
  await engine.transaction(() => {
    engine.run('INSERT INTO t VALUES (?)', [1]);
  });
  assert.deepEqual(engine.exec('SELECT a FROM t').rows, [[1]]);
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

test('메모리 한계(Step 10): SQLITE_NOMEM은 삽입·직렬화 모두 E_MEM이고 롤백 뒤 DB는 계속 쓸 수 있다', async () => {
  // wasm 메모리를 10 MB 블롭으로 채운다(약 2 GB에서 sqlite가 NOMEM을 낸다. 실측 6초 안팎).
  // 이전에는 롤백까지 실패해 E_DB_QUERY "rollback failed"로 가려졌고, 직렬화의 NOMEM은 결과 코드가 1이라
  // 일반 질의 오류로 안내됐다.
  const engine = await openWasmEngine();
  await engine.transaction(() =>
    engine.exec('CREATE TABLE big (id INTEGER PRIMARY KEY, b BLOB) STRICT'),
  );
  /** @type {AppError | null} */
  let failure = null;
  let inserted = 0;
  for (let i = 0; i < 400 && !failure; i += 1) {
    try {
      await engine.transaction(() =>
        engine.exec('INSERT INTO big (b) VALUES (zeroblob(?))', [10 * MB]),
      );
      inserted += 1;
    } catch (err) {
      failure = err instanceof AppError ? err : null;
      assert.ok(failure, `AppError여야 한다: ${String(err)}`);
    }
  }
  assert.ok(failure, '400개(4 GB)를 넣기 전에 메모리 한계에 닿아야 한다');
  assert.equal(failure.code, 'E_MEM', failure.message);
  assert.ok(inserted > 50, `한계 전에 상당량이 들어가야 한다(${inserted})`);
  // 직렬화도 같은 코드. `sqlite3_js_db_export`의 NOMEM은 결과 코드 없이 메시지로만 온다.
  await assert.rejects(
    async () => engine.snapshot(),
    (err) => err instanceof AppError && err.code === 'E_MEM',
  );
  // 실패한 트랜잭션은 롤백됐고 DB는 계속 쓸 수 있다(작업 중단 → 저장 유도).
  const { rows } = engine.exec('SELECT count(*) FROM big');
  assert.deepEqual(rows, [[inserted]]);
  await engine.transaction(() => engine.exec('DELETE FROM big'));
  await engine.close();
});
