// @ts-check
/**
 * 파일 접근 추상화(D-04): File System Access API → `<input type="file">`·`<a download>` 폴백.
 * Step 9: gzip(`.db.gz`) 압축·해제, 내보내기 조각을 받는 바이트 싱크, 저장 종류(db·csv·xlsx)별 선택기.
 * Step 11: 데스크톱 모드(`capabilities().native`)의 경로 선택기(러스트 `pick_open`·`pick_save`), `.bak` 정보·복원,
 * 작업 사본 목록, 경로 싱크(러스트 `sink_*`로 조각을 쓰고 닫을 때 원자적으로 교체). 타우리 invoke는 이 파일과
 * `io/ipc-bridge.js`에서만 부른다(CLAUDE.md 4장). 브라우저 모드의 폴백 사다리는 데스크톱 모드에 없다(D-15).
 *
 * 이 파일은 메인 스레드에서만 실행된다(gzip·싱크 함수는 DOM 없이도 동작해 Node 테스트가 부른다).
 */
import { AppError, toAppError } from '../util/errors.js';
import { invokeWithChannel, tauriInternals, tauriInvoke } from './ipc-bridge.js';

/** 열기·저장 대화상자에 보이는 확장자. */
export const DB_EXTENSIONS = Object.freeze(['.db', '.sqlite', '.sqlite3']);
/** gzip으로 저장한 DB의 확장자(Step 9). 열기 입력의 accept와 저장 종류에 함께 둔다. */
export const GZIP_EXTENSION = '.gz';
/** @typedef {'db' | 'csv' | 'xlsx'} SaveKind */
/** @type {Record<SaveKind, FilePickerAcceptType[]>} */
const ACCEPT_TYPES_BY_KIND = {
  db: [
    { description: 'SQLite database', accept: { 'application/vnd.sqlite3': [...DB_EXTENSIONS] } },
    { description: 'SQLite database (gzip)', accept: { 'application/gzip': [GZIP_EXTENSION] } },
  ],
  csv: [{ description: 'CSV', accept: { 'text/csv': ['.csv'] } }],
  xlsx: [
    {
      description: 'Excel workbook',
      accept: {
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      },
    },
  ],
};
/** @type {Record<SaveKind, string>} */
export const MIME_BY_KIND = {
  db: 'application/vnd.sqlite3',
  csv: 'text/csv',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};

/** 폴백 열기 경로가 쓰는 숨은 입력 요소의 클래스. E2E가 파일 선택기 대신 이 요소를 쓴다. */
export const FILE_INPUT_CLASS = 'jdr-file-input';

/**
 * @typedef {object} FsCapabilities
 * @property {boolean} fsa `showOpenFilePicker`·`showSaveFilePicker`를 쓸 수 있는가
 * @property {boolean} idb `indexedDB` 전역이 있는가(실제 열기 성공 여부는 io/idb.js가 안다)
 * @property {boolean} native 데스크톱 모드(타우리 전역 객체가 있음). 파일 선택·바이트 이동은 러스트 명령이 한다
 * @property {boolean} gzip `CompressionStream`·`DecompressionStream`을 쓸 수 있는가(Step 9)
 */

/**
 * @typedef {object} PickedFile
 * @property {string} name
 * @property {File} file
 * @property {FileSystemFileHandle | null} handle FSA 경로에서만 있다. 없으면 저장은 다운로드 폴백
 */

/** @typedef {{ kind: 'handle', handle: FileSystemFileHandle } | { kind: 'download', name: string } | { kind: 'path', path: string } | { kind: 'cancelled' }} SaveTarget 저장 대상. `path`는 데스크톱 모드의 경로 문자열 */

/**
 * 내보내기 조각을 받는 바이트 싱크(Step 9). FSA 경로는 `createWritable()`(임시 파일에 쓰고 `close()`에서 교체),
 * 폴백은 조각을 모아 `close()`에서 내려받게 한다. `abort()`는 어느 쪽도 파일을 남기지 않는다.
 * @typedef {object} ByteSink
 * @property {(chunk: Uint8Array<ArrayBuffer>) => Promise<void>} write
 * @property {() => Promise<void>} close
 * @property {() => Promise<void>} abort
 */

