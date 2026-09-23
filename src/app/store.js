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
import { formatBytes } from '../util/bytes.js';
import { nextNames } from '../util/names.js';
import { t } from '../i18n/index.js';

/** @typedef {import('../db/client.js').Client} Client */
/** @typedef {import('../db/engine.js').EngineCapabilities} EngineCapabilities */
/** @typedef {import('../db/schema.js').Meta} Meta */
/** @typedef {import('../db/command.js').Command} Command */
/** @typedef {import('../db/tables.js').TableInfo} TableInfo */
/** @typedef {import('../db/tables.js').NewColumn} NewColumn */
/** @typedef {import('../db/worker.js').OpMap} OpMap */
/** @typedef {import('../db/client.js').CallOptions} CallOptions */
/** @typedef {import('../io/idb.js').Idb} Idb */
/** @typedef {import('../io/autosave.js').Autosave} Autosave */
/** @typedef {import('../io/autosave.js').JournalSummary} JournalSummary */
/** @typedef {import('../io/tablock.js').TabLock} TabLock */
/** @typedef {import('../io/filesystem.js').PickedFile} PickedFile */
/** @typedef {import('../io/filesystem.js').SaveTarget} SaveTarget */
/** @typedef {import('../io/filesystem.js').SaveKind} SaveKind */
/** @typedef {import('../io/filesystem.js').NativeBackupInfo} NativeBackupInfo */
/** @typedef {import('../io/filesystem.js').WorkcopyEntry} WorkcopyEntry */
/** @typedef {import('../db/engine.js').NativeOpenInfo} NativeOpenInfo */
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
/** @typedef {import('../db/cleanup.js').CleanupPlan} CleanupPlan */
/** @typedef {import('../db/cleanup.js').CleanupResult} CleanupResult */

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
 * @property {(target: { kind: 'handle', handle: FileSystemFileHandle } | { kind: 'download', name: string } | { kind: 'path', path: string }, mime: string) => Promise<ByteSink>} openSink 내보내기 조각을 받을 싱크(Step 9·11)
 * @property {(bytes: Uint8Array) => Promise<Uint8Array<ArrayBuffer>>} gzip
 * @property {(bytes: Uint8Array) => Promise<Uint8Array<ArrayBuffer>>} gunzip
 * @property {(bytes: Uint8Array) => boolean} isGzip
 * @property {() => boolean} gzipSupported
 * @property {() => Promise<string | null>} [pickOpenPath] 데스크톱 모드(Step 11): 열 파일 경로. 취소는 null
 * @property {(suggestedName: string, kind?: SaveKind) => Promise<string | null>} [pickSavePath] 데스크톱 모드: 저장 경로. 취소는 null
 * @property {(originalPath: string) => Promise<NativeBackupInfo | null>} [backupInfo] 데스크톱 모드: `<원본>.bak` 정보
 * @property {(originalPath: string, targetPath: string) => Promise<NativeBackupInfo>} [restoreBackup] 데스크톱 모드: `.bak`을 새 파일로 복사
 * @property {() => Promise<WorkcopyEntry[]>} [listWorkcopies] 데스크톱 모드: 남은 작업 사본
 * @property {(key: string) => Promise<void>} [removeWorkcopy] 데스크톱 모드: 작업 사본 버리기
 * @property {(path: string) => string} [baseName] 데스크톱 모드: 경로의 파일 이름 부분
 * @property {() => Promise<{ phase: string, done: number, total: number } | null>} [pollProgress] 데스크톱 모드: 러스트가 마지막으로 보고한 진행률
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
 * @property {(info: { name: string }) => Promise<'overwrite' | 'saveAs' | 'cancel'>} originalChanged 데스크톱 모드: 연 뒤 원본이 디스크에서 바뀜(D-15)
 * @property {(info: { fileName: string | null, sameRevision: boolean, originalRevision: number | null, workcopyRevision: number | null }) => Promise<'recover' | 'discard'>} workcopyRecover 데스크톱 모드: 남은 dirty 작업 사본의 복구 여부
 */

/**
 * @typedef {object} Notifier
 * @property {(err: AppError, key?: MessageKey) => void} error `key`를 주면 `error.<코드>` 대신 그 문구로 알린다
 * @property {(key: MessageKey, params?: MessageParams) => void} info
 * @property {(key: MessageKey, params?: MessageParams) => void} warn 오류는 아니지만 놓치면 안 되는 안내
 */

/**
 * @typedef {object} FileState
 * @property {string | null} name 저장한 적 없는 새 DB면 null
 * @property {FileSystemFileHandle | null} handle FSA 핸들. 없으면 저장은 다운로드 폴백
 * @property {string | null} path 데스크톱 모드의 원본 경로(D-15). 브라우저 모드에서는 항상 null
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
 * @property {{ phase: string, done: number, total: number } | null} progress 데스크톱 모드의 긴 작업(열기·저장) 진행률. 없으면 null
 */

/** @typedef {'file:opened' | 'file:saved' | 'file:dirty' | 'state:changed' | 'journal:full' | 'tables:changed' | 'selection:changed' | 'view:changed' | 'data:changed' | 'import:done' | 'cleanup:done'} StoreEvent */

