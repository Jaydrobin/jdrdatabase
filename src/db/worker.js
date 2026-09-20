// @ts-check
/**
 * Worker 진입점과 RPC 디스패처(D-11, DESIGN.md 6장).
 *
 * `createDispatcher()`는 전송 계층과 무관하다. Blob Worker 안에서는 `self`를 포트로 쓰고,
 * Worker를 만들 수 없는 환경에서는 `client.js`의 인라인 전송이 같은 디스패처를 메인 스레드에서 부른다.
 * Worker는 "열린 DB 하나"만 상태로 가진다.
 */
import { AppError, serializeError } from '../util/errors.js';
import { applyCommand, assertCommand } from './command.js';
import { selectEngine } from './engine.js';
import * as query from './query.js';
import * as tables from './tables.js';
import {
  adoptExternal,
  bumpRevision,
  hasMeta,
  integrityCheck,
  migrate,
  readMeta,
  validateHeader,
} from './schema.js';

/** @typedef {import('./engine.js').Engine} Engine */
/** @typedef {import('./engine.js').EngineMode} EngineMode */
/** @typedef {import('./engine.js').EngineCapabilities} EngineCapabilities */
/** @typedef {import('./engine.js').ExecResult} ExecResult */
/** @typedef {import('./engine.js').SqlParams} SqlParams */
/** @typedef {import('../util/errors.js').SerializedError} SerializedError */
/** @typedef {import('./command.js').Command} Command */
/** @typedef {import('./command.js').Direction} Direction */
/** @typedef {import('./command.js').ApplyResult} ApplyResult */
/** @typedef {import('./schema.js').Meta} Meta */
/** @typedef {import('./tables.js').TableInfo} TableInfo */
/** @typedef {import('./values.js').LogicalType} LogicalType */
/** @typedef {import('./values.js').ColumnOptions} ColumnOptions */
/** @typedef {import('./values.js').CoercePolicy} CoercePolicy */
/** @typedef {import('./query.js').ViewSpec} ViewSpec */
/** @typedef {import('./query.js').WindowRow} WindowRow */
/** @typedef {import('./query.js').FullRow} FullRow */

/**
 * `db.open`·`schema.adopt`의 결과.
 * @typedef {object} OpenResult
 * @property {Meta} meta
 * @property {TableInfo[]} tables
 * @property {boolean} [unmanaged] `_jdr_meta`가 없는 파일을 등록 없이 연 상태
 * @property {boolean} [readOnly] 앱보다 새로운 `schema_version`
 */

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
 *   'engine.init': { args: { mode: EngineMode, wasmBinary?: ArrayBuffer, appVersion?: string }, result: { version: string, compileOptions: string[], capabilities: EngineCapabilities } },
 *   'engine.exec': { args: { sql: string, params?: SqlParams }, result: ExecResult },
 *   'db.open': { args: { bytes?: Uint8Array | ArrayBuffer, dbId?: string, adoptExternal?: boolean }, result: OpenResult },
 *   'db.snapshot': { args: { bumpRevision?: boolean, savedBy?: string }, result: { bytes: Uint8Array<ArrayBuffer>, meta: Meta } },
 *   'db.close': { args: undefined, result: null },
 *   'schema.adopt': { args: undefined, result: OpenResult },
 *   'schema.list': { args: undefined, result: { tables: TableInfo[] } },
 *   'schema.create': { args: { name: string }, result: { tableId: string, cmd: Command } },
 *   'schema.rename': { args: { tableId: string, name: string }, result: { cmd: Command } },
 *   'schema.drop': { args: { tableId: string }, result: { cmd: Command } },
 *   'schema.addColumn': { args: { tableId: string, name: string, type: LogicalType, options?: ColumnOptions | null }, result: { columnId: string, columnCount: number, cmd: Command } },
 *   'schema.renameColumn': { args: { tableId: string, columnId: string, name: string }, result: { cmd: Command } },
 *   'schema.reorderColumns': { args: { tableId: string, orderedIds: string[] }, result: { cmd: Command } },
 *   'schema.softDeleteColumn': { args: { tableId: string, columnId: string }, result: { cmd: Command } },
 *   'schema.restoreColumn': { args: { tableId: string, columnId: string }, result: { cmd: Command } },
 *   'schema.changeColumnType': { args: { tableId: string, columnId: string, type: LogicalType, policy?: CoercePolicy, options?: ColumnOptions | null }, result: { columnId: string, cmd: Command, result: ApplyResult } },
 *   'command.apply': { args: { cmd: Command, direction?: Direction }, result: ApplyResult },
 *   'query.window': { args: { tableId: string, viewSpec: ViewSpec, offset: number, limit: number, seq: number }, result: { rows: WindowRow[], columnIds: string[], seq: number, elapsedMs: number } },
 *   'query.count': { args: { tableId: string, viewSpec: ViewSpec }, result: { count: number } },
 *   'query.row': { args: { tableId: string, rowId: number, colIds?: string[] }, result: { row: FullRow | null } },
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

