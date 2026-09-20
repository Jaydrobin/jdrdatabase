// @ts-check
/**
 * 앱 상태(파일 상태 부분, Step 2)와 이벤트 버스. 열기·저장·저널 복구·revision 판정의 흐름이 여기 있다.
 *
 * DOM을 만지지 않는다. 사용자에게 묻는 일은 `prompts`, 알리는 일은 `notify`로 주입받아 Node에서도 검사할 수 있다.
 * 엔진에는 `db/client.js`로만 접근한다(CLAUDE.md 4장).
 */
import { judge } from './revision.js';
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
/** @typedef {import('../i18n/index.js').MessageKey} MessageKey */
/** @typedef {import('../i18n/index.js').MessageParams} MessageParams */

/** 저장 직전 백업을 IDB에 남기는 파일 크기 상한(D-04). */
export const BACKUP_MAX_BYTES = 200 * 1024 * 1024;
/** IDB `handles` 스토어에서 최근 파일 핸들을 두는 키. */
export const RECENT_HANDLE_KEY = 'recent';

/**
 * 파일 접근 함수 묶음. `io/filesystem.js`의 export와 같은 형태이며 테스트가 가짜를 넣는다.
 * @typedef {object} FileSystemLike
 * @property {() => Promise<PickedFile | null>} pickOpen
 * @property {(suggestedName: string) => Promise<SaveTarget>} pickSaveAs
 * @property {(source: File | FileSystemFileHandle) => Promise<Uint8Array>} readAll
 * @property {(handle: FileSystemFileHandle, bytes: Uint8Array<ArrayBuffer>) => Promise<void>} write
 * @property {(name: string, bytes: Uint8Array<ArrayBuffer> | Blob) => void} download
 * @property {(handle: FileSystemFileHandle, mode: 'read' | 'readwrite') => Promise<void>} ensurePermission
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
 * @property {number} size 마지막으로 읽거나 쓴 바이트 수
 */

/** @typedef {'none' | 'newerSchema' | 'otherTab'} ReadOnlyReason */

/**
 * @typedef {object} StoreState
 * @property {FileState} file
 * @property {Meta} meta
 * @property {TableInfo[]} tables
 * @property {string | null} currentTableId 사이드바에서 고른 테이블
 * @property {boolean} dirty
 * @property {ReadOnlyReason} readOnly
 * @property {boolean} journalFull
 */

/** @typedef {'file:opened' | 'file:saved' | 'file:dirty' | 'state:changed' | 'journal:full' | 'tables:changed' | 'selection:changed'} StoreEvent */

/**
 * 스키마 op 이름(`schema.*` 중 쓰기). 결과는 적용된 커맨드를 담는다.
 * @typedef {'schema.create' | 'schema.rename' | 'schema.drop' | 'schema.addColumn' | 'schema.renameColumn' | 'schema.reorderColumns' | 'schema.softDeleteColumn' | 'schema.restoreColumn' | 'schema.changeColumnType'} SchemaOp
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
 * @property {string} deviceName `_jdr_meta.saved_by`
 * @property {string} defaultFileName 새 DB를 처음 저장할 때의 제안 이름
 */

