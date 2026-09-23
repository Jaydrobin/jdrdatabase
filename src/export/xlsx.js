// @ts-check
/**
 * XLSX 내보내기(Step 9). SheetJS CE로 통합 문서를 만든다. Worker에서 실행된다.
 *
 * - SheetJS 쓰기는 메모리 상주라 조각이 하나뿐이다. 행 수가 `XLSX_MAX_ROWS`(규격 상한 − 헤더)를 넘으면 시작 전에
 *   `E_FILE_TOO_LARGE`, `XLSX_WARN_ROWS`를 넘으면 대화상자가 시작 전에 경고한다.
 * - 셀은 타입대로: 숫자·불리언은 그대로, 날짜는 로컬 시각으로 만든 `Date`(Step 8의 어댑터가 로컬 시각 부품으로
 *   읽으므로 왕복이 같다), 텍스트는 문자열(XLSX 문자열 셀은 수식으로 해석되지 않으므로 수식 주입 방지는 없다).
 * - SheetJS 객체(`XLSX`)를 만지는 코드는 `import/xlsx.js`, 이 파일, 픽스처 생성기뿐이다(R3: 어댑터 경계).
 */
import XLSX from '../../vendor/xlsx.full.min.js';
import { count as countRows } from '../db/query.js';
import { AppError } from '../util/errors.js';
import { exportColumns, PAGE_ROWS, readPages } from './rows.js';

/** @typedef {import('../db/engine.js').Engine} Engine */
/** @typedef {import('../db/engine.js').SqlValue} SqlValue */
/** @typedef {import('../db/tables.js').TableInfo} TableInfo */
/** @typedef {import('../db/tables.js').ColumnInfo} ColumnInfo */
/** @typedef {import('../db/query.js').ViewSpec} ViewSpec */
/** @typedef {import('./csv.js').ByteSink} ByteSink */
/** @typedef {import('./csv.js').ExportResult} ExportResult */
/** @typedef {import('./csv.js').ExportContext} ExportContext */
/** @typedef {import('../../vendor/xlsx.full.min.js').CellObject} CellObject */
/** @typedef {import('../../vendor/xlsx.full.min.js').WorkSheet} WorkSheet */

/** XLSX 규격의 시트 행 상한(1,048,576)에서 헤더 한 줄을 뺀 값. */
export const XLSX_MAX_ROWS = 1_048_575;
/** 이보다 많은 행은 시작 전에 경고한다(SheetJS 쓰기가 메모리 상주). */
export const XLSX_WARN_ROWS = 100_000;
/** 시트 이름 길이 상한(엑셀 규격). */
export const SHEET_NAME_MAX = 31;

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:T(\d{2}):(\d{2}):(\d{2}))?$/;

/**
 * 표시 이름 → 엑셀 시트 이름. 금지 문자 `[]:*?/\`를 `_`로 바꾸고 31자로 자른다. 비면 `Sheet1`.
 * @param {string} name
 * @returns {string}
 */
export function sheetName(name) {
  const cleaned = name
    .replace(/[[\]:*?/\\]/g, '_')
    .trim()
    .slice(0, SHEET_NAME_MAX)
    .trim();
  return cleaned || 'Sheet1';
}

/**
 * 저장 문자열(`YYYY-MM-DD` 또는 `YYYY-MM-DDTHH:mm:ss`)을 로컬 시각 Date로 만든다. 형식이 틀리면 null.
 * @param {string} text
 * @returns {Date | null}
 */
export function localDate(text) {
  const m = DATE_RE.exec(text);
  if (!m) return null;
  const d = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    m[4] === undefined ? 0 : Number(m[4]),
    m[5] === undefined ? 0 : Number(m[5]),
    m[6] === undefined ? 0 : Number(m[6]),
  );
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * 저장값 → 셀 객체. NULL·BLOB은 null(빈 셀).
 * @param {ColumnInfo} column
 * @param {SqlValue} value
 * @returns {CellObject | null}
 */
