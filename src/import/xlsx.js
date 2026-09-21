// @ts-check
/**
 * XLSX 어댑터(Step 8, D-09): SheetJS CE로 통합 문서를 읽어 CSV와 같은 행 이터레이터를 만든다. Worker에서 실행된다.
 *
 * - `readWorkbook(bytes, opts)`: SheetJS 예외를 `E_XLSX_ENCRYPTED` / `E_XLSX_CORRUPT`로 바꾸는 유일한 자리.
 *   `XLSX_MAX_FILE_BYTES`(100 MB)를 넘으면 `E_FILE_TOO_LARGE`(`detail.format = 'xlsx'`).
 * - `listSheets(bytes)`: 시트마다 첫 행까지만 파싱하고 `!fullref`에서 행·열 수를 읽는다.
 * - `openXlsx(file, options)`: 고른 시트를 dense 모드로 읽어 셀을 `n/s/b/d/e`에서 논리값으로 바꾼다. 날짜는
 *   SheetJS가 준 Date의 로컬 시각 부품으로 `YYYY-MM-DD`(00:00:00) 또는 `YYYY-MM-DDTHH:mm:ss` 문자열을 만들어
 *   추론(`infer`)과 검증(`values.validate`)이 CSV와 같은 규칙을 타게 한다.
 * - SheetJS 객체(`XLSX`)를 만지는 코드는 이 파일과 픽스처 생성기뿐이다(R3: 어댑터 경계).
 * - `vendor/xlsx.full.min.js`는 UMD(CommonJS)라 기본 가져오기(`module.exports`)로 받는다. Node는 `vendor/package.json`의
 *   `"type": "commonjs"`로, esbuild는 구문으로 CommonJS임을 안다.
 */
import XLSX from '../../vendor/xlsx.full.min.js';
import { MB } from '../util/bytes.js';
import { AppError } from '../util/errors.js';

/** @typedef {import('./infer.js').SourceValue} SourceValue */
/** @typedef {import('./infer.js').Row} Row */
/** @typedef {import('./pipeline.js').ImportOptions} ImportOptions */
/** @typedef {import('./pipeline.js').Source} Source */
/** @typedef {import('./pipeline.js').SheetInfo} SheetInfo */
/** @typedef {import('./pipeline.js').ImportWarning} ImportWarning */
/** @typedef {import('../../vendor/xlsx.full.min.js').WorkBook} WorkBook */
/** @typedef {import('../../vendor/xlsx.full.min.js').WorkSheet} WorkSheet */
/** @typedef {import('../../vendor/xlsx.full.min.js').CellObject} CellObject */
/** @typedef {import('../../vendor/xlsx.full.min.js').ParsingOptions} ParsingOptions */

/** 파일 크기 상한(Step 8 예외 처리). 통째로 메모리에 올려야 하므로 CSV보다 낮다. */
export const XLSX_MAX_FILE_BYTES = 100 * MB;

/**
 * @param {number} n
 * @param {number} width
 */
function pad(n, width) {
  return String(n).padStart(width, '0');
}

/**
 * SheetJS의 Date(로컬 시각으로 만들어진다)를 앱의 날짜 문자열로 바꾼다. 시각이 00:00:00이면 날짜만.
 * @param {Date} d
 * @returns {string | null}
 */
export function dateString(d) {
  if (Number.isNaN(d.getTime())) return null;
  const date = `${pad(d.getFullYear(), 4)}-${pad(d.getMonth() + 1, 2)}-${pad(d.getDate(), 2)}`;
  const h = d.getHours();
  const m = d.getMinutes();
  const s = d.getSeconds();
  if (h === 0 && m === 0 && s === 0) return date;
  return `${date}T${pad(h, 2)}:${pad(m, 2)}:${pad(s, 2)}`;
}

/**
 * 셀 하나를 논리값으로 바꾼다. 수식 셀은 계산값(`v`)만 쓴다. 오류 셀(`e`)과 빈 셀(`z`)은 null.
 * @param {CellObject | undefined} cell
 * @returns {SourceValue}
 */
export function cellValue(cell) {
  if (!cell) return null;
  switch (cell.t) {
    case 'n':
      return typeof cell.v === 'number' && Number.isFinite(cell.v) ? cell.v : null;
    case 's':
      return cell.v === undefined || cell.v === null ? null : String(cell.v);
    case 'b':
      return Boolean(cell.v);
    case 'd':
      return cell.v instanceof Date ? dateString(cell.v) : null;
    case 'e':
    case 'z':
      return null;
    default:
      return cell.v === undefined || cell.v === null ? null : String(cell.v);
  }
}

/**
 * SheetJS로 통합 문서를 읽는다. 크기 상한과 오류 코드 변환은 여기서만 한다.
 * @param {Uint8Array} bytes
 * @param {ParsingOptions} [opts]
 * @returns {WorkBook}
 */
