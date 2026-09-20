// @ts-check
/**
 * 가상 그리드 컨트롤러(Step 4, D-05·D-06): 뷰포트 계산, 행·열 풀, 스크롤, 열 너비 조절, 열 고정, 행 번호.
 *
 * - 행 높이는 고정(32 px)이고 행 수 × 행 높이가 1,000만 px를 넘으면 스크롤 스케일링을 적용한다.
 * - 화면에 보이는 행·열만 DOM에 두고(행·열 가상화), 요소는 풀에서 재사용한다.
 * - 데이터는 200행 블록 캐시(`cache.js`)에서 읽고 없는 블록만 `query.window`로 요청한다.
 * - 렌더 경로는 레이아웃 측정을 한 번(뷰포트 크기·스크롤 위치)만 하고, 인라인 스타일은 위치 계산
 *   (`transform`, `width`, `height`)에만 쓴다(CLAUDE.md 5.5).
 * - 사용자 데이터는 `cells.render`가 textContent로만 넣는다.
 */
import { MIN_COLUMN_WIDTH } from '../../app/store.js';
import { visibleColumns } from '../../db/query.js';
import { t } from '../../i18n/index.js';
import { toAppError } from '../../util/errors.js';
import { formatInteger } from '../../util/format.js';
import { BLOCK_ROWS, createBlockCache } from './cache.js';
import { render as renderCell } from './cells.js';

/** @typedef {import('../../app/store.js').Store} Store */
/** @typedef {import('../../app/store.js').TableViewState} TableViewState */
/** @typedef {import('../../db/client.js').Client} Client */
/** @typedef {import('../../db/query.js').ViewSpec} ViewSpec */
/** @typedef {import('../../db/query.js').WindowRow} WindowRow */
/** @typedef {import('../../db/tables.js').TableInfo} TableInfo */
/** @typedef {import('../../db/tables.js').ColumnInfo} ColumnInfo */
/** @typedef {import('../toast.js').Toasts} Toasts */

/** 행 높이(px, D-05). */
export const ROW_HEIGHT = 32;
/** 머리글 높이(px). */
export const HEADER_HEIGHT = 32;
/** 행 번호 열 너비(px). */
export const ROW_NUMBER_WIDTH = 64;
/** 가시 범위 앞뒤로 더 그리는 행 수. */
export const BUFFER_ROWS = 10;
/** 캔버스 높이 상한(px). 넘으면 스크롤 스케일링(D-05, Step 4 예외 처리). */
export const MAX_CANVAS_HEIGHT = 10_000_000;
/** 고정할 수 있는 열 수 상한(UI 선택지). */
export const MAX_FROZEN_COLUMNS = 5;
/** 테스트 빌드가 렌더 시간을 기록하는 `performance.measure` 이름(8장). */
export const RENDER_MEASURE = 'jdr:grid.render';
const RENDER_MARK = 'jdr:grid.render:start';

/**
 * @typedef {object} RowLayout
 * @property {number} rowCount
 * @property {number} rowHeight
 */

/**
 * @typedef {object} RowRange
 * @property {number} start 그릴 첫 행(버퍼 포함)
 * @property {number} end 그릴 마지막 행 + 1(버퍼 포함)
 * @property {number} first 뷰포트 맨 위에 걸린 행
 * @property {number} offsetY `first` 행의 캔버스 y 좌표(px)
 */

/**
 * 캔버스(스크롤 영역) 높이. 상한을 넘으면 상한에서 잘리고 스크롤 위치를 환산한다.
 * @param {RowLayout} layout
 * @returns {number}
 */
export function canvasHeightFor(layout) {
  return Math.min(layout.rowCount * layout.rowHeight, MAX_CANVAS_HEIGHT);
}

/**
 * @param {number} n
 * @param {number} lo
 * @param {number} hi
 */
function clamp(n, lo, hi) {
  return Math.min(hi, Math.max(lo, n));
}

/**
 * 스크롤 위치 → 실제 내용 좌표(px). 스케일링이 없으면 같은 값이다.
 * @param {number} scrollTop
 * @param {number} viewportHeight
 * @param {RowLayout} layout
 * @returns {number}
 */
export function scrollToContent(scrollTop, viewportHeight, layout) {
  const content = layout.rowCount * layout.rowHeight;
  const canvas = canvasHeightFor(layout);
  const maxScroll = Math.max(0, canvas - viewportHeight);
  const maxContent = Math.max(0, content - viewportHeight);
  const top = clamp(scrollTop, 0, maxScroll);
  if (content <= canvas || maxScroll === 0) return Math.min(top, maxContent);
  return (top / maxScroll) * maxContent;
}

/**
 * 실제 내용 좌표(px) → 스크롤 위치. `scrollToContent`의 역함수.
 * @param {number} contentTop
 * @param {number} viewportHeight
 * @param {RowLayout} layout
 * @returns {number}
 */
