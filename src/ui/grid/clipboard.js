// @ts-check
/**
 * TSV 복사·붙여넣기(Step 5). 이 파일은 순수 함수만 둔다. 클립보드 API와 커맨드 적용은
 * `editing.js`가 맡는다.
 *
 * - 직렬화: 탭·줄바꿈·따옴표가 든 셀은 스프레드시트 규칙대로 `"..."`로 감싸고 안의 따옴표는 두 번 쓴다.
 * - 파싱: 따옴표 안의 탭·줄바꿈을 셀의 일부로 읽고, CRLF·LF를 모두 행 구분으로 본다. 끝의 빈 줄 하나는 버린다.
 * - 계획: 앵커와 그리드 크기로 붙여넣기가 덮을 기존 행·새로 만들 행·버릴 열을 센다(Step 5 예외 처리).
 */
import { PASTE_MAX_CELLS } from '../../app/commands.js';
import { toDisplay, validate } from '../../db/values.js';
import { AppError } from '../../util/errors.js';

/** @typedef {import('../../db/tables.js').ColumnInfo} ColumnInfo */
/** @typedef {import('../../db/engine.js').SqlValue} SqlValue */
/** @typedef {import('../../db/values.js').StoredValue} StoredValue */

/**
 * @param {string} cell
 * @returns {string}
 */
function quoteCell(cell) {
  if (!/[\t\n\r"]/.test(cell)) return cell;
  return `"${cell.replace(/"/g, '""')}"`;
}

/**
 * 2차원 문자열 배열 → TSV. 행은 LF로 잇는다.
 * @param {string[][]} rows
 * @returns {string}
 */
export function serializeTsv(rows) {
  return rows.map((row) => row.map(quoteCell).join('\t')).join('\n');
}

/**
 * TSV → 2차원 문자열 배열. 따옴표 필드 안의 탭·줄바꿈을 지킨다.
 * @param {string} text
 * @returns {string[][]}
 */
export function parseTsv(text) {
  /** @type {string[][]} */
  const rows = [];
  /** @type {string[]} */
  let row = [];
  let cell = '';
  let quoted = false;
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
          continue;
        }
        quoted = false;
        i += 1;
        continue;
      }
      cell += ch;
      i += 1;
      continue;
    }
    if (ch === '"' && cell === '') {
      quoted = true;
      i += 1;
      continue;
    }
    if (ch === '\t') {
      row.push(cell);
      cell = '';
      i += 1;
      continue;
    }
    if (ch === '\r' || ch === '\n') {
      row.push(cell);
      rows.push(row);
      row = [];
      cell = '';
      i += ch === '\r' && text[i + 1] === '\n' ? 2 : 1;
      continue;
    }
    cell += ch;
    i += 1;
  }
  if (cell !== '' || row.length > 0) {
    row.push(cell);
    rows.push(row);
  }
  return rows;
}

/**
 * 편집기의 초기값과 복사할 때 셀 값을 문자열로 바꾼다. NULL은 빈 문자열, boolean은 true/false.
 *
 * 그리드 표시(`cells.render`)와 달리 `real`의 `decimals`는 적용하지 않는다. `decimals`는 몇 자리까지
 * 보일지를 정하는 표시 설정인데, 여기서 쓴 문자열은 `validate`를 거쳐 그대로 저장값이 되므로
 * 적용하면 셀을 열었다 확정하거나 복사해 붙여넣는 것만으로 값이 깎인다(3.14159 → 3.14).
 * `select`의 `choices`처럼 값 자체를 정하는 옵션은 그대로 넘긴다.
 * @param {ColumnInfo} column
 * @param {SqlValue} value
 * @returns {string}
 */
export function cellToText(column, value) {
  if (value === null || value === undefined) return '';
  if (value instanceof Uint8Array) return '';
  const options = column.type === 'real' ? undefined : (column.options ?? undefined);
  return toDisplay(column.type, typeof value === 'bigint' ? String(value) : value, options);
}

/**
 * 붙여넣기 계획(순수). 값 검증은 하지 않고 크기만 센다.
 * @typedef {object} PastePlan
 * @property {number} rows 붙여넣을 행 수
 * @property {number} cols 실제로 쓰는 열 수(그리드 끝에서 잘린 뒤)
 * @property {number} droppedColumns 그리드 오른쪽 경계를 넘어 버리는 열 수
 * @property {number} existingRows 기존 행에 덮어쓰는 수
 * @property {number} newRows 새로 만드는 행 수
 * @property {number} cells `rows × cols`(잘린 뒤)
 */

/**
 * @param {{ data: string[][], anchor: { row: number, col: number }, rowCount: number, colCount: number }} input
 * @returns {PastePlan}
 */
export function planPaste(input) {
  const rows = input.data.length;
  const width = input.data.reduce((max, r) => Math.max(max, r.length), 0);
  const available = Math.max(0, input.colCount - input.anchor.col);
  const cols = Math.min(width, available);
  const totalCells = rows * width;
  if (totalCells > PASTE_MAX_CELLS) {
    throw new AppError('E_PASTE_TOO_LARGE', `${totalCells} cells exceeds ${PASTE_MAX_CELLS}`, {
      detail: { cells: totalCells, limit: PASTE_MAX_CELLS },
    });
  }
  const existingRows = Math.max(0, Math.min(rows, input.rowCount - input.anchor.row));
  return {
    rows,
    cols,
    droppedColumns: Math.max(0, width - available),
    existingRows,
    newRows: rows - existingRows,
    cells: rows * cols,
  };
}

/**
 * 붙여넣을 문자열을 열 타입에 맞는 저장값으로 바꾼다. 실패하면 위치를 담아 `E_VALUE_INVALID`.
 * @param {ColumnInfo} column
 * @param {string} text
 * @param {{ row: number, col: number }} at 오류 detail에 넣을 위치(붙여넣기 데이터 기준 0부터)
 * @returns {StoredValue}
 */
export function convertPastedCell(column, text, at) {
  const result = validate(column.type, text, column.options ?? undefined);
  if (result.ok) return result.value;
  throw new AppError('E_VALUE_INVALID', `cannot paste "${text.slice(0, 80)}" into ${column.type}`, {
    detail: {
      reason: result.reason,
      row: at.row,
      col: at.col,
      columnId: column.id,
      columnName: column.name,
    },
  });
}