/**
 * 기능 감지는 try/catch로 감싼다(CLAUDE.md 5.6).
 * @returns {FsCapabilities}
 */
export function capabilities() {
  let fsa = false;
  let idb = false;
  try {
    fsa =
      typeof window.showOpenFilePicker === 'function' &&
      typeof window.showSaveFilePicker === 'function';
  } catch {
    fsa = false;
  }
  try {
    idb = typeof globalThis.indexedDB !== 'undefined' && globalThis.indexedDB !== null;
  } catch {
    idb = false;
  }
  return { fsa, idb, native: tauriInternals() !== null, gzip: gzipSupported() };
}

/** 데스크톱 E2E가 대화상자 대신 넣어 주는 경로(테스트 빌드 전용, DESIGN.md Step 11 완료 기준). */
/** @type {Array<string | null>} */
const injectedPaths = [];

/**
 * 다음 경로 선택기가 대화상자 없이 돌려줄 경로를 넣는다. null은 취소다. 테스트 빌드에서만 동작한다.
 * @param {string | null} path
 */
export function injectPickedPath(path) {
  if (!__JDR_TEST__) throw new AppError('E_UNSUPPORTED', 'injectPickedPath is test-only');
  injectedPaths.push(path);
}

/** @returns {string | null | undefined} 넣어 둔 경로가 없으면 undefined */
function takeInjectedPath() {
  if (!__JDR_TEST__ || injectedPaths.length === 0) return undefined;
  return injectedPaths.shift() ?? null;
}

/**
 * 경로의 파일 이름 부분(`/`·`\` 뒤). 표시용이며 경로 결합에는 쓰지 않는다.
 * @param {string} path
 * @returns {string}
 */
export function baseName(path) {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return cut >= 0 ? path.slice(cut + 1) : path;
}

/**
 * 데스크톱 모드: 열 파일의 경로를 고른다. 취소하면 null.
 * @returns {Promise<string | null>}
 */
export async function pickOpenPath() {
  const injected = takeInjectedPath();
  if (injected !== undefined) return injected;
  const picked = await tauriInvoke('pick_open', {});
  return typeof picked === 'string' && picked ? picked : null;
}

/**
 * 데스크톱 모드: 저장할 경로를 고른다. 취소하면 null.
 * @param {string} suggestedName
 * @param {SaveKind} [kind]
 * @returns {Promise<string | null>}
 */
export async function pickSavePath(suggestedName, kind = 'db') {
  const injected = takeInjectedPath();
  if (injected !== undefined) return injected;
  const picked = await tauriInvoke('pick_save', { suggestedName, kind });
  return typeof picked === 'string' && picked ? picked : null;
}

/**
 * 러스트 코어 명령(`engine_call`)을 메인 스레드에서 직접 부른다. 열린 DB를 건드리지 않는 파일 명령에만 쓴다.
 * @param {string} cmd
 * @param {Record<string, unknown>} args
 * @returns {Promise<unknown>}
 */
function engineCall(cmd, args) {
  // 러스트 `engine_call`은 진행률 채널을 항상 받는다(파일 명령은 보내지 않지만 인자는 있어야 한다).
  return invokeWithChannel('engine_call', { cmd, args }, undefined);
}

/** @typedef {{ path: string, size: number, mtime: number }} NativeBackupInfo */
/** @typedef {{ key: string, dir: string, dirty: boolean, size: number, meta: { originalPath: string | null, originalMtime: number | null, originalSize: number | null, openedAt: number } | null }} WorkcopyEntry */

/**
 * `<원본>.bak`이 있으면 크기·시각.
 * @param {string} originalPath
 * @returns {Promise<NativeBackupInfo | null>}
 */
export async function backupInfo(originalPath) {
  const info = await engineCall('backup_info', { originalPath });
  return /** @type {NativeBackupInfo | null} */ (info ?? null);
}

/**
 * `<원본>.bak`을 고른 경로로 복사한다.
 * @param {string} originalPath
 * @param {string} targetPath
 * @returns {Promise<NativeBackupInfo>}
 */
export async function restoreBackup(originalPath, targetPath) {
  return /** @type {NativeBackupInfo} */ (
    await engineCall('restore_backup', { originalPath, targetPath })
  );
}