export function contentToScroll(contentTop, viewportHeight, layout) {
  const content = layout.rowCount * layout.rowHeight;
  const canvas = canvasHeightFor(layout);
  const maxScroll = Math.max(0, canvas - viewportHeight);
  const maxContent = Math.max(0, content - viewportHeight);
  const top = clamp(contentTop, 0, maxContent);
  if (content <= canvas || maxContent === 0) return Math.min(top, maxScroll);
  return (top / maxContent) * maxScroll;
}

/**
 * 스크롤 위치와 뷰포트 높이로 그릴 행 범위를 계산한다(O(1), D-05).
 * @param {number} scrollTop
 * @param {number} viewportHeight
 * @param {RowLayout & { buffer?: number }} layout
 * @returns {RowRange}
 */
export function computeRange(scrollTop, viewportHeight, layout) {
  const { rowCount, rowHeight } = layout;
  const buffer = layout.buffer ?? BUFFER_ROWS;
  if (rowCount <= 0 || rowHeight <= 0) return { start: 0, end: 0, first: 0, offsetY: 0 };
  const canvas = canvasHeightFor(layout);
  const top = clamp(scrollTop, 0, Math.max(0, canvas - viewportHeight));
  const contentTop = scrollToContent(top, viewportHeight, layout);
  const first = Math.min(rowCount - 1, Math.floor(contentTop / rowHeight));
  const offsetY = top - (contentTop - first * rowHeight);
  const visible = Math.ceil(Math.max(0, viewportHeight) / rowHeight) + 1;
  return {
    start: Math.max(0, first - buffer),
    end: Math.min(rowCount, first + visible + buffer),
    first,
    offsetY,
  };
}

/**
 * 열 배치: 각 열의 왼쪽 위치(행 번호 열 뒤부터)와 전체 너비.
 * @param {number[]} widths
 * @returns {{ lefts: number[], total: number }}
 */
export function layoutColumns(widths) {
  /** @type {number[]} */
  const lefts = new Array(widths.length);
  let x = ROW_NUMBER_WIDTH;
  for (let i = 0; i < widths.length; i += 1) {
    lefts[i] = x;
    x += widths[i] ?? 0;
  }
  return { lefts, total: x };
}

/**
 * 가로 스크롤 위치에서 그릴 (고정되지 않은) 열 범위. 고정 열(`0..frozen-1`)은 항상 그린다.
 * @param {number} scrollLeft
 * @param {number} viewportWidth
 * @param {{ lefts: number[], widths: number[], frozen: number }} columns
 * @returns {{ start: number, end: number }} `frozen` 이상의 열 인덱스 범위(end 제외)
 */
export function computeColumnRange(scrollLeft, viewportWidth, columns) {
  const { lefts, widths } = columns;
  const frozen = Math.min(columns.frozen, lefts.length);
  const n = lefts.length;
  let start = frozen;
  while (start < n && (lefts[start] ?? 0) + (widths[start] ?? 0) <= scrollLeft) start += 1;
  let end = start;
  while (end < n && (lefts[end] ?? 0) < scrollLeft + viewportWidth) end += 1;
  return { start, end };
}

/**
 * @typedef {object} GridStats
 * @property {number} renders 렌더 횟수
 * @property {number} lastRenderMs 마지막 렌더 시간(테스트 빌드에서만 측정)
 * @property {number} queries 창 질의 횟수
 * @property {number} maxQueryMs Worker가 보고한 창 질의 시간의 최댓값
 * @property {number} lastQueryMs
 * @property {number} rowCount
 * @property {number} domRows 지금 DOM에 있는 행 요소 수
 */

/**
 * @typedef {object} Grid
 * @property {HTMLElement} el
 * @property {(container: HTMLElement, options: { table: TableInfo, viewSpec: ViewSpec, view: TableViewState }) => void} mount 컨테이너에 붙이고 테이블을 연다. 이미 붙어 있으면 테이블만 바꾼다
 * @property {(view: TableViewState) => void} applyView 열 너비·고정 열 갱신
 * @property {(n: number) => void} setRowCount
 * @property {(scrollTop: number, viewportHeight: number) => RowRange} computeRange
 * @property {(range?: RowRange) => void} render
 * @property {() => void} invalidate 블록 캐시를 버리고 행 수를 다시 세어 다시 그린다
 * @property {(row: number) => void} scrollToRow
 * @property {(row: number, col: number) => void} scrollToCell
 * @property {() => GridStats} stats
 * @property {() => void} unmount
 */

/**
 * @typedef {object} GridDeps
 * @property {Client} client
 * @property {Store} store
 * @property {(err: import('../../util/errors.js').AppError) => void} onError 창 질의 실패. 호출자가 빈 상태·사이드바 복귀를 맡는다
 */

