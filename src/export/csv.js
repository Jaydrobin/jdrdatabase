// @ts-check
/**
 * CSV 내보내기(Step 9). Worker에서 실행된다.
 *
 * - RFC 4180: 구분자·`"`·개행이 든 필드는 `"…"`로 감싸고 안의 `"`는 `""`. 레코드 구분은 `\r\n`.
 * - 기본 인코딩은 UTF-8 BOM(엑셀 호환). 파일 전체를 문자열로 만들지 않고 페이지(5,000행)마다 조각을
 *   싱크에 쓴다(`sink.write`가 끝나야 다음 페이지를 읽는다).
 * - 수식 주입 방지(`formulaGuard`, 기본 켜짐): 텍스트 계열 값이 `=`, `+`, `-`, `@`로 시작하면 앞에 `'`를 붙인다.
 *   값을 바꾸는 옵션이므로 대화상자가 표시하고, 왕복이 필요하면 끌 수 있다.
 * - 값 규칙은 `cellText`에 있다. 다시 가져올 때 타입·값이 같도록 실수는 소수 자릿수 옵션을 적용하지 않는다.
 */
import { count as countRows } from '../db/query.js';
import { AppError } from '../util/errors.js';
import { exportColumns, PAGE_ROWS, readPages } from './rows.js';

/** @typedef {import('../db/engine.js').Engine} Engine */
/** @typedef {import('../db/engine.js').SqlValue} SqlValue */
/** @typedef {import('../db/tables.js').TableInfo} TableInfo */
/** @typedef {import('../db/tables.js').ColumnInfo} ColumnInfo */
/** @typedef {import('../db/query.js').ViewSpec} ViewSpec */

/** @typedef {'utf-8-bom' | 'utf-8'} CsvExportEncoding */

/**
 * @typedef {object} CsvExportOptions
 * @property {CsvExportEncoding} [encoding] 기본 `utf-8-bom`
 * @property {string} [delimiter] 한 글자. 기본 `,`
 * @property {boolean} [formulaGuard] 기본 true
 */

/**
 * 감지·기본값이 채워진 옵션.
 * @typedef {object} ResolvedCsvExportOptions
 * @property {CsvExportEncoding} encoding
 * @property {string} delimiter
 * @property {boolean} formulaGuard
 */

/**
 * 조각을 받는 싱크. Worker에서는 `{ id, chunk }` 메시지를 보내고, 테스트에서는 배열에 모은다.
 * @typedef {object} ByteSink
 * @property {(bytes: Uint8Array<ArrayBuffer>) => Promise<void> | void} write
 */

/**
 * 내보내기 결과. `blobCells`는 빈 값으로 쓴 BLOB 셀 수(외부 테이블).
 * @typedef {object} ExportResult
 * @property {number} rows
 * @property {number} bytes
 * @property {number} blobCells
 */

/**
 * @typedef {object} ExportContext
 * @property {AbortSignal} [signal]
 * @property {(progress: { phase: string, done: number, total: number }) => void} [progress]
 */

/** 인코딩 선택지. UI와 검증이 같은 목록을 쓴다. */
export const CSV_EXPORT_ENCODINGS = Object.freeze(/** @type {const} */ (['utf-8-bom', 'utf-8']));
/** UTF-8 BOM 바이트. */
export const UTF8_BOM = Object.freeze([0xef, 0xbb, 0xbf]);
/** 수식으로 해석될 수 있는 첫 글자(Step 9 예외 처리). */
const FORMULA_LEADERS = new Set(['=', '+', '-', '@']);

/**
 * 텍스트 계열 타입(수식 주입 방지 대상). 숫자·불리언·날짜는 저장값이 수식이 될 수 없다.
 * @param {ColumnInfo} column
 * @returns {boolean}
 */
function isTextual(column) {
  return column.type === 'text' || column.type === 'longtext' || column.type === 'select';
}

/**
 * Worker 경계를 넘어온 옵션의 형태를 정리한다.
 * @param {unknown} raw
 * @returns {ResolvedCsvExportOptions}
 */
export function normalizeCsvOptions(raw) {
  const o =
    typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {};
  const encoding = o.encoding === 'utf-8' ? 'utf-8' : 'utf-8-bom';
  const delimiter = typeof o.delimiter === 'string' && o.delimiter.length === 1 ? o.delimiter : ',';
  if (delimiter === '"' || delimiter === '\r' || delimiter === '\n') {
    throw new AppError('E_DB_QUERY', 'csv delimiter must not be a quote or newline', {
      detail: { delimiter },
    });
  }
  return { encoding, delimiter, formulaGuard: o.formulaGuard !== false };
}

