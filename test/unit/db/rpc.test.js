// @ts-check
/**
 * RPC 계층: 디스패처(worker.js) ↔ 클라이언트(client.js)를 인라인 전송으로 잇고 프로토콜을 검사한다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient, createInlineTransport, createTransport } from '../../../src/db/client.js';
import {
  createDispatcher,
  createProgressReporter,
  EXCLUSIVE_OPS,
  isExclusiveOp,
} from '../../../src/db/worker.js';
import { AppError } from '../../../src/util/errors.js';
import { loadWasmBinary } from './helpers.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures');

/** @typedef {import('../../../src/db/worker.js').RpcOutbound} RpcOutbound */

/** 초기화되고 빈 DB가 열린 인라인 클라이언트. */
async function readyClient() {
  const client = createClient({ transport: createInlineTransport() });
  const wasm = await loadWasmBinary();
  const init = await client.call('engine.init', { mode: 'wasm', wasmBinary: wasm });
  await client.call('db.open', {});
  return { client, init };
}

test('engine.init → db.open → engine.exec SELECT 1 (인라인 전송)', async () => {
  const { client, init } = await readyClient();
  assert.match(init.version, /^3\./);
  assert.ok(init.compileOptions.includes('ENABLE_FTS5'));
  assert.equal(init.capabilities.mode, 'wasm');
  const result = await client.call('engine.exec', { sql: 'SELECT 1 AS one' });
  assert.deepEqual(result, { columns: ['one'], rows: [[1]] });
  assert.equal(await client.call('db.close'), null);
  client.close();
});

test('오류는 직렬화되어 같은 AppError로 복원된다', async () => {
  const { client } = await readyClient();
  await assert.rejects(
    client.call('engine.exec', { sql: 'SELEC 1' }),
    (err) =>
      err instanceof AppError && err.code === 'E_DB_QUERY' && /syntax error/.test(err.message),
  );
  await assert.rejects(
    client.call(/** @type {never} */ ('nope.op')),
    (err) => err instanceof AppError && err.code === 'E_UNKNOWN' && /unknown op/.test(err.message),
  );
  client.close();
});

test('engine.init 전의 요청은 E_DB_QUERY로 거부된다', async () => {
  const client = createClient({ transport: createInlineTransport() });
  await assert.rejects(
    client.call('engine.exec', { sql: 'SELECT 1' }),
    (err) => err instanceof AppError && err.code === 'E_DB_QUERY',
  );
  client.close();
});

test('db.snapshot: 바이트가 transfer로 넘어오고 새 세션에서 열린다', async () => {
  const { client } = await readyClient();
  /** @type {Array<[unknown, Transferable[] | undefined]>} */
  const posted = [];
  const dispatcher = createDispatcher({ post: (m, t) => posted.push([m, t]) });
  const wasm = await loadWasmBinary();
  await dispatcher.dispatch({ id: 1, op: 'engine.init', args: { mode: 'wasm', wasmBinary: wasm } });
  await dispatcher.dispatch({ id: 2, op: 'db.open', args: {} });
  await dispatcher.dispatch({ id: 3, op: 'db.snapshot', args: {} });
  const last = posted.at(-1);
  assert.ok(last);
  const [message, transfer] = last;
  const bytes = /** @type {{ result: { bytes: Uint8Array } }} */ (message).result.bytes;
  assert.ok(bytes instanceof Uint8Array);
  assert.deepEqual(transfer, [bytes.buffer]);

  const opened = await client.call('db.open', { bytes });
  assert.equal(opened.meta.revision, '0');
  assert.match(opened.meta.db_id ?? '', /^[0-9a-f-]{36}$/);
  assert.deepEqual(opened.tables, []);
  assert.deepEqual(
    (await client.call('engine.exec', { sql: 'SELECT count(*) FROM _jdr_meta' })).rows,
    [[5]],
  );
  client.close();
});

test('db.open: 빈 DB에 메타를 만들고, dbId를 주면 그 값으로', async () => {
  const { client } = await readyClient();
  const opened = await client.call('db.open', { dbId: '00000000-0000-4000-8000-000000000001' });
  assert.equal(opened.meta.db_id, '00000000-0000-4000-8000-000000000001');
  assert.equal(opened.meta.app_version, '0.0.0', 'engine.init에 appVersion이 없으면 기본값');
  client.close();
});