/** @typedef {{ phase: string, done: number, total: number }} NativeProgress */

/**
 * 러스트가 마지막으로 보고한 진행률. 긴 명령(5 GB 열기·저장)이 도는 동안 메인 스레드가 폴링한다.
 * 엔진 프로토콜(동기 XHR)에는 진행률 채널이 없어 보고가 Worker까지 가지 못하기 때문이다(D-15).
 * 커넥션 뮤텍스를 잡지 않는 명령이라 도는 명령을 막지 않는다.
 * @returns {Promise<NativeProgress | null>}
 */
export async function pollProgress() {
  const raw = await engineCall('progress_peek', {});
  if (!raw || typeof raw !== 'object') return null;
  const v = /** @type {Record<string, unknown>} */ (raw);
  if (typeof v.done !== 'number' || typeof v.total !== 'number') return null;
  return { phase: String(v.phase ?? ''), done: v.done, total: v.total };
}

/**
 * 남아 있는 작업 사본 목록(최근 연 순).
 * @returns {Promise<WorkcopyEntry[]>}
 */
export async function listWorkcopies() {
  return /** @type {WorkcopyEntry[]} */ (await engineCall('list_workcopies', {}));
}

/**
 * 작업 사본 하나를 지운다(버리기).
 * @param {string} key
 */
export async function removeWorkcopy(key) {
  await engineCall('remove_workcopy', { key });
}

/**
 * 데스크톱 모드의 경로 싱크: 러스트가 임시 파일에 쓰고 `close()`에서 원자적으로 교체한다. `abort()`는 임시 파일을 지운다.
 * 조각은 IPC 요청 본문(raw)으로 보내 base64 부풀림을 피한다.
 * @param {string} path
 * @returns {Promise<ByteSink>}
 */
export async function openPathSink(path) {
  const id = /** @type {number} */ (await engineCall('sink_open', { path }));
  return {
    write: async (chunk) => {
      await tauriInvoke('sink_write', chunk, { headers: { 'jdr-sink': String(id) } });
    },
    close: async () => {
      await engineCall('sink_close', { id });
    },
    abort: async () => {
      await engineCall('sink_abort', { id });
    },
  };
}

/**
 * gzip 스트림을 쓸 수 있는가. 기능 감지는 try/catch로 감싼다(CLAUDE.md 5.6).
 * @returns {boolean}
 */
export function gzipSupported() {
  try {
    return (
      typeof globalThis.CompressionStream === 'function' &&
      typeof globalThis.DecompressionStream === 'function'
    );
  } catch {
    return false;
  }
}

/**
 * gzip 매직(`1f 8b`)인가.
 * @param {Uint8Array} bytes
 * @returns {boolean}
 */
export function isGzip(bytes) {
  return bytes.byteLength >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

/**
 * @param {Uint8Array} bytes
 * @param {'gzip'} format
 * @param {boolean} compress
 * @returns {Promise<Uint8Array<ArrayBuffer>>}
 */
async function pipeGzip(bytes, format, compress) {
  if (!gzipSupported()) {
    throw new AppError('E_GZIP_UNSUPPORTED', 'CompressionStream/DecompressionStream is missing');
  }
  const transform = compress ? new CompressionStream(format) : new DecompressionStream(format);
  const stream = new Blob([/** @type {BlobPart} */ (bytes)]).stream().pipeThrough(transform);
  try {
    return new Uint8Array(await new Response(stream).arrayBuffer());
  } catch (err) {
    if (err instanceof RangeError) throw new AppError('E_MEM', err.message, { cause: err });
    throw toAppError(err, compress ? 'E_FILE_WRITE' : 'E_FILE_CORRUPT');
  }
}

/**
 * gzip 압축(`.db.gz` 저장).
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array<ArrayBuffer>>}
 */
export function gzip(bytes) {
  return pipeGzip(bytes, 'gzip', true);
}

/**
 * gzip 해제(`.db.gz` 열기). 손상된 스트림은 `E_FILE_CORRUPT`.
 * @param {Uint8Array} bytes
 * @returns {Promise<Uint8Array<ArrayBuffer>>}
 */
export function gunzip(bytes) {
  return pipeGzip(bytes, 'gzip', false);
}

/**
 * @param {unknown} err
 * @returns {boolean} 사용자가 대화상자를 취소했는가
 */
function isAbort(err) {
  return typeof err === 'object' && err !== null && 'name' in err && err.name === 'AbortError';
}

/**
 * @param {unknown} err
 * @param {'read' | 'write'} phase
 * @returns {AppError}
 */
function toFileError(err, phase) {
  if (err instanceof AppError) return err;
  const name = typeof err === 'object' && err !== null && 'name' in err ? String(err.name) : '';
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new AppError('E_FILE_PERMISSION', `${phase}: ${name}`, { cause: err });
  }
  if (err instanceof RangeError) {
    return new AppError('E_MEM', err.message, { cause: err });
  }
  return toAppError(err, phase === 'write' ? 'E_FILE_WRITE' : 'E_UNKNOWN');
}

