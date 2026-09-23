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
 * - 편집(Step 5): 선택 모델(`selection.js`)을 그리고, 편집·삭제·복사·붙여넣기·행 추가·삭제 요청은
 *   `hooks`로 편집 컨트롤러(`editing.js`)에 넘긴다. 커맨드는 이 파일에서 만들지 않는다.
 * - 뷰(Step 6): `viewSpec`(숨김·정렬·필터·검색)은 마운트 때 받아 창 질의·행 수에 그대로 넘긴다.
 *   필터 결과가 0건이면 "필터 지우기" 버튼이 있는 빈 상태를 보인다.
 * - 머리글(D-16): 칸의 내용·정렬 버튼·열 메뉴·이름 편집기는 `header.js`가 맡는다. 이 파일은 칸의 배치와
 *   너비 조절만 한다.
 * - 빈 행(D-16): 정렬·필터·검색이 없고 쓸 수 있는 STRICT 테이블이면 마지막 행 아래에 `GHOST_ROWS`줄을 더
 *   그린다. 빈 행은 화면에만 있고 창 질의를 하지 않는다. 빈 행에 값을 확정하는 일은 편집 컨트롤러가 한다.
 */
import { resolveShortcut } from '../../app/shortcuts.js';
import { MIN_COLUMN_WIDTH } from '../../app/store.js';
import { normalizeViewSpec, PREVIEW_CHARS, visibleColumns } from '../../db/query.js';
import { t } from '../../i18n/index.js';
import { toAppError } from '../../util/errors.js';
import { formatInteger } from '../../util/format.js';
import { BLOCK_ROWS, createBlockCache } from './cache.js';
import { render as renderCell } from './cells.js';
import { createEditingController } from './editing.js';
import { createHeader } from './header.js';
import { createSelection } from './selection.js';

/** @typedef {import('../../app/store.js').Store} Store */
/** @typedef {import('../../app/store.js').TableViewState} TableViewState */
/** @typedef {import('../../db/client.js').Client} Client */
/** @typedef {import('../../db/query.js').ViewSpec} ViewSpec */
/** @typedef {import('../../db/query.js').WindowRow} WindowRow */
/** @typedef {import('../../db/tables.js').TableInfo} TableInfo */
/** @typedef {import('../../db/tables.js').ColumnInfo} ColumnInfo */
/** @typedef {import('../toast.js').Toasts} Toasts */
/** @typedef {import('../../db/engine.js').SqlValue} SqlValue */
/** @typedef {import('./selection.js').Selection} Selection */
/** @typedef {import('./selection.js').CellRange} CellRange */
/** @typedef {import('./editing.js').GridHooks} GridHooks */
/** @typedef {import('../../app/history.js').History} History */
/** @typedef {import('../editor/longtext.js').LongtextPanel} LongtextPanel */
/** @typedef {import('../../app/commands.js').SchemaCommands} SchemaCommands */

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
/** 마지막 행 아래에 그리는 빈 행 수(D-16). 화면에만 있고 DB에는 없다. */
export const GHOST_ROWS = 30;
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
 * @property {(table: TableInfo) => boolean} applyTable 보이는 열 구성이 그대로면 테이블 메타만 갈아 끼우고 데이터를 다시 읽는다(스크롤·커서·열 너비 유지). 구성이 달라 다시 마운트해야 하면 false
 * @property {(n: number) => void} setRowCount
 * @property {() => boolean} ghostRowsEnabled 빈 행을 그리는가: 뷰에 정렬·필터·검색이 없고, 쓰기 가능하고, STRICT 테이블이고, 살아 있는 열이 있다(D-16)
 * @property {(row: number) => boolean} isGhostRow 그 행 순번이 빈 행인가(`row >= rowCount`이고 빈 행이 켜져 있음)
 * @property {() => number} displayRowCount 그리는 행 수(실제 행 + 빈 행)
 * @property {() => void} refreshGhost 읽기 전용 여부가 바뀐 뒤 빈 행을 다시 판정한다. 꺼지면 빈 행의 편집기를 닫는다
 * @property {(columnId: string) => void} startRename 그 열로 옮겨 머리글의 이름 편집기를 연다("+ 열" 직후. 확정한 이름은 열 추가와 한 히스토리 항목이 된다)
 * @property {(scrollTop: number, viewportHeight: number) => RowRange} computeRange
 * @property {(range?: RowRange) => void} render
 * @property {() => void} invalidate 블록 캐시를 버리고 행 수를 다시 세어 다시 그린다
 * @property {(row: number) => void} scrollToRow
 * @property {(row: number, col: number) => void} scrollToCell
 * @property {() => GridStats} stats
 * @property {() => void} unmount
 * @property {(hooks: GridHooks | null) => void} setHooks 편집 컨트롤러 연결(Step 5)
 * @property {() => Selection} selection 선택 모델(읽기용)
 * @property {(row: number, col: number, extend?: boolean) => void} moveCursor 활성 셀 이동(+스크롤). `extend`면 범위를 넓힌다
 * @property {() => TableInfo | null} table
 * @property {() => ViewSpec} viewSpec 지금 그리는 뷰 사양. 편집 컨트롤러가 행 읽기·범위 커맨드에 같은 사양을 넘긴다
 * @property {() => ColumnInfo[]} columns 지금 그리는 열(살아 있고 숨기지 않은 열, 표시 순서)
 * @property {() => number} rowCount
 * @property {(row: number, col: number) => CellInfo | null} cellInfo 캐시에 있는 셀의 값·행 id. 아직 읽지 않았으면 null
 * @property {(row: number, col: number) => { left: number, top: number, width: number, height: number }} cellRect 편집 오버레이(머리글 아래 보이는 영역) 기준 셀 위치
 * @property {(rowId: number, colId: string, value: SqlValue) => void} patchCell 캐시의 셀 값을 고쳐 다시 그린다(편집 확정 직후)
 * @property {HTMLElement} editorHost 인라인 편집기를 붙이는 요소(스크롤러 밖의 오버레이. 접근성 트리의 grid 구조를 지킨다)
 * @property {() => void} focus 스크롤 영역(role=grid)에 포커스
 */