/**
 * @typedef {object} Store
 * @property {() => StoreState} getState
 * @property {(event: StoreEvent, handler: () => void) => () => void} on 구독 해제 함수를 돌려준다
 * @property {(options?: { force?: boolean, dbId?: string }) => Promise<boolean>} newDatabase
 * @property {() => Promise<boolean>} openFile FSA 선택기로 고른 뒤 `openPicked`. 폴백 입력 요소는 UI가 `openPicked`를 직접 부른다
 * @property {(picked: PickedFile) => Promise<boolean>} openPicked 미저장 변경 확인 → 크기 검사 → 열기 → revision 판정
 * @property {() => Promise<boolean>} save
 * @property {() => Promise<boolean>} saveAs
 * @property {() => void} markDirty
 * @property {(cmd: Command) => Promise<void>} recordCommand 적용된 커맨드를 저널에 넣고 dirty로 표시한다
 * @property {() => Promise<boolean>} recoverPending 시작 시 저널에 남은 새 DB 기록을 복구 제안한다
 * @property {() => Promise<{ name: string, handle: FileSystemFileHandle } | null>} recentFile IDB에 남은 최근 파일 핸들(권한은 아직 묻지 않음)
 * @property {() => Promise<boolean>} openRecent 최근 파일을 권한 요청 뒤 연다
 * @property {(tableId: string | null) => void} selectTable
 * @property {<K extends SchemaOp>(op: K, args: OpMap[K]['args'], options?: CallOptions) => Promise<OpMap[K]['result'] | null>} runSchemaOp 스키마 op를 실행하고 커맨드를 저널·dirty에 반영한 뒤 테이블 목록을 새로 읽는다. 실패는 알리고 null
 * @property {() => Promise<void>} refreshTables `schema.list`로 테이블 목록을 다시 읽는다
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

  /** @type {StoreState} */
  const state = {
    file: { name: null, handle: null, size: 0 },
    meta: {},
    tables: [],
    currentTableId: null,
    dirty: false,
    readOnly: 'none',
    journalFull: false,
  };

  /** @type {Map<StoreEvent, Set<() => void>>} */
  const listeners = new Map();

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
  }

  /**
   * 열기·새로 만들기 뒤의 공통 상태 설정.
   * @param {{ name: string | null, handle: FileSystemFileHandle | null, size: number, meta: Meta, tables: TableInfo[], readOnly: ReadOnlyReason }} next
   */
  function setOpened(next) {
    state.file = { name: next.name, handle: next.handle, size: next.size };
    state.meta = next.meta;
    state.currentTableId = null;
    setTables(next.tables);
    state.dirty = false;
    state.readOnly = next.readOnly;
    state.journalFull = autosave.isFull();
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
        state.journalFull = false;
      }
    } else if (journal && verdict.journal === 'mismatch') {
      const choice = await prompts.journalMismatch({
        count: journal.commands.length,
        baseRevision: journal.baseRevision,
        fileRevision: revision,
      });
      if (choice === 'export') exportJournal(journal);
      await autosave.clear();
      state.journalFull = false;
    }
    return true;
  }

  /**
   * 저장 뒤의 공통 처리: 메타 갱신, 저널 비움, known 갱신, dirty 해제.
   * @param {{ name: string, handle: FileSystemFileHandle | null, size: number, meta: Meta }} saved
   */
  async function setSaved(saved) {
    state.file = { name: saved.name, handle: saved.handle, size: saved.size };
    state.meta = saved.meta;
    state.dirty = false;
    await autosave.clear();
    state.journalFull = false;
    await writeKnown(saved.meta.db_id ?? '', fileRevision());
    autosave.attach({
      dbId: saved.meta.db_id ?? '',
      baseRevision: fileRevision(),
      fileName: saved.name,
    });
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
        notify.info('file.backupSkipped');
        return;
      }
      await idb.put('backups', dbId, { name: state.file.name, bytes: previous, at: Date.now() });
    } catch (err) {
      const appErr = toStoreError(err);
      notify.info('file.backupFailed', { code: appErr.code });
    }
  }

  /**
   * 스냅샷을 만들고 대상에 쓴다. 실패 시 원본은 그대로다(`createWritable`의 원자성).
   * @param {{ kind: 'handle', handle: FileSystemFileHandle, name: string } | { kind: 'download', name: string }} target
   * @returns {Promise<boolean>}
   */
  async function writeSnapshot(target) {
    if (state.readOnly !== 'none') {
      notify.info('file.readOnlyBlocked');
      return false;
    }
    try {
      const snap = await client.call('db.snapshot', {
        bumpRevision: true,
        savedBy: deps.deviceName,
      });
      if (target.kind === 'handle') {
        await backupBefore(target.handle, snap.meta.db_id ?? '');
        await fs.write(target.handle, snap.bytes);
        await setSaved({
          name: target.name,
          handle: target.handle,
          size: snap.bytes.byteLength,
          meta: snap.meta,
        });
        notify.info('file.saved', { name: target.name });
      } else {
        fs.download(target.name, snap.bytes);
        await setSaved({
          name: target.name,
          handle: null,
          size: snap.bytes.byteLength,
          meta: snap.meta,
        });
        notify.info('file.downloaded', { name: target.name });
      }
      return true;
    } catch (err) {
      notify.error(toStoreError(err));
      return false;
    }
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
      if (size > caps.maxFileBytes) {
        notify.error(
          new AppError('E_FILE_TOO_LARGE', `file is ${size} bytes, limit ${caps.maxFileBytes}`, {
            detail: { bytes: size, limit: caps.maxFileBytes },
          }),
        );
        return false;
      }
      if (size > caps.warnFileBytes) {
        if (!(await prompts.largeFile({ size, warn: caps.warnFileBytes }))) return false;
      }
      /** @type {import('../db/worker.js').OpenResult} */
      let opened;
      try {
        const bytes = await fs.readAll(picked.handle ?? picked.file);
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

    async save() {
      if (!state.file.handle) return store.saveAs();
      return writeSnapshot({
        kind: 'handle',
        handle: state.file.handle,
        name: state.file.name ?? deps.defaultFileName,
      });
    },

    async saveAs() {
      const suggested = state.file.name ?? deps.defaultFileName;
      /** @type {SaveTarget} */
      let target;
      try {
        target = await fs.pickSaveAs(suggested);
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

    markDirty() {
      if (state.dirty) return;
      state.dirty = true;
      emit('file:dirty');
    },

    async recordCommand(cmd) {
      try {
        await autosave.recordCommand(cmd);
      } catch (err) {
        // 저널 실패는 데이터 유실이 아니다(정본은 파일). 알리고 계속한다.
        notify.error(toAppError(err));
      }
      if (autosave.isFull() && !state.journalFull) {
        state.journalFull = true;
        emit('journal:full');
      }
      store.markDirty();
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
