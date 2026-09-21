// @ts-check
/**
 * IPC 브리지(D-15)와 포트 호출자의 프로토콜: 동기 응답 버퍼 쓰기·읽기, 버퍼 부족 시 fetch, 오류 직렬화, 비동기 진행률,
 * 전송 형식(BLOB base64), 타우리 오류 매핑. 러스트 없이 가짜 invoke로 검사한다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createPortCaller,
  fromWire,
  SYNC_HEADER_BYTES,
  SYNC_STATUS,
  toWire,
} from '../../../src/db/engine-native.js';
import { createBridge, toIpcError } from '../../../src/io/ipc-bridge.js';
import { AppError } from '../../../src/util/errors.js';

/** @typedef {import('../../../src/db/engine-native.js').CallerPort} CallerPort */

/**
 * 같은 스레드의 가짜 포트 한 쌍. `a.postMessage`는 `b`의 구독자에게, `b.postMessage`는 `a`의 구독자에게 간다.
 * `sync`면 메시지를 즉시 전달한다(동기 호출 검사용). 아니면 마이크로태스크로 넘긴다.
 * @param {{ sync?: boolean }} [options]
 * @returns {{ a: CallerPort, b: CallerPort }}
 */
function pipe(options = {}) {
  /** @type {Set<(data: unknown) => void>} */
  const toA = new Set();
  /** @type {Set<(data: unknown) => void>} */
  const toB = new Set();
  /** @param {Set<(data: unknown) => void>} targets @param {unknown} message */
  const deliver = (targets, message) => {
    const send = () => {
      for (const handler of targets) handler(message);
    };
    if (options.sync) send();
    else queueMicrotask(send);
  };
  return {
    a: {
      postMessage: (m) => deliver(toB, m),
      subscribe: (h) => {
        toA.add(h);
        return () => toA.delete(h);
      },
    },
    b: {
      postMessage: (m) => deliver(toA, m),
      subscribe: (h) => {
        toB.add(h);
        return () => toB.delete(h);
      },
    },
  };
}

/**
 * 동기 응답을 흉내 낸다: 요청을 받으면 그 자리에서 버퍼에 쓴다(브리지의 `writeSync`와 같은 규칙).
 * @param {SharedArrayBuffer} buffer
 * @param {number} status
 * @param {unknown} payload
 */
function writeSync(buffer, status, payload) {
  const bytes = new TextEncoder().encode(JSON.stringify(payload));
  const header = new Int32Array(buffer, 0, 2);
  if (bytes.byteLength > buffer.byteLength - SYNC_HEADER_BYTES) {
    Atomics.store(header, 1, bytes.byteLength);
    Atomics.store(header, 0, SYNC_STATUS.TOO_SMALL);
    return false;
  }
  new Uint8Array(buffer, SYNC_HEADER_BYTES, bytes.byteLength).set(bytes);
  Atomics.store(header, 1, bytes.byteLength);
  Atomics.store(header, 0, status);
  return true;
}

test('toWire/fromWire: Uint8Array ↔ { $blob }, bigint, 중첩 객체·배열, undefined 제거', () => {
  const wire = toWire({
    a: new Uint8Array([1, 2, 3]),
    b: 7n,
    c: [null, 1.5, '가'],
    d: undefined,
    e: (2n ** 63n).toString(),
  });
  assert.deepEqual(wire, {
    a: { $blob: 'AQID' },
    b: 7,
    c: [null, 1.5, '가'],
    e: '9223372036854775808',
  });
  assert.equal(toWire(2n ** 60n), '1152921504606846976');
  const back = /** @type {{ a: Uint8Array, rows: unknown[][] }} */ (
    fromWire({ a: { $blob: 'AQID' }, rows: [[1, { $blob: '' }, { $blob: 'x', other: 1 }]] })
  );
  assert.deepEqual(Array.from(back.a), [1, 2, 3]);
  assert.ok(back.rows[0]?.[1] instanceof Uint8Array);
  assert.deepEqual(back.rows[0]?.[2], { $blob: 'x', other: 1 }, '키가 더 있으면 BLOB이 아니다');
});