/**
 * 서로 배타적인 op. 동시에 오면 `E_DB_BUSY`. `db.open`은 모든 op와 배타적이다.
 *
 * `db.snapshot`·`db.close`는 쓰기는 아니지만 여기 있어야 한다. 둘 다 트랜잭션 상태를 전제로
 * 하는데(스냅샷은 트랜잭션 밖에서만, 닫기는 연결을 없앤다), 쓰기 op가 청크 사이에서 이벤트
 * 루프로 돌아오므로 그 틈에 끼어들 수 있다. 끼어들면 중첩 SAVEPOINT 이름이 겹쳐 롤백이 깨지고,
 * 파일에는 아무것도 쓰이지 않았는데 revision만 오른 DB가 남는다.
 */
export const EXCLUSIVE_OPS = new Set([
  'command.apply',
  'import.run',
  'search.enable',
  'db.snapshot',
  'db.close',
]);

/**
 * 6장 규칙의 배타 여부. `schema.*`는 `schema.list`를 뺀 전부가 쓰기다.
 * @param {string} op
 * @returns {boolean}
 */
export function isExclusiveOp(op) {
  return EXCLUSIVE_OPS.has(op) || (op.startsWith('schema.') && op !== 'schema.list');
}

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
  /** `_jdr_meta.app_version`에 기록할 앱 버전. `engine.init`이 넘긴다. */
  let appVersion = '0.0.0';
  /** @type {Map<number, { op: string, controller: AbortController }>} */
  const inflight = new Map();
  /**
   * 쓰기 op가 끝날 때마다 오르는 일련번호. `query.count`의 결과를 이 번호와 함께 캐시해, 쓰기가 없는
   * 동안의 창 질의가 행 수를 다시 세지 않고(30만 행에서 35 ms) id 연속 여부를 판정할 수 있게 한다.
   */
  let writeSerial = 0;
  /** @type {Map<string, { serial: number, count: number }>} */
  const countCache = new Map();

  /**
   * 테이블의 행 수. 마지막 쓰기 뒤에 센 값이 있으면 그것을 쓴다.
   * @param {Engine} active
   * @param {TableInfo} table
   * @param {ViewSpec} viewSpec
   * @returns {number}
   */
  function countRows(active, table, viewSpec) {
    const cached = countCache.get(table.id);
    if (cached && cached.serial === writeSerial) return cached.count;
    const count = query.count(active, table, viewSpec);
    countCache.set(table.id, { serial: writeSerial, count });
    return count;
  }

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
      if (typeof args.appVersion === 'string' && args.appVersion) appVersion = args.appVersion;
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
      const active = requireEngine();
      const raw = args?.bytes;
      const bytes = raw instanceof ArrayBuffer ? new Uint8Array(raw) : raw;
      // 헤더는 deserialize 전에 본다. 틀린 파일을 엔진에 넣으면 첫 읽기에서야 SQLITE_NOTADB가 나고
      // 그 사이에 이전 DB가 닫힌다.
      if (bytes) validateHeader(bytes);
      await active.open(bytes);
      if (bytes) {
        try {
          integrityCheck(active);
        } catch (err) {
          // 손상 파일은 열지 않는다. Worker는 "열린 DB 없음" 상태가 되고 메인이 새 DB를 연다.
          await active.close();
          throw err;
        }
      }
      if (bytes && !hasMeta(active) && !args?.adoptExternal) {
        return { meta: {}, tables: [], unmanaged: true };
      }
      if (bytes && !hasMeta(active)) {
        const meta = await adoptExternal(active, { appVersion });
        return { meta, tables: tables.list(active) };
      }
      const migrated = await migrate(active, { appVersion, dbId: args?.dbId });
      return {
        meta: migrated.meta,
        tables: tables.list(active),
        ...(migrated.readOnly ? { readOnly: true } : {}),
      };
    },

    'db.snapshot': async (args) => {
      const active = requireEngine();
      // 등록하지 않은 외부 파일(unmanaged)은 메타가 없다. revision을 올려야 하면 그때 메타를 만든다.
      if (!hasMeta(active) && args?.bumpRevision) await migrate(active, { appVersion });
      const meta = args?.bumpRevision
        ? await bumpRevision(active, { savedBy: args.savedBy ?? '' })
        : hasMeta(active)
          ? readMeta(active)
          : {};
      const bytes = active.snapshot();
      return { result: { bytes, meta }, transfer: [bytes.buffer] };
    },

    'schema.adopt': async () => {
      const active = requireEngine();
      const meta = await adoptExternal(active, { appVersion });
      return { meta, tables: tables.list(active) };
    },

    'schema.list': async () => ({ tables: tables.list(requireEngine()) }),

    'schema.create': async (args) => tables.create(requireEngine(), { name: args.name }),

    'schema.rename': async (args) =>
      tables.rename(requireEngine(), args.tableId, { name: args.name }),

    'schema.drop': async (args) => tables.drop(requireEngine(), args.tableId),

    'schema.addColumn': async (args) =>
      tables.addColumn(requireEngine(), args.tableId, {
        name: args.name,
        type: args.type,
        options: args.options,
      }),

    'schema.renameColumn': async (args) =>
      tables.renameColumn(requireEngine(), args.tableId, args.columnId, { name: args.name }),

    'schema.reorderColumns': async (args) =>
      tables.reorderColumns(requireEngine(), args.tableId, { orderedIds: args.orderedIds }),

    'schema.softDeleteColumn': async (args) =>
      tables.softDeleteColumn(requireEngine(), args.tableId, args.columnId),

    'schema.restoreColumn': async (args) =>
      tables.restoreColumn(requireEngine(), args.tableId, args.columnId),

    'schema.changeColumnType': async (args, ctx) =>
      tables.changeColumnType(
        requireEngine(),
        args.tableId,
        args.columnId,
        { type: args.type, policy: args.policy, options: args.options },
        { signal: ctx.signal, progress: ctx.progress },
      ),

    'command.apply': async (args, ctx) => {
      const cmd = assertCommand(args?.cmd);
      const direction = args?.direction === 'undo' ? 'undo' : 'do';
      return applyCommand(requireEngine(), cmd, direction, {
        signal: ctx.signal,
        progress: ctx.progress,
      });
    },

    'query.window': async (args) => {
      const active = requireEngine();
      const table = tables.requireTable(active, args.tableId);
      const seq = typeof args.seq === 'number' ? args.seq : 0;
      const viewSpec = args.viewSpec ?? {};
      const result = query.fetchWindow(
        active,
        table,
        viewSpec,
        { offset: args.offset, limit: args.limit },
        { count: countRows(active, table, viewSpec) },
      );
      return { ...result, seq };
    },

    'query.count': async (args) => {
      const active = requireEngine();
      const table = tables.requireTable(active, args.tableId);
      return { count: countRows(active, table, args.viewSpec ?? {}) };
    },

    'query.row': async (args) => {
      const active = requireEngine();
      const table = tables.requireTable(active, args.tableId);
      if (typeof args.rowId !== 'number' || !Number.isInteger(args.rowId)) {
        throw new AppError('E_DB_QUERY', 'rowId must be an integer', {
          detail: { rowId: args.rowId },
        });
      }
      return { row: query.fetchRow(active, table, args.rowId, args.colIds ?? []) };
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

  /** 행 수 캐시를 무효화하지 않아도 되는 op: 읽기와, 메타만 쓰는 `db.snapshot`. */
  const READ_OPS = new Set([
    'engine.init',
    'schema.list',
    'query.window',
    'query.count',
    'query.row',
    'db.snapshot',
  ]);

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
      if (isExclusiveOp(op) && isExclusiveOp(running.op)) {
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
      // 쓰기 op 뒤에는 행 수 캐시가 낡는다. 실패한 쓰기도 롤백 전 상태를 단정할 수 없어 catch에서도 올린다.
      if (!READ_OPS.has(op)) writeSerial += 1;
      if (hasTransfer(returned)) {
        post({ id, ok: true, result: returned.result }, returned.transfer);
      } else {
        post({ id, ok: true, result: returned });
      }
    } catch (err) {
      if (typeof op === 'string' && !READ_OPS.has(op)) writeSerial += 1;
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
