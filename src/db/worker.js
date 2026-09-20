// @ts-check
/**
 * Worker 진입점과 RPC 디스패처(D-11, DESIGN.md 6장).
 *
 * `createDispatcher()`는 전송 계층과 무관하다. Blob Worker 안에서는 `self`를 포트로 쓰고,
 * Worker를 만들 수 없는 환경에서는 `client.js`의 인라인 전송이 같은 디스패처를 메인 스레드에서 부른다.
 * Worker는 "열린 DB 하나"만 상태로 가진다.
 */
import { AppError, serializeError } from '../util/errors.js';
import { selectEngine } from './engine.js';

/** @typedef {import('./engine.js').Engine} Engine */
/** @typedef {import('./engine.js').EngineMode} EngineMode */
/** @typedef {import('./engine.js').EngineCapabilities} EngineCapabilities */
/** @typedef {import('./engine.js').ExecResult} ExecResult */
/** @typedef {import('./engine.js').SqlParams} SqlParams */
/** @typedef {import('../util/errors.js').SerializedError} SerializedError */

/** @typedef {{ phase: string, done: number, total: number }} RpcProgress */
/** @typedef {{ id: number, op: string, args?: unknown }} RpcRequest */
/** @typedef {{ id: number, cancel: true }} RpcCancel */
/** @typedef {{ id: number, ok: true, result: unknown }} RpcOk */
/** @typedef {{ id: number, ok: false, error: SerializedError }} RpcFail */
/** @typedef {{ id: number, progress: RpcProgress }} RpcProgressEvent */
/** @typedef {{ ready: true }} RpcReady 전송 계층 핸드셰이크. Worker 부팅 직후 한 번 보낸다 */
/** @typedef {RpcOk | RpcFail | RpcProgressEvent | RpcReady} RpcOutbound */
/** @typedef {RpcRequest | RpcCancel} RpcInbound */

/**
 * RPC op 표(DESIGN.md 6장). 새 op는 여기와 `handlers`, 6장 표, 단위 테스트를 함께 갱신한다.
 * @typedef {{
 *   'engine.init': { args: { mode: EngineMode, wasmBinary?: ArrayBuffer }, result: { version: string, compileOptions: string[], capabilities: EngineCapabilities } },
 *   'engine.exec': { args: { sql: string, params?: SqlParams }, result: ExecResult },
 *   'db.open': { args: { bytes?: Uint8Array | ArrayBuffer }, result: { meta: Record<string, string>, tables: unknown[] } },
 *   'db.snapshot': { args: { bumpRevision?: boolean, savedBy?: string }, result: { bytes: Uint8Array } },
 *   'db.close': { args: undefined, result: null },
 * }} OpMap
 */
/** @typedef {keyof OpMap} OpName */

/**
 * 핸들러가 받는 실행 문맥.
 * @typedef {object} HandlerContext
 * @property {AbortSignal} signal 취소 신호. 취소를 지원하는 op만 확인한다
 * @property {(progress: RpcProgress) => void} progress 진행 이벤트. 250 ms 간격으로 조절된다
 */

/**
 * 핸들러 반환값. 전송 목록이 필요하면 `{ result, transfer }`로 돌려준다.
 * @template T
 * @typedef {{ result: T, transfer: Transferable[] }} HandlerReturn
 */

/**
 * 포트 추상화. Blob Worker의 `self`, 인라인 전송의 가짜 포트가 이 형태를 만족한다.
 * @typedef {object} MessagePortLike
 * @property {(message: unknown, transfer?: Transferable[]) => void} postMessage
 * @property {((ev: MessageEvent) => void) | null} onmessage
 */

/** 진행 이벤트 최소 간격(ms). CLAUDE.md 5.4. */
export const PROGRESS_INTERVAL_MS = 250;

/** 서로 배타적인 op. 동시에 오면 `E_DB_BUSY`. `db.open`은 모든 op와 배타적이다. */
export const EXCLUSIVE_OPS = new Set(['command.apply', 'import.run', 'search.enable']);

/**
 * 진행 이벤트를 최소 간격으로 묶는다. 단계가 바뀌거나 완료(done === total)면 즉시 보낸다.
 * @param {(progress: RpcProgress) => void} emit
 * @param {() => number} [now]
 * @returns {(progress: RpcProgress) => void}
 */
export function createProgressReporter(emit, now = () => Date.now()) {
  let lastAt = -Infinity;
  /** @type {string | null} */
  let lastPhase = null;
  return (progress) => {
    const t = now();
    const phaseChanged = progress.phase !== lastPhase;
    const finished = progress.total > 0 && progress.done >= progress.total;
    if (phaseChanged || finished || t - lastAt >= PROGRESS_INTERVAL_MS) {
      lastAt = t;
      lastPhase = progress.phase;
      emit(progress);
    }
  };
}

/**
 * @typedef {object} DispatcherOptions
 * @property {(message: RpcOutbound, transfer?: Transferable[]) => void} post 응답·진행 이벤트를 보내는 함수
 * @property {(mode: EngineMode) => Engine} [selectEngineImpl] 테스트용 주입
 */

/**
 * @typedef {object} Dispatcher
 * @property {(message: RpcInbound) => Promise<void>} dispatch 요청 하나를 처리하고 응답을 post한다
 * @property {() => Engine | null} engine 현재 엔진(테스트·진단용)
 */

/**
 * @param {DispatcherOptions} options
 * @returns {Dispatcher}
 */