export function cellObject(column, value) {
  if (value === null || value === undefined || value instanceof Uint8Array) return null;
  switch (column.type) {
    case 'integer':
    case 'real': {
      const n = typeof value === 'number' ? value : Number(value);
      return Number.isFinite(n) ? { t: 'n', v: n } : { t: 's', v: String(value) };
    }
    case 'boolean':
      return { t: 'b', v: Number(value) === 1 };
    case 'date':
    case 'datetime': {
      const d = typeof value === 'string' ? localDate(value) : null;
      if (!d) return { t: 's', v: String(value) };
      return { t: 'd', v: d, z: column.type === 'date' ? 'yyyy-mm-dd' : 'yyyy-mm-dd hh:mm:ss' };
    }
    default:
      return { t: 's', v: typeof value === 'string' ? value : String(value) };
  }
}

/**
 * 통합 문서 하나를 만들어 싱크에 한 번 쓴다.
 * @param {Engine} engine
 * @param {TableInfo} table
 * @param {ViewSpec} viewSpec
 * @param {ByteSink} sink
 * @param {ExportContext} [ctx]
 * @returns {Promise<ExportResult>}
 */
export async function exportXlsx(engine, table, viewSpec, sink, ctx = {}) {
  const columns = exportColumns(table, viewSpec);
  const total = countRows(engine, table, viewSpec);
  if (total > XLSX_MAX_ROWS) {
    throw new AppError(
      'E_FILE_TOO_LARGE',
      `xlsx export of ${total} rows exceeds ${XLSX_MAX_ROWS}`,
      {
        detail: { format: 'xlsx', rows: total, limit: XLSX_MAX_ROWS },
      },
    );
  }
  /** @type {ExportResult} */
  const result = { rows: 0, bytes: 0, blobCells: 0 };
  // dense 시트의 빈 셀은 `undefined`여야 한다(SheetJS 쓰기는 `null` 항목을 셀로 보고 읽다가 실패한다).
  /** @type {(CellObject | undefined)[][]} */
  const data = [columns.map((c) => /** @type {CellObject} */ ({ t: 's', v: c.name }))];
  ctx.progress?.({ phase: 'export', done: 0, total });
  for await (const page of readPages(engine, table, viewSpec, columns, {
    pageSize: PAGE_ROWS,
    signal: ctx.signal,
  })) {
    for (const row of page) {
      /** @type {(CellObject | undefined)[]} */
      const cells = new Array(columns.length);
      for (let c = 0; c < columns.length; c += 1) {
        const value = row[c] ?? null;
        if (value instanceof Uint8Array) result.blobCells += 1;
        cells[c] = cellObject(/** @type {ColumnInfo} */ (columns[c]), value) ?? undefined;
      }
      data.push(cells);
    }
    result.rows += page.length;
    ctx.progress?.({ phase: 'export', done: result.rows, total });
  }
  if (ctx.signal?.aborted) {
    throw new AppError('E_IMPORT_CANCELLED', 'export cancelled', {
      detail: { done: result.rows, total },
    });
  }
  // dense 시트: 행 배열의 셀 객체를 그대로 쓴다(aoa_to_sheet는 값에서 셀을 다시 만들어 서식을 잃는다).
  // SheetJS 0.20의 dense 시트는 행 배열을 `!data`에 둔다. 배열 자체를 시트로 넘기면(0.18 형식) 쓰기가
  // sparse 시트로 보고 `A1` 같은 키만 찾아 빈 시트가 된다.
  /** @type {WorkSheet} */
  const ws = { '!data': /** @type {CellObject[][]} */ (data) };
  ws['!ref'] = XLSX.utils.encode_range({
    s: { r: 0, c: 0 },
    e: { r: data.length - 1, c: Math.max(0, columns.length - 1) },
  });
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, sheetName(table.name));
  const written = /** @type {ArrayBuffer} */ (
    XLSX.write(wb, { type: 'array', bookType: 'xlsx', cellDates: true })
  );
  // `type: 'array'`의 ArrayBuffer는 그 자리에서 만들어져 뒤에 쓰는 데가 없으므로 복사 없이 감싸 transfer한다.
  const bytes = new Uint8Array(written);
  result.bytes = bytes.byteLength;
  await sink.write(bytes);
  ctx.progress?.({ phase: 'export', done: result.rows, total: total || result.rows });
  return result;
}