/** @type {HTMLInputElement | null} */
let fileInput = null;

/**
 * 폴백 열기가 쓰는 숨은 `<input type="file">`. 한 번 만들어 문서에 두고 재사용한다.
 * @returns {HTMLInputElement}
 */
export function getFileInput() {
  if (fileInput && fileInput.isConnected) return fileInput;
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = [...DB_EXTENSIONS, GZIP_EXTENSION].join(',');
  input.className = FILE_INPUT_CLASS;
  input.hidden = true;
  input.setAttribute('aria-hidden', 'true');
  input.tabIndex = -1;
  document.body.append(input);
  fileInput = input;
  return input;
}

/**
 * 파일 핸들 권한을 확인하고 필요하면 요청한다. 거부되면 `E_FILE_PERMISSION`.
 * @param {FileSystemFileHandle} handle
 * @param {'read' | 'readwrite'} mode
 */
export async function ensurePermission(handle, mode) {
  const h = /** @type {FileSystemHandle} */ (handle);
  if (typeof h.queryPermission !== 'function' || typeof h.requestPermission !== 'function') {
    return;
  }
  let state = await h.queryPermission({ mode });
  if (state === 'prompt') state = await h.requestPermission({ mode });
  if (state !== 'granted') {
    throw new AppError('E_FILE_PERMISSION', `permission ${state} for ${mode}`, {
      detail: { mode, state },
    });
  }
}

/**
 * File System Access API로 열 파일을 고른다. 취소하면 null. API가 없으면 폴백 입력 요소를 써야 하므로 null.
 * 폴백(`<input type="file">`)은 `getFileInput()`으로 만든 요소를 UI(도구 모음)가 소유하고, 그 `change`에서
 * `fileFromInput()`으로 읽는다. 자동화 도구(Playwright `setInputFiles`)가 같은 요소에 파일을 넣을 수 있다.
 * @returns {Promise<PickedFile | null>}
 */
export async function pickOpen() {
  if (!capabilities().fsa || !window.showOpenFilePicker) return null;
  try {
    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: ACCEPT_TYPES_BY_KIND.db,
      id: 'jdrdatabase-db',
    });
    if (!handle) return null;
    const file = await handle.getFile();
    return { name: file.name, file, handle };
  } catch (err) {
    if (isAbort(err)) return null;
    throw toFileError(err, 'read');
  }
}

/**
 * 폴백 입력 요소에서 고른 파일을 꺼내고 값을 비운다(같은 파일을 다시 골라도 change가 나게).
 * @param {HTMLInputElement} input
 * @returns {PickedFile | null}
 */
export function fileFromInput(input) {
  const file = input.files?.[0];
  input.value = '';
  return file ? { name: file.name, file, handle: null } : null;
}

/**
 * 저장 위치를 고른다. FSA가 없으면 다운로드 폴백을 알린다.
 * @param {string} suggestedName
 * @param {SaveKind} [kind] 제안하는 파일 종류. 기본 `db`
 * @returns {Promise<SaveTarget>}
 */