/**
 * @typedef {object} RowSlot
 * @property {HTMLElement} el
 * @property {number} rowIndex
 * @property {HTMLElement[]} cells `cells[0]`은 행 번호 칸
 * @property {number[]} cellCols 칸이 맡은 열 인덱스(행 번호 칸은 -1)
 * @property {number[]} cellLefts 마지막으로 쓴 translateX
 * @property {number[]} cellWidths 마지막으로 쓴 width
 * @property {number[]} cellVersions 마지막으로 내용을 그린 데이터 세대
 * @property {boolean[]} cellFrozen 마지막으로 쓴 고정 여부
 * @property {number} y 마지막으로 쓴 translateY
 */

/**
 * @param {string} className
 * @param {string} [role]
 * @returns {HTMLDivElement}
 */
function div(className, role) {
  const el = document.createElement('div');
  el.className = className;
  if (role) el.setAttribute('role', role);
  return el;
}

/**
 * @param {GridDeps} deps
 * @returns {Grid}
 */
export function createGrid(deps) {
  const { client, store, onError } = deps;
  const cache = createBlockCache();

  const el = div('jdr-grid', 'grid');
  el.tabIndex = 0;
  el.setAttribute('aria-label', t('grid.label'));

  const bar = div('jdr-grid__bar');
  const rowCountLabel = document.createElement('span');
  rowCountLabel.className = 'jdr-grid__rowcount';
  const frozenLabel = document.createElement('label');
  frozenLabel.className = 'jdr-grid__frozen';
  const frozenText = document.createElement('span');
  frozenText.textContent = t('grid.frozenLabel');
  const frozenSelect = document.createElement('select');
  frozenSelect.className = 'jdr-grid__frozen-select';
  frozenLabel.append(frozenText, frozenSelect);
  bar.append(rowCountLabel, frozenLabel);

  const scroller = div('jdr-grid__scroller');
  const header = div('jdr-grid__header', 'row');
  header.setAttribute('aria-rowindex', '1');
  const canvas = div('jdr-grid__canvas', 'rowgroup');
  scroller.append(header, canvas);
  el.append(bar, scroller);

  /** @type {TableInfo | null} */
  let table = null;
  /** @type {ViewSpec} */
  let viewSpec = {};
  /** @type {ColumnInfo[]} */
  let columns = [];
  /** @type {number[]} */
  let widths = [];
  /** @type {number[]} */
  let lefts = [];
  let totalWidth = ROW_NUMBER_WIDTH;
  let frozen = 0;
  let rowCount = 0;
  /** 테이블 전환·무효화마다 오르는 세대. 이전 세대의 응답은 버린다(Step 4 예외 처리). */
  let generation = 0;
  let seq = 0;
  /** @type {Set<number>} */
  const inflight = new Set();
  /** @type {Map<number, RowSlot>} */
  const active = new Map();
  /** @type {RowSlot[]} */
  const pool = [];
  /** @type {HTMLElement[]} */
  const headerCells = [];
  /** @type {{ row: number, col: number }} */
  const cursor = { row: 0, col: 0 };
  /** @type {HTMLElement | null} */
  let cursorEl = null;
  let viewportWidth = 0;
  let viewportHeight = 0;
  let rafId = 0;
  let mounted = false;
  /** @type {GridStats} */
  const stats = {
    renders: 0,
    lastRenderMs: 0,
    queries: 0,
    maxQueryMs: 0,
    lastQueryMs: 0,
    rowCount: 0,
    domRows: 0,
  };

  /** @returns {RowLayout} */
  const layout = () => ({ rowCount, rowHeight: ROW_HEIGHT });

  function scheduleRender() {
    if (rafId !== 0 || !mounted) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      render();
    });
  }

  /**
   * @param {HTMLElement} target
   * @param {number} x
   * @param {number} y
   */
  function setTransform(target, x, y) {
    target.style.transform = `translate(${x}px, ${y}px)`;
  }

  // ---- 열 배치 ----

  /** @param {TableViewState} view */
  function applyColumnLayout(view) {
    widths = columns.map((c) => Math.max(MIN_COLUMN_WIDTH, view.widths[c.id] ?? c.width));
    frozen = Math.min(view.frozenColumns, columns.length, MAX_FROZEN_COLUMNS);
    const laid = layoutColumns(widths);
    lefts = laid.lefts;
    totalWidth = laid.total;
    header.style.width = `${totalWidth}px`;
    canvas.style.width = `${totalWidth}px`;
    renderFrozenSelect();
  }

  function renderFrozenSelect() {
    const max = Math.min(columns.length, MAX_FROZEN_COLUMNS);
    frozenSelect.textContent = '';
    for (let i = 0; i <= max; i += 1) {
      const option = document.createElement('option');
      option.value = String(i);
      option.textContent = i === 0 ? t('grid.frozenNone') : t('grid.frozenCount', { count: i });
      option.selected = i === frozen;
      frozenSelect.append(option);
    }
    frozenSelect.disabled = max === 0;
  }

  function buildHeader() {
    for (const cell of headerCells) cell.remove();
    headerCells.length = 0;
    const rowNumber = div('jdr-grid__hcell jdr-grid__hcell--rownum', 'columnheader');
    rowNumber.textContent = t('grid.rowNumber');
    rowNumber.style.width = `${ROW_NUMBER_WIDTH}px`;
    header.append(rowNumber);
    headerCells.push(rowNumber);
    columns.forEach((column, index) => {
      const cell = div('jdr-grid__hcell', 'columnheader');
      cell.dataset.col = String(index);
      cell.setAttribute('aria-colindex', String(index + 2));
      const name = document.createElement('span');
      name.className = 'jdr-grid__hname';
      name.textContent = column.name;
      const resizer = div('jdr-grid__resizer');
      resizer.setAttribute('role', 'separator');
      resizer.setAttribute('aria-orientation', 'vertical');
      resizer.setAttribute('aria-label', t('grid.resizeHandle', { name: column.name }));
      cell.append(name, resizer);
      header.append(cell);
      headerCells.push(cell);
    });
    header.style.height = `${HEADER_HEIGHT}px`;
  }

  /**
   * 머리글 칸 위치. 고정 열과 행 번호는 스크롤 위치를 더해 왼쪽에 붙인다.
   * @param {number} scrollLeft
   * @param {{ start: number, end: number }} colRange
   */
  function placeHeader(scrollLeft, colRange) {
    const rowNumber = headerCells[0];
    if (rowNumber) setTransform(rowNumber, scrollLeft, 0);
    for (let i = 0; i < columns.length; i += 1) {
      const cell = headerCells[i + 1];
      if (!cell) continue;
      const isFrozen = i < frozen;
      cell.classList.toggle('jdr-grid__hcell--frozen', isFrozen);
      const shown = isFrozen || (i >= colRange.start && i < colRange.end);
      if (!shown) {
        if (!cell.hidden) cell.hidden = true;
        continue;
      }
      if (cell.hidden) cell.hidden = false;
      cell.style.width = `${widths[i] ?? 0}px`;
      setTransform(cell, (lefts[i] ?? 0) + (isFrozen ? scrollLeft : 0), 0);
    }
  }

  // ---- 행 풀 ----

  /** @returns {RowSlot} */
  function acquireRow() {
    const reused = pool.pop();
    if (reused) {
      reused.el.hidden = false;
      return reused;
    }
    const rowEl = div('jdr-grid__row', 'row');
    rowEl.style.height = `${ROW_HEIGHT}px`;
    const rowNumber = div('jdr-grid__cell jdr-grid__cell--rownum', 'rowheader');
    rowNumber.style.width = `${ROW_NUMBER_WIDTH}px`;
    rowEl.append(rowNumber);
    canvas.append(rowEl);
    return {
      el: rowEl,
      rowIndex: -1,
      cells: [rowNumber],
      cellCols: [-1],
      cellLefts: [-1],
      cellWidths: [ROW_NUMBER_WIDTH],
      cellVersions: [-1],
      cellFrozen: [true],
      y: -1,
    };
  }

  /** @param {RowSlot} slot */
  function releaseRow(slot) {
    slot.rowIndex = -1;
    slot.el.hidden = true;
    pool.push(slot);
  }

  /**
   * 행 하나의 칸을 맞추고 내용을 채운다.
   * @param {RowSlot} slot
   * @param {number} rowIndex
   * @param {number} y
   * @param {number} scrollLeft
   * @param {{ start: number, end: number }} colRange
   * @param {WindowRow | null} data
   */
  function renderRow(slot, rowIndex, y, scrollLeft, colRange, data) {
    const rowEl = slot.el;
    if (slot.rowIndex !== rowIndex) {
      // 풀에서 꺼낸 요소는 다른 행의 내용을 담고 있다. 칸 내용을 모두 다시 그리게 표시한다.
      slot.rowIndex = rowIndex;
      slot.cellVersions.fill(-1);
      rowEl.dataset.row = String(rowIndex);
      rowEl.setAttribute('aria-rowindex', String(rowIndex + 2));
      const rowNumber = slot.cells[0];
      if (rowNumber) rowNumber.textContent = formatInteger(rowIndex + 1);
    }
    if (slot.y !== y) {
      slot.y = y;
      setTransform(rowEl, 0, y);
    }
    const rowNumber = slot.cells[0];
    if (rowNumber && slot.cellLefts[0] !== scrollLeft) {
      slot.cellLefts[0] = scrollLeft;
      setTransform(rowNumber, scrollLeft, 0);
    }
    const needed = 1 + frozen + Math.max(0, colRange.end - colRange.start);
    while (slot.cells.length < needed) {
      const cell = div('jdr-grid__cell', 'gridcell');
      rowEl.append(cell);
      slot.cells.push(cell);
      slot.cellCols.push(-2);
      slot.cellLefts.push(-1);
      slot.cellWidths.push(-1);
      slot.cellVersions.push(-1);
      slot.cellFrozen.push(false);
    }
    while (slot.cells.length > needed) {
      slot.cells.pop()?.remove();
      slot.cellCols.pop();
      slot.cellLefts.pop();
      slot.cellWidths.pop();
      slot.cellVersions.pop();
      slot.cellFrozen.pop();
    }
    const rowVersion = data ? generation : -1;
    for (let k = 1; k < needed; k += 1) {
      const colIndex = k <= frozen ? k - 1 : colRange.start + (k - 1 - frozen);
      const cell = /** @type {HTMLElement} */ (slot.cells[k]);
      const column = /** @type {ColumnInfo} */ (columns[colIndex]);
      const isFrozen = colIndex < frozen;
      const left = (lefts[colIndex] ?? 0) + (isFrozen ? scrollLeft : 0);
      const width = widths[colIndex] ?? 0;
      if (slot.cellCols[k] !== colIndex) {
        slot.cellCols[k] = colIndex;
        slot.cellVersions[k] = -1;
        cell.dataset.col = String(colIndex);
        cell.setAttribute('aria-colindex', String(colIndex + 2));
      }
      if (slot.cellFrozen[k] !== isFrozen) {
        slot.cellFrozen[k] = isFrozen;
        cell.classList.toggle('jdr-grid__cell--frozen', isFrozen);
      }
      if (slot.cellLefts[k] !== left) {
        slot.cellLefts[k] = left;
        setTransform(cell, left, 0);
      }
      if (slot.cellWidths[k] !== width) {
        slot.cellWidths[k] = width;
        cell.style.width = `${width}px`;
      }
      if (slot.cellVersions[k] !== rowVersion) {
        slot.cellVersions[k] = rowVersion;
        if (data) {
          renderCell(cell, column, data.cells[colIndex] ?? null, {
            length: data.lengths[colIndex] ?? null,
          });
        } else if (cell.firstChild) {
          cell.textContent = '';
        }
      }
      const isCursor = rowIndex === cursor.row && colIndex === cursor.col;
      if (isCursor) {
        if (cursorEl !== cell) {
          cursorEl?.classList.remove('jdr-grid__cell--active');
          cursorEl?.removeAttribute('aria-selected');
          cell.classList.add('jdr-grid__cell--active');
          cell.setAttribute('aria-selected', 'true');
          cursorEl = cell;
        }
      } else if (cursorEl === cell) {
        cell.classList.remove('jdr-grid__cell--active');
        cell.removeAttribute('aria-selected');
        cursorEl = null;
      }
    }
  }

  // ---- 데이터 ----

  /**
   * @param {number} rowIndex
   * @returns {WindowRow | null}
   */
  function rowAt(rowIndex) {
    if (!table) return null;
    const block = Math.floor(rowIndex / BLOCK_ROWS);
    const cached = cache.get(table.id, block);
    return cached?.rows[rowIndex - block * BLOCK_ROWS] ?? null;
  }

  /**
   * 범위가 걸친 블록 중 캐시에 없고 요청 중도 아닌 블록을 요청한다.
   * @param {RowRange} range
   */
  function ensureBlocks(range) {
    if (!table || range.end <= range.start) return;
    const firstBlock = Math.floor(range.start / BLOCK_ROWS);
    const lastBlock = Math.floor((range.end - 1) / BLOCK_ROWS);
    for (let block = firstBlock; block <= lastBlock; block += 1) {
      if (cache.has(table.id, block) || inflight.has(block)) continue;
      void fetchBlock(table.id, block, generation);
    }
  }

  /**
   * @param {string} tableId
   * @param {number} block
   * @param {number} gen
   */
  async function fetchBlock(tableId, block, gen) {
    inflight.add(block);
    seq += 1;
    const mySeq = seq;
    try {
      const result = await client.call('query.window', {
        tableId,
        viewSpec,
        offset: block * BLOCK_ROWS,
        limit: BLOCK_ROWS,
        seq: mySeq,
      });
      stats.queries += 1;
      stats.lastQueryMs = result.elapsedMs;
      stats.maxQueryMs = Math.max(stats.maxQueryMs, result.elapsedMs);
      // 테이블이 바뀌었거나 무효화된 뒤의 응답은 버린다.
      if (gen !== generation || result.seq !== mySeq) return;
      cache.put(tableId, { block, rows: result.rows, columnIds: result.columnIds });
      scheduleRender();
    } catch (err) {
      if (gen !== generation) return;
      onError(toAppError(err));
    } finally {
      if (gen === generation) inflight.delete(block);
    }
  }

  /**
   * @param {string} tableId
   * @param {number} gen
   */
  async function recount(tableId, gen) {
    try {
      const { count } = await client.call('query.count', { tableId, viewSpec });
      if (gen !== generation) return;
      grid.setRowCount(count);
    } catch (err) {
      if (gen !== generation) return;
      onError(toAppError(err));
    }
  }

  // ---- 렌더 ----

  function render() {
    if (!mounted || !table) return;
    if (__JDR_TEST__) performance.mark(RENDER_MARK);
    const started = performance.now();
    const scrollTop = scroller.scrollTop;
    const scrollLeft = scroller.scrollLeft;
    if (viewportHeight === 0 || viewportWidth === 0) {
      viewportHeight = scroller.clientHeight - HEADER_HEIGHT;
      viewportWidth = scroller.clientWidth;
    }
    const range = computeRange(scrollTop, viewportHeight, layout());
    const colRange = computeColumnRange(scrollLeft, viewportWidth, { lefts, widths, frozen });
    ensureBlocks(range);
    placeHeader(scrollLeft, colRange);

    for (const [rowIndex, slot] of active) {
      if (rowIndex < range.start || rowIndex >= range.end) {
        active.delete(rowIndex);
        releaseRow(slot);
      }
    }
    for (let i = range.start; i < range.end; i += 1) {
      let slot = active.get(i);
      if (!slot) {
        slot = acquireRow();
        active.set(i, slot);
      }
      const y = range.offsetY + (i - range.first) * ROW_HEIGHT;
      renderRow(slot, i, y, scrollLeft, colRange, rowAt(i));
    }
    stats.renders += 1;
    stats.domRows = active.size;
    stats.lastRenderMs = performance.now() - started;
    if (__JDR_TEST__) {
      performance.measure(RENDER_MEASURE, RENDER_MARK);
      performance.clearMarks(RENDER_MARK);
    }
  }

  // ---- 이벤트 ----

  const onScroll = () => scheduleRender();

  /** @type {ResizeObserver | null} */
  let resizeObserver = null;
  try {
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        viewportWidth = entry.contentRect.width;
        viewportHeight = entry.contentRect.height - HEADER_HEIGHT;
      }
      scheduleRender();
    });
  } catch {
    // ResizeObserver가 없는 환경은 렌더마다 clientWidth/Height를 읽는다(측정 1회).
    resizeObserver = null;
  }

  const onFrozenChange = () => {
    if (!table) return;
    store.setFrozenColumns(table.id, Number(frozenSelect.value));
  };
  frozenSelect.addEventListener('change', onFrozenChange);

  /** @type {{ col: number, startX: number, startWidth: number, pointerId: number, target: HTMLElement } | null} */
  let resizing = null;
  /** @param {PointerEvent} ev */
  const onHeaderPointerDown = (ev) => {
    const target = /** @type {HTMLElement | null} */ (ev.target);
    if (!(target instanceof HTMLElement) || !target.classList.contains('jdr-grid__resizer')) return;
    const cell = target.parentElement;
    const col = Number(cell?.dataset.col ?? -1);
    if (col < 0) return;
    ev.preventDefault();
    target.setPointerCapture(ev.pointerId);
    resizing = {
      col,
      startX: ev.clientX,
      startWidth: widths[col] ?? 0,
      pointerId: ev.pointerId,
      target,
    };
  };
  /** @param {PointerEvent} ev */
  const onHeaderPointerMove = (ev) => {
    if (!resizing || ev.pointerId !== resizing.pointerId) return;
    const next = Math.max(
      MIN_COLUMN_WIDTH,
      Math.round(resizing.startWidth + ev.clientX - resizing.startX),
    );
    if (widths[resizing.col] === next) return;
    widths[resizing.col] = next;
    const laid = layoutColumns(widths);
    lefts = laid.lefts;
    totalWidth = laid.total;
    header.style.width = `${totalWidth}px`;
    canvas.style.width = `${totalWidth}px`;
    scheduleRender();
  };
  /** @param {PointerEvent} ev */
  const onHeaderPointerUp = (ev) => {
    if (!resizing || ev.pointerId !== resizing.pointerId) return;
    const { col, target } = resizing;
    resizing = null;
    try {
      target.releasePointerCapture(ev.pointerId);
    } catch {
      // 캡처가 이미 풀린 경우(포인터 취소). 너비는 그대로 반영한다.
    }
    const column = columns[col];
    if (table && column) store.setColumnWidth(table.id, column.id, widths[col] ?? column.width);
  };
  header.addEventListener('pointerdown', onHeaderPointerDown);
  header.addEventListener('pointermove', onHeaderPointerMove);
  header.addEventListener('pointerup', onHeaderPointerUp);
  header.addEventListener('pointercancel', onHeaderPointerUp);

  /** @param {MouseEvent} ev */
  const onCanvasClick = (ev) => {
    const target = /** @type {HTMLElement | null} */ (ev.target);
    const cell = target?.closest('.jdr-grid__cell');
    const rowEl = cell?.parentElement;
    if (!(cell instanceof HTMLElement) || !(rowEl instanceof HTMLElement)) return;
    const row = Number(rowEl.dataset.row ?? -1);
    const col = Number(cell.dataset.col ?? -1);
    if (row < 0 || col < 0) return;
    moveCursor(row, col);
  };
  canvas.addEventListener('click', onCanvasClick);

  /**
   * @param {number} row
   * @param {number} col
   */
  function moveCursor(row, col) {
    if (rowCount === 0 || columns.length === 0) return;
    cursor.row = clamp(row, 0, rowCount - 1);
    cursor.col = clamp(col, 0, columns.length - 1);
    grid.scrollToCell(cursor.row, cursor.col);
    scheduleRender();
  }

  /** @param {KeyboardEvent} ev */
  const onKeydown = (ev) => {
    if (ev.isComposing || !table) return;
    const pageRows = Math.max(1, Math.floor(viewportHeight / ROW_HEIGHT) - 1);
    let handled = true;
    switch (ev.key) {
      case 'ArrowDown':
        moveCursor(cursor.row + 1, cursor.col);
        break;
      case 'ArrowUp':
        moveCursor(cursor.row - 1, cursor.col);
        break;
      case 'ArrowRight':
        moveCursor(cursor.row, cursor.col + 1);
        break;
      case 'ArrowLeft':
        moveCursor(cursor.row, cursor.col - 1);
        break;
      case 'PageDown':
        moveCursor(cursor.row + pageRows, cursor.col);
        break;
      case 'PageUp':
        moveCursor(cursor.row - pageRows, cursor.col);
        break;
      case 'Home':
        if (ev.ctrlKey || ev.metaKey) moveCursor(0, 0);
        else moveCursor(cursor.row, 0);
        break;
      case 'End':
        if (ev.ctrlKey || ev.metaKey) moveCursor(rowCount - 1, columns.length - 1);
        else moveCursor(cursor.row, columns.length - 1);
        break;
      default:
        handled = false;
    }
    if (handled) ev.preventDefault();
  };
  el.addEventListener('keydown', onKeydown);

  function clearRows() {
    for (const slot of active.values()) releaseRow(slot);
    active.clear();
    cursorEl = null;
  }

  /** @type {Grid} */
  const grid = {
    el,

    mount(container, options) {
      if (!mounted) {
        container.append(el);
        scroller.addEventListener('scroll', onScroll, { passive: true });
        resizeObserver?.observe(scroller);
        mounted = true;
      }
      generation += 1;
      inflight.clear();
      cache.invalidate();
      clearRows();
      table = options.table;
      viewSpec = options.viewSpec;
      columns = visibleColumns(table, viewSpec);
      cursor.row = 0;
      cursor.col = 0;
      rowCount = 0;
      stats.rowCount = 0;
      applyColumnLayout(options.view);
      buildHeader();
      scroller.scrollTop = 0;
      scroller.scrollLeft = 0;
      rowCountLabel.textContent = '';
      el.setAttribute('aria-colcount', String(columns.length + 1));
      void recount(table.id, generation);
      scheduleRender();
    },

    applyView(view) {
      if (!table) return;
      applyColumnLayout(view);
      scheduleRender();
    },

    setRowCount(n) {
      rowCount = Math.max(0, Math.trunc(n));
      stats.rowCount = rowCount;
      canvas.style.height = `${canvasHeightFor(layout())}px`;
      el.setAttribute('aria-rowcount', String(rowCount + 1));
      rowCountLabel.textContent = t('grid.rowCount', { count: formatInteger(rowCount) });
      if (cursor.row >= rowCount) cursor.row = Math.max(0, rowCount - 1);
      scheduleRender();
    },

    computeRange(scrollTop, height) {
      return computeRange(scrollTop, height, layout());
    },

    render() {
      render();
    },

    invalidate() {
      if (!table) return;
      generation += 1;
      inflight.clear();
      cache.invalidate(table.id);
      void recount(table.id, generation);
      scheduleRender();
    },

    scrollToRow(row) {
      const target = clamp(row, 0, Math.max(0, rowCount - 1));
      scroller.scrollTop = contentToScroll(target * ROW_HEIGHT, viewportHeight, layout());
    },

    scrollToCell(row, col) {
      const target = clamp(row, 0, Math.max(0, rowCount - 1));
      const contentTop = scrollToContent(scroller.scrollTop, viewportHeight, layout());
      const rowTop = target * ROW_HEIGHT;
      if (rowTop < contentTop) {
        scroller.scrollTop = contentToScroll(rowTop, viewportHeight, layout());
      } else if (rowTop + ROW_HEIGHT > contentTop + viewportHeight) {
        scroller.scrollTop = contentToScroll(
          rowTop + ROW_HEIGHT - viewportHeight,
          viewportHeight,
          layout(),
        );
      }
      const c = clamp(col, 0, Math.max(0, columns.length - 1));
      if (c < frozen || columns.length === 0) return;
      const left = lefts[c] ?? 0;
      const width = widths[c] ?? 0;
      const frozenRight =
        frozen > 0 ? (lefts[frozen - 1] ?? 0) + (widths[frozen - 1] ?? 0) : ROW_NUMBER_WIDTH;
      const scrollLeft = scroller.scrollLeft;
      if (left - frozenRight < scrollLeft) {
        scroller.scrollLeft = left - frozenRight;
      } else if (left + width > scrollLeft + viewportWidth) {
        scroller.scrollLeft = left + width - viewportWidth;
      }
    },

    stats: () => ({ ...stats }),

    unmount() {
      if (!mounted) return;
      if (rafId !== 0) cancelAnimationFrame(rafId);
      rafId = 0;
      scroller.removeEventListener('scroll', onScroll);
      resizeObserver?.disconnect();
      frozenSelect.removeEventListener('change', onFrozenChange);
      header.removeEventListener('pointerdown', onHeaderPointerDown);
      header.removeEventListener('pointermove', onHeaderPointerMove);
      header.removeEventListener('pointerup', onHeaderPointerUp);
      header.removeEventListener('pointercancel', onHeaderPointerUp);
      canvas.removeEventListener('click', onCanvasClick);
      el.removeEventListener('keydown', onKeydown);
      generation += 1;
      inflight.clear();
      cache.invalidate();
      clearRows();
      table = null;
      el.remove();
      mounted = false;
    },
  };
  return grid;
}

