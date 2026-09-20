// @ts-check
/**
 * 논리 타입 ↔ 저장값 변환·검증(DESIGN.md 4.2). 순수 함수만 있고 엔진을 부르지 않는다.
 *
 * - NULL은 모든 타입에서 "비어 있음"이다. 빈 문자열(공백만 있는 문자열 포함)은 NULL로 저장한다.
 * - `date`는 `YYYY-MM-DD`, `datetime`은 `YYYY-MM-DDTHH:mm:ss`(표준시 정보 없음).
 */
import { AppError } from '../util/errors.js';

/** @typedef {'text' | 'longtext' | 'integer' | 'real' | 'boolean' | 'date' | 'datetime' | 'select'} LogicalType */
/** @typedef {{ choices?: string[], decimals?: number }} ColumnOptions */
/** @typedef {string | number | bigint | boolean | Date | Uint8Array | null | undefined} RawValue */
/** @typedef {string | number | null} StoredValue STRICT 물리 타입에 넣는 값 */
/**
 * @typedef {'not_integer' | 'out_of_range' | 'not_number' | 'not_boolean' | 'bad_date' | 'bad_datetime' | 'not_in_choices' | 'no_choices' | 'unsupported' | 'unknown_type'} InvalidReason
 */
/** @typedef {{ ok: true, value: StoredValue } | { ok: false, reason: InvalidReason }} ValidationResult */
/** @typedef {'null' | 'abort'} CoercePolicy 변환 실패 값을 NULL로 / 중단 */

export const LOGICAL_TYPES = Object.freeze(
  /** @type {const} */ ([
    'text',
    'longtext',
    'integer',
    'real',
    'boolean',
    'date',
    'datetime',
    'select',
  ]),
);

/**
 * @param {unknown} value
 * @returns {value is LogicalType}
 */
export function isLogicalType(value) {
  return (
    typeof value === 'string' && /** @type {readonly string[]} */ (LOGICAL_TYPES).includes(value)
  );
}

/** 정수 범위 ±2^53 (안전 정수). */
export const INTEGER_MAX = Number.MAX_SAFE_INTEGER;

const TRUE_WORDS = new Set(['1', 'true', 't', 'yes', 'y', 'on', '참', '예']);
const FALSE_WORDS = new Set(['0', 'false', 'f', 'no', 'n', 'off', '거짓', '아니오', '아니요']);

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/;

/**
 * @param {number} n
 * @param {number} width
 */
function pad(n, width) {
  return String(n).padStart(width, '0');
}

/**
 * 달력에 있는 날짜인지 확인한다(`2026-02-30`은 거부).
 * @param {number} y
 * @param {number} m 1..12
 * @param {number} d
 * @returns {boolean}
 */
function isCalendarDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1) return false;
  const check = new Date(Date.UTC(y, m - 1, d));
  return check.getUTCFullYear() === y && check.getUTCMonth() === m - 1 && check.getUTCDate() === d;
}

/**
 * 문자열 또는 Date에서 날짜·시각 부품을 뽑는다. 형식이 틀리거나 달력에 없는 날짜면 null.
 * @param {string | Date} raw
 * @returns {{ y: number, m: number, d: number, hh: number, mm: number, ss: number, hasTime: boolean } | null}
 */
function parseDateParts(raw) {
  if (raw instanceof Date) {
    if (Number.isNaN(raw.getTime())) return null;
    return {
      y: raw.getUTCFullYear(),
      m: raw.getUTCMonth() + 1,
      d: raw.getUTCDate(),
      hh: raw.getUTCHours(),
      mm: raw.getUTCMinutes(),
      ss: raw.getUTCSeconds(),
      hasTime: true,
    };
  }
  const m = DATE_RE.exec(raw.trim());
  if (!m) return null;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (!isCalendarDate(y, mo, d)) return null;
  const hasTime = m[4] !== undefined;
  const hh = hasTime ? Number(m[4]) : 0;
  const mi = hasTime ? Number(m[5]) : 0;
  const ss = m[6] !== undefined ? Number(m[6]) : 0;
  if (hh > 23 || mi > 59 || ss > 59) return null;
  return { y, m: mo, d, hh, mm: mi, ss, hasTime };
}

/**
 * 빈 값(NULL, undefined, 공백뿐인 문자열)인가.
 * @param {RawValue} raw
 * @returns {boolean}
 */
export function isEmpty(raw) {
  if (raw === null || raw === undefined) return true;
  return typeof raw === 'string' && raw.trim() === '';
}

/**
 * 논리 타입에 맞게 검증하고 저장값으로 바꾼다. 빈 값은 항상 `{ ok: true, value: null }`.
 * @param {LogicalType} type
 * @param {RawValue} raw
 * @param {ColumnOptions} [options]
 * @returns {ValidationResult}
 */
export function validate(type, raw, options = {}) {
  if (raw === null || raw === undefined || isEmpty(raw)) return { ok: true, value: null };
  if (raw instanceof Uint8Array) return { ok: false, reason: 'unsupported' };
  switch (type) {
    case 'text':
    case 'longtext':
      return { ok: true, value: toText(raw) };
    case 'integer':
      return validateInteger(raw);
    case 'real':
      return validateReal(raw);
    case 'boolean':
      return validateBoolean(raw);
    case 'date':
    case 'datetime': {
      if (typeof raw === 'number' || typeof raw === 'bigint' || typeof raw === 'boolean') {
        return { ok: false, reason: type === 'date' ? 'bad_date' : 'bad_datetime' };
      }
      const parts = parseDateParts(/** @type {string | Date} */ (raw));
      if (!parts) return { ok: false, reason: type === 'date' ? 'bad_date' : 'bad_datetime' };
      const date = `${pad(parts.y, 4)}-${pad(parts.m, 2)}-${pad(parts.d, 2)}`;
      if (type === 'date') return { ok: true, value: date };
      return {
        ok: true,
        value: `${date}T${pad(parts.hh, 2)}:${pad(parts.mm, 2)}:${pad(parts.ss, 2)}`,
      };
    }
    case 'select': {
      const choices = options.choices;
      if (!Array.isArray(choices) || choices.length === 0)
        return { ok: false, reason: 'no_choices' };
      const text = toText(raw);
      return choices.includes(text)
        ? { ok: true, value: text }
        : { ok: false, reason: 'not_in_choices' };
    }
    default:
      return { ok: false, reason: 'unknown_type' };
  }
}

