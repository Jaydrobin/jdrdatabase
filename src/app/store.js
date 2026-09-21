// @ts-check
/**
 * 앱 상태(파일 상태 부분, Step 2)와 이벤트 버스. 열기·저장·저널 복구·revision 판정의 흐름이 여기 있다.
 *
 * DOM을 만지지 않는다. 사용자에게 묻는 일은 `prompts`, 알리는 일은 `notify`로 주입받아 Node에서도 검사할 수 있다.
 * 엔진에는 `db/client.js`로만 접근한다(CLAUDE.md 4장).
 */
import { judge } from './revision.js';
import { normalizeViewSpec, pruneViewSpec, toggleSort } from '../db/query.js';
import { AppError, toAppError } from '../util/errors.js';

/** @typedef {import('../db/client.js').Client} Client */
/** @typedef {import('../db/engine.js').EngineCapabilities} EngineCapabilities */
/** @typedef {import('../db/schema.js').Meta} Meta */
/** @typedef {import('../db/command.js').Command} Command */
/** @typedef {import('../db/tables.js').TableInfo} TableInfo */
/** @typedef {import('../db/worker.js').OpMap} OpMap */
/** @typedef {import('../db/client.js').CallOptions} CallOptions */
/** @typedef {import('../io/idb.js').Idb} Idb */
/** @typedef {import('../io/autosave.js').Autosave} Autosave */
/** @typedef {import('../io/autosave.js').JournalSummary} JournalSummary */
/** @typedef {import('../io/tablock.js').TabLock} TabLock */
/** @typedef {import('../io/filesystem.js').PickedFile} PickedFile */
/** @typedef {import('../io/filesystem.js').SaveTarget} SaveTarget */
/** @typedef {import('../io/filesystem.js').SaveKind} SaveKind */
/** @typedef {import('../io/filesystem.js').ByteSink} ByteSink */
/** @typedef {import('../export/csv.js').CsvExportOptions} CsvExportOptions */
/** @typedef {import('../export/csv.js').ExportResult} ExportResult */
/** @typedef {import('../i18n/index.js').MessageKey} MessageKey */
/** @typedef {import('../i18n/index.js').MessageParams} MessageParams */
/** @typedef {import('../db/query.js').ViewSpec} ViewSpec */
/** @typedef {import('../db/query.js').NormalizedViewSpec} NormalizedViewSpec */
/** @typedef {import('../db/query.js').SortSpec} SortSpec */
/** @typedef {import('../db/query.js').FilterSpec} FilterSpec */
/** @typedef {import('../db/views.js').View} View */
/** @typedef {import('../db/views.js').SavedViewSpec} SavedViewSpec */
/** @typedef {import('../import/pipeline.js').ImportOptions} ImportOptions */
/** @typedef {import('../import/pipeline.js').ImportMapping} ImportMapping */
/** @typedef {import('../import/pipeline.js').ImportTarget} ImportTarget */
/** @typedef {import('../import/pipeline.js').ImportPolicy} ImportPolicy */
/** @typedef {import('../import/pipeline.js').ImportReport} ImportReport */
/** @typedef {import('../import/pipeline.js').PreviewResult} PreviewResult */

/** 저장 직전 백업을 IDB에 남기는 파일 크기 상한(D-04). */
export const BACKUP_MAX_BYTES = 200 * 1024 * 1024;
/** IDB `handles` 스토어에서 최근 파일 핸들을 두는 키. */
export const RECENT_HANDLE_KEY = 'recent';
/** 열 너비 하한(px). 이보다 좁히면 내용도 크기 조절 손잡이도 보이지 않는다. */
export const MIN_COLUMN_WIDTH = 40;

/**
 * 파일 접근 함수 묶음. `io/filesystem.js`의 export와 같은 형태이며 테스트가 가짜를 넣는다.
 * @typedef {object} FileSystemLike
 * @property {() => Promise<PickedFile | null>} pickOpen
 * @property {(suggestedName: string, kind?: SaveKind) => Promise<SaveTarget>} pickSaveAs
 * @property {(source: File | FileSystemFileHandle) => Promise<Uint8Array>} readAll
 * @property {(handle: FileSystemFileHandle, bytes: Uint8Array<ArrayBuffer>) => Promise<void>} write
 * @property {(name: string, bytes: Uint8Array<ArrayBuffer> | Blob) => void} download
 * @property {(handle: FileSystemFileHandle, mode: 'read' | 'readwrite') => Promise<void>} ensurePermission
 * @property {(target: { kind: 'handle', handle: FileSystemFileHandle } | { kind: 'download', name: string }, mime: string) => Promise<ByteSink>} openSink 내보내기 조각을 받을 싱크(Step 9)
 * @property {(bytes: Uint8Array) => Promise<Uint8Array<ArrayBuffer>>} gzip
 * @property {(bytes: Uint8Array) => Promise<Uint8Array<ArrayBuffer>>} gunzip
 * @property {(bytes: Uint8Array) => boolean} isGzip
 * @property {() => boolean} gzipSupported
 */

/**
 * 사용자에게 묻는 대화상자. UI(`ui/dialogs/conflict.js`)가 구현한다.
 * @typedef {object} Prompts
 * @property {() => Promise<boolean>} discardUnsaved 미저장 변경을 버리고 계속할지
 * @property {() => Promise<boolean>} adoptExternal 다른 도구가 만든 SQLite 파일에 메타를 추가할지
 * @property {(info: { size: number, warn: number }) => Promise<boolean>} largeFile 경고 상한을 넘는 파일을 계속 열지
 * @property {(info: { fileRevision: number, knownRevision: number }) => Promise<boolean>} revisionBehind 되돌아간 파일을 그대로 열지
 * @property {(info: { count: number, truncated: boolean, isNew: boolean, fileName: string | null }) => Promise<'recover' | 'discard'>} journalRecover
 * @property {(info: { count: number, baseRevision: number, fileRevision: number }) => Promise<'export' | 'discard'>} journalMismatch
 */

/**
 * @typedef {object} Notifier
 * @property {(err: AppError) => void} error
 * @property {(key: MessageKey, params?: MessageParams) => void} info
 */

/**
 * @typedef {object} FileState
 * @property {string | null} name 저장한 적 없는 새 DB면 null
 * @property {FileSystemFileHandle | null} handle FSA 핸들. 없으면 저장은 다운로드 폴백
 * @property {number} size 마지막으로 읽거나 쓴 바이트 수(gzip이면 압축된 크기)
 * @property {boolean} gzip 현재 파일이 gzip(`.db.gz`)인가. "저장"은 이 형식을 유지한다(Step 9)
 */

