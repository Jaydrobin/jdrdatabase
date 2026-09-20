// @ts-check
/**
 * 파일 접근 추상화(D-04): File System Access API → `<input type="file">`·`<a download>` 폴백.
 *
 * 타우리 dialog/fs 분기(`capabilities().native`)는 인터페이스와 스텁만 두고 Step 11에서 채운다.
 * 이 파일은 메인 스레드에서만 실행된다.
 */
import { AppError, toAppError } from '../util/errors.js';

/** 열기·저장 대화상자에 보이는 확장자. */
export const DB_EXTENSIONS = Object.freeze(['.db', '.sqlite', '.sqlite3']);
const ACCEPT_TYPES = [
  { description: 'SQLite database', accept: { 'application/vnd.sqlite3': [...DB_EXTENSIONS] } },
];

/** 폴백 열기 경로가 쓰는 숨은 입력 요소의 클래스. E2E가 파일 선택기 대신 이 요소를 쓴다. */
export const FILE_INPUT_CLASS = 'jdr-file-input';

/**
 * @typedef {object} FsCapabilities
 * @property {boolean} fsa `showOpenFilePicker`·`showSaveFilePicker`를 쓸 수 있는가
 * @property {boolean} idb `indexedDB` 전역이 있는가(실제 열기 성공 여부는 io/idb.js가 안다)
 * @property {boolean} native 데스크톱 모드(타우리 dialog/fs). Step 11 전에는 항상 false
 */

/**
 * @typedef {object} PickedFile
 * @property {string} name
 * @property {File} file
 * @property {FileSystemFileHandle | null} handle FSA 경로에서만 있다. 없으면 저장은 다운로드 폴백
 */

/** @typedef {{ kind: 'handle', handle: FileSystemFileHandle } | { kind: 'download', name: string } | { kind: 'cancelled' }} SaveTarget */

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
  return { fsa, idb, native: false };
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
  input.accept = DB_EXTENSIONS.join(',');
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
      types: ACCEPT_TYPES,
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
 * @returns {Promise<SaveTarget>}
 */
export async function pickSaveAs(suggestedName) {
  if (capabilities().fsa && window.showSaveFilePicker) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName,
        types: ACCEPT_TYPES,
        id: 'jdrdatabase-db',
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
 * `<a download>`로 바이트를 내려받게 한다(폴백 저장).
 * @param {string} name
 * @param {Uint8Array<ArrayBuffer> | Blob} bytes
 */
export function download(name, bytes) {
  const blob =
    bytes instanceof Blob ? bytes : new Blob([bytes], { type: 'application/vnd.sqlite3' });
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
