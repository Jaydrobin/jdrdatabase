// @ts-check
/**
 * 셀·범위·행 선택 모델(Step 5). DOM이 없는 순수 상태이며 그리드가 렌더 때 `contains()`로 읽는다.
 *
 * - 활성 셀(커서)은 항상 하나다. 범위는 앵커(선택을 시작한 셀)와 활성 셀이 만드는 직사각형이다.
 * - 행 선택은 범위가 모든 열을 덮는 것과 같고, `isRowSelection()`으로 구분한다(행 삭제 등에 쓴다).
 * - 좌표는 그리드의 행 인덱스·보이는 열 인덱스다. 행 수·열 수가 바뀌면 `clamp()`로 안에 맞춘다.
 */

/** @typedef {{ row: number, col: number }} CellPos */

/**
 * 양 끝을 포함하는 직사각형 범위.
 * @typedef {object} CellRange
 * @property {number} r0 첫 행
 * @property {number} r1 마지막 행(포함)
 * @property {number} c0 첫 열
 * @property {number} c1 마지막 열(포함)
 */

/**
 * @typedef {object} Selection
 * @property {(row: number, col: number) => void} setActive 활성 셀과 앵커를 옮기고 범위를 그 셀 하나로 줄인다
 * @property {(row: number, col: number) => void} extendTo 앵커는 두고 활성 셀을 옮겨 범위를 넓힌다(Shift+화살표·드래그)
 * @property {(from: number, to: number) => void} selectRows `from`부터 `to`까지의 행 전체(모든 열). 활성 셀은 `to`행의 첫 열
 * @property {() => void} selectAll 모든 행·열
 * @property {() => CellPos} getActive
 * @property {() => CellRange} getRange 항상 활성 셀을 포함하는 정규화된 범위
 * @property {() => boolean} isRowSelection 범위가 모든 열을 덮는가
 * @property {(row: number, col: number) => boolean} contains
 * @property {() => boolean} isSingle 범위가 셀 하나인가
 * @property {(rowCount: number, colCount: number) => void} setBounds 행·열 수를 알리고 선택을 안에 맞춘다
 * @property {() => void} reset 첫 셀 하나로 되돌린다
 */

/**
 * @param {number} n
 * @param {number} lo
 * @param {number} hi
 */
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * @returns {Selection}
 */
export function createSelection() {
  let rowCount = 0;
  let colCount = 0;
  /** @type {CellPos} */
  const active = { row: 0, col: 0 };
  /** @type {CellPos} */
  const anchor = { row: 0, col: 0 };
  let allColumns = false;

  /** @returns {number} */
  const maxRow = () => Math.max(0, rowCount - 1);
  /** @returns {number} */
  const maxCol = () => Math.max(0, colCount - 1);

  /**
   * @param {CellPos} pos
   * @param {number} row
   * @param {number} col
   */
  function place(pos, row, col) {
    pos.row = clamp(Math.trunc(row), 0, maxRow());
    pos.col = clamp(Math.trunc(col), 0, maxCol());
  }

  /** @type {Selection} */
  const selection = {
    setActive(row, col) {
      place(active, row, col);
      anchor.row = active.row;
      anchor.col = active.col;
      allColumns = false;
    },
    extendTo(row, col) {
      place(active, row, col);
      allColumns = false;
    },
    selectRows(from, to) {
      place(anchor, from, 0);
      place(active, to, 0);
      allColumns = true;
    },
    selectAll() {
      place(anchor, 0, 0);
      place(active, maxRow(), 0);
      allColumns = true;
    },
    getActive: () => ({ row: active.row, col: active.col }),
    getRange() {
      return {
        r0: Math.min(anchor.row, active.row),
        r1: Math.max(anchor.row, active.row),
        c0: allColumns ? 0 : Math.min(anchor.col, active.col),
        c1: allColumns ? maxCol() : Math.max(anchor.col, active.col),
      };
    },
    isRowSelection() {
      if (colCount === 0) return false;
      const range = selection.getRange();
      return range.c0 === 0 && range.c1 === maxCol();
    },
    contains(row, col) {
      const range = selection.getRange();
      return row >= range.r0 && row <= range.r1 && col >= range.c0 && col <= range.c1;
    },
    isSingle() {
      const range = selection.getRange();
      return range.r0 === range.r1 && range.c0 === range.c1;
    },
    setBounds(rows, cols) {
      rowCount = Math.max(0, Math.trunc(rows));
      colCount = Math.max(0, Math.trunc(cols));
      place(active, active.row, active.col);
      place(anchor, anchor.row, anchor.col);
    },
    reset() {
      active.row = 0;
      active.col = 0;
      anchor.row = 0;
      anchor.col = 0;
      allColumns = false;
    },
  };
  return selection;
}
