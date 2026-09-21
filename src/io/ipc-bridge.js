// @ts-check
/**
 * 메인 스레드의 IPC 브리지(D-15): Worker의 `engine:call` 메시지를 타우리 `invoke`로 러스트에 전달하고 결과를 되돌린다.
 *
 * - 동기 호출(메시지에 `buffer`가 있음): 결과를 `SharedArrayBuffer`에 UTF-8 JSON으로 쓰고 `Atomics.notify`로 깨운다.
 *   버퍼가 모자라면 상태 `TOO_SMALL`과 필요한 길이를 쓰고 응답을 보관했다가 `fetch`에 다시 쓴다.
 * - 비동기 호출: `{ callId, ok, result | error }`를 postMessage로 돌려주고 진행률은 `{ callId, progress }`.
 * - 타우리 invoke는 이 파일과 `io/filesystem.js`에서만 부른다(CLAUDE.md 4장). `@tauri-apps/api`는 런타임 의존이라
 *   쓰지 않고 `window.__TAURI_INTERNALS__`를 직접 부른다(`transformCallback`으로 `Channel`을 만든다).
 */
import { SYNC_HEADER_BYTES, SYNC_STATUS } from '../db/engine-native.js';
import { AppError, deserializeError, isErrorCode, serializeError } from '../util/errors.js';

/** @typedef {import('../db/engine-native.js').EngineCallMessage} EngineCallMessage */
/** @typedef {import('../db/engine-native.js').EngineFetchMessage} EngineFetchMessage */
/** @typedef {import('../db/engine-native.js').CallerPort} CallerPort */

/**
 * 러스트 명령 호출 함수. 타우리에서는 `engine_call`, Node 테스트에서는 표준 입출력 하네스.
 * @typedef {(op: string, args: unknown, onProgress?: (progress: unknown) => void) => Promise<unknown>} EngineInvoke
 */

/**
 * @typedef {object} Bridge
 * @property {(port: CallerPort) => void} attach Worker(포트)의 `callId` 메시지를 받기 시작한다
 * @property {() => void} detach
 * @property {() => number} pendingSyncResults 보관 중인 큰 응답 수(테스트·진단용)
 */

/**
 * `window.__TAURI_INTERNALS__`의 이 파일이 쓰는 부분.
 * @typedef {object} TauriInternals
 * @property {(cmd: string, args?: unknown, options?: unknown) => Promise<unknown>} invoke
 * @property {(callback?: (response: unknown) => void, once?: boolean) => number} transformCallback
 */

/**
 * 타우리 전역 객체. 없으면 null. 기능 감지는 try/catch로(CLAUDE.md 5.6).
 * @returns {TauriInternals | null}
 */
export function tauriInternals() {
  try {
    const g = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis));
    const internals = g.__TAURI_INTERNALS__;
    if (!internals || typeof internals !== 'object') return null;
    const t = /** @type {Partial<TauriInternals>} */ (internals);
    if (typeof t.invoke !== 'function' || typeof t.transformCallback !== 'function') return null;
    return /** @type {TauriInternals} */ (t);
  } catch {
    return null;
  }
}

/**
 * 러스트가 돌려준 오류(`AppError` 직렬형)면 같은 `AppError`로, 아니면(명령 미등록, 권한 누락) `E_NATIVE_IPC`.
 * @param {unknown} err
 * @param {string} cmd
 * @returns {AppError}
 */
export function toIpcError(err, cmd) {
  if (err instanceof AppError) return err;
  if (typeof err === 'object' && err !== null && 'code' in err) {
    const code = /** @type {{ code: unknown }} */ (err).code;
    if (typeof code === 'string' && isErrorCode(code)) return deserializeError(err);
  }
  const message = err instanceof Error ? err.message : String(err);
  return new AppError('E_NATIVE_IPC', `${cmd}: ${message.slice(0, 300)}`, {
    cause: err,
    detail: { cmd },
  });
}

/**
 * 타우리 명령을 부른다. 전역 객체가 없거나 호출이 실패하면 `E_NATIVE_IPC`(wasm 폴백 없음, D-15).
 * @param {string} cmd
 * @param {Record<string, unknown>} [args]
 * @returns {Promise<unknown>}
 */
export async function tauriInvoke(cmd, args = {}) {
  const internals = tauriInternals();
  if (!internals) throw new AppError('E_NATIVE_IPC', 'window.__TAURI_INTERNALS__ is missing');
  try {
    return await internals.invoke(cmd, args);
  } catch (err) {
    throw toIpcError(err, cmd);
  }
}

/**
 * 진행률 채널을 붙여 타우리 명령을 부른다. 러스트 쪽 `tauri::ipc::Channel<Value>`는 `__CHANNEL__:<id>` 문자열로
 * 역직렬화되며 메시지는 `{ message, index }`(또는 `{ message, id }`)로 온다. 순서는 도착 순서를 그대로 쓴다.
 * @param {string} cmd
 * @param {Record<string, unknown>} args
 * @param {((progress: unknown) => void) | undefined} onProgress
 * @returns {Promise<unknown>}
 */