/**
 * 마지막 저장의 백업 결과(Step 9 예외 처리: 상태바에 표시). `skipped`는 200 MB 초과, `quota`는 IDB 용량 부족.
 * @typedef {'none' | 'skipped' | 'quota' | 'failed'} BackupNote
 */

/**
 * 직전 저장본 요약(설정 대화상자용).
 * @typedef {object} BackupInfo
 * @property {string} name 백업이 만들어질 때의 파일 이름
 * @property {number} bytes
 * @property {number} at 백업 시각(epoch ms)
 */

/**
 * @typedef {object} ExportArgs
 * @property {string} tableId
 * @property {ViewSpec} viewSpec
 * @property {'csv' | 'xlsx'} format
 * @property {CsvExportOptions} [options]
 * @property {string} suggestedName 저장 대화상자의 제안 이름
 */

/** @typedef {ExportResult & { name: string }} ExportOutcome */

/** @typedef {'none' | 'newerSchema' | 'otherTab'} ReadOnlyReason */
/** 저널이 기록을 멈춘 이유. `limit`은 50 MB 상한, `import`는 가져오기(Step 7). */
/** @typedef {'none' | 'limit' | 'import'} JournalStop */

/**
 * 테이블별 뷰 상태(Step 4·6). 메모리에만 있고, 파일에 남기는 것은 `saveView`(`_jdr_views`)다.
 * @typedef {object} TableViewState
 * @property {Record<string, number>} widths 열 id → 너비(px). 없는 열은 `_jdr_columns.width`
 * @property {number} frozenColumns 왼쪽에 고정하는 열 수
 * @property {string[]} hidden 숨긴 열 id
 * @property {SortSpec[]} sort
 * @property {FilterSpec | null} filter
 * @property {string} search 전문 검색어
 * @property {string | null} viewId 마지막으로 불러오거나 저장한 뷰. 없으면 null
 */

/**
 * @typedef {object} StoreState
 * @property {FileState} file
 * @property {Meta} meta
 * @property {TableInfo[]} tables
 * @property {string | null} currentTableId 사이드바에서 고른 테이블
 * @property {boolean} dirty
 * @property {ReadOnlyReason} readOnly
 * @property {boolean} journalFull 저널이 기록을 멈췄다(`journalStop !== 'none'`)
 * @property {JournalStop} journalStop
 * @property {BackupNote} backupNote 마지막 저장의 백업 결과. 다음 저장이 성공하면 `none`
 * @property {boolean} saving 저장(사용자·자동)이 진행 중(저장 뮤텍스)
 */

/** @typedef {'file:opened' | 'file:saved' | 'file:dirty' | 'state:changed' | 'journal:full' | 'tables:changed' | 'selection:changed' | 'view:changed' | 'data:changed' | 'import:done'} StoreEvent */

/**
 * `recordCommand`의 선택 사항.
 * @typedef {object} RecordOptions
 * @property {boolean} [fromHistory] 히스토리(`app/history.js`)가 적용·되돌리기·다시 실행으로 부른 것. `onCommand`를 내지 않는다
 * @property {boolean} [refresh] false면 `data:changed`를 내지 않는다(호출자가 그리드 캐시를 직접 고친 경우). 기본 true
 */

/**
 * Worker가 커맨드를 만들어 적용하고 `{ cmd }`를 돌려주는 op(`schema.*` 중 쓰기, 검색 인덱스, 뷰 저장·삭제).
 * @typedef {'schema.create' | 'schema.rename' | 'schema.drop' | 'schema.addColumn' | 'schema.renameColumn' | 'schema.reorderColumns' | 'schema.softDeleteColumn' | 'schema.restoreColumn' | 'schema.changeColumnType' | 'search.enable' | 'search.disable' | 'views.save' | 'views.delete'} SchemaOp
 */

/**
 * @typedef {object} StoreDeps
 * @property {Client} client
 * @property {EngineCapabilities} caps
 * @property {FileSystemLike} fs
 * @property {Idb | null} idb
 * @property {Autosave} autosave
 * @property {TabLock} tablock
 * @property {Prompts} prompts
 * @property {Notifier} notify
 * @property {string} deviceName `_jdr_meta.saved_by`. `setDeviceName`으로 바꾼다
 * @property {string} defaultFileName 새 DB를 처음 저장할 때의 제안 이름
 * @property {boolean} [saveGzip] 다운로드 폴백의 제안 이름을 `.db.gz`로 만들지(설정). `setSaveGzip`으로 바꾼다
 */

