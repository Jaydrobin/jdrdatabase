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
import { exportCsv } from '../export/csv.js';
import { exportXlsx } from '../export/xlsx.js';
import * as pipeline from '../import/pipeline.js';
import * as query from './query.js';
import * as search from './search.js';
import * as tables from './tables.js';
import * as views from './views.js';
import {
  adoptExternal,
  bumpRevision,
  hasMeta,
  integrityCheck,
  migrate,
  readMeta,
  validateHeader,
  writeMeta,
} from './schema.js';

/** @typedef {import('./engine.js').Engine} Engine */
/** @typedef {import('./engine.js').EngineMode} EngineMode */
/** @typedef {import('./engine.js').EngineCapabilities} EngineCapabilities */
/** @typedef {import('./engine.js').ExecResult} ExecResult */
/** @typedef {import('./engine.js').SqlParams} SqlParams */
/** @typedef {import('./engine.js').NativeOpenInfo} NativeOpenInfo */
/** @typedef {import('../util/errors.js').SerializedError} SerializedError */
/** @typedef {import('./command.js').Command} Command */
/** @typedef {import('./command.js').Direction} Direction */
/** @typedef {import('./command.js').ApplyResult} ApplyResult */
/** @typedef {import('./schema.js').Meta} Meta */
/** @typedef {import('./tables.js').TableInfo} TableInfo */
/** @typedef {import('./tables.js').NewColumn} NewColumn */
/** @typedef {import('./values.js').LogicalType} LogicalType */
/** @typedef {import('./values.js').ColumnOptions} ColumnOptions */
/** @typedef {import('./values.js').CoercePolicy} CoercePolicy */
/** @typedef {import('./query.js').ViewSpec} ViewSpec */
/** @typedef {import('./query.js').WindowRow} WindowRow */
/** @typedef {import('./query.js').FullRow} FullRow */
/** @typedef {import('./query.js').RowStats} RowStats */
/** @typedef {import('./views.js').View} View */
/** @typedef {import('./views.js').SavedViewSpec} SavedViewSpec */
/** @typedef {import('../import/pipeline.js').ImportOptions} ImportOptions */
/** @typedef {import('../import/pipeline.js').ImportMapping} ImportMapping */
/** @typedef {import('../import/pipeline.js').ImportTarget} ImportTarget */
/** @typedef {import('../import/pipeline.js').ImportPolicy} ImportPolicy */
/** @typedef {import('../import/pipeline.js').ImportReport} ImportReport */
/** @typedef {import('../import/pipeline.js').PreviewResult} PreviewResult */
/** @typedef {import('../export/csv.js').CsvExportOptions} CsvExportOptions */
/** @typedef {import('../export/csv.js').ExportResult} ExportResult */

/**
 * `db.open`·`schema.adopt`의 결과.
 * @typedef {object} OpenResult
 * @property {Meta} meta
 * @property {TableInfo[]} tables
 * @property {boolean} [unmanaged] `_jdr_meta`가 없는 파일을 등록 없이 연 상태
 * @property {boolean} [readOnly] 앱보다 새로운 `schema_version`
 * @property {NativeOpenInfo} [workcopy] 데스크톱 모드의 작업 사본 정보(복구 판정용, D-15)
 */

/** @typedef {{ phase: string, done: number, total: number }} RpcProgress */
/** @typedef {{ id: number, op: string, args?: unknown }} RpcRequest */
/** @typedef {{ id: number, cancel: true }} RpcCancel */
/** @typedef {{ id: number, ok: true, result: unknown }} RpcOk */
/** @typedef {{ id: number, ok: false, error: SerializedError }} RpcFail */
/** @typedef {{ id: number, progress: RpcProgress }} RpcProgressEvent */
/** @typedef {{ id: number, chunk: Uint8Array<ArrayBuffer> }} RpcChunkEvent 내보내기 조각(Step 9). 바이트는 transfer */
/** @typedef {{ ready: true }} RpcReady 전송 계층 핸드셰이크. Worker 부팅 직후 한 번 보낸다 */
/** @typedef {RpcOk | RpcFail | RpcProgressEvent | RpcChunkEvent | RpcReady} RpcOutbound */
/** @typedef {RpcRequest | RpcCancel} RpcInbound */

