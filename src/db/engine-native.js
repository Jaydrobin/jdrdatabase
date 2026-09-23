// @ts-check
/**
 * 데스크톱 모드 엔진(D-15): 러스트 rusqlite 명령을 부르는 `Engine` 구현. 호출 경로는 둘이다.
 *
 * 1. 엔진 프로토콜(기본): 앱이 등록한 `jdr://localhost/call`(Windows는 `http://jdr.localhost/call`)에 동기 XHR(`exec`·`run`)과
 *    fetch(`open`·`close`·`runBatch`·`begin`/`commit`/`rollback`·`saveTo`)로 직접 요청한다. 메인 스레드를 거치지 않는다.
 * 2. 공유 버퍼 중계(폴백·Node 테스트): 동기 호출은 `SharedArrayBuffer`를 요청에 실어 메인의 `io/ipc-bridge.js`에 보내고
 *    `Atomics.wait`로 응답을 기다린다. 버퍼가 모자라면 브리지가 필요한 크기를 알려 주고 더 큰 버퍼로 다시 받는다.
 *    비동기 호출은 `postMessage` 왕복이며 진행률은 `{ callId, progress }`로 온다. `crossOriginIsolated`가 아니면 쓸 수 없다
 *    (세션 I 실측: WebKitGTK는 COOP/COEP 헤더를 내도 `tauri://` 문서에 SharedArrayBuffer를 주지 않는다).
 *
 * - 값은 JSON으로 오가고 BLOB은 `{ "$blob": base64 }`다(`util/bytes.js`의 base64를 쓴다).
 * - `runBatch`는 500행씩 나눠 보내 wasm 엔진과 같은 시점에 진행률·취소 표식을 본다.
 * - 메인 스레드에서는 동기 XHR도 `Atomics.wait`도 쓸 수 없으므로 인라인 전송에서는 만들 수 없다(`E_NATIVE_IPC`).
 * - 타우리 invoke는 이 파일에 없다. 이 파일은 DOM·`window`에 접근하지 않는다(CLAUDE.md 4장).
 */
import { base64ToBytes, bytesToBase64 } from '../util/bytes.js';
import { AppError, deserializeError, serializeError, toAppError } from '../util/errors.js';

/** @typedef {import('./engine.js').Engine} Engine */
/** @typedef {import('./engine.js').EngineInfo} EngineInfo */
/** @typedef {import('./engine.js').SqlParams} SqlParams */
/** @typedef {import('./engine.js').SqlSource} SqlSource */
/** @typedef {import('./engine.js').SqlValue} SqlValue */
/** @typedef {import('./engine.js').NativeOpenInfo} NativeOpenInfo */
/** @typedef {import('./engine.js').NativeSaveInfo} NativeSaveInfo */

/** 동기 응답 버퍼의 머리(바이트): 상태 Int32 + 길이 Int32. */
export const SYNC_HEADER_BYTES = 8;
/** 동기 응답 버퍼의 처음 크기. 창 질의 200행 × 20열의 미리보기가 넉넉히 들어간다. */
export const SYNC_BUFFER_BYTES = 4 * 1024 * 1024;
/** 동기 응답 상태 값. */
export const SYNC_STATUS = Object.freeze({ PENDING: 0, OK: 1, ERROR: 2, TOO_SMALL: 3 });
/** `runBatch`가 한 번의 IPC로 보내는 행 수. wasm 엔진의 진행률 간격과 같아 취소 판정 시점이 같다. */
export const NATIVE_BATCH_CHUNK = 500;

/**
 * 메인(브리지)으로 보내는 호출.
 * @typedef {object} EngineCallMessage
 * @property {number} callId
 * @property {string} op 러스트 명령 이름(`exec`, `run`, `open`…)
 * @property {unknown} args JSON으로 직렬화 가능한 인자
 * @property {SharedArrayBuffer} [buffer] 있으면 동기 호출. 응답은 이 버퍼에 온다
 */
/** @typedef {{ callId: number, fetch: true, buffer: SharedArrayBuffer }} EngineFetchMessage 버퍼가 모자라 더 큰 버퍼로 다시 받는다 */
/** @typedef {{ callId: number, ok: true, result: unknown } | { callId: number, ok: false, error: unknown }} EngineResultMessage */
/** @typedef {{ callId: number, progress: unknown }} EngineProgressMessage */

/**
 * 메시지 포트 추상화. Worker 전역, Node `parentPort`, 테스트의 가짜 포트가 이 형태를 만족한다.
 * @typedef {object} CallerPort
 * @property {(message: unknown) => void} postMessage
 * @property {(handler: (data: unknown) => void) => () => void} subscribe 메시지 데이터(이벤트가 아니라 `data`)를 받는다. 해제 함수를 돌려준다
 */