/**
 * @typedef {object} Store
 * @property {() => StoreState} getState
 * @property {(event: StoreEvent, handler: () => void) => () => void} on 구독 해제 함수를 돌려준다
 * @property {(options?: { force?: boolean, dbId?: string }) => Promise<boolean>} newDatabase
 * @property {() => Promise<boolean>} openFile FSA 선택기로 고른 뒤 `openPicked`. 폴백 입력 요소는 UI가 `openPicked`를 직접 부른다
 * @property {(picked: PickedFile) => Promise<boolean>} openPicked 미저장 변경 확인 → 크기 검사 → 열기 → revision 판정
 * @property {(options?: { auto?: boolean }) => Promise<boolean>} save `auto`면 자동 저장: 정본 핸들이 있고 dirty일 때만, 뮤텍스·`E_DB_BUSY`는 조용히 false
 * @property {() => Promise<boolean>} saveAs
 * @property {(name: string) => void} setDeviceName `saved_by`에 쓸 기기 이름
 * @property {(on: boolean) => void} setSaveGzip 폴백 저장의 제안 이름을 `.db.gz`로
 * @property {() => Promise<BackupInfo | null>} backupInfo 직전 저장본 요약(IDB `backups`). 없으면 null
 * @property {() => Promise<boolean>} restoreBackup 직전 저장본을 새 이름으로 내보낸다(열린 DB는 그대로)
 * @property {(tableId: string, viewSpec: ViewSpec) => Promise<number>} countRows 뷰 조건을 포함한 행 수(`query.count`). 실패는 알리고 0
 * @property {(args: ExportArgs, callOptions?: CallOptions) => Promise<ExportOutcome | null>} exportTable 저장 위치 선택 → `export.stream` 조각을 싱크에 쓰기. 취소는 null, 실패는 던진다(싱크는 버린다)
 * @property {() => void} markDirty
 * @property {(cmd: Command, options?: RecordOptions) => Promise<void>} recordCommand 적용된 커맨드를 저널에 넣고 dirty로 표시한다. 히스토리가 부른 것이 아니면 `onCommand` 구독자에게 알린다
 * @property {(handler: (cmd: Command) => void) => () => void} onCommand 스키마 op 등 히스토리 밖에서 적용된 커맨드의 알림. 구독 해제 함수를 돌려준다
 * @property {() => void} refreshData 그리드가 블록 캐시를 버리고 다시 읽게 한다(`data:changed`)
 * @property {() => Promise<boolean>} recoverPending 시작 시 저널에 남은 새 DB 기록을 복구 제안한다
 * @property {() => Promise<{ name: string, handle: FileSystemFileHandle } | null>} recentFile IDB에 남은 최근 파일 핸들(권한은 아직 묻지 않음)
 * @property {() => Promise<boolean>} openRecent 최근 파일을 권한 요청 뒤 연다
 * @property {(tableId: string | null) => void} selectTable
 * @property {<K extends SchemaOp>(op: K, args: OpMap[K]['args'], options?: CallOptions) => Promise<OpMap[K]['result'] | null>} runSchemaOp 스키마 op를 실행하고 커맨드를 저널·dirty에 반영한 뒤 테이블 목록을 새로 읽는다. 실패는 알리고 null
 * @property {() => Promise<void>} refreshTables `schema.list`로 테이블 목록을 다시 읽는다
 * @property {(tableId: string) => TableViewState} getViewState 테이블의 뷰 상태(복사본)
 * @property {(tableId: string, columnId: string, width: number) => void} setColumnWidth
 * @property {(tableId: string, count: number) => void} setFrozenColumns
 * @property {(tableId: string) => NormalizedViewSpec} viewSpecOf 그리드·Worker에 넘기는 뷰 사양(숨김·정렬·필터·검색)
 * @property {(tableId: string, sort: SortSpec[]) => void} setSort
 * @property {(tableId: string, columnId: string, append?: boolean) => void} toggleSort 머리글 클릭(없음 → 오름 → 내림 → 없음). `append`면 보조 정렬
 * @property {(tableId: string, filter: FilterSpec | null) => void} setFilter
 * @property {(tableId: string, search: string) => void} setSearch
 * @property {(tableId: string, columnId: string) => void} toggleHidden
 * @property {(tableId: string) => void} clearFilters 필터와 검색을 함께 지운다
 * @property {(tableId: string, view: View) => void} applyView 저장된 뷰를 뷰 상태에 적용한다(살아 있지 않은 열의 항목은 빼고 안내)
 * @property {(tableId: string) => Promise<View[]>} listViews
 * @property {(tableId: string, name: string) => Promise<string | null>} saveView 지금 뷰 상태를 그 이름으로 저장(같은 이름이 있으면 덮어쓴다). 저장한 뷰 id
 * @property {(tableId: string, viewId: string) => Promise<boolean>} deleteView
 * @property {(tableId: string, options?: CallOptions) => Promise<boolean>} enableSearch 검색 인덱스 만들기(진행률·취소는 options)
 * @property {(tableId: string) => Promise<boolean>} disableSearch
 * @property {() => EngineCapabilities} capabilities 엔진이 보고한 상한(UI는 숫자를 여기서만 읽는다)
 * @property {(file: Blob, options: ImportOptions, callOptions?: CallOptions) => Promise<PreviewResult>} importPreview 미리보기·추론. 실패는 던진다(대화상자가 표시)
 * @property {(args: { file: Blob, options: ImportOptions, mapping: ImportMapping, target: ImportTarget, policy?: ImportPolicy }, callOptions?: CallOptions) => Promise<ImportReport | null>} importRun 가져오기 실행. 성공하면 히스토리·저널 정지·dirty·테이블 목록을 반영하고 `import:done`. 읽기 전용이면 안내하고 null. 실패는 던진다
 */

/**
 * 메모리 부족은 RangeError로 드러난다. 그 밖은 그대로 AppError로.
 * @param {unknown} err
 * @returns {AppError}
 */
function toStoreError(err) {
  if (err instanceof RangeError) return new AppError('E_MEM', err.message, { cause: err });
  return toAppError(err);
}

/**
 * @param {StoreDeps} deps
 * @returns {Store}
 */