test('createPortCaller.callSync: 요청과 버퍼를 보내고 즉시 쓰인 응답을 읽는다(성공·오류)', () => {
  const { a, b } = pipe({ sync: true });
  /** @type {unknown[]} */
  const seen = [];
  b.subscribe((data) => {
    const m =
      /** @type {{ callId: number, op: string, args: unknown, buffer?: SharedArrayBuffer }} */ (
        data
      );
    seen.push(m);
    if (!m.buffer) return;
    if (m.op === 'exec') {
      writeSync(m.buffer, SYNC_STATUS.OK, {
        columns: ['b'],
        rows: [[{ $blob: 'AQID' }]],
      });
    } else {
      writeSync(m.buffer, SYNC_STATUS.ERROR, {
        code: 'E_DB_QUERY',
        message: 'boom',
        detail: { sql: 'x' },
      });
    }
  });
  const caller = createPortCaller(a, { bufferBytes: 4096 });
  const result = /** @type {{ columns: string[], rows: Uint8Array[][] }} */ (
    caller.callSync('exec', { sql: 'SELECT b', params: [new Uint8Array([9])] })
  );
  assert.deepEqual(result.columns, ['b']);
  assert.deepEqual(Array.from(result.rows[0]?.[0] ?? []), [1, 2, 3]);
  const sent = /** @type {{ args: { params: unknown[] } }} */ (seen[0]);
  assert.deepEqual(sent.args.params, [{ $blob: 'CQ==' }], '인자의 BLOB은 base64로 나간다');
  assert.throws(
    () => caller.callSync('run', { sql: 'x' }),
    (err) => err instanceof AppError && err.code === 'E_DB_QUERY' && err.message === 'boom',
  );
  caller.dispose();
});

test('createPortCaller.callSync: 버퍼가 모자라면 필요한 크기의 새 버퍼로 fetch한다', () => {
  const { a, b } = pipe({ sync: true });
  const big = '가'.repeat(10_000);
  let fetches = 0;
  b.subscribe((data) => {
    const m = /** @type {{ callId: number, fetch?: true, buffer?: SharedArrayBuffer }} */ (data);
    if (!m.buffer) return;
    if (m.fetch) fetches += 1;
    writeSync(m.buffer, SYNC_STATUS.OK, { value: big });
  });
  const caller = createPortCaller(a, { bufferBytes: 256 });
  const first = /** @type {{ value: string }} */ (caller.callSync('exec', {}));
  assert.equal(first.value, big);
  assert.equal(fetches, 1);
  // 커진 버퍼는 유지되므로 같은 크기의 다음 응답은 fetch 없이 들어온다.
  caller.callSync('exec', {});
  assert.equal(fetches, 1);
  caller.dispose();
});