/**
 * @typedef {object} GridHost
 * @property {HTMLElement} el
 * @property {() => GridStats | null} stats 열린 그리드의 통계(테스트·진단용). 그리드가 없으면 null
 * @property {() => void} unmount
 */

/**
 * 메인 영역의 그리드 호스트: 스토어의 선택·테이블·뷰·데이터 변경을 구독해 그리드를 열고 닫고,
 * 테이블이 없거나 열이 없으면 빈 상태를 보여 준다.
 * @param {HTMLElement} container
 * @param {{ store: Store, client: Client, toasts: Toasts }} deps
 * @returns {GridHost}
 */
export function mountGridHost(container, deps) {
  const { store, client, toasts } = deps;
  const el = div('jdr-grid-host');
  const empty = document.createElement('p');
  empty.className = 'jdr-grid__empty';
  el.append(empty);
  container.append(el);

  /** @type {string | null} */
  let openTableId = null;
  let gridMounted = false;

  const grid = createGrid({
    client,
    store,
    onError: (err) => {
      // 창 질의 실패(테이블이 삭제됨 등): 빈 상태로 그리고 사이드바로 복귀(Step 4 예외 처리).
      toasts.error(err);
      closeGrid();
      store.selectTable(null);
      store.refreshTables().catch((/** @type {unknown} */ e) => toasts.error(toAppError(e)));
    },
  });

  function closeGrid() {
    if (gridMounted) grid.unmount();
    gridMounted = false;
    openTableId = null;
  }

  /** @param {'grid.noTable' | 'grid.noColumns' | null} key */
  function showEmpty(key) {
    empty.hidden = key === null;
    empty.textContent = key === null ? '' : t(key);
  }

  function sync() {
    const state = store.getState();
    const table = state.tables.find((tb) => tb.id === state.currentTableId) ?? null;
    if (!table) {
      closeGrid();
      showEmpty('grid.noTable');
      return;
    }
    if (visibleColumns(table).length === 0) {
      closeGrid();
      showEmpty('grid.noColumns');
      return;
    }
    showEmpty(null);
    grid.mount(el, { table, viewSpec: {}, view: store.getViewState(table.id) });
    gridMounted = true;
    openTableId = table.id;
  }

  const unsubscribe = [
    store.on('selection:changed', sync),
    store.on('tables:changed', sync),
    store.on('file:opened', sync),
    store.on('view:changed', () => {
      if (openTableId) grid.applyView(store.getViewState(openTableId));
    }),
    store.on('data:changed', () => {
      if (openTableId) grid.invalidate();
    }),
  ];
  sync();

  return {
    el,
    stats: () => (gridMounted ? grid.stats() : null),
    unmount() {
      for (const off of unsubscribe) off();
      closeGrid();
      el.remove();
    },
  };
}