/**
 * @param {Exclude<RawValue, null | undefined | Uint8Array>} raw
 * @returns {string}
 */
function toText(raw) {
  if (raw instanceof Date) {
    const v = validate('datetime', raw);
    return v.ok ? String(v.value) : '';
  }
  if (typeof raw === 'boolean') return raw ? 'true' : 'false';
  return String(raw);
}

/**
 * @param {Exclude<RawValue, null | undefined | Uint8Array>} raw
 * @returns {ValidationResult}
 */
function validateInteger(raw) {
  /** @type {number} */
  let n;
  if (typeof raw === 'bigint') {
    if (raw > BigInt(INTEGER_MAX) || raw < -BigInt(INTEGER_MAX)) {
      return { ok: false, reason: 'out_of_range' };
    }
    return { ok: true, value: Number(raw) };
  }
  if (typeof raw === 'number') {
    n = raw;
  } else if (typeof raw === 'boolean') {
    return { ok: true, value: raw ? 1 : 0 };
  } else if (typeof raw === 'string') {
    const s = raw.trim().replace(/,/g, '');
    if (!/^[+-]?\d+(?:\.0+)?$/.test(s)) return { ok: false, reason: 'not_integer' };
    n = Number(s);
  } else {
    return { ok: false, reason: 'not_integer' };
  }
  if (!Number.isFinite(n) || !Number.isInteger(n)) return { ok: false, reason: 'not_integer' };
  if (Math.abs(n) > INTEGER_MAX) return { ok: false, reason: 'out_of_range' };
  return { ok: true, value: n };
}

/**
 * @param {Exclude<RawValue, null | undefined | Uint8Array>} raw
 * @returns {ValidationResult}
 */
function validateReal(raw) {
  /** @type {number} */
  let n;
  if (typeof raw === 'number') n = raw;
  else if (typeof raw === 'bigint') n = Number(raw);
  else if (typeof raw === 'boolean') n = raw ? 1 : 0;
  else if (typeof raw === 'string') {
    const s = raw.trim().replace(/,/g, '');
    if (!/^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(s)) {
      return { ok: false, reason: 'not_number' };
    }
    n = Number(s);
  } else return { ok: false, reason: 'not_number' };
  if (!Number.isFinite(n)) return { ok: false, reason: 'not_number' };
  return { ok: true, value: n };
}

/**
 * @param {Exclude<RawValue, null | undefined | Uint8Array>} raw
 * @returns {ValidationResult}
 */
function validateBoolean(raw) {
  if (typeof raw === 'boolean') return { ok: true, value: raw ? 1 : 0 };
  if (typeof raw === 'number' || typeof raw === 'bigint') {
    if (raw === 0 || raw === 1 || raw === 0n || raw === 1n) return { ok: true, value: Number(raw) };
    return { ok: false, reason: 'not_boolean' };
  }
  if (typeof raw === 'string') {
    const s = raw.trim().toLowerCase();
    if (TRUE_WORDS.has(s)) return { ok: true, value: 1 };
    if (FALSE_WORDS.has(s)) return { ok: true, value: 0 };
  }
  return { ok: false, reason: 'not_boolean' };
}

/**
 * 변환 정책을 적용한다. 실패 값은 `null` 정책이면 NULL, `abort` 정책이면 `E_VALUE_INVALID`.
 * @param {LogicalType} type
 * @param {RawValue} raw
 * @param {CoercePolicy} policy
 * @param {ColumnOptions} [options]
 * @returns {StoredValue}
 */
export function coerce(type, raw, policy, options) {
  const result = validate(type, raw, options);
  if (result.ok) return result.value;
  if (policy === 'null') return null;
  throw new AppError('E_VALUE_INVALID', `cannot convert value to ${type}: ${result.reason}`, {
    detail: { type, reason: result.reason, preview: previewOf(raw) },
  });
}

/**
 * 오류 detail에 넣을 값 미리보기(앞 80자, CLAUDE.md 5.7).
 * @param {RawValue} raw
 * @returns {string}
 */
export function previewOf(raw) {
  if (raw === null || raw === undefined) return '';
  if (raw instanceof Uint8Array) return `<blob ${raw.byteLength} bytes>`;
  return String(raw).slice(0, 80);
}

/**
 * 저장값을 표시 문자열로 바꾼다. NULL은 빈 문자열.
 * @param {LogicalType} type
 * @param {StoredValue} value
 * @param {ColumnOptions} [options]
 * @returns {string}
 */
export function toDisplay(type, value, options = {}) {
  if (value === null || value === undefined) return '';
  switch (type) {
    case 'boolean':
      return Number(value) === 1 ? 'true' : 'false';
    case 'real': {
      const n = Number(value);
      if (typeof options.decimals === 'number' && Number.isFinite(n)) {
        return n.toFixed(options.decimals);
      }
      return String(value);
    }
    default:
      return String(value);
  }
}