/**
 * 렌더 한 번 동안 고정되는 선택 상태.
 * @typedef {object} SelectionSnapshot
 * @property {CellRange} range
 * @property {{ row: number, col: number }} active
 * @property {boolean} multi 범위가 셀 하나보다 큰가
 */

/**
 * 캐시에서 읽은 셀 정보.
 * @typedef {object} CellInfo
 * @property {number} rowId
 * @property {ColumnInfo} column
 * @property {SqlValue} value 미리보기(텍스트는 256자까지)
 * @property {number | null} length 미리보기가 잘렸으면 전체 문자 수
 * @property {boolean} stale 이 행이 낡은 블록에서 왔는가(데이터가 바뀐 뒤 아직 다시 읽지 않음)
 */

/**
 * @typedef {object} GridDeps
 * @property {Client} client
 * @property {Store} store
 * @property {(err: import('../../util/errors.js').AppError) => void} onError 창 질의 실패. 호출자가 빈 상태·사이드바 복귀를 맡는다
 * @property {Toasts} toasts 머리글의 안내(읽기 전용, 이름 확정 실패)
 * @property {SchemaCommands} commands 열 메뉴의 타입 변경·삭제
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
 * @property {boolean[]} cellCursor 마지막으로 쓴 활성 셀 여부
 * @property {boolean[]} cellSelected 마지막으로 쓴 선택 범위 포함 여부
 * @property {boolean} ghost 마지막으로 쓴 빈 행 표시 여부. 같은 순번이라도 행 수가 바뀌면 빈 행이 실제 행이 된다
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
  const { client, store, onError, toasts, commands } = deps;
  const cache = createBlockCache();

  // `role="grid"`는 자식이 `row`·`rowgroup`이어야 한다. 바깥 상자에 두면 그 사이의 도구 모음과
  // 스크롤 영역이 끼어들어 브라우저가 행·머리글·셀 역할을 전부 버린다(실측: 평평한 텍스트 목록).
  const el = div('jdr-grid');

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
  const rowInsertButton = document.createElement('button');
  rowInsertButton.type = 'button';
  rowInsertButton.className = 'jdr-grid__button';
  rowInsertButton.dataset.action = 'row-insert';
  rowInsertButton.textContent = t('grid.rowInsert');
  const rowDeleteButton = document.createElement('button');
  rowDeleteButton.type = 'button';
  rowDeleteButton.className = 'jdr-grid__button';
  rowDeleteButton.dataset.action = 'row-delete';
  rowDeleteButton.textContent = t('grid.rowDelete');
  bar.append(rowCountLabel, frozenLabel, rowInsertButton, rowDeleteButton);

  const scroller = div('jdr-grid__scroller', 'grid');
  scroller.tabIndex = 0;
  scroller.setAttribute('aria-label', t('grid.label'));
  // 범위 선택(Shift+화살표, 끌기, Ctrl+A)이 있으므로 칸 여럿이 동시에 선택될 수 있다.
  scroller.setAttribute('aria-multiselectable', 'true');
  const header = div('jdr-grid__header', 'row');
  header.setAttribute('aria-rowindex', '1');
  const canvas = div('jdr-grid__canvas', 'rowgroup');
  scroller.append(header, canvas);
  // 인라인 편집기는 role="grid" 바깥의 오버레이에 둔다. grid의 자식은 row·rowgroup뿐이어야 하는데(ARIA 필수
  // 자식), 편집기(textbox)를 캔버스 안에 두면 보조 기술이 그리드 구조를 잃는다(axe aria-required-children).
  // 오버레이는 머리글 아래(`HEADER_HEIGHT`, grid.css의 top과 같은 값)를 덮고 넘친 부분을 잘라, 편집기가
  // 스크롤러 안에 있을 때와 같은 클리핑을 준다. 포인터는 통과시키고(pointer-events: none) 편집기만 받는다.
  const viewport = div('jdr-grid__viewport');
  const overlay = div('jdr-grid__overlay');
  viewport.append(scroller, overlay);
  // 필터·검색 결과가 0건일 때의 빈 상태(Step 6 예외 처리). 정렬만 있는 빈 테이블에는 보이지 않는다.
  const noMatch = div('jdr-grid__nomatch');
  noMatch.setAttribute('role', 'status');
  const noMatchText = document.createElement('span');
  noMatchText.textContent = t('grid.noMatch');
  const clearFiltersButton = document.createElement('button');
  clearFiltersButton.type = 'button';
  clearFiltersButton.className = 'jdr-grid__button';
  clearFiltersButton.dataset.action = 'clear-filters';
  clearFiltersButton.textContent = t('grid.clearFilters');
  noMatch.append(noMatchText, clearFiltersButton);
  noMatch.hidden = true;
  el.append(bar, viewport, noMatch);

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
  /** 이번 마운트에서 행 수를 한 번이라도 받았는가. 받기 전에는 빈 행을 그리지 않는다(자리가 곧 밀린다). */
  let countKnown = false;
  /** 빈 행을 그리는가(`ghostRowsEnabled()`를 마운트·행 수·읽기 전용 변경 때 다시 판정해 담는다). */
  let ghost = false;
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
  const selection = createSelection();
  /** @type {GridHooks | null} */
  let hooks = null;
  /** 블록 내용 세대. 새 응답·셀 패치마다 오르고, 칸은 자기 세대와 다르면 다시 그린다. */
  let dataVersion = 0;
  /** `rowAt()`이 돌려준 행의 블록 세대(할당 없이 넘기기 위한 모듈 변수). */
  let lastRowVersion = -1;
  /** `rowAt()`이 돌려준 행이 낡은 블록에서 왔는가(같은 이유의 모듈 변수). */
  let lastRowStale = false;
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

  /**
   * 그 열이 보이게 가로로 스크롤한다(고정 열은 늘 보인다). `scrollToCell`의 가로 부분.
   * @param {number} col
   */
  function scrollToColumn(col) {
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
  }

  const headerCtl = createHeader({
    store,
    toasts,
    commands,
    host: {
      table: () => table,
      columns: () => columns,
      revealColumn(col) {
        if (!columns[col]) return null;
        scrollToColumn(col);
        // 머리글 칸은 가로 가상화로 숨어 있을 수 있다. 바로 그려 칸을 보이게 한 뒤 돌려준다.
        render();
        const cell = headerCells[col + 1] ?? null;
        return cell && !cell.hidden ? cell : null;
      },
      columnLeft: (col) => (lefts[col] ?? 0) - (col < frozen ? 0 : scroller.scrollLeft),
      overlay,
      focus: () => scroller.focus(),
      focusTarget: scroller,
    },
  });

  /** 머리글을 마지막으로 만들 때의 쓰기 가능 여부. */
  let headerWritable = false;

  /** @returns {boolean} 지금 테이블을 바꿀 수 있는가 */
  function writableNow() {
    return table !== null && table.strict && store.getState().readOnly === 'none';
  }

  /** @returns {number} 그리는 행 수(실제 행 + 빈 행) */
  const displayCount = () => rowCount + (ghost ? GHOST_ROWS : 0);

  /** @returns {RowLayout} */
  const layout = () => ({ rowCount: displayCount(), rowHeight: ROW_HEIGHT });

  /**
   * 빈 행을 그릴 조건(D-16). 정렬·필터·검색이 있는 뷰에서는 새 행이 입력한 자리에 보인다는 보장이 없다.
   * @returns {boolean}
   */
  function computeGhost() {
    if (!table || !countKnown || !writableNow()) return false;
    if (!table.columns.some((c) => c.deletedAt === null)) return false;
    const spec = normalizeViewSpec(viewSpec);
    return spec.sort.length === 0 && spec.filter === null && spec.search === '';
  }

  /** 행 수가 바뀐 뒤 캔버스 높이·접근성 행 수·선택 범위를 맞춘다. */
  function applyRowLayout() {
    canvas.style.height = `${canvasHeightFor(layout())}px`;
    // 머리글 + 실제 행 + 빈 행.
    scroller.setAttribute('aria-rowcount', String(displayCount() + 1));
    selection.setBounds(displayCount(), columns.length);
  }

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
    headerCtl.beforeBuild();
    for (const cell of headerCells) cell.remove();
    headerCells.length = 0;
    const rowNumber = div('jdr-grid__hcell jdr-grid__hcell--rownum', 'columnheader');
    rowNumber.textContent = t('grid.rowNumber');
    rowNumber.style.width = `${ROW_NUMBER_WIDTH}px`;
    header.append(rowNumber);
    headerCells.push(rowNumber);
    const sort = normalizeViewSpec(viewSpec).sort;
    const writable = writableNow();
    headerWritable = writable;
    columns.forEach((column, index) => {
      const cell = div('jdr-grid__hcell', 'columnheader');
      cell.dataset.col = String(index);
      cell.setAttribute('aria-colindex', String(index + 2));
      const order = sort.findIndex((s) => s.colId === column.id);
      const entry = order >= 0 ? sort[order] : undefined;
      headerCtl.render(
        cell,
        column,
        entry ? { dir: entry.dir, index: order, count: sort.length } : null,
        { writable },
      );
      header.append(cell);
      headerCells.push(cell);
    });
    header.style.height = `${HEADER_HEIGHT}px`;
    headerCtl.afterBuild();
  }

  /** 필터·검색 결과 0건 여부에 따라 빈 상태 블록을 보이거나 숨긴다. */
  function renderNoMatch() {
    const spec = normalizeViewSpec(viewSpec);
    const filtered = spec.filter !== null || spec.search !== '';
    noMatch.hidden = !(table !== null && rowCount === 0 && filtered);
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
      cellCursor: [false],
      cellSelected: [false],
      ghost: false,
      y: -1,
    };
  }

  /** @param {RowSlot} slot */
  function releaseRow(slot) {
    slot.rowIndex = -1;
    slot.el.hidden = true;
    for (let k = 0; k < slot.cellCursor.length; k += 1) {
      if (slot.cellCursor[k]) setCursorCell(slot, k, false);
      if (slot.cellSelected[k]) setSelectedCell(slot, k, false);
    }
    pool.push(slot);
  }

  /**
   * 선택 범위 표시. 활성 셀과 같은 방식으로 칸마다 마지막 값을 들고 비교한다.
   * @param {RowSlot} slot
   * @param {number} k
   * @param {boolean} on
   */
  function setSelectedCell(slot, k, on) {
    const cell = slot.cells[k];
    if (!cell) return;
    slot.cellSelected[k] = on;
    cell.classList.toggle('jdr-grid__cell--selected', on);
    // 범위 선택도 선택이다. 클래스만 붙이면 보조 기술에는 활성 셀 하나만 선택된 것으로 보인다.
    // 활성 셀과 범위는 겹치지 않고(`renderRow`의 `!isCursor`), 칸을 그릴 때 활성 여부를 먼저
    // 쓰므로 두 표시가 같은 속성을 두고 다투지 않는다.
    //
    // 행 번호 칸(k === 0, `rowheader`)은 뺀다. 그 칸은 범위가 지나는 행을 눈으로 짚어 주는 것이라
    // 셀 하나만 골라도 켜지는데, `aria-selected`까지 붙이면 행 전체를 고른 것처럼 읽힌다.
    if (k === 0) return;
    if (on) cell.setAttribute('aria-selected', 'true');
    else cell.removeAttribute('aria-selected');
  }

  /**
   * 활성 셀 표시. 칸마다 마지막으로 쓴 값을 들고 비교하므로, 풀에서 돌아온 칸이 남의 표시를 달고
   * 있을 수 없다(전역 포인터 하나로 관리하면 `clearRows()`가 포인터만 비워 표시가 남는다).
   * @param {RowSlot} slot
   * @param {number} k
   * @param {boolean} on
   */
  function setCursorCell(slot, k, on) {
    const cell = slot.cells[k];
    if (!cell) return;
    slot.cellCursor[k] = on;
    cell.classList.toggle('jdr-grid__cell--active', on);
    if (on) cell.setAttribute('aria-selected', 'true');
    else cell.removeAttribute('aria-selected');
  }

  /**
   * 행 하나의 칸을 맞추고 내용을 채운다.
   * @param {RowSlot} slot
   * @param {number} rowIndex
   * @param {number} y
   * @param {number} scrollLeft
   * @param {{ start: number, end: number }} colRange
   * @param {WindowRow | null} data
   * @param {SelectionSnapshot} sel 이번 렌더의 선택 상태(행마다 다시 읽지 않는다)
   */
  function renderRow(slot, rowIndex, y, scrollLeft, colRange, data, sel) {
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
    const isGhost = rowIndex >= rowCount;
    if (slot.ghost !== isGhost) {
      slot.ghost = isGhost;
      rowEl.classList.toggle('jdr-grid__row--ghost', isGhost);
      if (isGhost) rowEl.setAttribute('aria-label', t('grid.ghostRow'));
      else rowEl.removeAttribute('aria-label');
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
    const { range, active, multi } = sel;
    const rowSelected = rowIndex >= range.r0 && rowIndex <= range.r1;
    if (slot.cellSelected[0] !== rowSelected) setSelectedCell(slot, 0, rowSelected);
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
      slot.cellCursor.push(false);
      slot.cellSelected.push(false);
    }
    while (slot.cells.length > needed) {
      slot.cells.pop()?.remove();
      slot.cellCols.pop();
      slot.cellLefts.pop();
      slot.cellWidths.pop();
      slot.cellVersions.pop();
      slot.cellFrozen.pop();
      slot.cellCursor.pop();
      slot.cellSelected.pop();
    }
    const rowVersion = data ? lastRowVersion : -1;
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
      const isCursor = rowIndex === active.row && colIndex === active.col;
      if (slot.cellCursor[k] !== isCursor) setCursorCell(slot, k, isCursor);
      const isSelected =
        multi && rowSelected && colIndex >= range.c0 && colIndex <= range.c1 && !isCursor;
      if (slot.cellSelected[k] !== isSelected) setSelectedCell(slot, k, isSelected);
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
    lastRowVersion = cached ? cached.version : -1;
    lastRowStale = cached?.stale === true;
    return cached?.rows[rowIndex - block * BLOCK_ROWS] ?? null;
  }

  /**
   * 응답의 열 목록이 지금 그리는 열 목록과 같은지. 값은 열 이름이 아니라 위치로 맞추므로(`cells[j]`를
   * `columns[j]`에 꽂는다) 순서까지 같아야 한다.
   * @param {string[]} ids
   * @returns {boolean}
   */
  function sameColumns(ids) {
    if (!Array.isArray(ids) || ids.length !== columns.length) return false;
    for (let i = 0; i < columns.length; i += 1) {
      if (ids[i] !== columns[i]?.id) return false;
    }
    return true;
  }

  /**
   * 범위가 걸친 블록 중 캐시에 없고 요청 중도 아닌 블록을 요청한다.
   * @param {RowRange} range
   */
  function ensureBlocks(range) {
    // 빈 행은 창 질의를 하지 않는다(D-16). 실제 행이 걸친 블록만 읽는다.
    const end = Math.min(range.end, rowCount);
    if (!table || end <= range.start) return;
    const firstBlock = Math.floor(range.start / BLOCK_ROWS);
    const lastBlock = Math.floor((end - 1) / BLOCK_ROWS);
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
      // Worker는 질의 시점의 메타로 열을 다시 고른다. 스키마가 바뀐 뒤 그리드가 다시 마운트되기 전에
      // 도착한 응답은 다른 열 목록으로 만들어졌을 수 있고, 그대로 그리면 값이 남의 열 밑에 들어간다.
      // 버린 블록은 캐시에 없으므로 목록이 맞춰진 뒤의 렌더가 다시 요청한다.
      if (!sameColumns(result.columnIds)) return;
      dataVersion += 1;
      cache.put(tableId, {
        block,
        rows: result.rows,
        columnIds: result.columnIds,
        version: dataVersion,
      });
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
    /** @type {SelectionSnapshot} */
    const sel = {
      range: selection.getRange(),
      active: selection.getActive(),
      multi: !selection.isSingle(),
    };

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
      // 빈 행은 낡은 블록에 남은 옛 행(행을 지운 직후)을 그리지 않도록 캐시를 보지 않는다.
      renderRow(slot, i, y, scrollLeft, colRange, i < rowCount ? rowAt(i) : null, sel);
    }
    // 칸을 다 놓은 뒤에 편집기를 그 위에 맞춘다. 열려 있지 않으면 하는 일이 없다.
    hooks?.onRelayout();
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
  const onClearFilters = () => {
    if (table) store.clearFilters(table.id);
  };
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

  /**
   * 이벤트가 난 셀의 좌표. 행 번호 칸이면 `col`은 -1.
   * @param {EventTarget | null} target
   * @returns {{ row: number, col: number } | null}
   */
  function cellAt(target) {
    const el = /** @type {HTMLElement | null} */ (target);
    const cell = el?.closest('.jdr-grid__cell');
    const rowEl = cell?.parentElement;
    if (!(cell instanceof HTMLElement) || !(rowEl instanceof HTMLElement)) return null;
    const row = Number(rowEl.dataset.row ?? -1);
    if (row < 0) return null;
    if (cell.classList.contains('jdr-grid__cell--rownum')) return { row, col: -1 };
    const col = Number(cell.dataset.col ?? -1);
    return col < 0 ? null : { row, col };
  }

  /** 드래그 선택 상태. */
  /** @type {{ pointerId: number, rows: boolean } | null} */
  let dragging = null;

  /** @param {PointerEvent} ev */
  const onCanvasPointerDown = (ev) => {
    if (ev.button !== 0) return;
    // 편집기 안의 포인터 이벤트는 편집기의 것이다.
    if (ev.target instanceof HTMLElement && ev.target.closest('.jdr-editor')) return;
    const pos = cellAt(ev.target);
    if (!pos) return;
    // 셀을 누르면 포커스가 스크롤 영역에 남아야 키보드 입력이 이어진다. 편집기가 열려 있으면 blur가
    // 확정을 시도하므로 여기서 preventDefault로 포커스 이동을 막지 않는다.
    if (pos.col < 0) {
      if (ev.shiftKey) selection.selectRows(selection.getRange().r0, pos.row);
      else selection.selectRows(pos.row, pos.row);
      dragging = { pointerId: ev.pointerId, rows: true };
    } else {
      if (ev.shiftKey) selection.extendTo(pos.row, pos.col);
      else selection.setActive(pos.row, pos.col);
      dragging = { pointerId: ev.pointerId, rows: false };
    }
    // 포인터 캡처는 쓰지 않는다. 캡처하면 뒤따르는 click·dblclick의 target이 캔버스가 되어 어느 셀을
    // 두 번 눌렀는지 알 수 없다. 드래그는 캔버스 위의 pointermove와 버튼 상태로만 잇는다.
    scheduleRender();
  };
  /** @param {PointerEvent} ev */
  const onCanvasPointerMove = (ev) => {
    if (!dragging || ev.pointerId !== dragging.pointerId) return;
    if (ev.buttons === 0) {
      dragging = null;
      return;
    }
    const pos = cellAt(document.elementFromPoint(ev.clientX, ev.clientY));
    if (!pos) return;
    const range = selection.getRange();
    const active = selection.getActive();
    if (dragging.rows) {
      if (active.row !== pos.row) {
        const anchorRow = active.row === range.r0 ? range.r1 : range.r0;
        selection.selectRows(anchorRow, pos.row);
        scheduleRender();
      }
    } else if (pos.col >= 0 && (active.row !== pos.row || active.col !== pos.col)) {
      selection.extendTo(pos.row, pos.col);
      scheduleRender();
    }
  };
  /** @param {PointerEvent} ev */
  const onCanvasPointerUp = (ev) => {
    if (!dragging || ev.pointerId !== dragging.pointerId) return;
    dragging = null;
  };
  /** @param {MouseEvent} ev */
  const onCanvasDblClick = (ev) => {
    if (ev.target instanceof HTMLElement && ev.target.closest('.jdr-editor')) return;
    const pos = cellAt(ev.target);
    if (!pos || pos.col < 0) return;
    selection.setActive(pos.row, pos.col);
    scheduleRender();
    hooks?.onEdit(pos.row, pos.col, null);
  };

  /**
   * @param {number} row
   * @param {number} col
   * @param {boolean} [extend]
   */
  function moveCursor(row, col, extend = false) {
    if (displayCount() === 0 || columns.length === 0) return;
    const r = clamp(row, 0, displayCount() - 1);
    const c = clamp(col, 0, columns.length - 1);
    if (extend) selection.extendTo(r, c);
    else selection.setActive(r, c);
    grid.scrollToCell(r, c);
    scheduleRender();
  }

  /** @param {KeyboardEvent} ev */
  const onKeydown = (ev) => {
    if (ev.isComposing || !table) return;
    // 편집기 안의 키는 편집기가 stopPropagation으로 막지만, 만일을 위해 스크롤 영역 자신의 키만 다룬다.
    if (ev.target !== scroller) return;
    const pageRows = Math.max(1, Math.floor(viewportHeight / ROW_HEIGHT) - 1);
    const active = selection.getActive();
    const extend = ev.shiftKey;
    let handled = true;
    switch (ev.key) {
      case 'ArrowDown':
        moveCursor(active.row + 1, active.col, extend);
        break;
      case 'ArrowUp':
        moveCursor(active.row - 1, active.col, extend);
        break;
      case 'ArrowRight':
        moveCursor(active.row, active.col + 1, extend);
        break;
      case 'ArrowLeft':
        moveCursor(active.row, active.col - 1, extend);
        break;
      case 'PageDown':
        moveCursor(active.row + pageRows, active.col, extend);
        break;
      case 'PageUp':
        moveCursor(active.row - pageRows, active.col, extend);
        break;
      case 'Home':
        if (ev.ctrlKey || ev.metaKey) moveCursor(0, 0, extend);
        else moveCursor(active.row, 0, extend);
        break;
      case 'End':
        // Ctrl+End는 마지막 실제 행으로 간다. 빈 행은 아래 화살표로 들어간다.
        if (ev.ctrlKey || ev.metaKey) moveCursor(rowCount - 1, columns.length - 1, extend);
        else moveCursor(active.row, columns.length - 1, extend);
        break;
      default:
        handled = false;
    }
    if (handled) {
      ev.preventDefault();
      return;
    }
    if (!hooks) return;
    const action = resolveShortcut(ev, 'grid');
    if (action === 'edit') {
      ev.preventDefault();
      hooks.onEdit(active.row, active.col, null);
    } else if (action === 'cancel') {
      if (!selection.isSingle()) {
        selection.setActive(active.row, active.col);
        scheduleRender();
      }
    } else if (action === 'clear') {
      ev.preventDefault();
      hooks.onClear(selection.getRange());
    } else if (action === 'copy') {
      ev.preventDefault();
      hooks.onCopy(selection.getRange());
    } else if (action === 'selectAll') {
      ev.preventDefault();
      selection.selectAll();
      scheduleRender();
    } else if (action === 'rowInsert') {
      ev.preventDefault();
      hooks.onRowInsert();
    } else if (action === 'rowDelete') {
      ev.preventDefault();
      hooks.onRowDelete(selection.getRange());
    } else if (action === 'columnMenu') {
      ev.preventDefault();
      headerCtl.openMenu(active.col);
    } else if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      // 셀에서 바로 타이핑: 첫 글자를 편집기의 초기값으로 넘긴다(Step 5 예외 처리).
      ev.preventDefault();
      hooks.onEdit(active.row, active.col, ev.key);
    }
  };

  /** @param {ClipboardEvent} ev */
  const onPaste = (ev) => {
    if (!hooks || !table) return;
    if (ev.target instanceof HTMLElement && ev.target.closest('.jdr-editor')) return;
    // 머리글 이름 편집기에 붙여넣는 글자는 그 입력칸의 것이다.
    if (ev.target !== scroller) return;
    const text = ev.clipboardData?.getData('text/plain') ?? '';
    if (!text) return;
    ev.preventDefault();
    // 앵커는 범위의 왼쪽 위다. 활성 셀은 범위를 어느 방향으로 넓혔느냐에 따라 네 귀퉁이 중
    // 아무 데나 있을 수 있어(아래로 끌면 오른쪽 아래, Ctrl+A면 마지막 행), 그것을 앵커로 쓰면
    // 복사한 범위를 그 자리에 다시 붙여넣는 것만으로 값이 밀린다.
    const range = selection.getRange();
    hooks.onPaste(text, { row: range.r0, col: range.c0 });
  };
  const onRowInsertClick = () => hooks?.onRowInsert();
  const onRowDeleteClick = () => hooks?.onRowDelete(selection.getRange());

  /**
   * 편집기 위에서 굴린 휠은 오버레이(스크롤러 밖)에 떨어진다. 스크롤러에 넘겨 편집 중에도 스크롤되게 한다.
   * `deltaY`·`deltaX`의 단위는 `deltaMode`가 정한다. 크로미움의 트랙패드·휠은 픽셀(0)이지만 파이어폭스의
   * 마우스 휠은 줄(1, `deltaY` 3)이고 Page Up/Down 장치는 쪽(2)이다. 그대로 더하면 줄 단위 휠 한 번이
   * 3 px만 움직인다. 브라우저가 스크롤러 안에서 하던 것과 같도록 픽셀로 바꾼다.
   * @param {WheelEvent} ev
   */
  function onOverlayWheel(ev) {
    const factorY =
      ev.deltaMode === 1 ? ROW_HEIGHT : ev.deltaMode === 2 ? Math.max(1, viewportHeight) : 1;
    const factorX =
      ev.deltaMode === 1 ? ROW_HEIGHT : ev.deltaMode === 2 ? Math.max(1, viewportWidth) : 1;
    scroller.scrollTop += ev.deltaY * factorY;
    scroller.scrollLeft += ev.deltaX * factorX;
  }

  /**
   * 리스너는 마운트에서 한 번에 걸고 언마운트에서 한 번에 뗀다(CLAUDE.md 5.5). 등록을 `createGrid`에
   * 두면 `unmount()` → `mount()`를 거친 그리드에서 스크롤 외의 상호작용이 모두 죽는다.
   */
  function addListeners() {
    scroller.addEventListener('scroll', onScroll, { passive: true });
    overlay.addEventListener('wheel', onOverlayWheel, { passive: true });
    frozenSelect.addEventListener('change', onFrozenChange);
    header.addEventListener('pointerdown', onHeaderPointerDown);
    header.addEventListener('pointermove', onHeaderPointerMove);
    header.addEventListener('pointerup', onHeaderPointerUp);
    header.addEventListener('pointercancel', onHeaderPointerUp);
    headerCtl.mount(header);
    clearFiltersButton.addEventListener('click', onClearFilters);
    canvas.addEventListener('pointerdown', onCanvasPointerDown);
    canvas.addEventListener('pointermove', onCanvasPointerMove);
    canvas.addEventListener('pointerup', onCanvasPointerUp);
    canvas.addEventListener('pointercancel', onCanvasPointerUp);
    canvas.addEventListener('dblclick', onCanvasDblClick);
    scroller.addEventListener('keydown', onKeydown);
    scroller.addEventListener('paste', onPaste);
    rowInsertButton.addEventListener('click', onRowInsertClick);
    rowDeleteButton.addEventListener('click', onRowDeleteClick);
  }

  function removeListeners() {
    scroller.removeEventListener('scroll', onScroll);
    overlay.removeEventListener('wheel', onOverlayWheel);
    frozenSelect.removeEventListener('change', onFrozenChange);
    header.removeEventListener('pointerdown', onHeaderPointerDown);
    header.removeEventListener('pointermove', onHeaderPointerMove);
    header.removeEventListener('pointerup', onHeaderPointerUp);
    header.removeEventListener('pointercancel', onHeaderPointerUp);
    headerCtl.unmount();
    clearFiltersButton.removeEventListener('click', onClearFilters);
    canvas.removeEventListener('pointerdown', onCanvasPointerDown);
    canvas.removeEventListener('pointermove', onCanvasPointerMove);
    canvas.removeEventListener('pointerup', onCanvasPointerUp);
    canvas.removeEventListener('pointercancel', onCanvasPointerUp);
    canvas.removeEventListener('dblclick', onCanvasDblClick);
    scroller.removeEventListener('keydown', onKeydown);
    scroller.removeEventListener('paste', onPaste);
    rowInsertButton.removeEventListener('click', onRowInsertClick);
    rowDeleteButton.removeEventListener('click', onRowDeleteClick);
  }

  function clearRows() {
    for (const slot of active.values()) releaseRow(slot);
    active.clear();
  }

  /** @type {Grid} */
  const grid = {
    el,

    mount(container, options) {
      if (!mounted) {
        container.append(el);
        addListeners();
        resizeObserver?.observe(scroller);
        mounted = true;
      }
      // 같은 테이블에서 정렬·필터·검색을 켜 빈 행이 꺼지면, 빈 행에 열려 있던 편집기는 가리킬 행이 없다(D-16).
      if (ghost && table?.id === options.table.id) {
        const spec = normalizeViewSpec(options.viewSpec);
        if (spec.sort.length > 0 || spec.filter !== null || spec.search !== '') {
          hooks?.onGhostDisabled();
        }
      }
      headerCtl.close();
      hooks?.onReset();
      generation += 1;
      inflight.clear();
      cache.invalidate();
      clearRows();
      table = options.table;
      viewSpec = options.viewSpec;
      columns = visibleColumns(table, viewSpec);
      selection.reset();
      selection.setBounds(0, columns.length);
      rowCount = 0;
      countKnown = false;
      ghost = false;
      stats.rowCount = 0;
      applyColumnLayout(options.view);
      buildHeader();
      scroller.scrollTop = 0;
      scroller.scrollLeft = 0;
      rowCountLabel.textContent = '';
      scroller.setAttribute('aria-colcount', String(columns.length + 1));
      renderNoMatch();
      void recount(table.id, generation);
      scheduleRender();
    },

    applyView(view) {
      if (!table) return;
      applyColumnLayout(view);
      scheduleRender();
    },

    applyTable(next) {
      if (!mounted || !table || next.id !== table.id) return false;
      const nextColumns = visibleColumns(next, viewSpec);
      if (nextColumns.length !== columns.length) return false;
      for (let i = 0; i < nextColumns.length; i += 1) {
        if (nextColumns[i]?.id !== columns[i]?.id) return false;
      }
      table = next;
      columns = nextColumns;
      buildHeader();
      // 목록을 다시 읽은 이유(스키마 op, 저널 재생)가 행도 바꿨을 수 있으므로 데이터는 버린다.
      grid.invalidate();
      return true;
    },

    setRowCount(n) {
      rowCount = Math.max(0, Math.trunc(n));
      countKnown = true;
      ghost = computeGhost();
      stats.rowCount = rowCount;
      // 행 수 표시는 실제 행만 센다. 빈 행은 DB에 없다.
      rowCountLabel.textContent = t('grid.rowCount', { count: formatInteger(rowCount) });
      applyRowLayout();
      rowDeleteButton.disabled = rowCount === 0;
      renderNoMatch();
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
      // 블록을 버리지 않고 낡은 것으로만 표시한다. 새 응답이 올 때까지 옛 행을 그려 깜빡임을 없앤다.
      cache.markStale(table.id);
      void recount(table.id, generation);
      scheduleRender();
    },

    ghostRowsEnabled: () => ghost,
    isGhostRow: (row) => ghost && row >= rowCount,
    displayRowCount: () => displayCount(),

    refreshGhost() {
      if (!table) return;
      // 읽기 전용이 되거나 풀리면 머리글의 편집 표시가 바뀐다. 상태 변경 알림은 저장 때마다 오므로
      // 쓰기 가능 여부가 실제로 바뀐 때만 머리글을 다시 만든다.
      if (writableNow() !== headerWritable) buildHeader();
      const next = computeGhost();
      if (next === ghost) return;
      if (!next) hooks?.onGhostDisabled();
      ghost = next;
      applyRowLayout();
      scheduleRender();
    },

    startRename(columnId) {
      const col = columns.findIndex((c) => c.id === columnId);
      // "+ 열" 직후의 이름은 열 추가와 한 번에 되돌린다(D-16).
      if (col >= 0) headerCtl.openRename(col, { mergeWithAdd: true });
    },

    scrollToRow(row) {
      const target = clamp(row, 0, Math.max(0, displayCount() - 1));
      scroller.scrollTop = contentToScroll(target * ROW_HEIGHT, viewportHeight, layout());
    },

    scrollToCell(row, col) {
      const target = clamp(row, 0, Math.max(0, displayCount() - 1));
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
      scrollToColumn(col);
    },

    stats: () => ({ ...stats }),

    unmount() {
      if (!mounted) return;
      headerCtl.close();
      hooks?.onReset();
      if (rafId !== 0) cancelAnimationFrame(rafId);
      rafId = 0;
      removeListeners();
      resizeObserver?.disconnect();
      generation += 1;
      inflight.clear();
      cache.invalidate();
      clearRows();
      table = null;
      ghost = false;
      countKnown = false;
      noMatch.hidden = true;
      el.remove();
      mounted = false;
    },

    setHooks(next) {
      hooks = next;
    },

    selection: () => selection,

    moveCursor(row, col, extend = false) {
      moveCursor(row, col, extend);
    },

    table: () => table,
    viewSpec: () => viewSpec,
    columns: () => columns,
    rowCount: () => rowCount,

    cellInfo(row, col) {
      const column = columns[col];
      const data = rowAt(row);
      if (!column || !data) return null;
      return {
        rowId: data.id,
        column,
        value: data.cells[col] ?? null,
        length: data.lengths[col] ?? null,
        stale: lastRowStale,
      };
    },

    cellRect(row, col) {
      const c = clamp(col, 0, Math.max(0, columns.length - 1));
      const scrollLeft = scroller.scrollLeft;
      const scrollTop = scroller.scrollTop;
      const range = computeRange(scrollTop, viewportHeight, layout());
      const top = range.offsetY + (row - range.first) * ROW_HEIGHT;
      const isFrozen = c < frozen;
      // 오버레이 기준: 캔버스 좌표에서 스크롤만큼 뺀다. 고정 열은 스크롤과 무관하게 제자리다.
      return {
        left: (lefts[c] ?? 0) - (isFrozen ? 0 : scrollLeft),
        top: top - scrollTop,
        width: widths[c] ?? 0,
        height: ROW_HEIGHT,
      };
    },

    patchCell(rowId, colId, value) {
      if (!table) return;
      const col = columns.findIndex((c) => c.id === colId);
      if (col < 0) return;
      const column = columns[col];
      for (const block of cache.blocks(table.id)) {
        const row = block.rows.find((r) => r.id === rowId);
        if (!row) continue;
        const isText = column?.type === 'text' || column?.type === 'longtext';
        if (isText && typeof value === 'string' && value.length > PREVIEW_CHARS) {
          row.cells[col] = value.slice(0, PREVIEW_CHARS);
          row.lengths[col] = value.length;
        } else {
          row.cells[col] = value;
          row.lengths[col] = null;
        }
        dataVersion += 1;
        block.version = dataVersion;
        scheduleRender();
        return;
      }
    },

    editorHost: overlay,

    focus() {
      scroller.focus();
    },
  };
  return grid;
}

