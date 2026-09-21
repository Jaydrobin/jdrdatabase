// @ts-check
/**
 * RPC 클라이언트(메인 측, D-11)와 전송 계층 선택.
 *
 * - `createWorkerTransport(source)`: `<script type="text/plain">`의 Worker 소스를 Blob URL로 만들어 Worker를 띄운다.
 * - `createInlineTransport()`: Worker를 만들 수 없는 환경에서 같은 디스패처를 메인 스레드에서 돌린다.
 * - `createTransport()`: Worker를 시도하고 실패하면 인라인으로 폴백한다(E_ENV_NO_WORKER).
 * - `createClient({ transport })`: `call(op, args, { transfer, onProgress, signal })`.
 *
 * RPC에는 타임아웃이 없다(대용량 작업은 수십 초가 정상). 부팅 핸드셰이크에만 시간 제한을 둔다.
 */
import { AppError, deserializeError } from '../util/errors.js';
import { createDispatcher } from './worker.js';

/** @typedef {import('./worker.js').OpMap} OpMap */
/** @typedef {import('./worker.js').OpName} OpName */
/** @typedef {import('./worker.js').RpcInbound} RpcInbound */
/** @typedef {import('./worker.js').RpcOutbound} RpcOutbound */
/** @typedef {import('./worker.js').RpcProgress} RpcProgress */

/**
 * @typedef {object} Transport
 * @property {'worker' | 'inline'} kind
 * @property {(message: RpcInbound, transfer?: Transferable[]) => void} post
 * @property {(handler: (message: RpcOutbound) => void) => void} onMessage
 * @property {(handler: (err: AppError) => void) => void} onFatal 전송 계층이 더 이상 응답을 못 주는 상태. 마지막 등록만 유효하다
 * @property {() => void} close
 */

/**
 * @typedef {object} CallOptions
 * @property {Transferable[]} [transfer] 1 MB를 넘는 ArrayBuffer는 반드시 여기에 넣는다
 * @property {(progress: RpcProgress) => void} [onProgress]
 * @property {AbortSignal} [signal] 취소. 취소를 지원하는 op만 실제로 멈춘다
 * @property {(chunk: Uint8Array<ArrayBuffer>) => void} [onChunk] 조각 이벤트(`export.stream`). 도착 순서가 파일 순서다
 */

/**
 * @typedef {object} Client
 * @property {Transport} transport
 * @property {<K extends OpName>(op: K, args?: OpMap[K]['args'], options?: CallOptions) => Promise<OpMap[K]['result']>} call
 * @property {() => void} close
 */

/** 부팅 핸드셰이크 제한(ms). Worker가 만들어졌지만 시작하지 못하는 환경에서 인라인으로 넘어가기 위한 값. */
export const HANDSHAKE_TIMEOUT_MS = 10_000;

/**
 * @param {Worker} worker
 * @param {string} blobUrl
 * @returns {Transport}
 */
function wrapWorker(worker, blobUrl) {
  /** @type {((message: RpcOutbound) => void) | null} */
  let handler = null;
  /** @type {((err: AppError) => void) | null} */
  let fatal = null;
  worker.onmessage = (ev) => {
    handler?.(/** @type {RpcOutbound} */ (ev.data));
  };
  // 핸드셰이크 이후에도 계속 듣는다. Worker가 죽은 뒤 이 알림이 없으면 RPC에 타임아웃이 없으므로
  // 대기 중인 호출이 영원히 settle되지 않는다.
  worker.onerror = (ev) => {
    const message = typeof ev === 'object' && 'message' in ev ? ev.message : '';
    fatal?.(new AppError('E_ENV_NO_WORKER', message || 'worker error', { detail: { message } }));
  };
  worker.onmessageerror = () => {
    fatal?.(new AppError('E_UNKNOWN', 'worker message could not be deserialized'));
  };
  return {
    kind: 'worker',
    post: (message, transfer) => worker.postMessage(message, transfer ?? []),
    onMessage: (h) => {
      handler = h;
    },
    onFatal: (h) => {
      fatal = h;
    },
    close: () => {
      worker.terminate();
      URL.revokeObjectURL(blobUrl);
    },
  };
}

/**
 * Worker 소스 문자열로 Blob Worker를 만든다. 생성 자체가 막히면 동기 예외가 난다.
 * 준비 신호(`{ ready: true }`)를 기다리는 것은 `createTransport()`가 한다.
 * @param {string} source
 * @returns {{ transport: Transport, worker: Worker }}
 */
export function createWorkerTransport(source) {
  const blobUrl = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  /** @type {Worker} */
  let worker;
  try {
    worker = new Worker(blobUrl);
  } catch (err) {
    URL.revokeObjectURL(blobUrl);
    throw new AppError('E_ENV_NO_WORKER', 'failed to create Worker', { cause: err });
  }
  return { transport: wrapWorker(worker, blobUrl), worker };
}