export async function invokeWithChannel(cmd, args, onProgress) {
  const internals = tauriInternals();
  if (!internals) throw new AppError('E_NATIVE_IPC', 'window.__TAURI_INTERNALS__ is missing');
  const id = internals.transformCallback((raw) => {
    if (!onProgress) return;
    const value =
      typeof raw === 'object' && raw !== null && 'message' in raw
        ? /** @type {{ message: unknown }} */ (raw).message
        : raw;
    onProgress(value);
  }, false);
  try {
    return await internals.invoke(cmd, { ...args, progress: `__CHANNEL__:${id}` });
  } catch (err) {
    throw toIpcError(err, cmd);
  } finally {
    try {
      Reflect.deleteProperty(globalThis, `_${id}`);
    } catch {
      // 콜백 정리 실패는 누수일 뿐 동작에 영향이 없다.
    }
  }
}

/**
 * 타우리용 엔진 호출 함수: 러스트 명령 `engine_call { cmd, args, progress }`.
 * @returns {EngineInvoke}
 */
export function tauriEngineInvoke() {
  return (op, args, onProgress) => invokeWithChannel('engine_call', { cmd: op, args }, onProgress);
}

/**
 * 브라우저 `Worker`를 포트로 감싼다.
 * @param {Worker} worker
 * @returns {CallerPort}
 */
export function workerPort(worker) {
  return {
    postMessage: (message) => worker.postMessage(message),
    subscribe: (handler) => {
      /** @param {MessageEvent} ev */
      const listener = (ev) => handler(ev.data);
      worker.addEventListener('message', listener);
      return () => worker.removeEventListener('message', listener);
    },
  };
}

/**
 * @param {{ invoke: EngineInvoke }} options
 * @returns {Bridge}
 */
export function createBridge(options) {
  const { invoke } = options;
  const encoder = new TextEncoder();
  /** @type {(() => void) | null} */
  let unsubscribe = null;
  /** @type {CallerPort | null} */
  let port = null;
  /** 버퍼가 모자라 보관 중인 응답. `fetch`가 가져간다. */
  /** @type {Map<number, { status: number, bytes: Uint8Array }>} */
  const stored = new Map();

  /**
   * 응답을 버퍼에 쓰고 Worker를 깨운다. 모자라면 길이만 알리고 보관한다.
   * @param {number} callId
   * @param {SharedArrayBuffer} buffer
   * @param {number} status
   * @param {Uint8Array} bytes
   */
  function writeSync(callId, buffer, status, bytes) {
    const header = new Int32Array(buffer, 0, 2);
    if (bytes.byteLength > buffer.byteLength - SYNC_HEADER_BYTES) {
      stored.set(callId, { status, bytes });
      Atomics.store(header, 1, bytes.byteLength);
      Atomics.store(header, 0, SYNC_STATUS.TOO_SMALL);
      Atomics.notify(header, 0);
      return;
    }
    new Uint8Array(buffer, SYNC_HEADER_BYTES, bytes.byteLength).set(bytes);
    Atomics.store(header, 1, bytes.byteLength);
    Atomics.store(header, 0, status);
    Atomics.notify(header, 0);
  }

  /**
   * @param {EngineCallMessage} message
   */
  async function handleSync(message) {
    const buffer = /** @type {SharedArrayBuffer} */ (message.buffer);
    /** @type {number} */
    let status = SYNC_STATUS.OK;
    /** @type {unknown} */
    let payload;
    try {
      payload = await invoke(message.op, message.args);
    } catch (err) {
      status = SYNC_STATUS.ERROR;
      payload = serializeError(toIpcError(err, message.op));
    }
    writeSync(message.callId, buffer, status, encoder.encode(JSON.stringify(payload ?? null)));
  }

  /**
   * @param {EngineCallMessage} message
   */
  async function handleAsync(message) {
    const target = port;
    if (!target) return;
    try {
      const result = await invoke(message.op, message.args, (progress) => {
        target.postMessage({ callId: message.callId, progress });
      });
      target.postMessage({ callId: message.callId, ok: true, result: result ?? null });
    } catch (err) {
      target.postMessage({
        callId: message.callId,
        ok: false,
        error: serializeError(toIpcError(err, message.op)),
      });
    }
  }

  /**
   * @param {unknown} data
   */
  function onMessage(data) {
    if (!data || typeof data !== 'object' || !('callId' in data)) return;
    if ('fetch' in data) {
      const message = /** @type {EngineFetchMessage} */ (data);
      const kept = stored.get(message.callId);
      stored.delete(message.callId);
      if (kept) {
        writeSync(message.callId, message.buffer, kept.status, kept.bytes);
      } else {
        writeSync(
          message.callId,
          message.buffer,
          SYNC_STATUS.ERROR,
          encoder.encode(
            JSON.stringify(
              serializeError(new AppError('E_NATIVE_IPC', 'no stored result for fetch')),
            ),
          ),
        );
      }
      return;
    }
    if (!('op' in data)) return;
    const message = /** @type {EngineCallMessage} */ (data);
    if (message.buffer) void handleSync(message);
    else void handleAsync(message);
  }

  return {
    attach(target) {
      if (unsubscribe) unsubscribe();
      port = target;
      unsubscribe = target.subscribe(onMessage);
    },
    detach() {
      if (unsubscribe) unsubscribe();
      unsubscribe = null;
      port = null;
      stored.clear();
    },
    pendingSyncResults: () => stored.size,
  };
}