/**
 * @typedef {object} GridHost
 * @property {HTMLElement} el
 * @property {() => GridStats | null} stats 열린 그리드의 통계(테스트·진단용). 그리드가 없으면 null
 * @property {(tableId: string, columnId: string) => void} startRename 열린 그리드가 그 테이블이면 그 열의 머리글 이름 편집기를 연다("+ 열" 직후, D-16)
 * @property {() => void} unmount
 */

/**
 * 메인 영역의 그리드 호스트: 스토어의 선택·테이블·뷰·데이터 변경을 구독해 그리드를 열고 닫고,
 * 테이블이 없거나 열이 없으면 빈 상태를 보여 준다. 편집 컨트롤러(Step 5)를 그리드에 잇는다.
 * @param {HTMLElement} container
 * @param {{ store: Store, client: Client, toasts: Toasts, commands: SchemaCommands, history: History, longtext: LongtextPanel, confirmIrreversible: (info: { count: number }) => Promise<boolean> }} deps
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
  /** 열린 그리드의 뷰 사양 키. 정렬·필터·검색·숨김이 바뀌면 다시 마운트한다(Step 6). */
  let openSpecKey = '';
  let gridMounted = false;

  const grid = createGrid({
    client,
    store,
    toasts,
    commands: deps.commands,
    onError: (err) => {
      // 창 질의 실패(테이블이 삭제됨 등): 빈 상태로 그리고 사이드바로 복귀(Step 4 예외 처리).
      toasts.error(err);
      closeGrid();
      store.selectTable(null);
      store.refreshTables().catch((/** @type {unknown} */ e) => toasts.error(toAppError(e)));
    },
  });

  const editing = createEditingController({
    grid,
    client,
    store,
    history: deps.history,
    toasts,
    longtext: deps.longtext,
    confirmIrreversible: deps.confirmIrreversible,
  });

  function closeGrid() {
    if (gridMounted) grid.unmount();
    gridMounted = false;
    openTableId = null;
  }

  /** @param {'grid.noTable' | 'grid.noColumns' | 'grid.allHidden' | null} key */
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
    const viewSpec = store.viewSpecOf(table.id);
    if (visibleColumns(table, viewSpec).length === 0) {
      closeGrid();
      showEmpty('grid.allHidden');
      return;
    }
    showEmpty(null);
    const specKey = JSON.stringify(viewSpec);
    // 열 이름만 바뀐 경우까지 다시 마운트하면 스크롤 위치·활성 셀·열 너비가 처음으로 돌아간다.
    if (
      gridMounted &&
      openTableId === table.id &&
      openSpecKey === specKey &&
      grid.applyTable(table)
    )
      return;
    grid.mount(el, { table, viewSpec, view: store.getViewState(table.id) });
    gridMounted = true;
    openTableId = table.id;
    openSpecKey = specKey;
  }

  const unsubscribe = [
    store.on('selection:changed', sync),
    store.on('tables:changed', sync),
    store.on('file:opened', sync),
    store.on('view:changed', () => {
      if (!openTableId) return;
      // 정렬·필터·검색·숨김이 바뀌면 다른 행 집합·순서이므로 다시 마운트하고, 너비·고정 열만 바뀌면 배치만 고친다.
      if (JSON.stringify(store.viewSpecOf(openTableId)) !== openSpecKey) sync();
      else grid.applyView(store.getViewState(openTableId));
    }),
    store.on('data:changed', () => {
      if (openTableId) grid.invalidate();
    }),
    // 읽기 전용이 되거나 풀리면 빈 행과 머리글의 편집 표시가 바뀐다(D-16).
    store.on('state:changed', () => {
      if (gridMounted) grid.refreshGhost();
    }),
  ];
  sync();

  return {
    el,
    stats: () => (gridMounted ? grid.stats() : null),
    startRename(tableId, columnId) {
      if (gridMounted && openTableId === tableId) grid.startRename(columnId);
    },
    unmount() {
      for (const off of unsubscribe) off();
      closeGrid();
      editing.dispose();
      el.remove();
    },
  };
}