test('db.snapshot: bumpRevision이면 revision·saved_at·saved_by를 기록하고 meta를 함께 돌려준다', async () => {
  const { client } = await readyClient();
  const plain = await client.call('db.snapshot', {});
  assert.equal(plain.meta.revision, '0');
  const bumped = await client.call('db.snapshot', { bumpRevision: true, savedBy: 'PC-1' });
  assert.equal(bumped.meta.revision, '1');
  assert.equal(bumped.meta.saved_by, 'PC-1');
  assert.ok(bumped.meta.saved_at);
  const reopened = await client.call('db.open', { bytes: bumped.bytes });
  assert.equal(reopened.meta.revision, '1');
  client.close();
});

test('db.open: 메타 없는 외부 파일은 unmanaged로 열리고 schema.adopt가 등록한다', async () => {
  const { client } = await readyClient();
  await client.call('db.open', {});
  await client.call('engine.exec', { sql: 'CREATE TABLE ext (a TEXT)' });
  // 메타를 지워 "다른 도구가 만든 파일"을 만든다.
  for (const t of ['_jdr_columns', '_jdr_views', '_jdr_tables', '_jdr_meta']) {
    await client.call('engine.exec', { sql: `DROP TABLE ${t}` });
  }
  const { bytes } = await client.call('db.snapshot', {}).catch(() => ({ bytes: null }));
  assert.ok(bytes, 'db.snapshot은 메타가 없어도 동작해야 한다');
  const opened = await client.call('db.open', { bytes });
  assert.equal(opened.unmanaged, true);
  assert.deepEqual(opened.meta, {});
  const adopted = await client.call('schema.adopt');
  assert.equal(adopted.unmanaged, undefined);
  assert.ok(adopted.meta.db_id);
  assert.deepEqual(
    (await client.call('engine.exec', { sql: 'SELECT id, strict FROM _jdr_tables' })).rows,
    [['ext', 0]],
  );
  // adoptExternal 인자를 주면 한 번에 등록한다.
  const direct = await client.call('db.open', {
    bytes: (await client.call('db.snapshot', {})).bytes,
  });
  assert.equal(direct.unmanaged, undefined, '이미 메타가 있으니 관리 대상');
  client.close();
});

test('db.open: 헤더 불일치는 E_FILE_NOT_SQLITE, 손상은 E_FILE_CORRUPT이며 이후 새 DB를 열 수 있다', async () => {
  const { client } = await readyClient();
  const junk = new TextEncoder().encode('x'.repeat(200));
  await assert.rejects(
    client.call('db.open', { bytes: junk }),
    (err) => err instanceof AppError && err.code === 'E_FILE_NOT_SQLITE',
  );
  const corrupt = new Uint8Array(await readFile(path.join(FIXTURES, 'corrupt.db')));
  await assert.rejects(
    client.call('db.open', { bytes: corrupt }),
    (err) => err instanceof AppError && err.code === 'E_FILE_CORRUPT',
  );
  await assert.rejects(
    client.call('engine.exec', { sql: 'SELECT 1' }),
    (err) => err instanceof AppError && err.code === 'E_DB_QUERY',
    '손상 파일은 열린 채로 두지 않는다',
  );
  const fresh = await client.call('db.open', {});
  assert.equal(fresh.meta.revision, '0');
  client.close();
});

test('command.apply: do/undo 방향, 잘못된 형태는 E_DB_QUERY', async () => {
  const { client } = await readyClient();
  /** @type {import('../../../src/db/command.js').Command} */
  const cmd = {
    type: 'table.create',
    tableId: null,
    do: [
      { sql: 'CREATE TABLE t (a INTEGER) STRICT' },
      { sql: 'INSERT INTO t VALUES (?)', params: [1] },
    ],
    undo: [{ sql: 'DROP TABLE t' }],
    summary: 'create t',
  };
  assert.deepEqual(await client.call('command.apply', { cmd }), { affected: 1 });
  assert.deepEqual((await client.call('engine.exec', { sql: 'SELECT a FROM t' })).rows, [[1]]);
  await client.call('command.apply', { cmd, direction: 'undo' });
  assert.deepEqual(
    (
      await client.call('engine.exec', {
        sql: "SELECT count(*) FROM sqlite_master WHERE name = 't'",
      })
    ).rows,
    [[0]],
  );
  await assert.rejects(
    client.call('command.apply', { cmd: /** @type {never} */ ({ type: 'x' }) }),
    (err) => err instanceof AppError && err.code === 'E_DB_QUERY',
  );
  client.close();
});