/**
 * 작업 사본 모두 버리기(D-18)의 결과. 실패한 항목은 사본이 그대로 남아 목록에 다시 나온다.
 * @typedef {object} DiscardAllResult
 * @property {number} removed
 * @property {Array<{ entry: WorkcopyEntry, error: AppError }>} failed
 */

/**
 * `recordCommand`의 선택 사항.
 * @typedef {object} RecordOptions
 * @property {boolean} [fromHistory] 히스토리(`app/history.js`)가 적용·되돌리기·다시 실행으로 부른 것. `onCommand`를 내지 않는다
 * @property {boolean} [refresh] false면 `data:changed`를 내지 않는다(호출자가 그리드 캐시를 직접 고친 경우). 기본 true
 * @property {boolean} [mergeWithAdd] "+ 열" 직후 이름 편집기의 확정(D-16). `onCommand` 구독자(히스토리)에 실어 보내 직전의 열 추가와 한 항목으로 합치게 한다
 */

/**
 * `onCommand` 알림의 부가 정보.
 * @typedef {object} CommandNotice
 * @property {boolean} mergeWithAdd 직전의 열 추가와 합칠 커맨드인가(`RecordOptions.mergeWithAdd`)
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
 * @property {(originalPath: string) => Promise<boolean>} openPath 데스크톱 모드: 미저장 변경 확인 → 작업 사본 위에서 열기 → dirty 사본 복구 판정 → revision 판정
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
 * @property {(handler: (cmd: Command, notice: CommandNotice) => void) => () => void} onCommand 스키마 op 등 히스토리 밖에서 적용된 커맨드의 알림. 구독 해제 함수를 돌려준다
 * @property {() => void} refreshData 그리드가 블록 캐시를 버리고 다시 읽게 한다(`data:changed`)
 * @property {() => Promise<boolean>} recoverPending 시작 시 저널에 남은 새 DB 기록을 복구 제안한다
 * @property {() => Promise<WorkcopyEntry[]>} listWorkcopies 데스크톱 모드: 복구를 기다리는 dirty 작업 사본. 브라우저 모드는 빈 배열
 * @property {(key: string) => Promise<boolean>} openWorkcopy 데스크톱 모드: 남은 작업 사본을 키로 연다
 * @property {(key: string) => Promise<boolean>} discardWorkcopy 데스크톱 모드: 남은 작업 사본을 버린다
 * @property {() => Promise<DiscardAllResult>} discardAllWorkcopies 데스크톱 모드: 복구를 기다리는 작업 사본을 모두 버린다(D-18). 하나가 실패해도 나머지를 계속한다. 브라우저 모드는 할 일이 없다
 * @property {() => Promise<number | null>} backupCount 이 브라우저에 남은 직전 저장본 수(IDB `backups`의 키 수, 모든 파일). IDB가 없거나 읽지 못하면 null
 * @property {() => Promise<{ removed: number } | null>} clearBackups 이 브라우저의 직전 저장본을 모두 지운다(D-18). 저널·최근 파일·설정은 건드리지 않는다. 실패는 알리고 null
 * @property {() => Promise<CleanupPlan | null>} planCleanup 데이터베이스 정리 계획(D-17). 실패는 알리고 null
 * @property {(columns: Array<{ tableId: string, columnId: string }>, callOptions?: CallOptions) => Promise<CleanupResult | null>} runCleanup 정리 실행 → 커맨드를 저널에 기록하고 히스토리를 비운다(`cleanup:done`), 테이블 목록·그리드를 다시 읽고 dirty. 읽기 전용이면 안내하고 null. 실패는 던진다(대화상자가 원인별 문구로 표시)
 * @property {() => Promise<RecentFile | null>} recentFile IDB에 남은 최근 파일(핸들 또는 데스크톱 경로. 권한은 아직 묻지 않음)
 * @property {() => Promise<boolean>} openRecent 최근 파일을 권한 요청 뒤 연다
 * @property {(tableId: string | null) => void} selectTable
 * @property {<K extends SchemaOp>(op: K, args: OpMap[K]['args'], options?: CallOptions) => Promise<OpMap[K]['result'] | null>} runSchemaOp 스키마 op를 실행하고 커맨드를 저널·dirty에 반영한 뒤 테이블 목록을 새로 읽는다. 실패는 알리고 null
 * @property {(name: string, options?: { columns?: NewColumn[] }) => Promise<string | null>} createTable 테이블을 만들고(기본 열은 `columns`, D-16) 그 테이블을 고른다. 만든 테이블 id. 실패는 알리고 null
 * @property {(tableId: string) => Promise<{ columnId: string, columnCount: number } | null>} addDefaultColumn 자동 이름(`column.defaultName`)의 텍스트 열을 끝에 붙인다(D-16). 이름은 살아 있는 열과 소프트 삭제된 열의 이름을 모두 건너뛰고, Worker가 이름 겹침으로 거부하면 목록을 다시 읽어 한 번만 다시 시도한다
 * @property {(tableId: string, columnId: string, name: string, options?: { mergeWithAdd?: boolean }) => Promise<boolean>} renameColumn 열 표시 이름 바꾸기(머리글 이름 편집기). `mergeWithAdd`면 히스토리가 직전의 열 추가와 합친다(D-16). 실패는 알리고 false
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

/** @typedef {{ name: string, handle: FileSystemFileHandle | null, path: string | null }} RecentFile */

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

  /** 데스크톱 모드(D-15): 저장은 `db.save`, 열기는 원본 경로, 백업은 `.bak`. */
  const nativeMode = caps.persistence !== 'snapshot';

  /** @type {StoreState} */
  const state = {
    file: { name: null, handle: null, path: null, size: 0, gzip: false },
    meta: {},
    tables: [],
    currentTableId: null,
    dirty: false,
    readOnly: 'none',
    journalFull: false,
    journalStop: 'none',
    backupNote: 'none',
    saving: false,
    progress: null,
  };

  /** @type {Map<StoreEvent, Set<() => void>>} */
  const listeners = new Map();
  /** @type {Set<(cmd: Command, notice: CommandNotice) => void>} */
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
   * 저장이 도는 중에는 파일을 열지 않는다. 열기가 저장보다 먼저 끝나면 `setOpened`가 세운 새 DB의
   * 상태 위에 `setSaved`가 옛 DB의 이름·메타를 덮어써, 화면에는 A의 이름이 뜨는데 내용은 B가 된다.
   * @returns {boolean} 열어도 되는가
   */
  function canOpenNow() {
    if (!state.saving) return true;
    notify.info('file.saveBusy');
    return false;
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
   * @param {{ name: string | null, handle: FileSystemFileHandle | null, path?: string | null, size: number, gzip: boolean, meta: Meta, tables: TableInfo[], readOnly: ReadOnlyReason }} next
   */
  function setOpened(next) {
    state.file = {
      name: next.name,
      handle: next.handle,
      path: next.path ?? null,
      size: next.size,
      gzip: next.gzip,
    };
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
      const { applied, skipped } = await autosave.replay(client, journal.commands);
      notify.info('file.recovered', { count: applied });
      // 사본을 만든 뒤 그 테이블이 외부 등록으로 바뀌면 그 커맨드는 적용되지 않는다. 조용히 넘기면
      // 사용자는 복구가 다 된 줄 안다.
      if (skipped > 0) notify.info('file.recoveredSkipped', { count: skipped });
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
   * @param {{ name: string, handle: FileSystemFileHandle | null, path?: string | null, size: number, gzip: boolean, meta: Meta }} saved
   */
  async function setSaved(saved) {
    const during = duringSave;
    const pending = during?.commands ?? [];
    const stop = during?.stop ?? null;
    state.file = {
      name: saved.name,
      handle: saved.handle,
      path: saved.path ?? null,
      size: saved.size,
      gzip: saved.gzip,
    };
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
    if (saved.handle) await rememberRecent(saved.name, saved.handle, null);
    else if (saved.path) await rememberRecent(saved.name, null, saved.path);
    emit('file:saved');
  }

  /**
   * 최근 파일(FSA 핸들 또는 데스크톱 경로)을 IDB에 남긴다.
   * @param {string} name
   * @param {FileSystemFileHandle | null} handle
   * @param {string | null} path
   */
  async function rememberRecent(name, handle, path) {
    if (!idb) return;
    try {
      await idb.put('handles', RECENT_HANDLE_KEY, { name, handle, path });
    } catch (err) {
      // 핸들을 IDB에 넣지 못하는 브라우저가 있다. 최근 파일 기능만 빠진다.
      notify.error(toAppError(err));
    }
  }

  /** 데스크톱 모드의 긴 작업 진행률 폴링 간격(ms). */
  const PROGRESS_POLL_MS = 500;

  /**
   * 데스크톱 모드의 긴 작업(5 GB 열기·저장)을 돌리며 진행률을 상태에 싣는다. 엔진 프로토콜(동기 XHR)에는
   * 진행률 채널이 없어 보고가 Worker까지 오지 못하므로, 메인이 러스트에 직접 물어 본다(D-15).
   * @template T
   * @param {() => Promise<T>} run
   * @returns {Promise<T>}
   */
  async function withNativeProgress(run) {
    const poll = nativeMode ? fs.pollProgress : undefined;
    if (!poll) return run();
    const timer = setInterval(() => {
      void poll()
        .then((progress) => {
          // 작업이 끝난 뒤 도착한 응답이 끝난 숫자를 화면에 남기지 않게 한다.
          if (state.progress === null && progress === null) return;
          state.progress = progress;
          emit('state:changed');
        })
        .catch(() => {
          // 진행률을 못 읽는 것은 작업의 실패가 아니다. 표시만 빠진다.
        });
    }, PROGRESS_POLL_MS);
    state.progress = null;
    try {
      return await run();
    } finally {
      clearInterval(timer);
      if (state.progress !== null) {
        state.progress = null;
        emit('state:changed');
      }
    }
  }

  /**
   * 데스크톱 모드에서 필요한 파일 함수. 없으면 주입이 잘못된 것이다.
   * @template {keyof FileSystemLike} K
   * @param {K} name
   * @returns {NonNullable<FileSystemLike[K]>}
   */
  function nativeFs(name) {
    const fn = fs[name];
    if (!fn) throw new AppError('E_UNSUPPORTED', `${name} is not available in this mode`);
    return /** @type {NonNullable<FileSystemLike[K]>} */ (fn);
  }

  /**
   * 데스크톱 모드에서 지금 열린 작업 사본의 키. 설정의 작업 사본 목록이 이 사본을 "복구를 기다리는" 것으로
   * 보이거나 버리지 않게 한다(러스트 `remove_workcopy`는 열린 사본이면 DB를 닫고 폴더를 지운다).
   * @type {string | null}
   */
  let openWorkcopyKey = null;
  /** 크기 경고 단계(`checkDbSize`): 0 권장 크기 아래, 1 `warnFileBytes` 이상, 2 `maxFileBytes` 이상. */
  let sizeLevel = 0;

  /**
   * `db.open`을 부르고 열린 작업 사본의 키를 기억한다. 스토어의 모든 열기는 이 함수를 거친다. 열기가 실패하면
   * 앞 DB가 이미 닫혔을 수 있으므로 키를 먼저 비운다.
   * @param {import('../db/worker.js').OpMap['db.open']['args']} args
   * @param {CallOptions} [options]
   * @returns {Promise<import('../db/worker.js').OpenResult>}
   */
  async function openDb(args, options) {
    openWorkcopyKey = null;
    const opened = await client.call('db.open', args, options);
    openWorkcopyKey = opened.workcopy?.workcopyKey ?? null;
    await checkDbSize({ baseline: true });
    return opened;
  }

  /**
   * 편집·가져오기로 커진 DB의 크기 경고(Step 10). 열기 때의 상한 검사는 파일 크기만 보므로, 커맨드·가져오기 뒤에
   * `db.size`로 재어 `warnFileBytes`·`maxFileBytes`를 처음 넘을 때 한 번씩 알린다. 상한이 없으면(native) 재지 않는다.
   * `baseline`이면 알리지 않고 단계만 정한다(열기 직후. 큰 파일은 열 때 이미 확인받았다).
   * @param {{ baseline?: boolean }} [options]
   * @returns {Promise<void>}
   */
  async function checkDbSize(options = {}) {
    if (!Number.isFinite(caps.warnFileBytes)) return;
    /** @type {number} */
    let bytes;
    try {
      ({ bytes } = await client.call('db.size'));
    } catch (err) {
      const appErr = toAppError(err);
      // 열기와 겹친 것은 미룸이다. 다음 변경에서 다시 잰다. 그 밖의 실패는 알리되 이미 적용된 변경은 그대로다.
      if (appErr.code !== 'E_DB_BUSY') notify.error(appErr);
      return;
    }
    const level = bytes >= caps.maxFileBytes ? 2 : bytes >= caps.warnFileBytes ? 1 : 0;
    const previous = sizeLevel;
    sizeLevel = level;
    if (options.baseline || level <= previous) return;
    const limit = level === 2 ? caps.maxFileBytes : caps.warnFileBytes;
    notify.warn(level === 2 ? 'file.sizeOver' : 'file.sizeWarn', {
      size: formatBytes(bytes),
      limit: formatBytes(limit),
    });
  }

  /**
   * 데스크톱 모드: 지금 열린 dirty 작업 사본을 버린다(사용자가 미저장 변경 버리기를 확인한 뒤에만).
   */
  async function discardDirtyWorkcopy() {
    if (!nativeMode || !state.dirty) return;
    try {
      await client.call('db.close', { discardWorkcopy: true });
      openWorkcopyKey = null;
    } catch (err) {
      notify.error(toStoreError(err));
    }
  }

  /**
   * 데스크톱 모드 저장 한 번(D-15): `db.save`가 메타를 기록하고 러스트가 `VACUUM INTO` → `.bak` → rename으로
   * 원본을 바꾼다. 저장 뮤텍스(`state.saving`)는 이 함수가 잡았다가 반드시 놓는다.
   * @param {string} originalPath
   * @param {{ auto?: boolean, force?: boolean }} options
   * @returns {Promise<'saved' | 'failed' | 'changed'>} `changed`는 연 뒤 원본이 디스크에서 바뀐 것이다
   */
  async function saveNativeOnce(originalPath, options) {
    if (state.readOnly !== 'none') {
      if (!options.auto) notify.info('file.readOnlyBlocked');
      return 'failed';
    }
    if (state.saving) {
      if (!options.auto) notify.info('file.saveBusy');
      return 'failed';
    }
    state.saving = true;
    emit('state:changed');
    const name = nativeFs('baseName')(originalPath);
    try {
      const saved = await withNativeProgress(() =>
        client.call('db.save', {
          originalPath,
          bumpRevision: true,
          savedBy: deviceName,
          force: options.force === true,
        }),
      );
      // `.bak`은 러스트가 저장마다 회전시키므로 브라우저 모드의 백업 생략 표시는 여기서 뜻이 없다.
      state.backupNote = 'none';
      await setSaved({
        name,
        handle: null,
        path: originalPath,
        size: saved.size,
        gzip: false,
        meta: saved.meta,
      });
      if (!options.auto) {
        if (saved.backupPath) {
          notify.info('file.savedBackup', {
            name,
            backup: nativeFs('baseName')(saved.backupPath),
          });
        } else {
          notify.info('file.saved', { name });
        }
      }
      return 'saved';
    } catch (err) {
      const appErr = toStoreError(err);
      // 연 뒤 바뀐 원본은 오류가 아니라 물어볼 일이다. 묻기는 뮤텍스를 놓은 뒤 `saveNative`가 한다.
      if (appErr.code === 'E_ORIGINAL_CHANGED' && !options.auto) return 'changed';
      // 자동 저장이 배타 op와 겹친 것과 원본 변경은 오류가 아니라 미룸이다.
      if (!(
        options.auto &&
        (appErr.code === 'E_DB_BUSY' || appErr.code === 'E_ORIGINAL_CHANGED')
      )) {
        notify.error(appErr);
      }
      return 'failed';
    } finally {
      state.saving = false;
      emit('state:changed');
    }
  }

  /**
   * 데스크톱 모드 저장. 원본이 연 뒤 디스크에서 바뀌었으면 덮어쓰기 / 다른 이름으로 저장 / 취소를 묻고 고른 대로
   * 다시 저장한다. 되물을 때는 뮤텍스를 놓고(대화상자가 오래 열려 있을 수 있다) 다시 저장할 때 `saveNativeOnce`가
   * 새로 잡는다. 되묻기와 다시 저장이 한 `try`/`finally` 안에 있으면 `finally`가 다시 저장이 끝나기 전에 돌아
   * 저장 중인데도 뮤텍스가 풀린 상태가 된다.
   * @param {string} originalPath
   * @param {{ auto?: boolean, force?: boolean }} [options]
   * @returns {Promise<boolean>}
   */
  async function saveNative(originalPath, options = {}) {
    const outcome = await saveNativeOnce(originalPath, options);
    if (outcome !== 'changed') return outcome === 'saved';
    const choice = await prompts.originalChanged({ name: nativeFs('baseName')(originalPath) });
    if (choice === 'overwrite') return saveNative(originalPath, { ...options, force: true });
    if (choice === 'saveAs') return store.saveAs();
    return false;
  }

  /**
   * 데스크톱 모드: 남은 dirty 사본을 열었을 때의 복구 판정(4.3절의 저널 조건과 같다, D-15).
   * @param {NativeOpenInfo} workcopy
   * @param {string | null} fileName
   * @returns {Promise<'keep' | 'discard'>}
   */
  async function judgeWorkcopy(workcopy, fileName) {
    const sameRevision =
      fileName === null || workcopy.originalRevision === workcopy.workcopyRevision;
    const choice = await prompts.workcopyRecover({
      fileName,
      sameRevision,
      originalRevision: workcopy.originalRevision,
      workcopyRevision: workcopy.workcopyRevision,
    });
    if (choice === 'discard') return 'discard';
    if (!sameRevision) notify.info('file.workcopyMismatch');
    return 'keep';
  }

  /**
   * 데스크톱 모드: 연 결과를 스토어 상태로 옮긴다(외부 파일 등록, 읽기 전용, 탭 잠금, revision 판정).
   * @param {import('../db/worker.js').OpenResult} opened
   * @param {{ name: string | null, path: string | null, dirty: boolean }} file
   * @returns {Promise<boolean>}
   */
  async function finishNativeOpen(opened, file) {
    let result = opened;
    if (result.unmanaged) {
      if (!(await prompts.adoptExternal())) {
        await store.newDatabase({ force: true });
        return false;
      }
      try {
        result = await client.call('schema.adopt');
      } catch (err) {
        notify.error(toStoreError(err));
        await store.newDatabase({ force: true });
        return false;
      }
    }
    /** @type {ReadOnlyReason} */
    let readOnly = 'none';
    if (result.readOnly) {
      readOnly = 'newerSchema';
      notify.error(new AppError('E_FILE_NEWER_SCHEMA', 'schema_version is newer than this app'));
    }
    const dbId = result.meta.db_id ?? '';
    const lock = await tablock.claim(dbId);
    if (lock.heldElsewhere && readOnly === 'none') {
      readOnly = 'otherTab';
      notify.info('file.readOnlyTab');
    }
    setOpened({
      name: file.name,
      handle: null,
      path: file.path,
      size: opened.workcopy?.size ?? 0,
      gzip: false,
      meta: result.meta,
      tables: result.tables,
      readOnly,
    });
    if (file.dirty) {
      // 복구한 사본의 변경은 아직 파일에 없다.
      state.dirty = true;
    }
    if (file.path !== null && !(await reconcileRevision(result.meta))) {
      await store.newDatabase({ force: true });
      return false;
    }
    if (file.path !== null && file.name !== null) await rememberRecent(file.name, null, file.path);
    emit('file:opened');
    if (file.dirty) emit('file:dirty');
    return true;
  }

  /**
   * 저장 직전 기존 파일을 IDB `backups`에 1세대 보관한다(D-04). 실패는 저장을 막지 않는다.
   * @param {FileSystemFileHandle} handle
   * @param {string} dbId
   */
  async function backupBefore(handle, dbId) {
    // 이번 저장의 백업 결과로 덮어쓴다. 백업이 필요 없는 저장(첫 저장, IDB 없음)은 지난 실패를 지운다.
    state.backupNote = 'none';
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
        // 다운로드 폴백은 덮어쓸 원본이 없어 백업하지 않는다. 지난 저장의 백업 실패 표시는 지운다.
        state.backupNote = 'none';
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
      // 스냅샷의 메모리 부족에는 "저장한 뒤 다시 시작"(`error.E_MEM`)이 맞지 않는다. 방금 실패한 일이 저장이다.
      if (appErr.code === 'E_MEM') notify.error(appErr, 'file.saveMemFailed');
      else if (!(options.auto && appErr.code === 'E_DB_BUSY')) notify.error(appErr);
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

  /**
   * 스키마 op를 실행하고 커맨드를 저널·dirty에 반영한 뒤 테이블 목록을 새로 읽는다(`runSchemaOp`의 본문).
   * `record`는 `recordCommand`에 넘기는 선택 사항(열 추가와 이름 합치기 표시).
   * @template {SchemaOp} K
   * @param {K} op
   * @param {OpMap[K]['args']} args
   * @param {CallOptions | undefined} options
   * @param {RecordOptions} record
   * @returns {Promise<OpMap[K]['result'] | null>}
   */
  async function schemaOp(op, args, options, record) {
    if (state.readOnly !== 'none') {
      notify.info('file.readOnlyBlocked');
      return null;
    }
    /** @type {OpMap[K]['result']} */
    let result;
    try {
      result = await client.call(op, args, options);
    } catch (err) {
      notify.error(toStoreError(err));
      // 적용되지 않았으므로 상태를 그대로 두되, 목록이 어긋났을 수 있으니 다시 읽는다(E_DB_QUERY 등).
      await store.refreshTables();
      return null;
    }
    await store.recordCommand(result.cmd, record);
    await store.refreshTables();
    return result;
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
      if (!options.force) {
        if (!(await confirmDiscard())) return false;
        await discardDirtyWorkcopy();
      }
      try {
        const opened = await openDb(options.dbId ? { dbId: options.dbId } : {});
        tablock.release();
        setOpened({
          name: null,
          handle: null,
          path: null,
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
      if (!canOpenNow()) return false;
      if (nativeMode) {
        /** @type {string | null} */
        let path;
        try {
          path = await nativeFs('pickOpenPath')();
        } catch (err) {
          notify.error(toStoreError(err));
          return false;
        }
        if (!path) return false;
        return store.openPath(path);
      }
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

    async openPath(originalPath) {
      if (!canOpenNow()) return false;
      if (!nativeMode) {
        notify.error(new AppError('E_UNSUPPORTED', 'openPath is desktop-only'));
        return false;
      }
      if (!(await confirmDiscard())) return false;
      await discardDirtyWorkcopy();
      const name = nativeFs('baseName')(originalPath);
      /** @type {import('../db/worker.js').OpenResult} */
      let opened;
      try {
        opened = await withNativeProgress(() => openDb({ originalPath }));
        if (opened.workcopy?.dirty) {
          const verdict = await judgeWorkcopy(opened.workcopy, name);
          if (verdict === 'discard') {
            opened = await withNativeProgress(() =>
              openDb({ originalPath, discardWorkcopy: true }),
            );
          }
        }
      } catch (err) {
        // 이전 DB는 이미 닫혔다. 사용 가능한 상태로 돌아가기 위해 새 DB를 연다.
        notify.error(toStoreError(err));
        await store.newDatabase({ force: true });
        return false;
      }
      return finishNativeOpen(opened, {
        name,
        path: originalPath,
        dirty: opened.workcopy?.dirty === true,
      });
    },

    async openPicked(picked) {
      if (!canOpenNow()) return false;
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
        opened = await openDb({ bytes }, { transfer: [bytes.buffer] });
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
      if (picked.handle) await rememberRecent(picked.name, picked.handle, null);
      emit('file:opened');
      return true;
    },

    async save(options = {}) {
      if (nativeMode) {
        if (options.auto) {
          if (!state.file.path || !state.dirty || state.readOnly !== 'none') return false;
          return saveNative(state.file.path, { auto: true });
        }
        if (!state.file.path) return store.saveAs();
        return saveNative(state.file.path);
      }
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
      if (nativeMode) {
        /** @type {string | null} */
        let path;
        try {
          path = await nativeFs('pickSavePath')(state.file.name ?? deps.defaultFileName, 'db');
        } catch (err) {
          notify.error(toStoreError(err));
          return false;
        }
        if (!path) return false;
        return saveNative(path);
      }
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
      if (target.kind === 'path') {
        notify.error(new AppError('E_UNSUPPORTED', 'path targets belong to desktop mode'));
        return false;
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
      if (nativeMode) {
        if (!state.file.path) return null;
        try {
          const info = await nativeFs('backupInfo')(state.file.path);
          if (!info) return null;
          return { name: nativeFs('baseName')(info.path), bytes: info.size, at: info.mtime };
        } catch (err) {
          notify.error(toStoreError(err));
          return null;
        }
      }
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
      if (nativeMode) {
        // `<원본>.bak`을 고른 경로로 복사한다. 열린 DB와 원본은 건드리지 않는다.
        const originalPath = state.file.path;
        if (!originalPath) {
          notify.info('backup.none');
          return false;
        }
        try {
          const info = await nativeFs('backupInfo')(originalPath);
          if (!info) {
            notify.info('backup.none');
            return false;
          }
          const suggested = `backup-${nativeFs('baseName')(originalPath)}`;
          const target = await nativeFs('pickSavePath')(suggested, 'db');
          if (!target) return false;
          const restored = await nativeFs('restoreBackup')(originalPath, target);
          notify.info('backup.restored', { name: nativeFs('baseName')(restored.path) });
          return true;
        } catch (err) {
          notify.error(toStoreError(err));
          return false;
        }
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
        } else if (target.kind === 'download') {
          fs.download(target.name, copy);
          notify.info('backup.restored', { name: target.name });
        } else {
          throw new AppError('E_UNSUPPORTED', 'path targets belong to desktop mode');
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
      const name =
        target.kind === 'handle'
          ? target.handle.name
          : target.kind === 'path'
            ? nativeFs('baseName')(target.path)
            : target.name;
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
        const notice = { mergeWithAdd: options.mergeWithAdd === true };
        for (const handler of commandListeners) handler(cmd, notice);
      }
      // 커맨드는 DB 내용을 바꿨다. 그리드는 블록 캐시를 버리고 다시 읽는다(D-06).
      if (options.refresh !== false) emit('data:changed');
      await checkDbSize();
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
      if (nativeMode) return recoverWorkcopies();
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
        const { name, handle, path } =
          /** @type {{ name: string, handle?: FileSystemFileHandle | null, path?: string | null }} */ (
            stored
          );
        if (typeof name !== 'string') return null;
        if (nativeMode)
          return typeof path === 'string' && path ? { name, handle: null, path } : null;
        if (!handle || typeof handle.getFile !== 'function') return null;
        return { name, handle, path: null };
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
      return schemaOp(op, args, options, {});
    },

    async createTable(name, options = {}) {
      const result = await store.runSchemaOp('schema.create', {
        name,
        ...(options.columns ? { columns: options.columns } : {}),
      });
      if (!result) return null;
      store.selectTable(result.tableId);
      return result.tableId;
    },

    async addDefaultColumn(tableId) {
      if (state.readOnly !== 'none') {
        notify.info('file.readOnlyBlocked');
        return null;
      }
      for (let attempt = 0; ; attempt += 1) {
        const table = state.tables.find((tb) => tb.id === tableId);
        if (!table) return null;
        // 소프트 삭제된 열의 이름도 건너뛴다. 그 이름을 새 열이 가져가면 삭제한 열을 복원할 수 없다(D-16).
        const taken = new Set(table.columns.map((c) => c.name));
        const [name = ''] = nextNames(t('column.defaultName'), taken, 1);
        /** @type {OpMap['schema.addColumn']['result']} */
        let result;
        try {
          result = await client.call('schema.addColumn', { tableId, name, type: 'text' });
        } catch (err) {
          const appErr = toStoreError(err);
          // 다른 경로(저널 재생, 다른 창의 커맨드)가 같은 이름을 막 만들었다. 목록을 다시 읽고 한 번만 더.
          const retry = appErr.code === 'E_NAME_INVALID' && attempt === 0;
          await store.refreshTables();
          if (retry) continue;
          notify.error(appErr);
          return null;
        }
        await store.recordCommand(result.cmd);
        await store.refreshTables();
        return { columnId: result.columnId, columnCount: result.columnCount };
      }
    },

    async renameColumn(tableId, columnId, name, options = {}) {
      const result = await schemaOp('schema.renameColumn', { tableId, columnId, name }, undefined, {
        mergeWithAdd: options.mergeWithAdd === true,
      });
      return result !== null;
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
      await checkDbSize();
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

    async listWorkcopies() {
      if (!nativeMode) return [];
      try {
        // 열린 사본은 복구를 기다리지 않는다(이미 열려 있다). 여기서 빼야 목록에서 버려지지 않는다.
        return (await nativeFs('listWorkcopies')()).filter(
          (e) => e.dirty && e.key !== openWorkcopyKey,
        );
      } catch (err) {
        notify.error(toStoreError(err));
        return [];
      }
    },

    async openWorkcopy(key) {
      if (!nativeMode) return false;
      if (!canOpenNow()) return false;
      if (!(await confirmDiscard())) return false;
      await discardDirtyWorkcopy();
      /** @type {import('../db/worker.js').OpenResult} */
      let opened;
      try {
        opened = await openDb({ workcopyKey: key });
      } catch (err) {
        notify.error(toStoreError(err));
        await store.newDatabase({ force: true });
        return false;
      }
      const originalPath = opened.workcopy?.originalPath ?? null;
      return finishNativeOpen(opened, {
        name: originalPath === null ? null : nativeFs('baseName')(originalPath),
        path: originalPath,
        dirty: true,
      });
    },

    async discardWorkcopy(key) {
      if (!nativeMode) return false;
      // 러스트는 열린 사본을 버리라면 DB를 닫고 지운다. 화면은 그 DB가 열려 있다고 믿으므로 받지 않는다.
      if (key === openWorkcopyKey) return false;
      try {
        await nativeFs('removeWorkcopy')(key);
        return true;
      } catch (err) {
        notify.error(toStoreError(err));
        return false;
      }
    },

    async discardAllWorkcopies() {
      /** @type {DiscardAllResult} */
      const outcome = { removed: 0, failed: [] };
      if (!nativeMode) return outcome;
      // 목록은 열린 사본을 뺀 것이다(`listWorkcopies`). 지금 열린 DB는 대상이 아니다(D-18).
      for (const entry of await store.listWorkcopies()) {
        try {
          await nativeFs('removeWorkcopy')(entry.key);
          outcome.removed += 1;
        } catch (err) {
          // 파일 잠금 등. 그 사본만 남기고 나머지를 계속한다. 원본 파일은 이 경로에서 건드리지 않는다.
          outcome.failed.push({ entry, error: toStoreError(err) });
        }
      }
      return outcome;
    },

    async backupCount() {
      if (!idb) return null;
      try {
        return (await idb.keys('backups')).length;
      } catch (err) {
        notify.error(toAppError(err));
        return null;
      }
    },

    async clearBackups() {
      if (!idb) return null;
      try {
        const removed = (await idb.keys('backups')).length;
        await idb.clear('backups');
        return { removed };
      } catch (err) {
        // IDB의 clear는 트랜잭션 하나라 실패하면 아무것도 지워지지 않는다. 보관본이 그대로임을 문구로 알린다.
        notify.error(
          new AppError('E_UNKNOWN', 'clearing previous saves failed', {
            cause: err,
            detail: { backupsKept: true },
          }),
          'backup.clearFailed',
        );
        return null;
      }
    },

    async planCleanup() {
      try {
        return await client.call('cleanup.plan');
      } catch (err) {
        notify.error(toStoreError(err));
        return null;
      }
    },

    async runCleanup(columns, callOptions) {
      if (state.readOnly !== 'none') {
        notify.info('file.readOnlyBlocked');
        return null;
      }
      const result = await client.call('cleanup.run', { columns }, callOptions);
      // 커맨드는 저널에만 남긴다(재생은 `do` 방향이라 같은 재작성이 다시 일어난다). 되돌릴 수 없으므로 히스토리
      // 스택에 넣지 않고, `cleanup:done`을 받은 히스토리가 스택을 비운다(테이블 삭제와 같은 규칙, D-08).
      for (const cmd of result.cmds) {
        await store.recordCommand(cmd, { fromHistory: true, refresh: false });
      }
      if (result.cmds.length > 0) {
        emit('cleanup:done');
      } else if (result.vacuumed) {
        // 빈 공간만 줄였다. 논리 상태는 그대로라 저널에 남길 것이 없지만, 저장해야 파일이 작아진다.
        store.markDirty();
      }
      await store.refreshTables();
      emit('data:changed');
      return result;
    },

    async openRecent() {
      if (!canOpenNow()) return false;
      const recent = await store.recentFile();
      if (!recent) return false;
      if (recent.path !== null) return store.openPath(recent.path);
      if (!recent.handle) return false;
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

  /**
   * 데스크톱 모드의 시작 복구(D-15): 저장한 적 없는 새 DB의 dirty 사본은 복구를 제안하고, 파일의 dirty 사본은
   * 그 파일을 열면 복구된다는 안내만 한다(브라우저 모드의 `file.journalPendingFor`와 같다).
   * @returns {Promise<boolean>}
   */
  async function recoverWorkcopies() {
    /** @type {WorkcopyEntry[]} */
    let entries;
    try {
      entries = await nativeFs('listWorkcopies')();
    } catch (err) {
      notify.error(toStoreError(err));
      return false;
    }
    const dirty = entries.filter((e) => e.dirty);
    const fresh = dirty.find((e) => (e.meta?.originalPath ?? null) === null);
    for (const entry of dirty) {
      const originalPath = entry.meta?.originalPath ?? null;
      if (originalPath !== null) {
        notify.info('file.workcopyPendingFor', { name: nativeFs('baseName')(originalPath) });
      }
    }
    if (!fresh) return false;
    const choice = await prompts.workcopyRecover({
      fileName: null,
      sameRevision: true,
      originalRevision: null,
      workcopyRevision: null,
    });
    if (choice !== 'recover') {
      try {
        await nativeFs('removeWorkcopy')(fresh.key);
      } catch (err) {
        notify.error(toStoreError(err));
      }
      return false;
    }
    /** @type {import('../db/worker.js').OpenResult} */
    let opened;
    try {
      opened = await openDb({ workcopyKey: fresh.key });
    } catch (err) {
      notify.error(toStoreError(err));
      await store.newDatabase({ force: true });
      return false;
    }
    return finishNativeOpen(opened, { name: null, path: null, dirty: true });
  }

  autosave.attach({ dbId: '', baseRevision: 0, fileName: null });
  return store;
}