export async function pickSaveAs(suggestedName, kind = 'db') {
  if (capabilities().native) {
    const path = await pickSavePath(suggestedName, kind);
    return path ? { kind: 'path', path } : { kind: 'cancelled' };
  }
  if (capabilities().fsa && window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: ACCEPT_TYPES_BY_KIND[kind],
        id: `jdrdatabase-${kind}`,
      });
      return { kind: 'handle', handle };
    } catch (err) {
      if (isAbort(err)) return { kind: 'cancelled' };
      throw toFileError(err, 'write');
    }
  }
  return { kind: 'download', name: suggestedName };
}

/**
 * 파일 전체를 읽는다. 큰 파일의 `arrayBuffer()`가 실패하면 `E_MEM`.
 * @param {File | FileSystemFileHandle} source
 * @returns {Promise<Uint8Array>}
 */
export async function readAll(source) {
  try {
    /** @type {File} */
    let file;
    if (source instanceof File) {
      file = source;
    } else {
      await ensurePermission(source, 'read');
      file = await source.getFile();
    }
    return new Uint8Array(await file.arrayBuffer());
  } catch (err) {
    throw toFileError(err, 'read');
  }
}

/**
 * 핸들에 바이트를 쓴다. `createWritable()`은 임시 파일에 쓰고 `close()`에서 교체하므로 실패해도 원본은 남는다.
 * @param {FileSystemFileHandle} handle
 * @param {Uint8Array<ArrayBuffer>} bytes
 */
export async function write(handle, bytes) {
  await ensurePermission(handle, 'readwrite');
  /** @type {FileSystemWritableFileStream | null} */
  let writable = null;
  try {
    writable = await handle.createWritable();
    await writable.write(bytes);
    await writable.close();
    writable = null;
  } catch (err) {
    if (writable) {
      try {
        await writable.abort();
      } catch {
        // abort 실패는 원본 보존에 영향이 없다(임시 파일만 남을 수 있다).
      }
    }
    throw toFileError(err, 'write');
  }
}

/**
 * 내보내기 조각을 받을 싱크를 연다(Step 9). FSA 핸들은 임시 파일에 쓰고 `close()`에서 교체하며, 다운로드 폴백은
 * 조각을 모아 `close()`에서 내려받는다. 어느 쪽이든 `abort()` 뒤에는 파일이 만들어지지 않는다.
 * @param {{ kind: 'handle', handle: FileSystemFileHandle } | { kind: 'download', name: string } | { kind: 'path', path: string }} target
 * @param {string} mime
 * @returns {Promise<ByteSink>}
 */
export async function openSink(target, mime) {
  if (target.kind === 'path') return openPathSink(target.path);
  if (target.kind === 'download') {
    /** @type {Uint8Array<ArrayBuffer>[]} */
    let parts = [];
    return {
      write: async (chunk) => {
        parts.push(chunk);
      },
      close: async () => {
        download(target.name, new Blob(parts, { type: mime }));
        parts = [];
      },
      abort: async () => {
        parts = [];
      },
    };
  }
  await ensurePermission(target.handle, 'readwrite');
  /** @type {FileSystemWritableFileStream} */
  let writable;
  try {
    writable = await target.handle.createWritable();
  } catch (err) {
    throw toFileError(err, 'write');
  }
  return {
    write: async (chunk) => {
      try {
        await writable.write(chunk);
      } catch (err) {
        throw toFileError(err, 'write');
      }
    },
    close: async () => {
      try {
        await writable.close();
      } catch (err) {
        throw toFileError(err, 'write');
      }
    },
    abort: async () => {
      try {
        await writable.abort();
      } catch {
        // abort 실패는 원본 보존에 영향이 없다(임시 파일만 남을 수 있다).
      }
    },
  };
}

/**
 * `<a download>`로 바이트를 내려받게 한다(폴백 저장).
 * @param {string} name
 * @param {Uint8Array<ArrayBuffer> | Blob} bytes
 */
export function download(name, bytes) {
  const blob =
    bytes instanceof Blob
      ? bytes
      : new Blob([bytes], {
          type: name.endsWith(GZIP_EXTENSION) ? 'application/gzip' : MIME_BY_KIND.db,
        });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.hidden = true;
  document.body.append(a);
  a.click();
  a.remove();
  // 다운로드가 시작될 시간을 준 뒤 해제한다. 즉시 해제하면 일부 브라우저가 다운로드를 시작하지 못한다.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}