test('db.open 진행 중의 다른 요청과 배타 op 충돌은 E_DB_BUSY', async () => {
  /** @type {RpcOutbound[]} */
  const out = [];
  const gate = { release: /** @type {(() => void) | null} */ (null) };
  const fakeEngine = /** @type {import('../../../src/db/engine.js').Engine} */ (
    /** @type {unknown} */ ({
      init: async () => ({ sqliteVersion: '3.99.0', compileOptions: [] }),
      capabilities: () => ({ mode: 'wasm' }),
      open: () =>
        new Promise((resolve) => {
          gate.release = () => resolve(undefined);
        }),
      exec: () => ({ columns: [], rows: [] }),
      run: () => ({ changes: 0, lastId: 0 }),
      prepareCached: (/** @type {string} */ sql) => ({ sql }),
      transaction: (/** @type {() => unknown} */ fn) => Promise.resolve(fn()),
      close: async () => {},
      snapshot: () => new Uint8Array(0),
    })
  );
  const dispatcher = createDispatcher({
    post: (m) => out.push(m),
    selectEngineImpl: () => fakeEngine,
  });
  await dispatcher.dispatch({ id: 1, op: 'engine.init', args: { mode: 'wasm' } });
  const opening = dispatcher.dispatch({ id: 2, op: 'db.open', args: {} });
  await dispatcher.dispatch({ id: 3, op: 'engine.exec', args: { sql: 'SELECT 1' } });
  const busy = out.find((m) => 'id' in m && m.id === 3);
  assert.ok(busy && 'ok' in busy && busy.ok === false && busy.error.code === 'E_DB_BUSY');
  assert.ok(gate.release);
  gate.release();
  await opening;
  const opened = out.find((m) => 'id' in m && m.id === 2);
  assert.ok(opened && 'ok' in opened && opened.ok === true);
  assert.deepEqual([...EXCLUSIVE_OPS].sort(), ['command.apply', 'import.run', 'search.enable']);
  assert.equal(isExclusiveOp('schema.create'), true);
  assert.equal(isExclusiveOp('schema.list'), false);
  assert.equal(isExclusiveOp('query.window'), false);
});

test('취소 메시지는 진행 중 요청의 signal을 abort한다', async () => {
  /** @type {RpcOutbound[]} */
  const out = [];
  const gate = { release: /** @type {(() => void) | null} */ (null) };
  const fakeEngine = /** @type {import('../../../src/db/engine.js').Engine} */ (
    /** @type {unknown} */ ({
      init: async () => ({ sqliteVersion: '3.99.0', compileOptions: [] }),
      capabilities: () => ({ mode: 'wasm' }),
      open: async () => {},
      exec: () => ({ columns: [], rows: [] }),
      run: () => ({ changes: 0, lastId: 0 }),
      prepareCached: (/** @type {string} */ sql) => ({ sql }),
      transaction: (/** @type {() => unknown} */ fn) => Promise.resolve(fn()),
      close: async () => {},
    })
  );
  const dispatcher = createDispatcher({
    post: (m) => out.push(m),
    selectEngineImpl: () => fakeEngine,
  });
  await dispatcher.dispatch({ id: 1, op: 'engine.init', args: { mode: 'wasm' } });
  // 핸들러 문맥의 signal을 관찰하기 위해 db.open을 느리게 만든다.
  fakeEngine.open = () =>
    new Promise((resolve) => {
      gate.release = () => resolve(undefined);
    });
  const slow = dispatcher.dispatch({ id: 2, op: 'db.open', args: {} });
  await dispatcher.dispatch({ id: 2, cancel: true });
  assert.ok(gate.release);
  gate.release();
  await slow;
  const ok = out.find((m) => 'id' in m && m.id === 2);
  assert.ok(ok && 'ok' in ok && ok.ok === true);
});

test('client: signal이 이미 abort된 호출은 보내지 않고 E_IMPORT_CANCELLED', async () => {
  const client = createClient({ transport: createInlineTransport() });
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    client.call('engine.exec', { sql: 'SELECT 1' }, { signal: controller.signal }),
    (err) => err instanceof AppError && err.code === 'E_IMPORT_CANCELLED',
  );
  client.close();
});