/**
 * RPC op 표(DESIGN.md 6장). 새 op는 여기와 `handlers`, 6장 표, 단위 테스트를 함께 갱신한다.
 * @typedef {{
 *   'engine.init': { args: { mode: EngineMode, wasmBinary?: ArrayBuffer, appVersion?: string, native?: { url: string, token: string } }, result: { version: string, compileOptions: string[], capabilities: EngineCapabilities } },
 *   'engine.exec': { args: { sql: string, params?: SqlParams }, result: ExecResult },
 *   'db.open': { args: { bytes?: Uint8Array | ArrayBuffer, dbId?: string, adoptExternal?: boolean, originalPath?: string, discardWorkcopy?: boolean, workcopyKey?: string }, result: OpenResult },
 *   'db.snapshot': { args: { bumpRevision?: boolean, savedBy?: string }, result: { bytes: Uint8Array<ArrayBuffer>, meta: Meta } },
 *   'db.save': { args: { originalPath: string, bumpRevision?: boolean, savedBy?: string, force?: boolean }, result: { meta: Meta, size: number, mtime: number, backupPath: string | null } },
 *   'db.size': { args: undefined, result: { bytes: number } },
 *   'db.close': { args: { discardWorkcopy?: boolean } | undefined, result: null },
 *   'schema.adopt': { args: undefined, result: OpenResult },
 *   'schema.list': { args: undefined, result: { tables: TableInfo[] } },
 *   'schema.create': { args: { name: string, columns?: NewColumn[] }, result: { tableId: string, cmd: Command } },
 *   'schema.rename': { args: { tableId: string, name: string }, result: { cmd: Command } },
 *   'schema.drop': { args: { tableId: string }, result: { cmd: Command } },
 *   'schema.addColumn': { args: { tableId: string, name: string, type: LogicalType, options?: ColumnOptions | null }, result: { columnId: string, columnCount: number, cmd: Command } },
 *   'schema.renameColumn': { args: { tableId: string, columnId: string, name: string }, result: { cmd: Command } },
 *   'schema.reorderColumns': { args: { tableId: string, orderedIds: string[] }, result: { cmd: Command } },
 *   'schema.softDeleteColumn': { args: { tableId: string, columnId: string }, result: { cmd: Command } },
 *   'schema.restoreColumn': { args: { tableId: string, columnId: string }, result: { cmd: Command } },
 *   'schema.changeColumnType': { args: { tableId: string, columnId: string, type: LogicalType, policy?: CoercePolicy, options?: ColumnOptions | null }, result: { columnId: string, cmd: Command, result: ApplyResult } },
 *   'command.apply': { args: { cmd: Command, direction?: Direction, replay?: boolean }, result: ApplyResult },
 *   'query.window': { args: { tableId: string, viewSpec: ViewSpec, offset: number, limit: number, seq: number }, result: { rows: WindowRow[], columnIds: string[], seq: number, elapsedMs: number } },
 *   'query.count': { args: { tableId: string, viewSpec: ViewSpec }, result: { count: number, elapsedMs: number } },
 *   'query.row': { args: { tableId: string, rowId: number, colIds?: string[] }, result: { row: FullRow | null } },
 *   'query.rows': { args: { tableId: string, viewSpec: ViewSpec, offset: number, limit: number, colIds?: string[] }, result: { rows: FullRow[] } },
 *   'query.stats': { args: { tableId: string }, result: RowStats },
 *   'search.enable': { args: { tableId: string }, result: { cmd: Command } },
 *   'search.disable': { args: { tableId: string }, result: { cmd: Command } },
 *   'views.list': { args: { tableId: string }, result: { views: View[] } },
 *   'views.save': { args: { tableId: string, name: string, spec: SavedViewSpec, viewId?: string }, result: { viewId: string, cmd: Command } },
 *   'views.delete': { args: { viewId: string }, result: { cmd: Command } },
 *   'import.preview': { args: { file: Blob, options: ImportOptions }, result: PreviewResult },
 *   'import.run': { args: { file: Blob, options: ImportOptions, mapping: ImportMapping, target: ImportTarget, policy?: ImportPolicy }, result: { report: ImportReport } },
 *   'export.stream': { args: { tableId: string, viewSpec: ViewSpec, format: 'csv' | 'xlsx', options?: CsvExportOptions }, result: ExportResult },
 * }} OpMap
 */