/**
 * 러스트 명령을 부르는 방법. `callSync`는 응답까지 스레드를 멈춘다.
 * @typedef {object} NativeCaller
 * @property {(op: string, args: unknown) => unknown} callSync
 * @property {(op: string, args: unknown, onProgress?: (progress: unknown) => void) => Promise<unknown>} call
 * @property {() => void} dispose
 */

/**
 * 앱의 엔진 프로토콜(`jdr://localhost/call`, Windows는 `http://jdr.localhost/call`) 주소와 토큰. `engine.init`의 `native`로 온다.
 * @typedef {object} NativeEndpoint
 * @property {string} url
 * @property {string} token
 */

/**
 * JS 값을 전송 형식으로. `Uint8Array`는 `{ $blob }`, bigint는 안전 범위면 number, 아니면 문자열.
 * @param {unknown} value
 * @returns {unknown}
 */
export function toWire(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Uint8Array) return { $blob: bytesToBase64(value) };
  if (typeof value === 'bigint') {
    return value >= BigInt(Number.MIN_SAFE_INTEGER) && value <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (Array.isArray(value)) return value.map(toWire);
  if (typeof value === 'object') {
    /** @type {Record<string, unknown>} */
    const out = {};
    for (const [key, inner] of Object.entries(/** @type {Record<string, unknown>} */ (value))) {
      if (inner !== undefined) out[key] = toWire(inner);
    }
    return out;
  }
  return value;
}

/**
 * 전송 형식을 JS 값으로. `{ $blob }`은 `Uint8Array`.
 * @param {unknown} value
 * @returns {unknown}
 */
export function fromWire(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(fromWire);
  const obj = /** @type {Record<string, unknown>} */ (value);
  if (typeof obj.$blob === 'string' && Object.keys(obj).length === 1) {
    return base64ToBytes(obj.$blob);
  }
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [key, inner] of Object.entries(obj)) out[key] = fromWire(inner);
  return out;
}

/**
 * `SharedArrayBuffer`와 `Atomics.wait`를 이 스레드에서 쓸 수 있는가. 기능 감지는 try/catch로(CLAUDE.md 5.6).
 * @returns {boolean}
 */
export function syncCallSupported() {
  try {
    if (typeof SharedArrayBuffer !== 'function' || typeof Atomics?.wait !== 'function')
      return false;
    const probe = new Int32Array(new SharedArrayBuffer(4));
    // 메인 스레드는 'not-equal'조차 돌려주기 전에 던진다(브라우저). 값이 다르므로 대기하지 않는다.
    return Atomics.wait(probe, 0, 1, 0) === 'not-equal';
  } catch {
    return false;
  }
}

/**
 * 포트 위의 호출자. 동기 호출은 버퍼를 함께 보내고 기다리며, 비동기 호출은 `callId`로 응답을 짝짓는다.
 * @param {CallerPort} port
 * @param {{ bufferBytes?: number }} [options]
 * @returns {NativeCaller}
 */