test('createBridge: 동기 요청을 invoke로 넘기고 버퍼에 쓴다. 큰 응답은 TOO_SMALL 뒤 fetch로 준다', async () => {
  const { a, b } = pipe();
  /** @type {string[]} */
  const ops = [];
  const bridge = createBridge({
    invoke: async (op, args) => {
      ops.push(op);
      if (op === 'big') return { value: 'x'.repeat(5000) };
      if (op === 'fail') throw new AppError('E_DB_QUERY', 'nope', { detail: { sql: 'q' } });
      if (op === 'ipc') throw new Error('command engine_call not found');
      return { echo: args };
    },
  });
  bridge.attach(b);
  /**
   * @param {SharedArrayBuffer} buffer
   * @returns {Promise<{ status: number, payload: unknown }>}
   */
  const wait = (buffer) =>
    new Promise((resolve) => {
      const header = new Int32Array(buffer, 0, 2);
      const poll = () => {
        const status = Atomics.load(header, 0);
        if (status === SYNC_STATUS.PENDING) {
          setTimeout(poll, 1);
          return;
        }
        const length = Atomics.load(header, 1);
        const payload =
          status === SYNC_STATUS.TOO_SMALL
            ? null
            : JSON.parse(
                new TextDecoder().decode(new Uint8Array(buffer, SYNC_HEADER_BYTES, length).slice()),
              );
        resolve({ status, payload });
      };
      poll();
    });

  const buffer = new SharedArrayBuffer(SYNC_HEADER_BYTES + 256);
  a.postMessage({ callId: 1, op: 'exec', args: { sql: 'S' }, buffer });
  assert.deepEqual(await wait(buffer), { status: SYNC_STATUS.OK, payload: { echo: { sql: 'S' } } });

  const small = new SharedArrayBuffer(SYNC_HEADER_BYTES + 64);
  a.postMessage({ callId: 2, op: 'big', args: {}, buffer: small });
  const tooSmall = await wait(small);
  assert.equal(tooSmall.status, SYNC_STATUS.TOO_SMALL);
  assert.equal(bridge.pendingSyncResults(), 1);
  const needed = new Int32Array(small, 0, 2)[1] ?? 0;
  const bigger = new SharedArrayBuffer(SYNC_HEADER_BYTES + needed);
  a.postMessage({ callId: 2, fetch: true, buffer: bigger });
  const fetched = await wait(bigger);
  assert.equal(fetched.status, SYNC_STATUS.OK);
  assert.equal(/** @type {{ value: string }} */ (fetched.payload).value.length, 5000);
  assert.equal(bridge.pendingSyncResults(), 0);

  const errBuf = new SharedArrayBuffer(SYNC_HEADER_BYTES + 512);
  a.postMessage({ callId: 3, op: 'fail', args: {}, buffer: errBuf });
  const failed = await wait(errBuf);
  assert.equal(failed.status, SYNC_STATUS.ERROR);
  assert.deepEqual(/** @type {{ code: string }} */ (failed.payload).code, 'E_DB_QUERY');

  const ipcBuf = new SharedArrayBuffer(SYNC_HEADER_BYTES + 512);
  a.postMessage({ callId: 4, op: 'ipc', args: {}, buffer: ipcBuf });
  const ipc = await wait(ipcBuf);
  assert.equal(/** @type {{ code: string }} */ (ipc.payload).code, 'E_NATIVE_IPC');

  const orphan = new SharedArrayBuffer(SYNC_HEADER_BYTES + 512);
  a.postMessage({ callId: 99, fetch: true, buffer: orphan });
  const missing = await wait(orphan);
  assert.equal(missing.status, SYNC_STATUS.ERROR);
  assert.deepEqual(ops, ['exec', 'big', 'fail', 'ipc']);
  bridge.detach();
});

test('createBridge + createPortCaller: 비동기 호출은 진행률과 결과·오류를 메시지로 돌려준다', async () => {
  const { a, b } = pipe();
  const bridge = createBridge({
    invoke: async (op, args, onProgress) => {
      if (op === 'run_batch') {
        onProgress?.({ phase: 'batch', done: 500, total: 1000 });
        onProgress?.({ phase: 'batch', done: 1000, total: 1000 });
        return { changes: /** @type {{ n: number }} */ (args).n };
      }
      throw new AppError('E_FILE_LOCKED', 'locked');
    },
  });
  bridge.attach(b);
  const caller = createPortCaller(a);
  /** @type {unknown[]} */
  const progress = [];
  const result = await caller.call('run_batch', { n: 3 }, (p) => progress.push(p));
  assert.deepEqual(result, { changes: 3 });
  assert.equal(progress.length, 2);
  await assert.rejects(
    caller.call('save_to', {}),
    (err) => err instanceof AppError && err.code === 'E_FILE_LOCKED',
  );
  const dangling = caller.call('run_batch', { n: 1 });
  caller.dispose();
  await assert.rejects(dangling, (err) => err instanceof AppError && err.code === 'E_NATIVE_IPC');
  bridge.detach();
});

test('toIpcError: 러스트 AppError는 같은 코드로, 그 밖(명령 미등록·권한)은 E_NATIVE_IPC', () => {
  const mapped = toIpcError(
    { code: 'E_ORIGINAL_CHANGED', message: 'changed', detail: { a: 1 } },
    'x',
  );
  assert.equal(mapped.code, 'E_ORIGINAL_CHANGED');
  assert.deepEqual(mapped.detail, { a: 1 });
  assert.equal(
    toIpcError('Command engine_call not allowed by ACL', 'engine_call').code,
    'E_NATIVE_IPC',
  );
  assert.equal(toIpcError({ code: 'NOT_A_CODE' }, 'x').code, 'E_NATIVE_IPC');
  const passthrough = new AppError('E_MEM', 'm');
  assert.equal(toIpcError(passthrough, 'x'), passthrough);
});
