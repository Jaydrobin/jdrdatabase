// @ts-check
/**
 * 앱 오류(DESIGN.md 7장). 던지는 오류는 AppError 하나뿐이고, 코드 목록은 이 파일에서만 정의한다.
 * Worker 경계에서는 serializeError/deserializeError로 `{ code, message, detail, recoverable }`만 오간다.
 */

/** 오류 코드 목록. DESIGN.md 7장의 표, i18n/ko.js의 `error.<코드>` 키와 1:1이다. */
export const ERROR_CODES = Object.freeze(
  /** @type {const} */ ([
    'E_ENV_NO_WASM',
    'E_ENV_NO_WORKER',
    'E_ENV_NO_IDB',
    'E_FILE_NOT_SQLITE',
    'E_FILE_CORRUPT',
    'E_FILE_TOO_LARGE',
    'E_FILE_NEWER_SCHEMA',
    'E_FILE_PERMISSION',
    'E_FILE_WRITE',
    'E_REVISION_BEHIND',
    'E_DB_QUERY',
    'E_DB_BUSY',
    'E_ENGINE_LOCKED',
    'E_RESULT_TOO_LARGE',
    'E_BATCH_TOO_LARGE',
    'E_MEM',
    'E_NAME_INVALID',
    'E_SYSTEM_COLUMN',
    'E_VALUE_INVALID',
    'E_PASTE_TOO_LARGE',
    'E_UNDO_LIMIT',
    'E_IMPORT_ENCODING',
    'E_IMPORT_CANCELLED',
    'E_XLSX_ENCRYPTED',
    'E_XLSX_CORRUPT',
    'E_GZIP_UNSUPPORTED',
    'E_QUOTA',
    'E_UNSUPPORTED',
    'E_NATIVE_IPC',
    'E_DISK_FULL',
    'E_FILE_LOCKED',
    'E_ORIGINAL_CHANGED',
    'E_UNKNOWN',
  ]),
);

/** @typedef {(typeof ERROR_CODES)[number]} ErrorCode */

/** 7장 표의 "복구 가능" 열. 없는 코드는 복구 가능(true)으로 본다. */
const NOT_RECOVERABLE = new Set(
  /** @type {ErrorCode[]} */ ([
    'E_ENV_NO_WASM',
    'E_ENGINE_LOCKED',
    'E_RESULT_TOO_LARGE',
    'E_BATCH_TOO_LARGE',
    'E_MEM',
    'E_UNSUPPORTED',
    'E_NATIVE_IPC',
    'E_UNKNOWN',
  ]),
);

/**
 * @typedef {object} SerializedError
 * @property {ErrorCode} code
 * @property {string} message
 * @property {unknown} [detail] 구조화 복제 가능한 값만
 * @property {boolean} recoverable
 */

/**
 * @typedef {object} AppErrorOptions
 * @property {unknown} [detail] 부가 정보. Worker 경계를 넘으므로 구조화 복제 가능한 값이어야 한다
 * @property {boolean} [recoverable] 기본값은 코드별 표(7장)
 * @property {unknown} [cause] 원인 예외
 */

export class AppError extends Error {
  /**
   * @param {ErrorCode} code
   * @param {string} message
   * @param {AppErrorOptions} [options]
   */
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'AppError';
    /** @type {ErrorCode} */
    this.code = code;
    /** @type {unknown} */
    this.detail = options.detail;
    /** @type {boolean} */
    this.recoverable = options.recoverable ?? !NOT_RECOVERABLE.has(code);
  }
}

/**
 * @param {unknown} value
 * @returns {value is AppError}
 */
export function isAppError(value) {
  return value instanceof AppError;
}

/**
 * @param {string} code
 * @returns {code is ErrorCode}
 */
export function isErrorCode(code) {
  return /** @type {readonly string[]} */ (ERROR_CODES).includes(code);
}

/**
 * 알 수 없는 예외를 AppError로 감싼다. 이미 AppError면 그대로 돌려주고 원인은 cause에 보존한다.
 * @param {unknown} err
 * @param {ErrorCode} [code] 기본 E_UNKNOWN
 * @param {string} [message] 기본값은 원인 예외의 message
 * @returns {AppError}
 */
export function toAppError(err, code = 'E_UNKNOWN', message) {
  if (isAppError(err)) return err;
  const causeMessage = err instanceof Error ? err.message : String(err);
  return new AppError(code, message ?? causeMessage, { cause: err });
}

/**
 * detail을 구조화 복제 가능한 값으로 정리한다. Error 인스턴스는 이름과 메시지만 남긴다.
 * @param {unknown} detail
 * @returns {unknown}
 */
function sanitizeDetail(detail) {
  if (detail instanceof Error) return { name: detail.name, message: detail.message };
  if (typeof detail === 'function' || typeof detail === 'symbol') return undefined;
  return detail;
}

/**
 * Worker 경계로 보낼 형태로 직렬화한다(CLAUDE.md 5.4). AppError가 아니면 E_UNKNOWN으로 감싼다.
 * @param {unknown} err
 * @returns {SerializedError}
 */
export function serializeError(err) {
  const appErr = toAppError(err);
  const out = /** @type {SerializedError} */ ({
    code: appErr.code,
    message: appErr.message,
    recoverable: appErr.recoverable,
  });
  const detail = sanitizeDetail(appErr.detail);
  if (detail !== undefined) out.detail = detail;
  if (!isAppError(err) && err instanceof Error && out.detail === undefined) {
    out.detail = { cause: { name: err.name, message: err.message } };
  }
  return out;
}

/**
 * 직렬화된 오류를 같은 AppError로 복원한다. 모르는 코드는 E_UNKNOWN으로 두고 원래 코드를 detail에 남긴다.
 * @param {unknown} value
 * @returns {AppError}
 */
export function deserializeError(value) {
  if (typeof value !== 'object' || value === null) {
    return new AppError('E_UNKNOWN', String(value));
  }
  const obj = /** @type {Partial<SerializedError> & { code?: unknown }} */ (value);
  const message = typeof obj.message === 'string' ? obj.message : '';
  if (typeof obj.code === 'string' && isErrorCode(obj.code)) {
    return new AppError(obj.code, message, {
      detail: obj.detail,
      recoverable: typeof obj.recoverable === 'boolean' ? obj.recoverable : undefined,
    });
  }
  return new AppError('E_UNKNOWN', message, {
    detail: { originalCode: obj.code, ...(obj.detail ? { detail: obj.detail } : {}) },
  });
}