export function createPortCaller(port, options = {}) {
  let nextId = 1;
  let buffer = new SharedArrayBuffer(options.bufferBytes ?? SYNC_BUFFER_BYTES);
  const decoder = new TextDecoder();
  /** @type {Map<number, { resolve: (v: unknown) => void, reject: (e: AppError) => void, onProgress?: (p: unknown) => void }>} */
  const pending = new Map();

  const unsubscribe = port.subscribe((data) => {
    if (!data || typeof data !== 'object' || !('callId' in data)) return;
    const message = /** @type {EngineResultMessage | EngineProgressMessage} */ (data);
    const entry = pending.get(message.callId);
    if (!entry) return;
    if ('progress' in message) {
      entry.onProgress?.(message.progress);
      return;
    }
    pending.delete(message.callId);
    if (message.ok) entry.resolve(fromWire(message.result));
    else entry.reject(deserializeError(message.error));
  });

  /**
   * 응답을 버퍼에서 읽는다. 상태가 `TOO_SMALL`이면 더 큰 버퍼를 만들어 다시 받는다.
   * @param {number} callId
   * @returns {unknown}
   */
  function readSync(callId) {
    for (;;) {
      const header = new Int32Array(buffer, 0, 2);
      Atomics.wait(header, 0, SYNC_STATUS.PENDING);
      const status = Atomics.load(header, 0);
      const length = Atomics.load(header, 1);
      if (status === SYNC_STATUS.TOO_SMALL) {
        buffer = new SharedArrayBuffer(SYNC_HEADER_BYTES + Math.max(length, SYNC_BUFFER_BYTES));
        port.postMessage(/** @type {EngineFetchMessage} */ ({ callId, fetch: true, buffer }));
        continue;
      }
      // 공유 메모리 위의 뷰는 디코더에 바로 넘길 수 없는 환경이 있어 한 번 복사한다.
      const bytes = new Uint8Array(buffer, SYNC_HEADER_BYTES, length).slice();
      const payload = fromWire(JSON.parse(decoder.decode(bytes)));
      if (status === SYNC_STATUS.OK) return payload;
      if (status === SYNC_STATUS.ERROR) throw deserializeError(payload);
      throw new AppError('E_NATIVE_IPC', `unexpected sync status ${status}`);
    }
  }

  return {
    callSync(op, args) {
      const callId = nextId;
      nextId += 1;
      const header = new Int32Array(buffer, 0, 2);
      Atomics.store(header, 0, SYNC_STATUS.PENDING);
      Atomics.store(header, 1, 0);
      port.postMessage(
        /** @type {EngineCallMessage} */ ({ callId, op, args: toWire(args), buffer }),
      );
      return readSync(callId);
    },
    call(op, args, onProgress) {
      const callId = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        pending.set(callId, { resolve, reject, onProgress });
        port.postMessage(/** @type {EngineCallMessage} */ ({ callId, op, args: toWire(args) }));
      });
    },
    dispose() {
      unsubscribe();
      for (const entry of pending.values()) {
        entry.reject(new AppError('E_NATIVE_IPC', 'caller disposed'));
      }
      pending.clear();
    },
  };
}

/**
 * 응답 JSON `{ ok, result | error }`를 값으로 바꾸거나 던진다.
 * @param {string} text
 * @param {number} status HTTP 상태
 * @returns {unknown}
 */
function unwrapEnvelope(text, status) {
  /** @type {{ ok?: boolean, result?: unknown, error?: unknown }} */
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch (err) {
    throw new AppError(
      'E_NATIVE_IPC',
      `engine protocol returned status ${status} with a non-JSON body`,
      {
        cause: err,
        detail: { status, head: text.slice(0, 80) },
      },
    );
  }
  if (envelope.ok === true) return fromWire(envelope.result ?? null);
  if (envelope.ok === false) throw deserializeError(envelope.error);
  throw new AppError('E_NATIVE_IPC', `engine protocol returned status ${status}`, {
    detail: { status },
  });
}

/**
 * 앱의 엔진 프로토콜을 직접 부르는 호출자(데스크톱 모드의 기본 경로, D-15). 동기 호출은 동기 XHR, 비동기 호출은 fetch다.
 * 본문은 text/plain이라 CORS 사전 요청이 없고, 토큰은 질의 문자열로 보낸다. 진행률은 없다(배치는 500행씩 나뉜다).
 * @param {NativeEndpoint} endpoint
 * @returns {NativeCaller}
 */
export function createHttpCaller(endpoint) {
  const url = `${endpoint.url}?t=${encodeURIComponent(endpoint.token)}`;
  /** @param {string} op @param {unknown} args */
  const body = (op, args) => JSON.stringify({ cmd: op, args: toWire(args) ?? {} });
  return {
    callSync(op, args) {
      const xhr = new XMLHttpRequest();
      try {
        xhr.open('POST', url, false);
        xhr.setRequestHeader('Content-Type', 'text/plain;charset=UTF-8');
        xhr.send(body(op, args));
      } catch (err) {
        throw new AppError('E_NATIVE_IPC', `engine protocol request failed: ${op}`, {
          cause: err,
          detail: { op },
        });
      }
      return unwrapEnvelope(xhr.responseText, xhr.status);
    },
    async call(op, args) {
      /** @type {Response} */
      let res;
      try {
        res = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
          body: body(op, args),
        });
      } catch (err) {
        throw new AppError('E_NATIVE_IPC', `engine protocol request failed: ${op}`, {
          cause: err,
          detail: { op },
        });
      }
      return unwrapEnvelope(await res.text(), res.status);
    },
    dispose() {},
  };
}

/**
 * 전용 Worker 전역(`self`)을 포트로 감싼다.
 * @returns {CallerPort | null} Worker 전역이 아니면 null
 */