export function createDispatcher(options) {
  const { post } = options;
  const select = options.selectEngineImpl ?? selectEngine;

  /** @type {Engine | null} */
  let engine = null;
  /** @type {Map<number, { op: string, controller: AbortController }>} */
  const inflight = new Map();

  /** @returns {Engine} */
  function requireEngine() {
    if (!engine)
      throw new AppError('E_DB_QUERY', 'engine is not initialized (call engine.init first)');
    return engine;
  }

  /**
   * op별 핸들러. 반환값은 결과이거나 `{ result, transfer }`.
   * @type {{ [K in OpName]: (args: OpMap[K]['args'], ctx: HandlerContext) => Promise<OpMap[K]['result'] | HandlerReturn<OpMap[K]['result']>> }}
   */
  const handlers = {
    'engine.init': async (args) => {
      const next = select(args.mode);
      const info = await next.init({ wasmBinary: args.wasmBinary });
      engine = next;
      return {
        version: info.sqliteVersion,
        compileOptions: info.compileOptions,
        capabilities: next.capabilities(),
      };
    },

    'engine.exec': async (args) => {
      if (typeof args?.sql !== 'string')
        throw new AppError('E_DB_QUERY', 'engine.exec requires sql');
      const active = requireEngine();
      // 진단·테스트 전용 op이므로 한 문장을 트랜잭션 하나로 감싼다. 이렇게 해야 DDL도 보낼 수 있고
      // (E2E의 FTS5 검사), 쓰기는 트랜잭션 안에서만이라는 규칙도 그대로 지켜진다(CLAUDE.md 5.3).
      return active.transaction(() => active.exec(args.sql, args.params));
    },

    'db.open': async (args) => {
      const raw = args?.bytes;
      const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw;
      await requireEngine().open(bytes);
      // meta·tables는 Step 2(schema.readMeta)·Step 3(tables.list)에서 채운다.
      return { meta: {}, tables: [] };
    },

    'db.snapshot': async () => {
      // bumpRevision·savedBy에 따른 _jdr_meta 갱신은 Step 2에서 snapshot 직전에 추가한다.
      const bytes = requireEngine().snapshot();
      return { result: { bytes }, transfer: [bytes.buffer] };
    },

    'db.close': async () => {
      await requireEngine().close();
      return null;
    },
  };

  /**
   * @param {string} op
   * @returns {op is OpName}
   */
  function isOp(op) {
    return Object.prototype.hasOwnProperty.call(handlers, op);
  }

  /**
   * 6장 규칙: db.open 중에는 모든 요청이 E_DB_BUSY, 배타 op끼리는 E_DB_BUSY, query.*는 언제나 허용.
   * @param {string} op
   */
  function assertNotBusy(op) {
    if (inflight.size === 0) return;
    for (const running of inflight.values()) {
      if (running.op === 'db.open' || op === 'db.open') {
        throw new AppError('E_DB_BUSY', `${running.op} is in progress`, {
          detail: { running: running.op, requested: op },
        });
      }
      if (EXCLUSIVE_OPS.has(op) && EXCLUSIVE_OPS.has(running.op)) {
        throw new AppError('E_DB_BUSY', `${running.op} is in progress`, {
          detail: { running: running.op, requested: op },
        });
      }
    }
  }

  /**
   * @param {unknown} value
   * @returns {value is HandlerReturn<unknown>}
   */
  function hasTransfer(value) {
    return (
      typeof value === 'object' &&
      value !== null &&
      'transfer' in value &&
      Array.isArray(/** @type {{ transfer: unknown }} */ (value).transfer)
    );
  }

  /**
   * @param {RpcRequest} request
   */
  async function handle(request) {
    const { id, op } = request;
    const controller = new AbortController();
    try {
      if (typeof op !== 'string' || !isOp(op)) {
        throw new AppError('E_UNKNOWN', `unknown op: ${String(op)}`, { detail: { op } });
      }
      assertNotBusy(op);
      inflight.set(id, { op, controller });
      const progress = createProgressReporter((p) => post({ id, progress: p }));
      const handler = /** @type {(args: unknown, ctx: HandlerContext) => Promise<unknown>} */ (
        handlers[op]
      );
      const returned = await handler(request.args, { signal: controller.signal, progress });
      if (hasTransfer(returned)) {
        post({ id, ok: true, result: returned.result }, returned.transfer);
      } else {
        post({ id, ok: true, result: returned });
      }
    } catch (err) {
      post({ id, ok: false, error: serializeError(err) });
    } finally {
      inflight.delete(id);
    }
  }

  return {
    async dispatch(message) {
      if ('cancel' in message) {
        inflight.get(message.id)?.controller.abort();
        return;
      }
      await handle(message);
    },
    engine: () => engine,
  };
}

/**
 * 포트(Worker의 `self`)에 디스패처를 연결하고 핸드셰이크를 보낸다.
 * @param {MessagePortLike} port
 * @returns {Dispatcher}
 */
export function attachToPort(port) {
  const dispatcher = createDispatcher({
    post: (message, transfer) => port.postMessage(message, transfer),
  });
  port.onmessage = (ev) => {
    // dispatch는 자체적으로 모든 오류를 응답으로 바꾸므로 여기서 기다릴 필요가 없다.
    void dispatcher.dispatch(/** @type {RpcInbound} */ (ev.data));
  };
  port.postMessage(/** @type {RpcReady} */ ({ ready: true }));
  return dispatcher;
}

/**
 * 이 모듈이 Worker 전역에서 실행 중인지. 메인 번들(인라인 전송)이나 Node 테스트에서 import되면 거짓이다.
 * @returns {boolean}
 */
function isWorkerScope() {
  const g = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis));
  return typeof g.WorkerGlobalScope === 'function' && typeof g.importScripts === 'function';
}

if (isWorkerScope()) {
  attachToPort(/** @type {MessagePortLike} */ (/** @type {unknown} */ (self)));
}