/** @typedef {keyof OpMap} OpName */

/**
 * 핸들러가 받는 실행 문맥.
 * @typedef {object} HandlerContext
 * @property {AbortSignal} signal 취소 신호. 취소를 지원하는 op만 확인한다
 * @property {(progress: RpcProgress) => void} progress 진행 이벤트. 250 ms 간격으로 조절된다
 * @property {(bytes: Uint8Array<ArrayBuffer>) => void} chunk 조각 이벤트(`export.stream`). 조절 없이 순서대로, 바이트는 transfer
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
 * 행 수 캐시가 들고 있는 (테이블 × 뷰 조건) 항목 수 상한. 쓰기마다 비우므로 평소에는 한참 아래지만,
 * 쓰기 없이 검색·필터만 바꾸는 동안에도 한계를 둔다.
 */
export const COUNT_CACHE_MAX = 64;

/**
 * 서로 배타적인 op. 동시에 오면 `E_DB_BUSY`. `db.open`은 모든 op와 배타적이다.
 *
 * `db.snapshot`·`db.close`는 쓰기는 아니지만 여기 있어야 한다. 둘 다 트랜잭션 상태를 전제로
 * 하는데(스냅샷은 트랜잭션 밖에서만, 닫기는 연결을 없앤다), 쓰기 op가 청크 사이에서 이벤트
 * 루프로 돌아오므로 그 틈에 끼어들 수 있다. 끼어들면 중첩 SAVEPOINT 이름이 겹쳐 롤백이 깨지고,
 * 파일에는 아무것도 쓰이지 않았는데 revision만 오른 DB가 남는다.
 */
/**
 * 데이터 커맨드인가(스키마·뷰·검색 커맨드가 아닌가). 스키마 op는 `tables.js`가 이미 `requireStrict`를
 * 하므로, Worker 경계에서 다시 보는 것은 UI 밖에서도 만들어질 수 있는 데이터 커맨드뿐이다.
 * @param {Command} cmd
 * @returns {boolean}
 */
export function isDataCommand(cmd) {
  return cmd.type.startsWith('cell.') || cmd.type.startsWith('row.');
}

