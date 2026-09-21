// @ts-check
/**
 * 타입 추론(Step 7, D-09). 순수 함수만 있고 엔진을 부르지 않는다. CSV·XLSX가 같은 규칙을 쓴다.
 *
 * - `sample(rows, n)`: 행 이터레이터에서 앞 n행을 모으고 멈춘다(파서가 스트림을 취소한다).
 * - `column(values)`: 빈 값을 뺀 표본 전부가 맞는 첫 타입을 boolean → integer → real → date → datetime → text
 *   순으로 고른다. 2,000자 초과가 하나라도 있으면 longtext, 선행 0 숫자 문자열(우편번호)이 있으면 text.
 * - `columnName(raw, index, taken)`: 비어 있으면 `열N`, 겹치면 ` (2)` 접미사.
 */
import { t } from '../i18n/index.js';
import { MAX_NAME_LENGTH } from '../db/tables.js';
import { isEmpty, previewOf, validate } from '../db/values.js';

/** @typedef {import('../db/values.js').LogicalType} LogicalType */
/** @typedef {string | number | boolean | null} SourceValue 파서가 주는 값(D-09. XLSX 어댑터가 날짜를 문자열로 바꾼다) */
/**
 * 파서가 주는 행 하나. `errorCells`는 XLSX의 오류 셀(`#N/A` 등)이 있던 열 순번(값은 null로 온다).
 * @typedef {object} Row
 * @property {number} rowIndex
 * @property {SourceValue[]} cells
 * @property {number[]} [errorCells]
 */

/**
 * @typedef {object} Inferred
 * @property {LogicalType} type
 * @property {number} confidence 표본 중 비어 있지 않은 값의 비율(0~1)
 * @property {string[]} examples 비어 있지 않은 값 앞 3개(서로 다른 것, 앞 80자)
 */

/** 표본 크기(D-09). */
export const SAMPLE_ROWS = 1000;
/** 이 길이를 넘는 값이 하나라도 있으면 longtext. */
export const LONGTEXT_THRESHOLD = 2000;
/** 예시로 보여 주는 값의 수. */
export const EXAMPLE_COUNT = 3;

/** 추론 우선순위. 표본 전부가 맞는 첫 타입을 고른다. */
const TYPE_ORDER = /** @type {const} */ (['boolean', 'integer', 'real', 'date', 'datetime']);

const DATE_ONLY_RE = /^\s*\d{4}-\d{2}-\d{2}\s*$/;
const LEADING_ZERO_RE = /^\s*[+-]?0\d/;

/**
 * 행 이터레이터에서 앞 `limit`행을 모은다. 상한에 닿으면 이터레이터를 닫는다(`return()`).
 * @template {{ rowIndex: number }} R
 * @param {AsyncIterable<R>} rows
 * @param {number} [limit]
 * @returns {Promise<{ rows: R[], exhausted: boolean }>} `exhausted`는 상한 전에 끝났는가
 */
export async function sample(rows, limit = SAMPLE_ROWS) {
  /** @type {R[]} */
  const out = [];
  if (limit <= 0) return { rows: out, exhausted: false };
  for await (const row of rows) {
    out.push(row);
    if (out.length >= limit) return { rows: out, exhausted: false };
  }
  return { rows: out, exhausted: true };
}

/**
 * 헤더 값에서 열 이름을 만든다. 비어 있으면 자동 이름, `taken`과 겹치면 접미사를 붙인다. 만든 이름을 `taken`에 넣는다.
 * @param {SourceValue | undefined} raw
 * @param {number} index 0부터
 * @param {Set<string>} taken
 * @returns {string}
 */
export function columnName(raw, index, taken) {
  let base = raw === null || raw === undefined ? '' : String(raw).trim();
  if (!base) base = t('import.columnDefault', { n: index + 1 });
  if (base.length > MAX_NAME_LENGTH) base = base.slice(0, MAX_NAME_LENGTH).trim();
  let name = base;
  for (let k = 2; taken.has(name); k += 1) name = `${base} (${k})`;
  taken.add(name);
  return name;
}

/**
 * 값이 타입에 맞는가. `date`는 시각 부분이 없는 값만 받는다(있으면 `datetime`).
 * @param {LogicalType} type
 * @param {SourceValue} value 비어 있지 않은 값
 * @returns {boolean}
 */
function matches(type, value) {
  if (type === 'date') {
    return typeof value === 'string' && DATE_ONLY_RE.test(value) && validate('date', value).ok;
  }
  if (type === 'datetime') return typeof value === 'string' && validate('datetime', value).ok;
  if (typeof value === 'boolean') return type === 'boolean';
  return validate(type, value).ok;
}

/**
 * 표본 열 하나의 타입을 추론한다.
 * @param {ReadonlyArray<SourceValue | undefined>} values
 * @returns {Inferred}
 */
export function column(values) {
  /** @type {SourceValue[]} */
  const nonEmpty = [];
  for (const v of values) {
    if (v !== undefined && !isEmpty(v)) nonEmpty.push(v);
  }
  /** @type {string[]} */
  const examples = [];
  for (const v of nonEmpty) {
    const text = previewOf(v);
    if (!examples.includes(text)) examples.push(text);
    if (examples.length >= EXAMPLE_COUNT) break;
  }
  const confidence = values.length === 0 ? 0 : nonEmpty.length / values.length;
  if (nonEmpty.length === 0) return { type: 'text', confidence, examples };
  let longest = 0;
  let leadingZero = false;
  for (const v of nonEmpty) {
    if (typeof v === 'string') {
      if (v.length > longest) longest = v.length;
      if (LEADING_ZERO_RE.test(v)) leadingZero = true;
    }
  }
  if (longest > LONGTEXT_THRESHOLD) return { type: 'longtext', confidence, examples };
  if (leadingZero) return { type: 'text', confidence, examples };
  for (const type of TYPE_ORDER) {
    if (nonEmpty.every((v) => matches(type, v))) return { type, confidence, examples };
  }
  return { type: 'text', confidence, examples };
}
