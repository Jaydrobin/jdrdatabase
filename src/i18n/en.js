// @ts-check
/**
 * 영어 문자열. v1에서는 키만 ko.js와 같게 유지한다(D-14).
 * @type {Readonly<Record<keyof typeof import('./ko.js').ko, string>>}
 */
export const en = Object.freeze({
  'app.title': 'jdrdatabase',
  'app.subtitle': 'A serverless SQLite database manager that runs in your browser',
  'app.version': 'Version {version}',
  'status.booting': 'Starting…',
  'status.ready': 'Ready',
  'status.mode.worker': 'Worker mode',
  'status.mode.inline': 'Single-thread mode',
  'status.engine': 'SQLite {version}',
  'lock.title': 'The app cannot start',
  'lock.supportedBrowsers':
    'Supported browsers: the latest two versions of Chrome/Edge (recommended), latest Firefox/Safari. WebAssembly must be enabled.',
  'lock.cause': 'Cause: {message}',
  'error.E_ENV_NO_WASM': 'WebAssembly is unavailable, so the database engine could not start.',
  'error.E_ENV_NO_WORKER':
    'Workers are unavailable; running in single-thread mode. The UI may pause during large operations.',
  'error.E_ENV_NO_IDB':
    'IndexedDB is unavailable; journal, backup and recent-file features are disabled.',
  'error.E_FILE_NOT_SQLITE': 'This is not a SQLite database file. The file was not modified.',
  'error.E_FILE_CORRUPT':
    'The database file is corrupt. The file was not modified. You can try the sqlite3 .recover command.',
  'error.E_FILE_TOO_LARGE':
    'The file exceeds the size limit of this environment. The file was not modified.',
  'error.E_FILE_NEWER_SCHEMA':
    'This file was saved by a newer version of the app. Opening read-only.',
  'error.E_FILE_PERMISSION': 'No permission to write the file. Save under a different name.',
  'error.E_FILE_WRITE':
    'Writing the file failed. The existing file is intact. Retry or save via download.',
  'error.E_REVISION_BEHIND':
    'This device previously saved a newer revision. The file may not be fully synced.',
  'error.E_DB_QUERY': 'A database operation failed.',
  'error.E_DB_BUSY': 'Another operation is in progress. Try again when it finishes.',
  'error.E_RESULT_TOO_LARGE': 'Internal error: query result is too large (over 10,000 rows).',
  'error.E_BATCH_TOO_LARGE': 'Internal error: a single batch is too large.',
  'error.E_MEM': 'Out of memory. The operation was aborted. Save and restart the app.',
  'error.E_NAME_INVALID': 'The name is empty or already in use.',
  'error.E_SYSTEM_COLUMN': 'System columns cannot be changed.',
  'error.E_VALUE_INVALID': 'The value does not match the column type.',
  'error.E_PASTE_TOO_LARGE': 'Too many cells to paste (over 1,000,000). Use CSV import instead.',
  'error.E_UNDO_LIMIT':
    'This operation exceeds the undo limit and cannot be undone. Continuing clears the undo history.',
  'error.E_IMPORT_ENCODING': 'Too many undecodable characters. Choose another encoding.',
  'error.E_IMPORT_CANCELLED': 'Import cancelled. All changes were rolled back.',
  'error.E_XLSX_ENCRYPTED': 'Password-protected XLSX files cannot be opened.',
  'error.E_XLSX_CORRUPT': 'The XLSX file cannot be read.',
  'error.E_GZIP_UNSUPPORTED': 'This browser does not support compressed saving. Save uncompressed.',
  'error.E_QUOTA': 'Browser storage is full; backup and journal are skipped.',
  'error.E_UNSUPPORTED': 'Internal error: the current engine does not support this operation.',
  'error.E_NATIVE_IPC': 'Communication with the desktop engine failed. Restart the app.',
  'error.E_DISK_FULL':
    'The disk is full. The original file was not modified. Free space and retry.',
  'error.E_FILE_LOCKED':
    'The original file could not be replaced (locked or no permission). The original is intact; you can save under another name.',
  'error.E_ORIGINAL_CHANGED': 'The original file changed on disk after it was opened.',
  'error.E_UNKNOWN': 'An unexpected error occurred. Save and restart the app.',
});