/**
 * 같은 스레드에서 디스패처를 직접 부르는 전송. 메시지는 마이크로태스크로 넘겨 비동기 의미를 유지한다.
 * @returns {Transport}
 */
export function createInlineTransport() {
  /** @type {((message: RpcOutbound) => void) | null} */
  let handler = null;
  const dispatcher = createDispatcher({
    post: (message) => {
      queueMicrotask(() => handler?.(message));
    },
  });
  return {
    kind: 'inline',
    post: (message) => {
      void dispatcher.dispatch(message);
    },
    onMessage: (h) => {
      handler = h;
    },
    // 같은 스레드라 전송 계층이 따로 죽을 일이 없다. 디스패처의 오류는 응답으로 돌아온다.
    onFatal: () => {},
    close: () => {
      handler = null;
    },
  };
}

/**
 * @typedef {object} TransportOptions
 * @property {string} [workerSource] Worker 번들 소스. 없으면 바로 인라인
 * @property {number} [handshakeTimeoutMs]
 * @property {(source: string) => { transport: Transport, worker: Worker }} [createWorker] 테스트용 주입
 */

/**
 * Worker 전송을 시도하고 실패하면 인라인 전송으로 폴백한다.
 * @param {TransportOptions} [options]
 * @returns {Promise<{ transport: Transport, fallbackError: AppError | null }>}
 */
export async function createTransport(options = {}) {
  const { workerSource } = options;
  if (!workerSource) {
    return {
      transport: createInlineTransport(),
      fallbackError: new AppError('E_ENV_NO_WORKER', 'no worker source'),
    };
  }
  const make = options.createWorker ?? createWorkerTransport;
  /** @type {{ transport: Transport, worker: Worker }} */
  let created;
  try {
    created = make(workerSource);
  } catch (err) {
    return {
      transport: createInlineTransport(),
      fallbackError:
        err instanceof AppError
          ? err
          : new AppError('E_ENV_NO_WORKER', String(err), { cause: err }),
    };
  }

  const timeoutMs = options.handshakeTimeoutMs ?? HANDSHAKE_TIMEOUT_MS;
  /** @type {AppError | null} */
  const fallbackError = await new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(new AppError('E_ENV_NO_WORKER', `worker did not start within ${timeoutMs} ms`));
    }, timeoutMs);
    created.transport.onFatal((err) => {
      clearTimeout(timer);
      resolve(err);
    });
    created.transport.onMessage((message) => {
      if ('ready' in message && message.ready === true) {
        clearTimeout(timer);
        resolve(null);
      }
    });
  });

  if (fallbackError) {
    created.transport.close();
    return { transport: createInlineTransport(), fallbackError };
  }
  // 핸드셰이크용 구독을 해제한다. 이후의 치명적 오류는 createClient가 받아 대기 중인 호출을 거부한다.
  created.transport.onFatal(() => {});
  return { transport: created.transport, fallbackError: null };
}

/**
 * @param {{ transport: Transport }} options
 * @returns {Client}
 */
export function createClient(options) {
  const { transport } = options;
  let nextId = 1;
  /** @type {Map<number, { resolve: (value: unknown) => void, reject: (err: AppError) => void, onProgress?: (p: RpcProgress) => void, onChunk?: (chunk: Uint8Array<ArrayBuffer>) => void }>} */
  const pending = new Map();

  transport.onMessage((message) => {
    if ('ready' in message) return;
    const entry = pending.get(message.id);
    if (!entry) return;
    if ('progress' in message) {
      entry.onProgress?.(message.progress);
      return;
    }
    if ('chunk' in message) {
      entry.onChunk?.(message.chunk);
      return;
    }
    pending.delete(message.id);
    if (message.ok) entry.resolve(message.result);
    else entry.reject(deserializeError(message.error));
  });

  // 전송 계층이 죽으면 그 호출들은 응답을 받을 수 없다. 조용히 매달아 두지 않고 거부한다(CLAUDE.md 5.6).
  transport.onFatal((err) => {
    const waiting = [...pending.values()];
    pending.clear();
    for (const entry of waiting) entry.reject(err);
  });

  return {
    transport,
    call(op, args, callOptions = {}) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolve, reject) => {
        if (callOptions.signal?.aborted) {
          reject(new AppError('E_IMPORT_CANCELLED', 'cancelled before start'));
          return;
        }
        pending.set(id, {
          resolve: (value) => resolve(/** @type {never} */ (value)),
          reject,
          onProgress: callOptions.onProgress,
          onChunk: callOptions.onChunk,
        });
        callOptions.signal?.addEventListener(
          'abort',
          () => {
            if (pending.has(id)) transport.post({ id, cancel: true });
          },
          { once: true },
        );
        transport.post({ id, op, args }, callOptions.transfer);
      });
    },
    close() {
      transport.close();
      for (const entry of pending.values()) {
        entry.reject(new AppError('E_UNKNOWN', 'client closed'));
      }
      pending.clear();
    },
  };
}