/**
 * 저장값 → CSV 필드 문자열(인용 전). NULL은 빈 문자열, BLOB은 빈 문자열이며 호출자가 `blobCells`를 센다.
 * @param {ColumnInfo} column
 * @param {SqlValue} value
 * @param {{ formulaGuard: boolean }} options
 * @returns {string}
 */
export function cellText(column, value, options) {
  if (value === null || value === undefined) return '';
  if (value instanceof Uint8Array) return '';
  if (column.type === 'boolean') return Number(value) === 1 ? 'true' : 'false';
  const text = typeof value === 'string' ? value : String(value);
  if (options.formulaGuard && isTextual(column) && text.length > 0) {
    const first = text[0] ?? '';
    if (FORMULA_LEADERS.has(first)) return `'${text}`;
  }
  return text;
}

/**
 * RFC 4180 인용. 구분자·`"`·`\r`·`\n`이 있으면 감싼다.
 * @param {string} text
 * @param {string} delimiter
 * @returns {string}
 */
export function quoteField(text, delimiter) {
  if (
    text.includes(delimiter) ||
    text.includes('"') ||
    text.includes('\r') ||
    text.includes('\n')
  ) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

/**
 * 헤더와 페이지를 CSV 텍스트로 만들어 싱크에 쓴다.
 * @param {Engine} engine
 * @param {TableInfo} table
 * @param {ViewSpec} viewSpec
 * @param {CsvExportOptions | undefined} rawOptions
 * @param {ByteSink} sink
 * @param {ExportContext} [ctx]
 * @returns {Promise<ExportResult>}
 */
export async function exportCsv(engine, table, viewSpec, rawOptions, sink, ctx = {}) {
  const options = normalizeCsvOptions(rawOptions);
  const columns = exportColumns(table, viewSpec);
  const total = countRows(engine, table, viewSpec);
  const encoder = new TextEncoder();
  const guard = { formulaGuard: options.formulaGuard };
  /** @type {ExportResult} */
  const result = { rows: 0, bytes: 0, blobCells: 0 };

  /**
   * @param {string} text
   * @param {boolean} withBom
   */
  const write = async (text, withBom) => {
    const body = encoder.encode(text);
    /** @type {Uint8Array<ArrayBuffer>} */
    let bytes;
    if (withBom) {
      bytes = new Uint8Array(new ArrayBuffer(UTF8_BOM.length + body.byteLength));
      bytes.set(UTF8_BOM, 0);
      bytes.set(body, UTF8_BOM.length);
    } else {
      bytes = new Uint8Array(new ArrayBuffer(body.byteLength));
      bytes.set(body);
    }
    result.bytes += bytes.byteLength;
    await sink.write(bytes);
  };

  const header = columns.map((c) => quoteField(c.name, options.delimiter)).join(options.delimiter);
  ctx.progress?.({ phase: 'export', done: 0, total });
  await write(`${header}\r\n`, options.encoding === 'utf-8-bom');

  for await (const page of readPages(engine, table, viewSpec, columns, {
    pageSize: PAGE_ROWS,
    signal: ctx.signal,
  })) {
    /** @type {string[]} */
    const lines = new Array(page.length);
    for (let r = 0; r < page.length; r += 1) {
      const row = /** @type {SqlValue[]} */ (page[r]);
      /** @type {string[]} */
      const fields = new Array(columns.length);
      for (let c = 0; c < columns.length; c += 1) {
        const column = /** @type {ColumnInfo} */ (columns[c]);
        const value = row[c] ?? null;
        if (value instanceof Uint8Array) result.blobCells += 1;
        fields[c] = quoteField(cellText(column, value, guard), options.delimiter);
      }
      lines[r] = fields.join(options.delimiter);
    }
    await write(`${lines.join('\r\n')}\r\n`, false);
    result.rows += page.length;
    ctx.progress?.({ phase: 'export', done: result.rows, total });
  }
  if (ctx.signal?.aborted) {
    throw new AppError('E_IMPORT_CANCELLED', 'export cancelled', {
      detail: { done: result.rows, total },
    });
  }
  ctx.progress?.({ phase: 'export', done: result.rows, total: total || result.rows });
  return result;
}