test('client.close: 대기 중인 호출을 거부한다', async () => {
  /** @type {import('../../../src/db/client.js').Transport} */
  const silent = {
    kind: 'inline',
    post: () => {},
    onMessage: () => {},
    onFatal: () => {},
    close: () => {},
  };
  const client = createClient({ transport: silent });
  const pending = client.call('engine.exec', { sql: 'SELECT 1' });
  client.close();
  await assert.rejects(
    pending,
    (err) => err instanceof AppError && /client closed/.test(err.message),
  );
});

test('client: 부팅 후 Worker가 죽으면 대기 중인 호출이 거부된다', async () => {
  // RPC에는 타임아웃이 없으므로, 전송 계층이 치명적 오류를 알리지 않으면 호출이 영원히 멈춘다.
  /** @type {((err: AppError) => void)[]} */
  const fatals = [];
  /** @type {import('../../../src/db/client.js').Transport} */
  const silent = {
    kind: 'worker',
    post: () => {},
    onMessage: () => {},
    onFatal: (h) => {
      fatals.push(h);
    },
    close: () => {},
  };
  const client = createClient({ transport: silent });
  const pending = client.call('engine.exec', { sql: 'SELECT 1' });
  const fatal = fatals.at(-1);
  assert.ok(fatal, 'client가 전송 계층의 치명적 오류를 구독해야 한다');
  fatal(new AppError('E_ENV_NO_WORKER', 'worker terminated'));
  await assert.rejects(pending, (err) => err instanceof AppError && err.code === 'E_ENV_NO_WORKER');
});

test('createProgressReporter: 250 ms 간격, 단계 변경·완료는 즉시', () => {
  let now = 1_000;
  /** @type {import('../../../src/db/worker.js').RpcProgress[]} */
  const sent = [];
  const report = createProgressReporter(
    (p) => sent.push(p),
    () => now,
  );
  report({ phase: 'insert', done: 1, total: 100 });
  now += 100;
  report({ phase: 'insert', done: 2, total: 100 });
  now += 200;
  report({ phase: 'insert', done: 3, total: 100 });
  report({ phase: 'index', done: 0, total: 10 });
  report({ phase: 'index', done: 10, total: 10 });
  assert.deepEqual(
    sent.map((p) => `${p.phase}:${p.done}`),
    ['insert:1', 'insert:3', 'index:0', 'index:10'],
  );
});

test('createTransport: Worker 소스가 없거나 생성이 실패하면 인라인으로 폴백(E_ENV_NO_WORKER)', async () => {
  const none = await createTransport({});
  assert.equal(none.transport.kind, 'inline');
  assert.equal(none.fallbackError?.code, 'E_ENV_NO_WORKER');

  const failing = await createTransport({
    workerSource: 'x',
    createWorker: () => {
      throw new AppError('E_ENV_NO_WORKER', 'SecurityError');
    },
  });
  assert.equal(failing.transport.kind, 'inline');
  assert.match(failing.fallbackError?.message ?? '', /SecurityError/);
});

test('createTransport: 준비 신호가 오면 Worker 전송, 시간 안에 오지 않으면 인라인', async () => {
  /** @param {boolean} ready */
  const fakeWorker = (ready) => {
    /** @type {((m: RpcOutbound) => void) | null} */
    let handler = null;
    const worker = /** @type {Worker} */ (
      /** @type {unknown} */ ({ onerror: null, terminate() {} })
    );
    /** @type {import('../../../src/db/client.js').Transport} */
    const transport = {
      kind: 'worker',
      post: () => {},
      onMessage: (h) => {
        handler = h;
        if (ready) queueMicrotask(() => handler?.({ ready: true }));
      },
      onFatal: () => {},
      close: () => {},
    };
    return { transport, worker };
  };
  const ok = await createTransport({
    workerSource: 'x',
    createWorker: () => fakeWorker(true),
    handshakeTimeoutMs: 50,
  });
  assert.equal(ok.transport.kind, 'worker');
  assert.equal(ok.fallbackError, null);
  const slow = await createTransport({
    workerSource: 'x',
    createWorker: () => fakeWorker(false),
    handshakeTimeoutMs: 50,
  });
  assert.equal(slow.transport.kind, 'inline');
  assert.match(slow.fallbackError?.message ?? '', /did not start/);
});