export function createStore(deps) {
  const { client, caps, fs, idb, autosave, tablock, prompts, notify } = deps;
  let deviceName = deps.deviceName;
  let saveGzip = deps.saveGzip === true;
  /**
   * 스냅샷을 만든 뒤 저장이 끝나기 전에 들어온 변경. 이 변경은 방금 쓴 파일에 담기지 않았으므로 저장이 끝나도
   * dirty를 풀지 않고, 저널도 새 baseRevision 위에 이 변경만 남긴다. 저장 창 밖에서는 null이다.
   * @type {{ dirty: boolean, commands: Command[], stop: JournalStop | null } | null}
   */
  let duringSave = null;

  /** @type {StoreState} */
  const state = {
    file: { name: null, handle: null, size: 0, gzip: false },
    meta: {},
    tables: [],
    currentTableId: null,
    dirty: false,
    readOnly: 'none',
    journalFull: false,
    journalStop: 'none',
    backupNote: 'none',
    saving: false,
  };

  /** @type {Map<StoreEvent, Set<() => void>>} */
  const listeners = new Map();
  /** @type {Set<(cmd: Command) => void>} */
  const commandListeners = new Set();
  /** @type {Map<string, TableViewState>} */
  const views = new Map();

  /**
   * @param {string} tableId
   * @returns {TableViewState}
   */
  function viewOf(tableId) {
    let view = views.get(tableId);
    if (!view) {
      view = {
        widths: {},
        frozenColumns: 0,
        hidden: [],
        sort: [],
        filter: null,
        search: '',
        viewId: null,
      };
      views.set(tableId, view);
    }
    return view;
  }

  /**
   * 살아 있지 않은 열을 가리키는 정렬·필터·숨김 항목을 뷰 상태에서 뺀다. 뺀 것이 있으면 안내한다.
   * @param {string} tableId
   * @param {TableInfo} table
   * @returns {boolean} 바뀌었는가
   */
  function pruneView(tableId, table) {
    const view = views.get(tableId);
    if (!view) return false;
    const pruned = pruneViewSpec(view, table);
    if (!pruned.changed) return false;
    view.sort = pruned.spec.sort;
    view.filter = pruned.spec.filter;
    view.hidden = pruned.spec.hidden;
    notify.info('view.pruned', { name: table.name });
    return true;
  }

  /**
   * 저널 정지 상태를 바꾼다. `journalFull`은 이 값에서 따라온다.
   * @param {JournalStop} reason
   */
  function setJournalStop(reason) {
    // 저장 창 안에서 멈췄다면 그 이유는 방금 쓴 파일 뒤의 것이다. 저장이 끝난 뒤 다시 세운다.
    if (duringSave && reason !== 'none') duringSave.stop = reason;
    state.journalStop = reason;
    state.journalFull = reason !== 'none';
  }

  /** @param {StoreEvent} event */
  function emit(event) {
    for (const handler of listeners.get(event) ?? []) handler();
    if (event !== 'state:changed') {
      for (const handler of listeners.get('state:changed') ?? []) handler();
    }
  }

  /** @returns {number} */
  function fileRevision() {
    const n = Number.parseInt(state.meta.revision ?? '0', 10);
    return Number.isFinite(n) ? n : 0;
  }

  /** @param {string} dbId */
  async function readKnown(dbId) {
    if (!idb) return undefined;
    const v = await idb.get('known_revisions', dbId);
    return typeof v === 'number' ? v : undefined;
  }

  /**
   * @param {string} dbId
   * @param {number} revision
   */
  async function writeKnown(dbId, revision) {
    if (!idb) return;
    try {
      await idb.put('known_revisions', dbId, revision);
    } catch (err) {
      notify.error(toAppError(err));
    }
  }

  /**
   * 미저장 변경이 있으면 버릴지 묻는다.
   * @returns {Promise<boolean>} 계속해도 되는가
   */
  async function confirmDiscard() {
    if (!state.dirty) return true;
    return prompts.discardUnsaved();
  }

  /**
   * 테이블 목록을 바꾸고 선택이 사라졌으면 첫 테이블로 옮긴다.
   * @param {TableInfo[]} tables
   */
  function setTables(tables) {
    state.tables = tables;
    if (!tables.some((t) => t.id === state.currentTableId)) {
      state.currentTableId = tables[0]?.id ?? null;
    }
    // 열이 소프트 삭제되면 그 열의 정렬·필터·숨김 항목은 뷰에서 빠진다(Step 6 예외 처리). 뒤따르는
    // `tables:changed`에서 그리드 호스트가 새 사양으로 다시 마운트한다.
    for (const table of tables) pruneView(table.id, table);
  }

  /**
   * 열기·새로 만들기 뒤의 공통 상태 설정.
   * @param {{ name: string | null, handle: FileSystemFileHandle | null, size: number, gzip: boolean, meta: Meta, tables: TableInfo[], readOnly: ReadOnlyReason }} next
   */
  function setOpened(next) {
    state.file = { name: next.name, handle: next.handle, size: next.size, gzip: next.gzip };
    state.meta = next.meta;
    state.currentTableId = null;
    views.clear();
    setTables(next.tables);
    state.dirty = false;
    state.readOnly = next.readOnly;
    // 열 때 남아 있는 정지는 이유를 알 수 없으므로 상한으로 본다(어느 쪽이든 저장을 재촉한다).
    setJournalStop(autosave.isFull() ? 'limit' : 'none');
    autosave.attach({
      dbId: next.meta.db_id ?? '',
      baseRevision: fileRevision(),
      fileName: next.name,
    });
  }

  /**
   * 저널을 재생한다. 실패하면 DB 상태를 알 수 없으므로 오류를 알리고 dirty로 둔다(사용자가 저장 여부를 결정).
   * @param {JournalSummary} journal
   * @returns {Promise<boolean>}
   */
  async function replayJournal(journal) {
    /** @type {boolean} */
    let ok;
    try {
      const count = await autosave.replay(client, journal.commands);
      notify.info('file.recovered', { count });
      ok = true;
    } catch (err) {
      notify.error(toAppError(err));
      ok = false;
    }
    state.dirty = true;
    await store.refreshTables();
    emit('file:dirty');
    return ok;
  }

  /**
   * @param {JournalSummary} journal
   */
  function exportJournal(journal) {
    const json = JSON.stringify(
      {
        dbId: journal.dbId,
        baseRevision: journal.baseRevision,
        fileName: journal.fileName,
        truncated: journal.truncated,
        commands: journal.commands,
      },
      null,
      2,
    );
    fs.download(
      `journal-${journal.dbId.slice(0, 8)}.json`,
      new Blob([json], { type: 'application/json' }),
    );
  }

  /**
   * 4.3 판정표에 따른 대화상자와 저널 처리. 파일을 연 직후 부른다.
   * @param {Meta} meta
   * @returns {Promise<boolean>} 열기를 계속하는가
   */
  async function reconcileRevision(meta) {
    const dbId = meta.db_id ?? '';
    const revision = Number.parseInt(meta.revision ?? '0', 10) || 0;
    const knownRevision = await readKnown(dbId);
    const journal = await autosave.recoverable(dbId);
    const verdict = judge({
      fileRevision: revision,
      knownRevision,
      journalBaseRevision: journal?.baseRevision,
    });
    if (verdict.file === 'behind' && knownRevision !== undefined) {
      const proceed = await prompts.revisionBehind({ fileRevision: revision, knownRevision });
      if (!proceed) return false;
    }
    if (verdict.updateKnown) await writeKnown(dbId, revision);

    if (journal && verdict.journal === 'match') {
      const choice = await prompts.journalRecover({
        count: journal.commands.length,
        truncated: journal.truncated,
        isNew: false,
        fileName: journal.fileName,
      });
      if (choice === 'recover') {
        await replayJournal(journal);
      } else {
        await autosave.clear();
        setJournalStop('none');
      }
    } else if (journal && verdict.journal === 'mismatch') {
      const choice = await prompts.journalMismatch({
        count: journal.commands.length,
        baseRevision: journal.baseRevision,
        fileRevision: revision,
      });
      if (choice === 'export') exportJournal(journal);
      await autosave.clear();
      setJournalStop('none');
    }
    return true;
  }

  /**
   * 저장 뒤의 공통 처리: 메타 갱신, 저널 비움, known 갱신, dirty 해제.
   *
   * 스냅샷과 쓰기 사이에는 await가 여럿이라 그동안 편집·가져오기가 들어올 수 있고, 그 변경은 방금 쓴 파일에
   * 없다. 그래서 `duringSave`가 그 창의 변경을 들고 있으면 dirty를 풀지 않고, 저널도 비운 뒤 새 baseRevision
   * (= 방금 쓴 파일의 revision) 위에 그 변경만 다시 넣는다. 그대로 비우면 미저장 변경이 조용히 사라진다.
   * @param {{ name: string, handle: FileSystemFileHandle | null, size: number, gzip: boolean, meta: Meta }} saved
   */
  async function setSaved(saved) {
    const during = duringSave;
    const pending = during?.commands ?? [];
    const stop = during?.stop ?? null;
    state.file = { name: saved.name, handle: saved.handle, size: saved.size, gzip: saved.gzip };
    state.meta = saved.meta;
    state.dirty = during?.dirty === true;
    await autosave.clear();
    setJournalStop('none');
    await writeKnown(saved.meta.db_id ?? '', fileRevision());
    autosave.attach({
      dbId: saved.meta.db_id ?? '',
      baseRevision: fileRevision(),
      fileName: saved.name,
    });
    for (const cmd of pending) {
      try {
        await autosave.recordCommand(cmd);
      } catch (err) {
        // 저널 실패는 데이터 유실이 아니다(정본은 파일). 알리고 계속한다.
        notify.error(toAppError(err));
      }
    }
    if (stop) {
      // 저널에 남길 수 없는 변경(가져오기·상한 초과)이 저장 창 안에 들어왔다. 정지와 배너를 되돌린다.
      try {
        await autosave.suspend();
      } catch (err) {
        notify.error(toAppError(err));
      }
      setJournalStop(stop);
    }
    if (saved.handle) await rememberHandle(saved.name, saved.handle);
    emit('file:saved');
  }

  /**
   * @param {string} name
   * @param {FileSystemFileHandle} handle
   */
  async function rememberHandle(name, handle) {
    if (!idb) return;
    try {
      await idb.put('handles', RECENT_HANDLE_KEY, { name, handle });
    } catch (err) {
      // 핸들을 IDB에 넣지 못하는 브라우저가 있다. 최근 파일 기능만 빠진다.
      notify.error(toAppError(err));
    }
  }

  /**
   * 저장 직전 기존 파일을 IDB `backups`에 1세대 보관한다(D-04). 실패는 저장을 막지 않는다.
   * @param {FileSystemFileHandle} handle
   * @param {string} dbId
   */
  async function backupBefore(handle, dbId) {
    if (!idb) return;
    try {
      const previous = await fs.readAll(handle);
      if (previous.byteLength === 0) return;
      if (previous.byteLength > BACKUP_MAX_BYTES) {
        state.backupNote = 'skipped';
        notify.info('file.backupSkipped');
        return;
      }
      await idb.put('backups', dbId, {
        name: state.file.name ?? handle.name,
        bytes: previous,
        at: Date.now(),
      });
      state.backupNote = 'none';
    } catch (err) {
      const appErr = toStoreError(err);
      // 백업은 저장을 막지 않는다(Step 9 예외 처리). 상태바가 다음 저장 성공까지 표시한다.
      state.backupNote = appErr.code === 'E_QUOTA' ? 'quota' : 'failed';
      notify.info('file.backupFailed', { code: appErr.code });
    }
  }

  /**
   * gzip 형식으로 저장할 대상인가(이름이 `.gz`로 끝난다).
   * @param {string} name
   */
  function wantsGzip(name) {
    return /\.gz$/i.test(name);
  }

  /**
   * 스냅샷을 만들고 대상에 쓴다. 실패 시 원본은 그대로다(`createWritable`의 원자성).
   * 순서는 gzip 지원 확인 → 스냅샷(revision+1) → gzip → 기존 파일 백업 → 쓰기다. 지원 확인을 먼저 하는 이유는
   * 파일에는 아무것도 쓰이지 않았는데 revision만 오른 DB가 남지 않게 하기 위해서다.
   * 저장 뮤텍스(Step 9): 진행 중이면 사용자 저장은 알리고, 자동 저장은 조용히 미룬다.
   * @param {{ kind: 'handle', handle: FileSystemFileHandle, name: string } | { kind: 'download', name: string }} target
   * @param {{ auto?: boolean }} [options]
   * @returns {Promise<boolean>}
   */
  async function writeSnapshot(target, options = {}) {
    if (state.readOnly !== 'none') {
      if (!options.auto) notify.info('file.readOnlyBlocked');
      return false;
    }
    if (state.saving) {
      if (!options.auto) notify.info('file.saveBusy');
      return false;
    }
    const gzip = wantsGzip(target.name);
    if (gzip && !fs.gzipSupported()) {
      notify.error(new AppError('E_GZIP_UNSUPPORTED', 'CompressionStream is missing'));
      return false;
    }
    state.saving = true;
    emit('state:changed');
    try {
      const snap = await client.call('db.snapshot', {
        bumpRevision: true,
        savedBy: deviceName,
      });
      // 여기부터 `setSaved`까지 들어오는 변경은 이 스냅샷에 없다. `setSaved`가 저널에 다시 넣는다.
      duringSave = { dirty: false, commands: [], stop: null };
      const bytes = gzip ? await fs.gzip(snap.bytes) : snap.bytes;
      if (target.kind === 'handle') {
        await backupBefore(target.handle, snap.meta.db_id ?? '');
        await fs.write(target.handle, bytes);
        await setSaved({
          name: target.name,
          handle: target.handle,
          size: bytes.byteLength,
          gzip,
          meta: snap.meta,
        });
        if (!options.auto) notify.info('file.saved', { name: target.name });
      } else {
        fs.download(target.name, bytes);
        await setSaved({
          name: target.name,
          handle: null,
          size: bytes.byteLength,
          gzip,
          meta: snap.meta,
        });
        notify.info('file.downloaded', { name: target.name });
      }
      return true;
    } catch (err) {
      const appErr = toStoreError(err);
      // 자동 저장이 가져오기·내보내기(배타 op)와 겹친 것은 오류가 아니라 미룸이다.
      if (!(options.auto && appErr.code === 'E_DB_BUSY')) notify.error(appErr);
      return false;
    } finally {
      duringSave = null;
      state.saving = false;
      emit('state:changed');
    }
  }

  /**
   * 파일 이름에서 `.gz`를 붙이거나 뗀다.
   * @param {string} name
   * @param {boolean} gzip
   */
  function withGzipName(name, gzip) {
    const base = name.replace(/\.gz$/i, '');
    return gzip ? `${base}.gz` : base;
  }

  /** @type {Store} */
  const store = {
    getState: () => ({
      ...state,
      file: { ...state.file },
      meta: { ...state.meta },
      tables: [...state.tables],
    }),

    on(event, handler) {
      let set = listeners.get(event);
      if (!set) {
        set = new Set();
        listeners.set(event, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
      };
    },

    async newDatabase(options = {}) {
      if (!options.force && !(await confirmDiscard())) return false;
      try {
        const opened = await client.call('db.open', options.dbId ? { dbId: options.dbId } : {});
        tablock.release();
        setOpened({
          name: null,
          handle: null,
          size: 0,
          gzip: false,
          meta: opened.meta,
          tables: opened.tables,
          readOnly: 'none',
        });
        emit('file:opened');
        return true;
      } catch (err) {
        notify.error(toStoreError(err));
        return false;
      }
    },

    async openFile() {
      /** @type {PickedFile | null} */
      let picked;
      try {
        picked = await fs.pickOpen();
      } catch (err) {
        notify.error(toStoreError(err));
        return false;
      }
      if (!picked) return false;
      return store.openPicked(picked);
    },

    async openPicked(picked) {
      if (!(await confirmDiscard())) return false;
      const size = picked.file.size;
      /**
       * 크기 검사. gzip 파일은 압축 해제 뒤 크기로 한 번 더 한다(압축 파일은 작아 보인다).
       * @param {number} bytes
       * @returns {Promise<boolean>} 계속하는가
       */
      const checkSize = async (bytes) => {
        if (bytes > caps.maxFileBytes) {
          notify.error(
            new AppError('E_FILE_TOO_LARGE', `file is ${bytes} bytes, limit ${caps.maxFileBytes}`, {
              detail: { bytes, limit: caps.maxFileBytes },
            }),
          );
          return false;
        }
        if (bytes > caps.warnFileBytes) {
          return prompts.largeFile({ size: bytes, warn: caps.warnFileBytes });
        }
        return true;
      };
      if (!(await checkSize(size))) return false;
      /** @type {import('../db/worker.js').OpenResult} */
      let opened;
      let gzip = false;
      try {
        let bytes = await fs.readAll(picked.handle ?? picked.file);
        if (fs.isGzip(bytes)) {
          gzip = true;
          if (!fs.gzipSupported()) {
            throw new AppError('E_GZIP_UNSUPPORTED', 'DecompressionStream is missing');
          }
          bytes = await fs.gunzip(bytes);
          if (!(await checkSize(bytes.byteLength))) return false;
        }
        opened = await client.call('db.open', { bytes }, { transfer: [bytes.buffer] });
      } catch (err) {
        // 이전 DB는 이미 닫혔다. 사용 가능한 상태로 돌아가기 위해 새 DB를 연다.
        notify.error(toStoreError(err));
        await store.newDatabase({ force: true });
        return false;
      }
      if (opened.unmanaged) {
        if (!(await prompts.adoptExternal())) {
          await store.newDatabase({ force: true });
          return false;
        }
        try {
          opened = await client.call('schema.adopt');
        } catch (err) {
          notify.error(toStoreError(err));
          await store.newDatabase({ force: true });
          return false;
        }
      }
      /** @type {ReadOnlyReason} */
      let readOnly = 'none';
      if (opened.readOnly) {
        readOnly = 'newerSchema';
        notify.error(new AppError('E_FILE_NEWER_SCHEMA', 'schema_version is newer than this app'));
      }
      const dbId = opened.meta.db_id ?? '';
      const lock = await tablock.claim(dbId);
      if (lock.heldElsewhere && readOnly === 'none') {
        readOnly = 'otherTab';
        notify.info('file.readOnlyTab');
      }
      // 새 파일의 상태를 먼저 세운 뒤에 revision을 판정한다. 판정은 저널을 재생할 수 있고, 재생은
      // dirty와 테이블 목록을 바꾸므로, 순서가 뒤바뀌면 재생 결과가 열기 직전 값에 덮어써진다.
      // 앞 DB의 dirty도 여기서 끊긴다(버리기를 이미 확인받았다).
      setOpened({
        name: picked.name,
        handle: picked.handle,
        size,
        gzip,
        meta: opened.meta,
        tables: opened.tables,
        readOnly,
      });
      if (!(await reconcileRevision(opened.meta))) {
        await store.newDatabase({ force: true });
        return false;
      }
      if (picked.handle) await rememberHandle(picked.name, picked.handle);
      emit('file:opened');
      return true;
    },

    async save(options = {}) {
      if (options.auto) {
        // 자동 저장은 정본 파일(핸들)이 있을 때만이고, 다운로드 폴백으로는 하지 않는다(Step 9).
        if (!state.file.handle || !state.dirty || state.readOnly !== 'none') return false;
        return writeSnapshot(
          {
            kind: 'handle',
            handle: state.file.handle,
            name: state.file.name ?? deps.defaultFileName,
          },
          { auto: true },
        );
      }
      if (!state.file.handle) return store.saveAs();
      return writeSnapshot({
        kind: 'handle',
        handle: state.file.handle,
        // "저장"은 현재 파일의 형식(gzip 여부)을 유지한다. 이름은 열 때 판별한 형식을 따른다.
        name: withGzipName(state.file.name ?? deps.defaultFileName, state.file.gzip),
      });
    },

    async saveAs() {
      const current = state.file.name ?? deps.defaultFileName;
      // 폴백(다운로드) 경로에서는 설정의 "압축 저장"이 제안 이름을 정한다. 핸들이 있는 파일은 그 형식을 제안한다.
      const suggested = withGzipName(current, state.file.handle ? state.file.gzip : saveGzip);
      /** @type {SaveTarget} */
      let target;
      try {
        target = await fs.pickSaveAs(suggested, 'db');
      } catch (err) {
        notify.error(toStoreError(err));
        return false;
      }
      if (target.kind === 'cancelled') return false;
      if (target.kind === 'handle') {
        return writeSnapshot({ kind: 'handle', handle: target.handle, name: target.handle.name });
      }
      return writeSnapshot({ kind: 'download', name: target.name });
    },

    setDeviceName(name) {
      const next = typeof name === 'string' ? name.trim() : '';
      if (next) deviceName = next;
    },

    setSaveGzip(on) {
      saveGzip = on === true;
    },

    async backupInfo() {
      if (!idb) return null;
      const dbId = state.meta.db_id ?? '';
      if (!dbId) return null;
      try {
        const stored = await idb.get('backups', dbId);
        if (!stored || typeof stored !== 'object') return null;
        const b = /** @type {{ name?: unknown, bytes?: unknown, at?: unknown }} */ (stored);
        if (!(b.bytes instanceof Uint8Array)) return null;
        return {
          name: typeof b.name === 'string' ? b.name : deps.defaultFileName,
          bytes: b.bytes.byteLength,
          at: typeof b.at === 'number' ? b.at : 0,
        };
      } catch (err) {
        notify.error(toAppError(err));
        return null;
      }
    },

    async restoreBackup() {
      if (caps.persistence !== 'snapshot') {
        notify.error(new AppError('E_UNSUPPORTED', 'backup restore is Step 11 in this mode'));
        return false;
      }
      if (!idb) {
        notify.info('backup.none');
        return false;
      }
      const dbId = state.meta.db_id ?? '';
      /** @type {{ name?: unknown, bytes?: unknown } | undefined} */
      let stored;
      try {
        stored = /** @type {{ name?: unknown, bytes?: unknown } | undefined} */ (
          await idb.get('backups', dbId)
        );
      } catch (err) {
        notify.error(toAppError(err));
        return false;
      }
      const bytes = stored?.bytes;
      if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
        notify.info('backup.none');
        return false;
      }
      const original = typeof stored?.name === 'string' ? stored.name : deps.defaultFileName;
      /** @type {SaveTarget} */
      let target;
      try {
        target = await fs.pickSaveAs(`backup-${original}`, 'db');
      } catch (err) {
        notify.error(toStoreError(err));
        return false;
      }
      if (target.kind === 'cancelled') return false;
      // 바이트를 그대로 쓴다(압축 여부도 그대로). 열린 DB와 정본 파일은 건드리지 않는다.
      const copy = new Uint8Array(new ArrayBuffer(bytes.byteLength));
      copy.set(bytes);
      try {
        if (target.kind === 'handle') {
          await fs.write(target.handle, copy);
          notify.info('backup.restored', { name: target.handle.name });
        } else {
          fs.download(target.name, copy);
          notify.info('backup.restored', { name: target.name });
        }
        return true;
      } catch (err) {
        notify.error(toStoreError(err));
        return false;
      }
    },

    async countRows(tableId, viewSpec) {
      try {
        return (await client.call('query.count', { tableId, viewSpec })).count;
      } catch (err) {
        notify.error(toStoreError(err));
        return 0;
      }
    },

    async exportTable(args, callOptions = {}) {
      const kind = args.format === 'xlsx' ? 'xlsx' : 'csv';
      const target = await fs.pickSaveAs(args.suggestedName, kind);
      if (target.kind === 'cancelled') return null;
      const name = target.kind === 'handle' ? target.handle.name : target.name;
      const sink = await fs.openSink(
        target,
        kind === 'xlsx'
          ? 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
          : 'text/csv',
      );
      // 조각은 도착 순서대로 싱크에 쓴다. 쓰기는 비동기이므로 사슬로 이어 순서를 지키고, 쓰기 실패는
      // 취소 신호로 Worker를 멈춘 뒤 다시 던진다.
      const controller = new AbortController();
      const abortUpstream = () => controller.abort();
      if (callOptions.signal?.aborted) controller.abort();
      else callOptions.signal?.addEventListener('abort', abortUpstream, { once: true });
      /** @type {Promise<void>} */
      let queue = Promise.resolve();
      /** @type {AppError | null} */
      let sinkError = null;
      try {
        const result = await client.call(
          'export.stream',
          {
            tableId: args.tableId,
            viewSpec: args.viewSpec,
            format: args.format,
            ...(args.options ? { options: args.options } : {}),
          },
          {
            signal: controller.signal,
            onProgress: callOptions.onProgress,
            onChunk: (chunk) => {
              queue = queue.then(async () => {
                if (sinkError) return;
                try {
                  await sink.write(chunk);
                } catch (err) {
                  sinkError = toStoreError(err);
                  controller.abort();
                }
              });
            },
          },
        );
        await queue;
        if (sinkError) throw sinkError;
        await sink.close();
        return { ...result, name };
      } catch (err) {
        await queue;
        await sink.abort();
        throw sinkError ?? toStoreError(err);
      } finally {
        callOptions.signal?.removeEventListener('abort', abortUpstream);
      }
    },

    markDirty() {
      // 저장 창 안에서는 이미 dirty라 아래에서 일찍 빠져나가므로, 창 표시는 그 전에 남긴다.
      if (duringSave) duringSave.dirty = true;
      if (state.dirty) return;
      state.dirty = true;
      emit('file:dirty');
    },

    async recordCommand(cmd, options = {}) {
      try {
        const journaled = await autosave.recordCommand(cmd);
        // 저장 창 안의 커맨드는 방금 쓴 파일에 없다. `setSaved`가 새 baseRevision으로 다시 넣는다.
        if (journaled && duringSave) duringSave.commands.push(cmd);
      } catch (err) {
        // 저널 실패는 데이터 유실이 아니다(정본은 파일). 알리고 계속한다.
        notify.error(toAppError(err));
      }
      if (autosave.isFull() && !state.journalFull) {
        setJournalStop('limit');
        emit('journal:full');
      }
      store.markDirty();
      if (!options.fromHistory) {
        for (const handler of commandListeners) handler(cmd);
      }
      // 커맨드는 DB 내용을 바꿨다. 그리드는 블록 캐시를 버리고 다시 읽는다(D-06).
      if (options.refresh !== false) emit('data:changed');
    },

    onCommand(handler) {
      commandListeners.add(handler);
      return () => {
        commandListeners.delete(handler);
      };
    },

    refreshData() {
      emit('data:changed');
    },

    async recoverPending() {
      const pending = await autosave.pending();
      if (!pending) return false;
      if (pending.fileName !== null) {
        notify.info('file.journalPendingFor', { name: pending.fileName });
        return false;
      }
      const choice = await prompts.journalRecover({
        count: pending.commands.length,
        truncated: pending.truncated,
        isNew: true,
        fileName: null,
      });
      if (choice !== 'recover') {
        await autosave.clear();
        return false;
      }
      if (!(await store.newDatabase({ force: true, dbId: pending.dbId }))) return false;
      return replayJournal(pending);
    },

    async recentFile() {
      if (!idb) return null;
      try {
        const stored = await idb.get('handles', RECENT_HANDLE_KEY);
        if (!stored || typeof stored !== 'object') return null;
        const { name, handle } = /** @type {{ name: string, handle: FileSystemFileHandle }} */ (
          stored
        );
        if (typeof name !== 'string' || !handle || typeof handle.getFile !== 'function') {
          return null;
        }
        return { name, handle };
      } catch (err) {
        // 핸들을 구조화 복제로 되살릴 수 없는 브라우저는 최근 파일 항목이 없는 것과 같다.
        notify.error(toAppError(err));
        return null;
      }
    },

    selectTable(tableId) {
      const next = tableId !== null && state.tables.some((t) => t.id === tableId) ? tableId : null;
      if (next === state.currentTableId) return;
      state.currentTableId = next;
      emit('selection:changed');
    },

    async refreshTables() {
      try {
        const { tables } = await client.call('schema.list');
        setTables(tables);
      } catch (err) {
        notify.error(toStoreError(err));
        return;
      }
      emit('tables:changed');
    },

    async runSchemaOp(op, args, options) {
      if (state.readOnly !== 'none') {
        notify.info('file.readOnlyBlocked');
        return null;
      }
      /** @type {OpMap[typeof op]['result']} */
      let result;
      try {
        result = await client.call(op, args, options);
      } catch (err) {
        notify.error(toStoreError(err));
        // 적용되지 않았으므로 상태를 그대로 두되, 목록이 어긋났을 수 있으니 다시 읽는다(E_DB_QUERY 등).
        await store.refreshTables();
        return null;
      }
      await store.recordCommand(result.cmd);
      await store.refreshTables();
      return result;
    },

    getViewState(tableId) {
      const view = viewOf(tableId);
      return {
        widths: { ...view.widths },
        frozenColumns: view.frozenColumns,
        hidden: [...view.hidden],
        sort: view.sort.map((s) => ({ ...s })),
        filter: view.filter
          ? { logic: view.filter.logic, conditions: view.filter.conditions.map((c) => ({ ...c })) }
          : null,
        search: view.search,
        viewId: view.viewId,
      };
    },

    viewSpecOf(tableId) {
      return normalizeViewSpec(viewOf(tableId));
    },

    setSort(tableId, sort) {
      const view = viewOf(tableId);
      view.sort = normalizeViewSpec({ sort }).sort;
      emit('view:changed');
    },

    toggleSort(tableId, columnId, append = false) {
      const view = viewOf(tableId);
      view.sort = toggleSort(view.sort, columnId, append);
      emit('view:changed');
    },

    setFilter(tableId, filter) {
      const view = viewOf(tableId);
      view.filter = normalizeViewSpec({ filter }).filter;
      emit('view:changed');
    },

    setSearch(tableId, search) {
      const view = viewOf(tableId);
      const next = typeof search === 'string' ? search.trim() : '';
      if (view.search === next) return;
      view.search = next;
      emit('view:changed');
    },

    toggleHidden(tableId, columnId) {
      const view = viewOf(tableId);
      view.hidden = view.hidden.includes(columnId)
        ? view.hidden.filter((id) => id !== columnId)
        : [...view.hidden, columnId];
      emit('view:changed');
    },

    clearFilters(tableId) {
      const view = viewOf(tableId);
      if (view.filter === null && view.search === '') return;
      view.filter = null;
      view.search = '';
      emit('view:changed');
    },

    applyView(tableId, saved) {
      const view = viewOf(tableId);
      const spec = saved.spec;
      view.widths = { ...spec.widths };
      view.frozenColumns = Math.max(0, Math.trunc(spec.frozen));
      view.hidden = [...spec.hidden];
      view.sort = spec.sort.map((s) => ({ ...s }));
      view.filter = spec.filter
        ? { logic: spec.filter.logic, conditions: spec.filter.conditions.map((c) => ({ ...c })) }
        : null;
      view.search = spec.search;
      view.viewId = saved.id;
      const table = state.tables.find((t) => t.id === tableId);
      if (table) pruneView(tableId, table);
      emit('view:changed');
    },

    async listViews(tableId) {
      try {
        const { views: listed } = await client.call('views.list', { tableId });
        return listed;
      } catch (err) {
        notify.error(toStoreError(err));
        return [];
      }
    },

    async saveView(tableId, name) {
      const view = viewOf(tableId);
      const existing = (await store.listViews(tableId)).find((v) => v.name === name.trim());
      /** @type {SavedViewSpec} */
      const spec = {
        sort: view.sort,
        filter: view.filter,
        hidden: view.hidden,
        search: view.search,
        widths: view.widths,
        frozen: view.frozenColumns,
      };
      const result = await store.runSchemaOp('views.save', {
        tableId,
        name,
        spec,
        ...(existing ? { viewId: existing.id } : {}),
      });
      if (!result) return null;
      viewOf(tableId).viewId = result.viewId;
      emit('view:changed');
      notify.info('view.saved', { name: name.trim() });
      return result.viewId;
    },

    async deleteView(tableId, viewId) {
      const result = await store.runSchemaOp('views.delete', { viewId });
      if (!result) return false;
      const view = viewOf(tableId);
      if (view.viewId === viewId) {
        view.viewId = null;
        emit('view:changed');
      }
      return true;
    },

    capabilities: () => ({ ...caps }),

    async importPreview(file, options, callOptions) {
      return client.call('import.preview', { file, options }, callOptions);
    },

    async importRun(args, callOptions) {
      if (state.readOnly !== 'none') {
        notify.info('file.readOnlyBlocked');
        return null;
      }
      const { report } = await client.call('import.run', args, callOptions);
      // 가져오기는 커맨드가 아니다(Step 7): 저널에 남길 수 없으므로 이후 기록을 멈추고 저장을 재촉하며,
      // 되돌리기 스택은 `import:done`을 받은 히스토리가 비운다.
      try {
        await autosave.suspend();
      } catch (err) {
        notify.error(toAppError(err));
      }
      setJournalStop('import');
      emit('journal:full');
      store.markDirty();
      emit('import:done');
      await store.refreshTables();
      if (args.target.kind === 'new') store.selectTable(report.tableId);
      emit('data:changed');
      return report;
    },

    async enableSearch(tableId, options) {
      return (await store.runSchemaOp('search.enable', { tableId }, options)) !== null;
    },

    async disableSearch(tableId) {
      return (await store.runSchemaOp('search.disable', { tableId })) !== null;
    },

    setColumnWidth(tableId, columnId, width) {
      const view = viewOf(tableId);
      const next = Math.max(MIN_COLUMN_WIDTH, Math.round(width));
      if (view.widths[columnId] === next) return;
      view.widths[columnId] = next;
      emit('view:changed');
    },

    setFrozenColumns(tableId, count) {
      const view = viewOf(tableId);
      const next = Math.max(0, Math.trunc(count));
      if (view.frozenColumns === next) return;
      view.frozenColumns = next;
      emit('view:changed');
    },

    async openRecent() {
      const recent = await store.recentFile();
      if (!recent) return false;
      try {
        // 권한 만료: queryPermission → requestPermission(사용자 동작 안에서 호출됨). 거부되면 E_FILE_PERMISSION.
        await fs.ensurePermission(recent.handle, 'read');
        const file = await recent.handle.getFile();
        return store.openPicked({ name: file.name, file, handle: recent.handle });
      } catch (err) {
        notify.error(toStoreError(err));
        return false;
      }
    },
  };

  autosave.attach({ dbId: '', baseRevision: 0, fileName: null });
  return store;
}