export const EXCLUSIVE_OPS = new Set([
  'command.apply',
  'import.run',
  'search.enable',
  'search.disable',
  'views.save',
  'views.delete',
  'db.snapshot',
  'db.save',
  'db.close',
  'export.stream',
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
 * @property {() => number} countCacheSize 행 수 캐시의 항목 수(테스트·진단용)
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
  /**
   * 테이블 id와 뷰 조건(필터·검색. 정렬은 행 수를 바꾸지 않는다)을 키로 한다. `elapsedMs`는 처음 센
   * 시간이며 캐시에서 돌려줄 때도 그대로 보고한다(8장 측정은 첫 계산을 본다).
   *
   * 키에 검색어가 들어가므로 한 글자마다 항목이 하나씩 생긴다. 쓰기가 있을 때 통째로 비우고(그때 모든
   * 항목이 어차피 낡는다) 그 사이에도 상한을 두어, 오래 열어 둔 탭에서 끝없이 자라지 않게 한다.
   * @type {Map<string, { serial: number, count: number, elapsedMs: number }>}
   */
  const countCache = new Map();

  /**
   * 테이블의 행 수(뷰 조건 포함). 마지막 쓰기 뒤에 같은 조건으로 센 값이 있으면 그것을 쓴다.
   * @param {Engine} active
   * @param {TableInfo} table
   * @param {ViewSpec} viewSpec
   * @returns {{ count: number, elapsedMs: number }}
   */
  function countRows(active, table, viewSpec) {
    const spec = query.normalizeViewSpec(viewSpec);
    const key = `${table.id}\u0000${JSON.stringify([spec.filter, spec.search])}`;
    const cached = countCache.get(key);
    if (cached && cached.serial === writeSerial) {
      return { count: cached.count, elapsedMs: cached.elapsedMs };
    }
    const started = performance.now();
    const count = query.count(active, table, viewSpec);
    const elapsedMs = performance.now() - started;
    if (countCache.size >= COUNT_CACHE_MAX) {
      const oldest = countCache.keys().next().value;
      if (oldest !== undefined) countCache.delete(oldest);
    }
    countCache.set(key, { serial: writeSerial, count, elapsedMs });
    return { count, elapsedMs };
  }

  /** 쓰기 뒤: 모든 항목이 낡으므로 통째로 비운다(키가 늘어나기만 하는 것을 막는다). */
  function invalidateCounts() {
    writeSerial += 1;
    countCache.clear();
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
      const info = await next.init({ wasmBinary: args.wasmBinary, native: args.native });
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
      // 데스크톱 모드는 바이트 대신 원본 경로(또는 남은 사본의 키)를 받는다(D-15). 헤더 검사와
      // 작업 사본 복사는 러스트가 한다.
      /** @type {import('./engine.js').NativeOpenSource | undefined} */
      const nativeSource =
        typeof args?.originalPath === 'string' || typeof args?.workcopyKey === 'string'
          ? {
              ...(typeof args.originalPath === 'string' ? { originalPath: args.originalPath } : {}),
              ...(typeof args.workcopyKey === 'string' ? { workcopyKey: args.workcopyKey } : {}),
              ...(args.discardWorkcopy ? { discardWorkcopy: true } : {}),
            }
          : undefined;
      // 헤더는 deserialize 전에 본다. 틀린 파일을 엔진에 넣으면 첫 읽기에서야 SQLITE_NOTADB가 나고
      // 그 사이에 이전 DB가 닫힌다.
      if (bytes) validateHeader(bytes);
      const workcopy = await active.open(bytes ?? nativeSource);
      if (bytes) {
        try {
          integrityCheck(active);
        } catch (err) {
          // 손상 파일은 열지 않는다. Worker는 "열린 DB 없음" 상태가 되고 메인이 새 DB를 연다.
          await active.close();
          throw err;
        }
      }
      // 사본 정보는 원본 파일을 연 경우에만 뜻이 있다. 새 DB의 임시 사본은 저장 뒤 원본이 정해진다.
      const extra = workcopy ? { workcopy } : {};
      const isFile = bytes !== undefined || (workcopy?.originalPath ?? null) !== null;
      if (isFile && !hasMeta(active) && !args?.adoptExternal) {
        return { meta: {}, tables: [], unmanaged: true, ...extra };
      }
      if (isFile && !hasMeta(active)) {
        const meta = await adoptExternal(active, { appVersion });
        return { meta, tables: tables.list(active), ...extra };
      }
      const migrated = await migrate(active, { appVersion, dbId: args?.dbId });
      return {
        meta: migrated.meta,
        tables: tables.list(active),
        ...(migrated.readOnly ? { readOnly: true } : {}),
        ...extra,
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

    'db.size': async () => {
      const active = requireEngine();
      // 직렬화하면 나올 바이트 수. 비어 있는 페이지(freelist)도 파일에 들어가므로 page_count로 센다.
      const count = active.exec('PRAGMA page_count').rows[0]?.[0];
      const size = active.exec('PRAGMA page_size').rows[0]?.[0];
      return { bytes: Number(count ?? 0) * Number(size ?? 0) };
    },

    'db.save': async (args) => {
      const active = requireEngine();
      if (active.capabilities().persistence === 'snapshot') {
        throw new AppError('E_UNSUPPORTED', 'db.save is native-only; use db.snapshot in wasm mode');
      }
      if (typeof args?.originalPath !== 'string' || !args.originalPath) {
        throw new AppError('E_FILE_WRITE', 'db.save requires originalPath');
      }
      // `db.snapshot`과 같은 순서: 메타를 먼저 기록하고 파일을 만든다. 등록하지 않은 외부 파일은 그때 메타를 만든다.
      if (!hasMeta(active) && args.bumpRevision) await migrate(active, { appVersion });
      const before = hasMeta(active) ? readMeta(active) : {};
      const meta = args.bumpRevision
        ? await bumpRevision(active, { savedBy: args.savedBy ?? '' })
        : before;
      /** @type {import('./engine.js').NativeSaveInfo | undefined} */
      let saved;
      try {
        saved = await active.saveTo(args.originalPath, undefined, { force: args.force === true });
      } catch (err) {
        // 파일은 바뀌지 않았으므로 올린 revision·saved_at·saved_by를 되돌린다. 그대로 두면 사본의 revision이 파일보다
        // 앞서 다음 복구 판정(D-15)이 어긋난다. 브라우저 모드의 스냅샷은 메모리 DB라 같은 문제가 없다.
        if (args.bumpRevision && hasMeta(active)) {
          await active.transaction(() => {
            for (const key of ['revision', 'saved_at', 'saved_by']) {
              const previous = before[key];
              if (previous === undefined) {
                active.run('DELETE FROM _jdr_meta WHERE key = ?', [key]);
              } else {
                writeMeta(active, { [key]: previous });
              }
            }
          });
        }
        throw err;
      }
      if (!saved) throw new AppError('E_UNSUPPORTED', 'saveTo returned nothing');
      // 저장이 끝났으므로 사본의 dirty 표식을 내린다(D-15). 저장된 파일에는 이 값이 남아 있어도 뜻이 없다.
      if (hasMeta(active)) {
        await active.transaction(() => writeMeta(active, { dirty: 0 }));
      }
      return {
        meta: hasMeta(active) ? readMeta(active) : meta,
        size: saved.size,
        mtime: saved.mtime,
        backupPath: saved.backupPath ?? null,
      };
    },

    'schema.adopt': async () => {
      const active = requireEngine();
      const meta = await adoptExternal(active, { appVersion });
      return { meta, tables: tables.list(active) };
    },

    'schema.list': async () => ({ tables: tables.list(requireEngine()) }),

    'schema.create': async (args) =>
      tables.create(requireEngine(), {
        name: args.name,
        ...(Array.isArray(args.columns) ? { columns: args.columns } : {}),
      }),

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
      const active = requireEngine();
      // 외부(비STRICT) 테이블은 읽기 전용이다(R7). UI는 `editableTable`로 막지만 Worker에도 같은 층의
      // 방어를 둔다(세션 B 점검이 `tables.drop`에 넣은 `requireStrict`와 같은 규칙). 스키마 op는
      // `tables.js`가 이미 검사하므로 여기서는 UI 밖에서도 들어올 수 있는 데이터 커맨드만 본다.
      if (isDataCommand(cmd) && cmd.tableId !== null) {
        const target = tables.get(active, cmd.tableId);
        if (target && !target.strict) {
          // 저널 재생은 막지 않는다. 사본을 만든 뒤 그 테이블이 외부 등록으로 바뀐 경우 복구 전체가
          // 멈추면 그게 더 큰 손실이므로, 그 항목만 건너뛰고 호출자가 알릴 수 있게 알려 준다.
          if (args?.replay === true) return { affected: 0, skipped: 'external_table' };
          tables.requireStrict(target);
        }
      }
      return applyCommand(active, cmd, direction, {
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
        { count: countRows(active, table, viewSpec).count },
      );
      return { ...result, seq };
    },

    'query.count': async (args) => {
      const active = requireEngine();
      const table = tables.requireTable(active, args.tableId);
      return countRows(active, table, args.viewSpec ?? {});
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

    'query.rows': async (args) => {
      const active = requireEngine();
      const table = tables.requireTable(active, args.tableId);
      return {
        rows: query.fetchRows(
          active,
          table,
          args.viewSpec ?? {},
          { offset: args.offset, limit: args.limit },
          args.colIds ?? [],
        ),
      };
    },

    'query.stats': async (args) => {
      const active = requireEngine();
      return query.stats(active, tables.requireTable(active, args.tableId));
    },

    'search.enable': async (args, ctx) =>
      search.enable(requireEngine(), args.tableId, { signal: ctx.signal, progress: ctx.progress }),

    'search.disable': async (args) => search.disable(requireEngine(), args.tableId),

    'views.list': async (args) => ({ views: views.list(requireEngine(), args.tableId) }),

    'views.save': async (args) =>
      views.save(requireEngine(), args.tableId, {
        name: args.name,
        spec: args.spec,
        viewId: args.viewId,
      }),

    'views.delete': async (args) => views.remove(requireEngine(), args.viewId),

    'import.preview': async (args, ctx) =>
      pipeline.preview(pipeline.requireBlob(args?.file), pipeline.normalizeOptions(args?.options), {
        signal: ctx.signal,
      }),

    'import.run': async (args, ctx) =>
      pipeline.run({
        engine: requireEngine(),
        file: pipeline.requireBlob(args?.file),
        options: pipeline.normalizeOptions(args?.options),
        mapping: args.mapping,
        target: args.target,
        policy: args.policy,
        signal: ctx.signal,
        progress: ctx.progress,
      }),

    'export.stream': async (args, ctx) => {
      const active = requireEngine();
      const table = tables.requireTable(active, args.tableId);
      const viewSpec = args.viewSpec ?? {};
      const sink = { write: (/** @type {Uint8Array<ArrayBuffer>} */ bytes) => ctx.chunk(bytes) };
      const exportCtx = { signal: ctx.signal, progress: ctx.progress };
      if (args.format === 'xlsx') return exportXlsx(active, table, viewSpec, sink, exportCtx);
      if (args.format === 'csv') {
        return exportCsv(active, table, viewSpec, args.options, sink, exportCtx);
      }
      throw new AppError('E_DB_QUERY', 'export format must be csv or xlsx', {
        detail: { format: String(args.format).slice(0, 20) },
      });
    },

    'db.close': async (args) => {
      await requireEngine().close({ discard: args?.discardWorkcopy === true });
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

  /** 행 수 캐시를 무효화하지 않아도 되는 op: 읽기와, 메타만 쓰는 `db.snapshot`, 읽기만 하는 `export.stream`. */
  const READ_OPS = new Set([
    'engine.init',
    'schema.list',
    'query.window',
    'query.count',
    'query.row',
    'query.rows',
    'query.stats',
    'views.list',
    'import.preview',
    'db.snapshot',
    'db.save',
    'export.stream',
  ]);

  /**
   * 작업 사본의 dirty 표식을 올리지 않는 op: 읽기와 열기·닫기·저장·초기화, 그리고 진단·테스트 전용 `engine.exec`
   * (UI가 부르지 않으며, 검사 질의가 사본을 dirty로 만들면 복구 제안이 잘못 뜬다).
   */
  const NOT_DIRTY_OPS = new Set([...READ_OPS, 'db.open', 'db.close', 'engine.init', 'engine.exec']);

  /**
   * 데스크톱 모드(D-15): 쓰기 op가 성공하면 사본에 `_jdr_meta.dirty = 1`을 남겨 비정상 종료 뒤 복구를 제안할 수 있게 한다.
   * 이 기록의 실패는 방금 성공한 op를 되돌리지 않으므로 경고만 남긴다.
   * @param {string} op
   */
  async function markWorkcopyDirty(op) {
    if (NOT_DIRTY_OPS.has(op) || !engine) return;
    const active = engine;
    if (active.capabilities().persistence === 'snapshot') return;
    try {
      if (hasMeta(active)) await active.transaction(() => writeMeta(active, { dirty: 1 }));
    } catch (err) {
      console.warn(`dirty mark failed after ${op}: ${serializeError(err).message}`);
    }
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
      /** @param {Uint8Array<ArrayBuffer>} bytes */
      const chunk = (bytes) => post({ id, chunk: bytes }, [bytes.buffer]);
      const handler = /** @type {(args: unknown, ctx: HandlerContext) => Promise<unknown>} */ (
        handlers[op]
      );
      const returned = await handler(request.args, { signal: controller.signal, progress, chunk });
      // 쓰기 op 뒤에는 행 수 캐시가 낡는다. 실패한 쓰기도 롤백 전 상태를 단정할 수 없어 catch에서도 올린다.
      if (!READ_OPS.has(op)) invalidateCounts();
      await markWorkcopyDirty(op);
      if (hasTransfer(returned)) {
        post({ id, ok: true, result: returned.result }, returned.transfer);
      } else {
        post({ id, ok: true, result: returned });
      }
    } catch (err) {
      if (typeof op === 'string' && !READ_OPS.has(op)) invalidateCounts();
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
    /** 행 수 캐시가 들고 있는 항목 수(상한을 지키는지 보는 검사용). */
    countCacheSize: () => countCache.size,
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
    // `callId`가 있는 메시지는 네이티브 엔진의 동기 중계 응답(D-15)이며 `engine-native.js`가 받는다.
    const data = ev.data;
    if (data && typeof data === 'object' && 'callId' in data) return;
    // dispatch는 자체적으로 모든 오류를 응답으로 바꾸므로 여기서 기다릴 필요가 없다.
    void dispatcher.dispatch(/** @type {RpcInbound} */ (data));
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