export function workerScopePort() {
  const g = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis));
  if (typeof g.WorkerGlobalScope !== 'function' || typeof g.postMessage !== 'function') return null;
  const scope =
    /** @type {{ postMessage: (m: unknown) => void, addEventListener: (t: string, h: (ev: MessageEvent) => void) => void, removeEventListener: (t: string, h: (ev: MessageEvent) => void) => void }} */ (
      /** @type {unknown} */ (globalThis)
    );
  return {
    postMessage: (message) => scope.postMessage(message),
    subscribe: (handler) => {
      /** @param {MessageEvent} ev */
      const listener = (ev) => handler(ev.data);
      scope.addEventListener('message', listener);
      return () => scope.removeEventListener('message', listener);
    },
  };
}

/** @type {NativeCaller | null} */
let registeredCaller = null;

/**
 * 이 스레드에서 쓸 호출자를 미리 등록한다(Node 테스트: `worker_threads` 포트). 없으면 Worker 전역을 쓴다.
 * @param {NativeCaller | null} caller
 */
export function setNativeCaller(caller) {
  registeredCaller = caller;
}

/**
 * 호출자를 고른다. 등록된 것 → 엔진 프로토콜(`endpoint`) → Worker 전역 위의 공유 버퍼 중계.
 * 프로토콜 호출자는 `info`를 한 번 불러 닿는지 확인하고, 안 닿으면 공유 버퍼 중계로 내려간다(둘 다 안 되면 `E_NATIVE_IPC`).
 * @param {NativeEndpoint} [endpoint]
 * @returns {NativeCaller}
 */
function resolveCaller(endpoint) {
  if (registeredCaller) return registeredCaller;
  /** @type {AppError | null} */
  let httpError = null;
  if (endpoint && typeof XMLHttpRequest === 'function') {
    const http = createHttpCaller(endpoint);
    try {
      http.callSync('info', {});
      registeredCaller = http;
      return http;
    } catch (err) {
      httpError = toAppError(err, 'E_NATIVE_IPC');
    }
  }
  if (!syncCallSupported()) {
    throw new AppError(
      'E_NATIVE_IPC',
      httpError
        ? `engine protocol unreachable (${httpError.message}) and SharedArrayBuffer/Atomics.wait is unavailable`
        : 'SharedArrayBuffer/Atomics.wait is unavailable in this thread (crossOriginIsolated required)',
      { cause: httpError },
    );
  }
  const port = workerScopePort();
  if (!port) {
    throw new AppError(
      'E_NATIVE_IPC',
      'native engine requires a dedicated Worker (no inline transport)',
      { cause: httpError },
    );
  }
  const caller = createPortCaller(port);
  registeredCaller = caller;
  return caller;
}

/**
 * @param {SqlSource} source
 * @returns {string}
 */
function sqlText(source) {
  return typeof source === 'string' ? source : source.sql;
}

/**
 * @typedef {object} NativeEngineOptions
 * @property {NativeCaller} [caller] 테스트·Node용 주입. 없으면 `resolveCaller()`
 */

/**
 * `engine.js`가 `selectEngine('native')`에서 만든다.
 * @param {NativeEngineOptions} [options]
 * @returns {Engine}
 */
