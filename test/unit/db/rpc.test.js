// @ts-check
/**
 * RPC 계층: 디스패처(worker.js) ↔ 클라이언트(client.js)를 인라인 전송으로 잇고 프로토콜을 검사한다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient, createInlineTransport, createTransport } from '../../../src/db/client.js';
import { createDispatcher, createProgressReporter, EXCLUSIVE_OPS } from '../../../src/db/worker.js';
import { AppError } from '../../../src/util/errors.js';
import { loadWasmBinary } from './helpers.js';

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
  assert.deepEqual(opened, { meta: {}, tables: [] });
  assert.deepEqual(
    (await client.call('engine.exec', { sql: 'SELECT count(*) FROM sqlite_master' })).rows,
    [[0]],
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
  const silent = { kind: 'inline', post: () => {}, onMessage: () => {}, close: () => {} };
  const client = createClient({ transport: silent });
  const pending = client.call('engine.exec', { sql: 'SELECT 1' });
  client.close();
  await assert.rejects(
    pending,
    (err) => err instanceof AppError && /client closed/.test(err.message),
  );
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