export function readWorkbook(bytes, opts = {}) {
  if (bytes.byteLength > XLSX_MAX_FILE_BYTES) {
    throw new AppError(
      'E_FILE_TOO_LARGE',
      `xlsx is ${bytes.byteLength} bytes, limit ${XLSX_MAX_FILE_BYTES}`,
      { detail: { format: 'xlsx', bytes: bytes.byteLength, limit: XLSX_MAX_FILE_BYTES } },
    );
  }
  try {
    return XLSX.read(bytes, { type: 'array', dense: true, cellDates: true, ...opts });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/password/i.test(message)) {
      throw new AppError('E_XLSX_ENCRYPTED', 'workbook is password-protected', {
        cause: err,
        detail: { message: message.slice(0, 200) },
      });
    }
    throw new AppError('E_XLSX_CORRUPT', 'workbook could not be parsed', {
      cause: err,
      detail: { message: message.slice(0, 200) },
    });
  }
}

/**
 * 시트 목록과 크기. 시트마다 첫 행까지만 파싱하고(`sheetRows: 1`) 잘리지 않은 범위(`!fullref`)를 읽는다.
 * @param {Uint8Array} bytes
 * @returns {SheetInfo[]}
 */
export function listSheets(bytes) {
  const wb = readWorkbook(bytes, { sheetRows: 1 });
  return wb.SheetNames.map((name) => {
    const ws = wb.Sheets[name];
    const ref = ws ? (ws['!fullref'] ?? ws['!ref']) : undefined;
    if (typeof ref !== 'string' || !ref) return { name, rows: 0, cols: 0 };
    const range = XLSX.utils.decode_range(ref);
    return { name, rows: range.e.r - range.s.r + 1, cols: range.e.c - range.s.c + 1 };
  });
}

/**
 * dense 모드 시트의 행 배열. SheetJS 0.18은 시트 객체 자체가 행 배열(`!ref` 등은 속성)이고, 0.20부터는
 * `!data`에 둔다. 둘 다 받아 vendor 갱신(R3)에 어댑터만 바뀌게 한다. 없으면 빈 시트다.
 * @param {WorkSheet} ws
 * @returns {(CellObject[] | undefined)[]}
 */
function denseRows(ws) {
  if (Array.isArray(ws)) return /** @type {(CellObject[] | undefined)[]} */ (ws);
  const data = /** @type {unknown} */ (ws['!data']);
  return Array.isArray(data) ? /** @type {(CellObject[] | undefined)[]} */ (data) : [];
}

/**
 * 파일을 열어 CSV와 같은 형태의 원본을 만든다(`pipeline.openSource`가 부른다).
 * `headerRow`는 1부터이며 0이면 헤더가 없다. 헤더보다 앞의 행은 건너뛴다.
 * @param {Blob} file
 * @param {ImportOptions} options
 * @returns {Promise<Source>}
 */
export async function openXlsx(file, options) {
  if (file.size > XLSX_MAX_FILE_BYTES) {
    throw new AppError(
      'E_FILE_TOO_LARGE',
      `xlsx is ${file.size} bytes, limit ${XLSX_MAX_FILE_BYTES}`,
      {
        detail: { format: 'xlsx', bytes: file.size, limit: XLSX_MAX_FILE_BYTES },
      },
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const sheets = listSheets(bytes);
  const sheetName =
    options.sheet !== undefined && sheets.some((s) => s.name === options.sheet)
      ? options.sheet
      : (sheets[0]?.name ?? null);
  const headerRow = options.headerRow ?? 1;
  /** @type {ImportWarning[]} */
  const warnings = [];
  /** @type {(CellObject[] | undefined)[]} */
  let data = [];
  if (sheetName !== null) {
    const wb = readWorkbook(bytes, { sheets: [sheetName] });
    const ws = wb.Sheets[sheetName];
    if (ws) {
      data = denseRows(ws);
      const merges = ws['!merges'];
      if (Array.isArray(merges) && merges.length > 0) {
        warnings.push({ kind: 'merged', count: merges.length });
      }
    }
  }
  let errorCells = 0;
  for (const row of data) {
    if (!row) continue;
    for (let i = 0; i < row.length; i += 1) if (row[i]?.t === 'e') errorCells += 1;
  }
  if (errorCells > 0) warnings.push({ kind: 'error_cells', count: errorCells });

  const start = headerRow > 0 ? headerRow : 0;
  /** @param {CellObject[] | undefined} row */
  const toCells = (row) => {
    /** @type {SourceValue[]} */
    const cells = [];
    /** @type {number[]} */
    const errors = [];
    if (row) {
      for (let i = 0; i < row.length; i += 1) {
        const cell = row[i];
        if (cell?.t === 'e') errors.push(i);
        cells.push(cellValue(cell));
      }
    }
    return { cells, errors };
  };
  const header = headerRow > 0 ? toCells(data[headerRow - 1]).cells : null;

  /** @returns {AsyncGenerator<Row, void, undefined>} */
  async function* rows() {
    for (let i = start; i < data.length; i += 1) {
      const { cells, errors } = toCells(data[i]);
      /** @type {Row} */
      const row = { rowIndex: i + 1, cells };
      if (errors.length > 0) row.errorCells = errors;
      yield row;
    }
  }

  return {
    header,
    rows: rows(),
    total: Math.max(0, data.length - start),
    resolved: {
      format: 'xlsx',
      encoding: 'utf-8',
      delimiter: ',',
      hasHeader: headerRow > 0,
      sheet: sheetName,
      headerRow,
    },
    warnings,
    sheets,
  };
}
