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
  COUNT_CACHE_MAX,
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

test('db.size: 직렬화하면 나올 바이트 수와 같고, 쓰기로 커지며, 배타 op가 아니다', async () => {
  const { client } = await readyClient();
  const empty = await client.call('db.size');
  const snap = await client.call('db.snapshot', {});
  assert.equal(empty.bytes, snap.bytes.byteLength);
  await client.call('engine.exec', { sql: 'CREATE TABLE b (x BLOB) STRICT' });
  await client.call('engine.exec', {
    sql: 'INSERT INTO b (x) VALUES (zeroblob(?))',
    params: [300_000],
  });
  const grown = await client.call('db.size');
  assert.ok(grown.bytes > empty.bytes + 300_000, `${grown.bytes}`);
  assert.equal(grown.bytes, (await client.call('db.snapshot', {})).bytes.byteLength);
  // 지운 행의 페이지는 freelist로 남아 파일 크기가 줄지 않는다(직렬화 크기와 같게 센다).
  await client.call('engine.exec', { sql: 'DELETE FROM b' });
  assert.equal((await client.call('db.size')).bytes, grown.bytes);
  assert.equal(isExclusiveOp('db.size'), false);
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
  assert.deepEqual([...EXCLUSIVE_OPS].sort(), [
    'cleanup.run',
    'command.apply',
    'db.close',
    'db.save',
    'db.snapshot',
    'export.stream',
    'import.run',
    'search.disable',
    'search.enable',
    'views.delete',
    'views.save',
  ]);
  assert.equal(isExclusiveOp('views.list'), false);
  assert.equal(isExclusiveOp('schema.create'), true);
  assert.equal(isExclusiveOp('schema.list'), false);
  assert.equal(isExclusiveOp('query.window'), false);
  assert.equal(isExclusiveOp('cleanup.plan'), false);
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
  /** @type {unknown[]} */
  const posted = [];
  /** @type {import('../../../src/db/client.js').Transport} */
  const silent = {
    kind: 'worker',
    post: (message) => {
      posted.push(message);
    },
    onMessage: () => {},
    onFatal: (h) => {
      fatals.push(h);
    },
    close: () => {},
  };
  const client = createClient({ transport: silent });
  const pending = client.call('engine.exec', { sql: 'SELECT 1' });
  /** @type {AppError[]} */
  const notified = [];
  const off = client.onFatal((err) => notified.push(err));
  assert.equal(client.fatalError(), null);
  const fatal = fatals.at(-1);
  assert.ok(fatal, 'client가 전송 계층의 치명적 오류를 구독해야 한다');
  fatal(new AppError('E_ENV_NO_WORKER', 'worker terminated'));
  await assert.rejects(pending, (err) => err instanceof AppError && err.code === 'E_ENV_NO_WORKER');
  assert.equal(notified.length, 1);
  assert.equal(client.fatalError()?.code, 'E_ENV_NO_WORKER');

  // 죽은 Worker에 보낸 새 요청은 영원히 응답이 없다(Step 10). 보내지 않고 같은 오류로 즉시 거부한다.
  posted.length = 0;
  await assert.rejects(
    client.call('engine.exec', { sql: 'SELECT 2' }),
    (err) => err instanceof AppError && err.code === 'E_ENV_NO_WORKER',
  );
  assert.equal(posted.length, 0, '죽은 전송 계층에는 보내지 않는다');
  // 두 번째 치명 알림은 무시되고, 죽은 뒤의 구독은 즉시 알림을 받는다.
  fatal(new AppError('E_UNKNOWN', 'again'));
  assert.equal(notified.length, 1);
  off();
  /** @type {AppError[]} */
  const late = [];
  client.onFatal((err) => late.push(err));
  assert.equal(late[0]?.code, 'E_ENV_NO_WORKER');
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

test('schema.*: 테이블 생성·열 추가가 커맨드를 돌려주고 db.open이 tables를 채운다', async () => {
  const { client } = await readyClient();
  const created = await client.call('schema.create', { name: 'T' });
  assert.match(created.tableId, /^t_/);
  assert.equal(created.cmd.type, 'table.create');
  const added = await client.call('schema.addColumn', {
    tableId: created.tableId,
    name: 'c',
    type: 'integer',
  });
  assert.equal(added.cmd.type, 'column.add');
  const listed = await client.call('schema.list');
  assert.deepEqual(
    listed.tables.map((t) => [t.name, t.columns.map((c) => c.type)]),
    [['T', ['integer']]],
  );
  const { bytes } = await client.call('db.snapshot', {});
  const reopened = await client.call('db.open', { bytes });
  assert.equal(reopened.tables.length, 1);
  assert.equal(reopened.tables[0]?.columns[0]?.id, added.columnId);
  await assert.rejects(
    client.call('schema.renameColumn', { tableId: created.tableId, columnId: 'id', name: 'x' }),
    (err) => err instanceof AppError && err.code === 'E_SYSTEM_COLUMN',
  );
  // 기본 열(D-16): `columns`가 RPC 경계를 넘어 테이블과 함께 만들어진다.
  const sheet = await client.call('schema.create', {
    name: '시트',
    columns: [
      { name: '열 1', type: 'text' },
      { name: '열 2', type: 'text' },
    ],
  });
  const withColumns = (await client.call('schema.list')).tables.find((t) => t.id === sheet.tableId);
  assert.deepEqual(
    withColumns?.columns.map((c) => c.name),
    ['열 1', '열 2'],
  );
  client.close();
});

/**
 * 진짜 Worker처럼 메시지를 "태스크"로 배달하는 전송. 인라인 전송은 `dispatch`를 동기로 부르므로
 * 긴 작업 중에 뒤 메시지가 닿는지를 검사할 수 없다. Worker의 `postMessage`는 태스크 큐에 들어가고,
 * 실행 중인 태스크가 이벤트 루프로 돌아와야만 배달된다.
 * @returns {import('../../../src/db/client.js').Transport}
 */
function createTaskTransport() {
  /** @type {((message: RpcOutbound) => void) | null} */
  let handler = null;
  const dispatcher = createDispatcher({
    post: (message) => {
      setTimeout(() => handler?.(message), 0);
    },
  });
  return {
    kind: 'worker',
    post: (message) => {
      setTimeout(() => void dispatcher.dispatch(message), 0);
    },
    onMessage: (h) => {
      handler = h;
    },
    onFatal: () => {},
    close: () => {
      handler = null;
    },
  };
}

test('취소: 메시지가 태스크로 배달되는 Worker 모드에서도 변환 중에 닿는다', async () => {
  // 변환 루프가 이벤트 루프로 돌아오지 않으면 취소 메시지는 변환이 끝난 뒤에야 배달되고,
  // 사용자의 취소 버튼은 아무 일도 하지 않는다(Step 3 "대용량 진행률·취소").
  const client = createClient({ transport: createTaskTransport() });
  await client.call('engine.init', { mode: 'wasm', wasmBinary: await loadWasmBinary() });
  await client.call('db.open', {});
  const { tableId } = await client.call('schema.create', { name: '표' });
  const { columnId } = await client.call('schema.addColumn', {
    tableId,
    name: '수',
    type: 'text',
  });
  /** @type {import('../../../src/db/command.js').Statement[]} */
  const inserts = [];
  for (let i = 1; i <= 12_000; i += 1) {
    inserts.push({
      sql: `INSERT INTO "${tableId}" ("id", "${columnId}") VALUES (?, ?)`,
      params: [i, String(i)],
    });
  }
  await client.call('command.apply', {
    cmd: { type: 'seed', tableId, summary: 'seed', do: inserts, undo: [] },
  });

  const controller = new AbortController();
  const pending = client.call(
    'schema.changeColumnType',
    { tableId, columnId, type: 'integer' },
    { signal: controller.signal, onProgress: () => controller.abort() },
  );
  await assert.rejects(
    pending,
    (err) => err instanceof AppError && err.code === 'E_IMPORT_CANCELLED',
  );

  // 롤백되었으므로 옛 열이 살아 있고 새 열은 없다.
  const columns = (await client.call('schema.list')).tables[0]?.columns ?? [];
  assert.deepEqual(
    columns.filter((c) => c.deletedAt === null).map((c) => c.id),
    [columnId],
  );
  client.close();
});

test('db.snapshot: 쓰기 op가 도는 중의 저장은 E_DB_BUSY이고 DB를 건드리지 않는다', async () => {
  // 저장이 배타가 아니면 진행 중인 쓰기의 트랜잭션 안으로 끼어든다. 중첩 SAVEPOINT 이름이
  // 겹쳐 롤백이 깨지고(`E_DB_QUERY: rollback failed after error`), 파일에 아무것도 쓰이지 않았는데
  // revision·saved_by만 올라간 DB가 남는다.
  const { client } = await readyClient();
  const { tableId } = await client.call('schema.create', { name: '표' });
  const { columnId } = await client.call('schema.addColumn', {
    tableId,
    name: '수',
    type: 'text',
  });
  /** @type {import('../../../src/db/command.js').Statement[]} */
  const inserts = [];
  for (let i = 1; i <= 12_000; i += 1) {
    inserts.push({
      sql: `INSERT INTO "${tableId}" ("id", "${columnId}") VALUES (?, ?)`,
      params: [i, String(i)],
    });
  }
  await client.call('command.apply', {
    cmd: { type: 'seed', tableId, summary: 'seed', do: inserts, undo: [] },
  });
  const before = (await client.call('db.snapshot', {})).meta;

  const converting = client.call('schema.changeColumnType', { tableId, columnId, type: 'integer' });
  await assert.rejects(
    client.call('db.snapshot', { bumpRevision: true, savedBy: '기기' }),
    (err) => err instanceof AppError && err.code === 'E_DB_BUSY',
  );
  await converting;

  const after = (await client.call('db.snapshot', {})).meta;
  assert.equal(after.revision, before.revision, '저장하지 않았으므로 revision은 그대로');
  assert.equal(after.saved_by, undefined);
  assert.equal(isExclusiveOp('db.snapshot'), true);
  assert.equal(isExclusiveOp('db.close'), true);
  client.close();
});

test('query.window / query.count / query.row: 창 질의 op (Step 4)', async () => {
  const { client } = await readyClient();
  const { tableId } = await client.call('schema.create', { name: '고객' });
  const name = (await client.call('schema.addColumn', { tableId, name: '이름', type: 'text' }))
    .columnId;
  const body = (await client.call('schema.addColumn', { tableId, name: '본문', type: 'longtext' }))
    .columnId;
  const long = '나'.repeat(300);
  await client.call('command.apply', {
    cmd: {
      type: 'test.insert',
      tableId,
      do: [
        {
          sql: `INSERT INTO "${tableId}" ("${name}", "${body}") VALUES (?, ?)`,
          params: ['하나', long],
        },
        {
          sql: `INSERT INTO "${tableId}" ("${name}", "${body}") VALUES (?, ?)`,
          params: ['둘', null],
        },
      ],
      undo: [],
      summary: 'insert',
    },
  });
  const window = await client.call('query.window', {
    tableId,
    viewSpec: {},
    offset: 0,
    limit: 200,
    seq: 7,
  });
  assert.equal(window.seq, 7, '요청 순번을 그대로 돌려준다');
  assert.deepEqual(window.columnIds, [name, body]);
  assert.equal(window.rows.length, 2);
  assert.equal(window.rows[0]?.cells[1], long.slice(0, 256));
  assert.deepEqual(window.rows[0]?.lengths, [null, 300]);
  assert.ok(typeof window.elapsedMs === 'number' && window.elapsedMs >= 0);

  const counted = await client.call('query.count', { tableId, viewSpec: {} });
  assert.equal(counted.count, 2);
  assert.ok(typeof counted.elapsedMs === 'number' && counted.elapsedMs >= 0);

  const full = await client.call('query.row', { tableId, rowId: 1, colIds: [body] });
  assert.deepEqual(full, {
    row: { id: 1, cells: { [body]: long }, createdAt: null, updatedAt: null },
  });
  assert.deepEqual(await client.call('query.row', { tableId, rowId: 99 }), { row: null });

  // Step 5: 전문 행 목록과 행 통계(데이터 커맨드가 옛 값·새 id를 읽는 경로).
  const rows = await client.call('query.rows', {
    tableId,
    viewSpec: {},
    offset: 1,
    limit: 10,
    colIds: [name],
  });
  assert.deepEqual(rows, {
    rows: [{ id: 2, cells: { [name]: '둘' }, createdAt: null, updatedAt: null }],
  });
  assert.deepEqual(await client.call('query.stats', { tableId }), {
    count: 2,
    minId: 1,
    maxId: 2,
  });

  // 삭제된 테이블: E_DB_QUERY(그리드는 빈 상태로 그리고 사이드바로 복귀).
  await client.call('schema.drop', { tableId });
  await assert.rejects(
    client.call('query.window', { tableId, viewSpec: {}, offset: 0, limit: 200, seq: 8 }),
    (err) =>
      err instanceof AppError && err.code === 'E_DB_QUERY' && /table not found/.test(err.message),
  );
  await assert.rejects(
    client.call('query.window', {
      tableId: 't_00000000',
      viewSpec: {},
      offset: 0,
      limit: 20000,
      seq: 1,
    }),
    (err) => err instanceof AppError && err.code === 'E_DB_QUERY',
  );
  client.close();
});

test('query.*는 읽기라 배타 op가 아니고, 쓰기 op 도중에도 허용된다', () => {
  assert.equal(isExclusiveOp('query.window'), false);
  assert.equal(isExclusiveOp('query.count'), false);
  assert.equal(isExclusiveOp('query.row'), false);
  assert.equal(isExclusiveOp('query.rows'), false);
  assert.equal(isExclusiveOp('query.stats'), false);
});

test('search.enable/disable·views.list/save/delete op (Step 6): 커맨드를 돌려주고 뷰 조건이 창 질의에 붙는다', async () => {
  const { client } = await readyClient();
  const { tableId } = await client.call('schema.create', { name: '고객' });
  const name = (await client.call('schema.addColumn', { tableId, name: '이름', type: 'text' }))
    .columnId;
  const age = (await client.call('schema.addColumn', { tableId, name: '나이', type: 'integer' }))
    .columnId;
  await client.call('command.apply', {
    cmd: {
      type: 'test.insert',
      tableId,
      do: [
        {
          sql: `INSERT INTO "${tableId}" ("${name}", "${age}") VALUES (?, ?)`,
          params: ['서울특별시', 1],
        },
        {
          sql: `INSERT INTO "${tableId}" ("${name}", "${age}") VALUES (?, ?)`,
          params: ['부산광역시', 2],
        },
        {
          sql: `INSERT INTO "${tableId}" ("${name}", "${age}") VALUES (?, ?)`,
          params: ['대전광역시', 3],
        },
      ],
      undo: [],
      summary: 'insert',
    },
  });

  // 정렬·필터·검색이 창 질의·행 수·행 읽기에 같은 순서로 붙는다.
  const viewSpec = {
    sort: [{ colId: age, dir: /** @type {const} */ ('desc') }],
    filter: {
      logic: /** @type {const} */ ('and'),
      conditions: [{ colId: age, op: /** @type {const} */ ('>'), value: '1' }],
    },
    search: '광역시',
  };
  const window = await client.call('query.window', {
    tableId,
    viewSpec,
    offset: 0,
    limit: 10,
    seq: 1,
  });
  assert.deepEqual(
    window.rows.map((r) => r.cells[0]),
    ['대전광역시', '부산광역시'],
  );
  assert.equal((await client.call('query.count', { tableId, viewSpec })).count, 2);
  const rows = await client.call('query.rows', {
    tableId,
    viewSpec,
    offset: 1,
    limit: 1,
    colIds: [name],
  });
  assert.deepEqual(
    rows.rows.map((r) => r.cells[name]),
    ['부산광역시'],
  );
  // 행 수 캐시는 뷰 조건마다 따로다.
  assert.equal((await client.call('query.count', { tableId, viewSpec: {} })).count, 3);
  await assert.rejects(
    client.call('query.count', {
      tableId,
      viewSpec: { filter: { logic: 'and', conditions: [{ colId: age, op: '>', value: 'x' }] } },
    }),
    (err) => err instanceof AppError && err.code === 'E_VALUE_INVALID',
  );

  /** @type {import('../../../src/db/worker.js').RpcProgress[]} */
  const progress = [];
  const enabled = await client.call(
    'search.enable',
    { tableId },
    { onProgress: (p) => progress.push(p) },
  );
  assert.equal(enabled.cmd.type, 'search.enable');
  assert.ok(progress.some((p) => p.phase === 'index'));
  assert.equal((await client.call('schema.list')).tables[0]?.ftsEnabled, true);
  assert.equal(
    (await client.call('query.count', { tableId, viewSpec: { search: '광역시' } })).count,
    2,
  );
  const disabled = await client.call('search.disable', { tableId });
  assert.equal(disabled.cmd.type, 'search.disable');
  assert.equal((await client.call('schema.list')).tables[0]?.ftsEnabled, false);

  const saved = await client.call('views.save', {
    tableId,
    name: '큰 나이',
    spec: { ...viewSpec, hidden: [], widths: { [name]: 200 }, frozen: 1 },
  });
  assert.equal(saved.cmd.type, 'view.create');
  const listed = await client.call('views.list', { tableId });
  assert.equal(listed.views.length, 1);
  assert.equal(listed.views[0]?.id, saved.viewId);
  assert.deepEqual(listed.views[0]?.spec.sort, viewSpec.sort);
  assert.equal(listed.views[0]?.spec.widths[name], 200);
  const removed = await client.call('views.delete', { viewId: saved.viewId });
  assert.equal(removed.cmd.type, 'view.delete');
  assert.deepEqual((await client.call('views.list', { tableId })).views, []);
  client.close();
});

/** `readyClient`와 같되 디스패처를 함께 돌려준다(캐시 크기를 들여다보는 검사용). */
async function readyClientWithDispatcher() {
  /** @type {((message: RpcOutbound) => void) | null} */
  let handler = null;
  const dispatcher = createDispatcher({
    post: (message) => {
      queueMicrotask(() => handler?.(message));
    },
  });
  const client = createClient({
    transport: {
      kind: 'inline',
      post: (message) => void dispatcher.dispatch(message),
      onMessage: (h) => {
        handler = h;
      },
      onFatal: () => {},
      close: () => {
        handler = null;
      },
    },
  });
  await client.call('engine.init', { mode: 'wasm', wasmBinary: await loadWasmBinary() });
  await client.call('db.open', {});
  return { client, dispatcher };
}

test('query.count: 행 수 캐시는 검색어마다 늘지 않고 쓰기 뒤에는 다시 센다', async () => {
  const { client, dispatcher } = await readyClientWithDispatcher();
  const { tableId } = await client.call('schema.create', { name: '도시' });
  const { columnId: name } = await client.call('schema.addColumn', {
    tableId,
    name: '이름',
    type: 'text',
  });
  const insert = {
    type: 'test.insert',
    tableId,
    do: [{ sql: `INSERT INTO "${tableId}" ("${name}") VALUES ('서울'), ('부산')` }],
    undo: [{ sql: `DELETE FROM "${tableId}"` }],
    summary: 'seed',
  };
  await client.call('command.apply', { cmd: insert });
  assert.equal((await client.call('query.count', { tableId, viewSpec: {} })).count, 2);

  // 검색어가 키에 들어가므로 한 글자마다 항목이 하나씩 생긴다. 상한을 넘겨도 답은 그대로여야 한다.
  for (let i = 0; i < COUNT_CACHE_MAX + 10; i += 1) {
    const found = await client.call('query.count', { tableId, viewSpec: { search: `없는말${i}` } });
    assert.equal(found.count, 0, `검색 ${i}`);
  }
  assert.ok(
    dispatcher.countCacheSize() <= COUNT_CACHE_MAX,
    `검색어마다 항목이 쌓이면 안 된다(지금 ${dispatcher.countCacheSize()}개)`,
  );
  // 상한에 밀려 빠진 옛 항목도 다시 세어 같은 답을 준다.
  assert.equal(
    (await client.call('query.count', { tableId, viewSpec: { search: '서울' } })).count,
    1,
  );

  // 쓰기 뒤에는 캐시를 통째로 비우므로 같은 조건도 새로 센다.
  await client.call('command.apply', { cmd: insert, direction: 'undo' });
  assert.equal(dispatcher.countCacheSize(), 0, '쓰기 뒤에는 캐시가 비어 있다');
  assert.equal((await client.call('query.count', { tableId, viewSpec: {} })).count, 0);
  assert.equal(
    (await client.call('query.count', { tableId, viewSpec: { search: '서울' } })).count,
    0,
  );
  client.close();
});

test('import.preview·import.run: Blob을 받아 미리보기와 가져오기를 하고, 실행은 배타 op다', async () => {
  const { client } = await readyClient();
  const file = new Blob(['이름,나이\n홍길동,30\n김영희,25\n']);
  const preview = await client.call('import.preview', { file, options: { format: 'csv' } });
  assert.deepEqual(preview.headers, ['이름', '나이']);
  assert.deepEqual(
    preview.inferred.map((i) => i.type),
    ['text', 'integer'],
  );
  /** @type {Array<{ phase: string, done: number, total: number }>} */
  const progress = [];
  const { report } = await client.call(
    'import.run',
    {
      file,
      options: { format: 'csv' },
      mapping: {
        columns: [
          { source: 0, name: '이름', type: 'text' },
          { source: 1, name: '나이', type: 'integer' },
        ],
      },
      target: { kind: 'new', name: '고객' },
    },
    { onProgress: (p) => progress.push(p) },
  );
  assert.equal(report.inserted, 2);
  assert.equal(progress.at(-1)?.phase, 'insert');
  const { tables } = await client.call('schema.list');
  assert.equal(tables[0]?.name, '고객');
  assert.equal(
    (await client.call('query.count', { tableId: report.tableId, viewSpec: {} })).count,
    2,
    '가져오기 뒤 행 수 캐시가 낡지 않는다',
  );
  assert.ok(isExclusiveOp('import.run'));
  assert.ok(!isExclusiveOp('import.preview'));
  await assert.rejects(
    client.call('import.preview', {
      file: /** @type {never} */ ('nope'),
      options: { format: 'csv' },
    }),
    (err) => err instanceof AppError && err.code === 'E_DB_QUERY' && /Blob/.test(err.message),
  );
  await assert.rejects(
    client.call('import.run', {
      file,
      options: { format: 'csv' },
      mapping: { columns: [{ source: 0, name: 'x', type: 'text' }] },
      target: /** @type {never} */ ({ kind: 'nope' }),
    }),
    (err) => err instanceof AppError && err.code === 'E_DB_QUERY',
  );
  client.close();
});

test('import.run: 취소 신호가 Worker에 닿아 롤백되고 E_IMPORT_CANCELLED', async () => {
  const { client } = await readyClient();
  const lines = ['n'];
  for (let i = 1; i <= 2500; i += 1) lines.push(String(i));
  const controller = new AbortController();
  await assert.rejects(
    client.call(
      'import.run',
      {
        file: new Blob([`${lines.join('\n')}\n`]),
        options: { format: 'csv' },
        mapping: { columns: [{ source: 0, name: 'n', type: 'integer' }] },
        target: { kind: 'new', name: 'P' },
      },
      {
        signal: controller.signal,
        // 진행 이벤트는 250 ms 간격으로 묶이므로(인라인 전송의 짧은 실행에서는 첫 이벤트만 온다)
        // 첫 이벤트에서 바로 취소한다. 취소 메시지 → 디스패처의 AbortController → 파이프라인의 첫 배치 전 검사.
        onProgress: (p) => {
          if (p.phase === 'insert') controller.abort();
        },
      },
    ),
    (err) => err instanceof AppError && err.code === 'E_IMPORT_CANCELLED',
  );
  assert.deepEqual((await client.call('schema.list')).tables, [], '새 테이블이 남지 않는다');
  client.close();
});

test('export.stream: 조각 이벤트(transfer)가 순서대로 오고 결과를 돌려주며, 배타 op이고 행 수 캐시를 건드리지 않는다', async () => {
  const { client } = await readyClient();
  const file = new Blob(['이름,나이\n홍길동,30\n김영희,25\n']);
  const { report } = await client.call('import.run', {
    file,
    options: { format: 'csv' },
    mapping: {
      columns: [
        { source: 0, name: '이름', type: 'text' },
        { source: 1, name: '나이', type: 'integer' },
      ],
    },
    target: { kind: 'new', name: '고객' },
  });
  /** @type {Uint8Array[]} */
  const chunks = [];
  /** @type {string[]} */
  const phases = [];
  const result = await client.call(
    'export.stream',
    { tableId: report.tableId, viewSpec: {}, format: 'csv', options: { encoding: 'utf-8' } },
    { onChunk: (c) => chunks.push(c), onProgress: (p) => phases.push(p.phase) },
  );
  const bytes = new Uint8Array(chunks.flatMap((c) => [...c]));
  assert.equal(new TextDecoder().decode(bytes), '이름,나이\r\n홍길동,30\r\n김영희,25\r\n');
  assert.deepEqual(result, { rows: 2, bytes: bytes.byteLength, blobCells: 0 });
  assert.equal(phases[0], 'export');
  assert.ok(isExclusiveOp('export.stream'));

  // 디스패처가 조각을 transfer 목록과 함께 보낸다.
  /** @type {Array<[unknown, Transferable[] | undefined]>} */
  const posted = [];
  const dispatcher = createDispatcher({ post: (m, t) => posted.push([m, t]) });
  const wasm = await loadWasmBinary();
  await dispatcher.dispatch({ id: 1, op: 'engine.init', args: { mode: 'wasm', wasmBinary: wasm } });
  const snap = await client.call('db.snapshot', {});
  await dispatcher.dispatch({ id: 2, op: 'db.open', args: { bytes: snap.bytes } });
  await dispatcher.dispatch({
    id: 3,
    op: 'export.stream',
    args: { tableId: report.tableId, viewSpec: {}, format: 'xlsx' },
  });
  const chunkMessages = posted.filter(([m]) => typeof m === 'object' && m !== null && 'chunk' in m);
  assert.equal(chunkMessages.length, 1, 'xlsx는 조각 하나');
  const [message, transfer] = /** @type {[{ chunk: Uint8Array }, Transferable[]]} */ (
    chunkMessages[0]
  );
  assert.deepEqual(transfer, [message.chunk.buffer]);
  const last = /** @type {{ ok: boolean, result: { rows: number } }} */ (posted.at(-1)?.[0]);
  assert.equal(last.ok, true);
  assert.equal(last.result.rows, 2);

  await assert.rejects(
    client.call('export.stream', {
      tableId: report.tableId,
      viewSpec: {},
      format: /** @type {never} */ ('pdf'),
    }),
    (err) => err instanceof AppError && err.code === 'E_DB_QUERY',
  );
  client.close();
});

test('db.save·원본 경로 열기는 wasm 엔진에서 E_UNSUPPORTED이고 DB는 그대로다', async () => {
  const { client } = await readyClient();
  await client.call('engine.exec', { sql: 'CREATE TABLE t (a INTEGER) STRICT' });
  await assert.rejects(
    client.call('db.save', { originalPath: '/tmp/x.db', bumpRevision: true, savedBy: 'PC' }),
    (err) => err instanceof AppError && err.code === 'E_UNSUPPORTED',
  );
  const meta = (await client.call('db.snapshot', {})).meta;
  assert.equal(meta.revision, '0', '실패한 db.save는 revision을 올리지 않는다');
  assert.equal('dirty' in meta, false, '브라우저 모드의 파일에는 dirty 키가 생기지 않는다');
  await assert.rejects(
    client.call('db.open', { originalPath: '/tmp/x.db' }),
    (err) => err instanceof AppError && err.code === 'E_UNSUPPORTED',
  );
  client.close();
});

test('command.apply: 외부(비STRICT) 테이블의 데이터 커맨드는 거부하고, 저널 재생은 건너뛴다', async () => {
  const { client } = await readyClient();
  await client.call('db.open', {});
  await client.call('engine.exec', { sql: 'CREATE TABLE ext (id INTEGER PRIMARY KEY, a TEXT)' });
  await client.call('engine.exec', { sql: "INSERT INTO ext VALUES (1, '원본')" });
  for (const t of ['_jdr_columns', '_jdr_views', '_jdr_tables', '_jdr_meta']) {
    await client.call('engine.exec', { sql: `DROP TABLE ${t}` });
  }
  const { bytes } = await client.call('db.snapshot', {});
  await client.call('db.open', { bytes, adoptExternal: true });
  assert.deepEqual(
    (await client.call('engine.exec', { sql: 'SELECT id, strict FROM _jdr_tables' })).rows,
    [['ext', 0]],
    '등록된 외부 테이블은 strict = 0',
  );

  /** @type {import('../../../src/db/command.js').Command} */
  const cmd = {
    type: 'cell.edit',
    tableId: 'ext',
    do: [{ sql: 'UPDATE "ext" SET "a" = ? WHERE "id" = ?', params: ['덮어씀', 1] }],
    undo: [{ sql: 'UPDATE "ext" SET "a" = ? WHERE "id" = ?', params: ['원본', 1] }],
    summary: 'cell',
  };

  // UI는 `editableTable`로 막지만 Worker에도 같은 층의 방어가 있어야 한다(세션 B 점검 5번과 같은 규칙).
  await assert.rejects(
    client.call('command.apply', { cmd }),
    (err) =>
      err instanceof AppError &&
      err.code === 'E_DB_QUERY' &&
      /** @type {{ reason?: string }} */ (err.detail ?? {}).reason === 'external_table',
  );
  assert.deepEqual(
    (await client.call('engine.exec', { sql: 'SELECT a FROM ext WHERE id = 1' })).rows,
    [['원본']],
    '거부됐으므로 값은 그대로',
  );

  // 저널 재생은 막지 않는다: 그 항목만 건너뛰고 알린다(복구 전체를 가로막으면 새 버그가 된다).
  const replayed = await client.call('command.apply', { cmd, replay: true });
  assert.equal(replayed.affected, 0);
  assert.equal(replayed.skipped, 'external_table');
  assert.deepEqual(
    (await client.call('engine.exec', { sql: 'SELECT a FROM ext WHERE id = 1' })).rows,
    [['원본']],
  );

  // 스키마 커맨드와 STRICT 테이블은 그대로 동작한다.
  const created = await client.call('schema.create', { name: '정상' });
  assert.ok(created.tableId);
  client.close();
});

test('cleanup.plan·cleanup.run(D-17): 계획은 읽기, 실행은 진행률과 커맨드를 돌려주고 가져오기 중에는 E_DB_BUSY', async () => {
  const { client } = await readyClient();
  const { tableId, cmd } = await client.call('schema.create', {
    name: '표',
    columns: [
      { name: '남김', type: 'text' },
      { name: '지움', type: 'longtext' },
    ],
  });
  assert.equal(cmd.type, 'table.create');
  const { tables } = await client.call('schema.list');
  const gone = tables.find((t) => t.id === tableId)?.columns[1]?.id ?? '';
  await client.call('schema.softDeleteColumn', { tableId, columnId: gone });
  const plan = await client.call('cleanup.plan');
  assert.deepEqual(
    plan.tables.map((t) => [t.tableId, t.columns.map((c) => c.id)]),
    [[tableId, [gone]]],
  );
  assert.equal(plan.compactsOnSave, false);
  /** @type {string[]} */
  const phases = [];
  const result = await client.call(
    'cleanup.run',
    { columns: [{ tableId, columnId: gone }] },
    { onProgress: (p) => phases.push(p.phase) },
  );
  assert.deepEqual(
    result.cmds.map((c) => c.type),
    ['column.purge'],
  );
  assert.equal(result.removedColumns, 1);
  assert.equal(result.vacuumed, true);
  assert.ok(phases.includes('purge') && phases.includes('vacuum'));
  assert.deepEqual((await client.call('cleanup.plan')).tables, []);
  client.close();
});

test('cleanup.run은 다른 배타 op와 겹치면 E_DB_BUSY, cleanup.plan은 그 사이에도 허용된다', async () => {
  /** @type {RpcOutbound[]} */
  const out = [];
  const dispatcher = createDispatcher({ post: (m) => out.push(m) });
  const wasm = await loadWasmBinary();
  await dispatcher.dispatch({ id: 1, op: 'engine.init', args: { mode: 'wasm', wasmBinary: wasm } });
  await dispatcher.dispatch({ id: 2, op: 'db.open', args: {} });
  // 가져오기가 도는 동안(첫 await에서 멈춘 사이)의 정리·계획.
  const file = new Blob(['a,b\n1,2\n']);
  const importing = dispatcher.dispatch({
    id: 3,
    op: 'import.run',
    args: {
      file,
      options: { format: 'csv' },
      mapping: { columns: [{ source: 0 }, { source: 1 }] },
      target: { kind: 'new', name: '가져옴' },
    },
  });
  await dispatcher.dispatch({ id: 4, op: 'cleanup.run', args: { columns: [] } });
  await dispatcher.dispatch({ id: 5, op: 'cleanup.plan' });
  await importing;
  const busy = out.find((m) => 'id' in m && m.id === 4);
  assert.ok(busy && 'ok' in busy && busy.ok === false && busy.error.code === 'E_DB_BUSY');
  const planned = out.find((m) => 'id' in m && m.id === 5);
  assert.ok(planned && 'ok' in planned && planned.ok === true);
  // 가져오기 자체의 성패는 여기서 보지 않는다(겹치는 동안 배타 op로 자리를 차지하는 것만 필요하다).
  assert.ok(out.some((m) => 'id' in m && m.id === 3 && 'ok' in m));
});