export function createNativeEngine(options = {}) {
  /** @type {NativeCaller | null} */
  let caller = options.caller ?? null;
  /** @type {EngineInfo | null} */
  let info = null;
  let interrupted = false;
  let opened = false;

  /** @type {NativeEndpoint | undefined} */
  let endpoint;

  /** @returns {NativeCaller} */
  function requireCaller() {
    if (!caller) caller = resolveCaller(endpoint);
    return caller;
  }

  /**
   * 오류에 `sql`을 남긴다(러스트가 이미 넣었으면 그대로).
   * @param {unknown} err
   * @param {string} sql
   */
  function withSql(err, sql) {
    const appErr = toAppError(err, 'E_DB_QUERY');
    const detail = typeof appErr.detail === 'object' && appErr.detail ? appErr.detail : {};
    if ('sql' in detail) return appErr;
    return new AppError(appErr.code, appErr.message, {
      cause: appErr,
      detail: { ...detail, sql: sql.slice(0, 200) },
    });
  }

  /** @type {Engine} */
  const engine = {
    async init(opts) {
      endpoint = opts.native;
      const c = requireCaller();
      const raw = /** @type {{ sqliteVersion: string, compileOptions: string[] }} */ (
        await c.call('info', {})
      );
      info = { sqliteVersion: raw.sqliteVersion, compileOptions: raw.compileOptions };
      return info;
    },

    capabilities() {
      return {
        mode: 'native',
        maxFileBytes: Infinity,
        warnFileBytes: Infinity,
        persistence: 'native',
        cancellable: true,
        fts5: info?.compileOptions.includes('ENABLE_FTS5') ?? false,
      };
    },

    async open(source) {
      if (source instanceof Uint8Array) {
        throw new AppError('E_UNSUPPORTED', 'native engine opens a path, not bytes');
      }
      const c = requireCaller();
      const result = /** @type {NativeOpenInfo} */ (await c.call('open', source ?? {}));
      opened = true;
      interrupted = false;
      return result;
    },

    async close(closeOptions = {}) {
      if (!opened) return;
      opened = false;
      await requireCaller().call('close', { discardWorkcopy: closeOptions.discard === true });
    },

    exec(sql, params) {
      const text = sqlText(sql);
      try {
        return /** @type {import('./engine.js').ExecResult} */ (
          requireCaller().callSync('exec', { sql: text, params })
        );
      } catch (err) {
        throw withSql(err, text);
      }
    },

    run(sql, params) {
      const text = sqlText(sql);
      try {
        return /** @type {import('./engine.js').RunResult} */ (
          requireCaller().callSync('run', { sql: text, params })
        );
      } catch (err) {
        throw withSql(err, text);
      }
    },

    async runBatch(sql, paramsList, batchOptions = {}) {
      const text = sqlText(sql);
      // 취소 표식은 배치가 소비할 때만 지운다(wasm 엔진과 같은 규칙).
      if (interrupted) {
        interrupted = false;
        throw new AppError('E_DB_QUERY', 'runBatch interrupted', {
          detail: { index: 0, reason: 'interrupted' },
        });
      }
      const c = requireCaller();
      return engine.transaction(async () => {
        let changes = 0;
        for (let i = 0; i < paramsList.length; i += NATIVE_BATCH_CHUNK) {
          if (i > 0 && interrupted) {
            interrupted = false;
            throw new AppError('E_DB_QUERY', 'runBatch interrupted', {
              detail: { index: i, reason: 'interrupted' },
            });
          }
          const chunk = paramsList.slice(i, i + NATIVE_BATCH_CHUNK);
          /** @type {{ changes: number }} */
          let result;
          try {
            result = /** @type {{ changes: number }} */ (
              await c.call('run_batch', { sql: text, paramsList: chunk })
            );
          } catch (err) {
            const appErr = withSql(err, text);
            const detail = typeof appErr.detail === 'object' && appErr.detail ? appErr.detail : {};
            const index = /** @type {{ index?: unknown }} */ (detail).index;
            throw new AppError(appErr.code, appErr.message, {
              cause: appErr,
              detail: { ...detail, index: typeof index === 'number' ? index + i : i },
            });
          }
          changes += result.changes;
          const done = Math.min(i + NATIVE_BATCH_CHUNK, paramsList.length);
          if (
            batchOptions.onProgress &&
            (done % NATIVE_BATCH_CHUNK === 0 || done === paramsList.length)
          ) {
            batchOptions.onProgress(done, paramsList.length);
          }
        }
        if (paramsList.length === 0 && batchOptions.onProgress) batchOptions.onProgress(0, 0);
        return { changes };
      });
    },

    async transaction(fn) {
      const c = requireCaller();
      await c.call('begin', {});
      try {
        const result = await fn();
        await c.call('commit', {});
        return result;
      } catch (err) {
        const original = toAppError(err, 'E_DB_QUERY');
        try {
          await c.call('rollback', {});
        } catch (rollbackErr) {
          throw new AppError(original.code, original.message, {
            cause: original,
            detail: {
              ...(typeof original.detail === 'object' && original.detail ? original.detail : {}),
              rollbackFailed:
                rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
            },
          });
        }
        throw original;
      }
    },

    prepareCached(sql) {
      return { sql };
    },

    snapshot() {
      throw new AppError('E_UNSUPPORTED', 'snapshot is wasm-only; use saveTo() in native mode');
    },

    async saveTo(originalPath, expected, saveOptions = {}) {
      const c = requireCaller();
      return /** @type {NativeSaveInfo} */ (
        await c.call(
          'save_to',
          { originalPath, expected, force: saveOptions.force === true },
          saveOptions.onProgress,
        )
      );
    },

    interrupt() {
      interrupted = true;
      if (!caller) return;
      // 러스트에서 실행 중인 문장이 있으면 중단한다. 응답은 기다리지 않는다.
      caller.call('interrupt', {}).catch((/** @type {unknown} */ err) => {
        console.warn(`interrupt: ${serializeError(err).message}`);
      });
    },

    applyPragmas() {
      // PRAGMA는 러스트가 사본을 열 때 적용한다(`core/src/db.rs`). 여기서는 할 일이 없다.
    },
  };

  return engine;
}
