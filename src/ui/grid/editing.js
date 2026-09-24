// @ts-check
/**
 * 편집 컨트롤러(Step 5): 그리드의 선택·키·포인터 요청을 받아 편집기를 열고, 데이터 커맨드를 만들어
 * 히스토리로 적용한다. 그리드 자체는 커맨드를 모른다.
 *
 * - 셀 편집: 인라인 편집기(`editor/inline.js`). `longtext` 열은 사이드 패널(`editor/longtext.js`),
 *   `boolean` 열은 편집기 없이 값을 뒤집는다.
 * - 되돌리기에 필요한 옛 값(`_updated_at` 포함)은 확정 시점에 `query.row`로 읽는다. 그리드 캐시의 값은
 *   미리보기일 수 있고, 다른 경로(되돌리기)가 그 사이 셀을 바꿨을 수도 있다.
 * - 범위 지우기·붙여넣기·행 삭제는 `query.rows`로 옛 값을 읽어 복합 커맨드 하나로 만든다(D-08).
 *   1만 행을 넘으면 확인을 받고 되돌릴 수 없는 커맨드로 적용하는데, 그때는 옛 값을 읽지 않는다.
 *   지우기·삭제는 문장 하나(`clearRowRange`·`deleteRowRange`)이고, 붙여넣기만 덮어쓸 행의 id가
 *   필요해 그 행들을 읽는다(붙여넣는 셀 수가 100만으로 묶여 있어 범위가 한정된다).
 * - 복사는 `navigator.clipboard.writeText`, 붙여넣기는 그리드가 받는 `paste` 이벤트다.
 * - 뷰(Step 6): 행 읽기(`query.rows`)와 되돌릴 수 없는 범위 커맨드에 그리드의 뷰 사양을 그대로 넘겨,
 *   정렬·필터·검색이 있어도 그리드의 행 순번이 가리키는 행을 다룬다.
 * - 빈 행(D-16): k번째 빈 행의 셀에 값을 확정하면(인라인·장문 편집기, 불리언, 붙여넣기) 그 줄까지 k행을
 *   만들고 마지막 행에 값을 넣는 `cell.bulkEdit` 하나를 적용한다. 되돌리기 한 번에 만든 행이 모두 사라진다.
 *   지우기·행 삭제는 실제 행 부분에만, 복사는 빈 행을 빈 칸으로 낸다.
 */
import {
  bulkEdit,
  clearRowRange,
  deleteRowRange,
  deleteRows,
  editCell,
  ghostRowInserts,
  insertRows,
  PASTE_MAX_CELLS,
  UNDO_SNAPSHOT_MAX_ROWS,
} from '../../app/commands.js';
import { MAX_RESULT_ROWS } from '../../db/engine.js';
import { buildViewClauses, normalizeViewSpec } from '../../db/query.js';
import { nowIso } from '../../db/schema.js';
import { toAppError } from '../../util/errors.js';
import { formatInteger } from '../../util/format.js';
import { createInlineEditor } from '../editor/inline.js';
import { cellToText, convertPastedCell, parseTsv, planPaste, serializeTsv } from './clipboard.js';

/** @typedef {import('./grid.js').Grid} Grid */
/** @typedef {import('./selection.js').CellRange} CellRange */
/** @typedef {import('../../app/store.js').Store} Store */
/** @typedef {import('../../app/history.js').History} History */
/** @typedef {import('../../app/commands.js').RowEdit} RowEdit */
/** @typedef {import('../../app/commands.js').RowInsert} RowInsert */
/** @typedef {import('../../db/client.js').Client} Client */
/** @typedef {import('../../db/engine.js').SqlValue} SqlValue */
/** @typedef {import('../../db/query.js').FullRow} FullRow */
/** @typedef {import('../../db/tables.js').ColumnInfo} ColumnInfo */
/** @typedef {import('../../db/tables.js').TableInfo} TableInfo */
/** @typedef {import('../editor/longtext.js').LongtextPanel} LongtextPanel */
/** @typedef {import('../toast.js').Toasts} Toasts */

/**
 * 그리드가 편집 컨트롤러에 넘기는 요청.
 * @typedef {object} GridHooks
 * @property {(row: number, col: number, initialText: string | null) => void} onEdit Enter·F2·더블클릭·타이핑. `initialText`는 타이핑한 첫 글자
 * @property {(range: CellRange) => void} onClear Delete·Backspace: 범위를 NULL로
 * @property {(range: CellRange) => void} onCopy Ctrl+C
 * @property {(text: string, anchor: { row: number, col: number }) => void} onPaste `paste` 이벤트의 텍스트
 * @property {() => void} onRowInsert
 * @property {(range: CellRange) => void} onRowDelete
 * @property {() => void} onReset 그리드가 다른 테이블로 바뀌거나 내려갈 때. 편집기를 닫는다
 * @property {() => void} onRelayout 렌더 끝. 열려 있는 편집기를 편집 중인 칸 위에 다시 놓는다
 * @property {() => void} onGhostDisabled 빈 행이 꺼지기 직전(정렬·필터·검색을 켬, 읽기 전용이 됨). 빈 행의 편집기를 닫고 알린다
 */

/**
 * @typedef {object} EditingController
 * @property {GridHooks} hooks
 * @property {() => void} dispose
 */

/**
 * @typedef {object} EditingDeps
 * @property {Grid} grid
 * @property {Client} client
 * @property {Store} store
 * @property {History} history
 * @property {Toasts} toasts
 * @property {LongtextPanel} longtext
 * @property {(info: { count: number }) => Promise<boolean>} confirmIrreversible 스냅샷 상한을 넘는 작업의 확인
 * @property {(text: string) => Promise<void>} [writeClipboard] 테스트용 주입. 기본은 `navigator.clipboard.writeText`
 */

/**
 * @param {EditingDeps} deps
 * @returns {EditingController}
 */
export function createEditingController(deps) {
  const { grid, client, store, history, toasts, longtext } = deps;
  const inline = createInlineEditor();
  grid.editorHost.append(inline.el);
  const writeClipboard = deps.writeClipboard ?? ((text) => navigator.clipboard.writeText(text));

  /**
   * 편집할 수 있는 상태인가. 아니면 안내하고 false.
   * @returns {TableInfo | null}
   */
  function editableTable() {
    const table = grid.table();
    if (!table) return null;
    if (store.getState().readOnly !== 'none' || !table.strict) {
      toasts.info('file.readOnlyBlocked');
      return null;
    }
    return table;
  }

  /**
   * 확정 시점의 옛 값. 행이 사라졌으면 null.
   * @param {string} tableId
   * @param {number} rowId
   * @param {string} colId
   * @returns {Promise<{ value: SqlValue, updatedAt: string | null } | null>}
   */
  async function readOld(tableId, rowId, colId) {
    const { row } = await client.call('query.row', { tableId, rowId, colIds: [colId] });
    if (!row) return null;
    return { value: row.cells[colId] ?? null, updatedAt: row.updatedAt };
  }

  /**
   * 셀 하나의 편집 커맨드를 적용한다. 성공하면 그리드 캐시를 직접 고친다(다시 읽지 않는다).
   * @param {{ tableId: string, rowId: number, column: ColumnInfo, newValue: SqlValue }} input
   * @returns {Promise<boolean>}
   */
  async function applyCellEdit(input) {
    /** @type {{ value: SqlValue, updatedAt: string | null } | null} */
    let old;
    try {
      old = await readOld(input.tableId, input.rowId, input.column.id);
    } catch (err) {
      toasts.error(toAppError(err));
      return false;
    }
    if (!old) {
      toasts.info('edit.rowGone');
      store.refreshData();
      return false;
    }
    if (old.value === input.newValue) return true;
    const cmd = editCell({
      tableId: input.tableId,
      rowId: input.rowId,
      colId: input.column.id,
      oldValue: old.value,
      newValue: input.newValue,
      oldUpdatedAt: old.updatedAt,
      now: nowIso(),
    });
    const result = await history.apply(cmd, { refresh: false });
    if (!result) return false;
    grid.patchCell(input.rowId, input.column.id, input.newValue);
    return true;
  }

  /**
   * @param {number} row
   * @param {number} col
   * @param {string | null} initialText
   */
  async function openEditor(row, col, initialText) {
    const table = editableTable();
    if (!table) return;
    if (grid.isGhostRow(row)) {
      openGhostEditor(table, row, col, initialText);
      return;
    }
    const info = grid.cellInfo(row, col);
    if (!info) return;
    const { column } = info;
    if (column.type === 'boolean') {
      if (initialText !== null) return;
      const current = info.value === null || info.value === undefined ? null : Number(info.value);
      await applyCellEdit({
        tableId: table.id,
        rowId: info.rowId,
        column,
        newValue: current === 1 ? 0 : 1,
      });
      grid.focus();
      return;
    }
    if (column.type === 'longtext') {
      if (initialText !== null) return;
      await longtext.open({
        tableId: table.id,
        tableName: table.name,
        rowId: info.rowId,
        rowIndex: row,
        column,
      });
      return;
    }
    let text = cellToText(column, info.value);
    if ((info.length !== null || info.stale) && initialText === null) {
      // 전문을 읽은 뒤 열어야 하는 두 경우.
      // - 미리보기가 잘린 텍스트 셀: 캐시에 256자만 있다.
      // - 낡은 블록의 셀(D-06): 화면은 옛 값을 그리고 있는데 DB는 이미 바뀌었을 수 있다. 그 값을
      //   편집기에 실으면 아무것도 고치지 않고 확정하는 것만으로 되돌린 값이 다시 저장된다.
      // 블록이 최신이면 왕복 없이 캐시에서 연다(실측: 왕복 2.2 ms, 쓰기가 도는 중이면 수백 ms).
      try {
        const old = await readOld(table.id, info.rowId, column.id);
        if (!old) {
          toasts.info('edit.rowGone');
          return;
        }
        text = cellToText(column, old.value);
      } catch (err) {
        toasts.error(toAppError(err));
        return;
      }
    }
    const rowId = info.rowId;
    inline.open(
      { row, col, column, rect: grid.cellRect(row, col), text },
      {
        initialText: initialText ?? undefined,
        onCommit: async (value, reason) => {
          const ok = await applyCellEdit({ tableId: table.id, rowId, column, newValue: value });
          if (!ok) return false;
          if (reason === 'enter') grid.moveCursor(row + 1, col);
          else if (reason === 'tab') grid.moveCursor(row, col + 1);
          if (reason !== 'blur') grid.focus();
          return true;
        },
        onCancel: () => {
          grid.focus();
        },
        onRevert: () => {
          toasts.info('edit.reverted');
        },
      },
    );
  }

  /**
   * 빈 행 `row`의 셀에 값을 확정한다(D-16): 그 줄까지 행을 만들고 마지막 행에 값을 넣는 커맨드 하나.
   * 행 수와 새 id는 확정 시점에 `query.stats`로 읽는다(빈 행이 켜진 뷰는 필터가 없어 테이블 행 수와 같다).
   * 실패하면 트랜잭션이 롤백되어 행이 하나도 생기지 않는다(오류 알림은 히스토리가 한다).
   * @param {TableInfo} table
   * @param {number} row
   * @param {ColumnInfo} column
   * @param {SqlValue} value
   * @returns {Promise<boolean>}
   */
  async function commitGhost(table, row, column, value) {
    try {
      const { count, maxId } = await client.call('query.stats', { tableId: table.id });
      const k = row - count + 1;
      if (k < 1) {
        // 확정하는 사이 그 자리에 실제 행이 생겼다(다른 경로의 커맨드). 입력값은 버리고 다시 읽는다.
        toasts.info('edit.reverted');
        store.refreshData();
        return false;
      }
      const inserts = ghostRowInserts({
        firstId: (maxId ?? 0) + 1,
        count: k,
        cells: { [column.id]: value },
      });
      const result = await history.apply(
        bulkEdit({ tableId: table.id, edits: [], inserts, now: nowIso() }),
      );
      if (!result) return false;
      // 행 수는 다시 세어 오지만, 커서가 방금 만든 행에 머물도록 먼저 늘려 둔다.
      grid.setRowCount(count + k);
      return true;
    } catch (err) {
      toasts.error(toAppError(err));
      return false;
    }
  }

  /**
   * 빈 행의 셀 편집기. DB에 행이 없으므로 빈 값으로 연다.
   * @param {TableInfo} table
   * @param {number} row
   * @param {number} col
   * @param {string | null} initialText
   */
  function openGhostEditor(table, row, col, initialText) {
    const column = grid.columns()[col];
    if (!column) return;
    if (column.type === 'boolean') {
      if (initialText !== null) return;
      // 빈 칸의 불리언을 누르면 참이 된다(행이 없는 칸의 값은 비어 있다).
      void commitGhost(table, row, column, 1).then(() => grid.focus());
      return;
    }
    if (column.type === 'longtext') {
      if (initialText !== null) return;
      void longtext.open({
        tableId: table.id,
        tableName: table.name,
        rowId: null,
        rowIndex: row,
        column,
        // 빈 값 확정은 만들 것이 없다. 행을 만들지 않고 닫는다.
        commit: (newValue) =>
          newValue === null ? Promise.resolve(true) : commitGhost(table, row, column, newValue),
      });
      return;
    }
    inline.open(
      { row, col, column, rect: grid.cellRect(row, col), text: '' },
      {
        initialText: initialText ?? undefined,
        onCommit: async (value, reason) => {
          // 빈 값 확정은 만들 것이 없다. 행을 만들지 않고 이동만 한다.
          if (value !== null && !(await commitGhost(table, row, column, value))) return false;
          if (reason === 'enter') grid.moveCursor(row + 1, col);
          else if (reason === 'tab') grid.moveCursor(row, col + 1);
          if (reason !== 'blur') grid.focus();
          return true;
        },
        onCancel: () => {
          grid.focus();
        },
        onRevert: () => {
          toasts.info('edit.reverted');
        },
      },
    );
  }

  /** 필터나 검색이 있어 새 행이 보이지 않을 수 있는가(Step 6 예외 처리). */
  function filteredView() {
    const spec = normalizeViewSpec(grid.viewSpec());
    return spec.filter !== null || spec.search !== '';
  }

  /**
   * 뷰 순서로 범위의 전문 행을 읽는다(1만 행 단위로 나눠서). 그리드와 같은 뷰 사양을 넘긴다.
   * @param {string} tableId
   * @param {number} offset
   * @param {number} count
   * @param {string[]} colIds
   * @returns {Promise<FullRow[]>}
   */
  async function readRows(tableId, offset, count, colIds) {
    /** @type {FullRow[]} */
    const out = [];
    const viewSpec = grid.viewSpec();
    for (let done = 0; done < count; done += MAX_RESULT_ROWS) {
      const { rows } = await client.call('query.rows', {
        tableId,
        viewSpec,
        offset: offset + done,
        limit: Math.min(MAX_RESULT_ROWS, count - done),
        colIds,
      });
      out.push(...rows);
      if (rows.length < Math.min(MAX_RESULT_ROWS, count - done)) break;
    }
    return out;
  }

  /** @param {CellRange} range */
  async function clearRange(range) {
    // 빈 행에는 지울 값이 없다. 실제 행 부분만 지우고, 선택이 빈 행뿐이면 아무것도 하지 않는다(D-16).
    const r1 = Math.min(range.r1, grid.rowCount() - 1);
    if (r1 < range.r0) return;
    const table = editableTable();
    if (!table) return;
    const columns = grid.columns().slice(range.c0, range.c1 + 1);
    const count = r1 - range.r0 + 1;
    if (columns.length === 0) return;
    if (count > UNDO_SNAPSHOT_MAX_ROWS) {
      // 되돌릴 수 없으므로 옛 값이 필요 없다. 읽으면 범위 전체가 메인 스레드로 올라온다
      // (30만 행 × 20열이면 수 GB. 미리보기가 아니라 전문이다).
      if (!(await deps.confirmIrreversible({ count }))) return;
      await history.apply(
        clearRowRange({
          tableId: table.id,
          colIds: columns.map((c) => c.id),
          offset: range.r0,
          count,
          now: nowIso(),
          clauses: buildViewClauses(table, grid.viewSpec()),
        }),
      );
      return;
    }
    /** @type {RowEdit[]} */
    let edits;
    try {
      const rows = await readRows(
        table.id,
        range.r0,
        count,
        columns.map((c) => c.id),
      );
      edits = rows
        .map((row) => ({
          rowId: row.id,
          oldUpdatedAt: row.updatedAt,
          cells: columns
            .filter((c) => (row.cells[c.id] ?? null) !== null)
            .map((c) => ({ colId: c.id, oldValue: row.cells[c.id] ?? null, newValue: null })),
        }))
        .filter((edit) => edit.cells.length > 0);
    } catch (err) {
      toasts.error(toAppError(err));
      return;
    }
    if (edits.length === 0) return;
    await history.apply(bulkEdit({ tableId: table.id, edits, now: nowIso() }));
  }

  /** @param {CellRange} range */
  async function copyRange(range) {
    const table = grid.table();
    if (!table) return;
    const columns = grid.columns().slice(range.c0, range.c1 + 1);
    const count = range.r1 - range.r0 + 1;
    if (count * columns.length > PASTE_MAX_CELLS) {
      toasts.info('copy.tooLarge');
      return;
    }
    try {
      // 빈 행(D-16)은 DB에 없으므로 읽지 않고 빈 칸으로 낸다.
      const real = Math.max(0, Math.min(range.r1, grid.rowCount() - 1) - range.r0 + 1);
      const rows =
        real > 0
          ? await readRows(
              table.id,
              range.r0,
              real,
              columns.map((c) => c.id),
            )
          : [];
      const lines = rows.map((row) => columns.map((c) => cellToText(c, row.cells[c.id] ?? null)));
      while (lines.length < count) lines.push(columns.map(() => ''));
      const tsv = serializeTsv(lines);
      await writeClipboard(tsv);
      toasts.info('copy.done', {
        rows: formatInteger(lines.length),
        cols: formatInteger(columns.length),
      });
    } catch (err) {
      const appErr = toAppError(err);
      if (appErr.code === 'E_UNKNOWN') toasts.info('copy.failed');
      else toasts.error(appErr);
    }
  }

  /**
   * @param {string} text
   * @param {{ row: number, col: number }} anchor
   */
  async function pasteText(text, anchor) {
    const table = editableTable();
    if (!table) return;
    const data = parseTsv(text);
    if (data.length === 0) return;
    const columns = grid.columns();
    /** @type {import('./clipboard.js').PastePlan} */
    let plan;
    try {
      plan = planPaste({ data, anchor, rowCount: grid.rowCount(), colCount: columns.length });
    } catch (err) {
      toasts.error(toAppError(err));
      return;
    }
    // 붙여넣을 줄이 빈 행 자리의 빈 줄뿐이면 만들 것이 없다(D-16).
    if (plan.cols === 0 || plan.rows === 0) return;
    const targets = columns.slice(anchor.col, anchor.col + plan.cols);
    // 빈 행에서 시작하면(D-16) 마지막 실제 행과 시작 행 사이의 빈 행도 빈 값으로 만든다.
    const irreversible = plan.gapRows + plan.rows > UNDO_SNAPSHOT_MAX_ROWS;
    if (irreversible && !(await deps.confirmIrreversible({ count: plan.gapRows + plan.rows }))) {
      return;
    }

    // 값 변환(전체를 먼저 검증한다. 일부만 들어가면 무엇이 들어갔는지 알 수 없다).
    /** @type {import('../../db/values.js').StoredValue[][]} */
    const converted = [];
    try {
      // 끝의 빈 줄(`plan.trailingEmpty`)은 버렸으므로 `plan.rows`줄만 변환한다.
      for (let r = 0; r < plan.rows; r += 1) {
        const line = data[r] ?? [];
        converted.push(
          targets.map((column, c) => convertPastedCell(column, line[c] ?? '', { row: r, col: c })),
        );
      }
    } catch (err) {
      const appErr = toAppError(err);
      toasts.error(appErr);
      const detail = /** @type {{ row?: number, columnName?: string }} */ (appErr.detail ?? {});
      if (typeof detail.row === 'number') {
        // `detail.row`는 붙여넣기 데이터 안에서의 순번이다. 사용자가 찾아갈 수 있도록
        // 앵커를 더해 그리드의 행 번호로 알린다.
        toasts.info('paste.invalidAt', {
          row: anchor.row + detail.row + 1,
          column: detail.columnName ?? '',
        });
      }
      return;
    }

    try {
      /** @type {RowEdit[]} */
      const edits = [];
      if (plan.existingRows > 0) {
        const existing = await readRows(
          table.id,
          anchor.row,
          plan.existingRows,
          targets.map((c) => c.id),
        );
        existing.forEach((row, r) => {
          const values = converted[r] ?? [];
          edits.push({
            rowId: row.id,
            oldUpdatedAt: row.updatedAt,
            cells: targets.map((c, k) => ({
              colId: c.id,
              oldValue: row.cells[c.id] ?? null,
              newValue: values[k] ?? null,
            })),
          });
        });
      }
      /** @type {RowInsert[]} */
      const inserts = [];
      if (plan.newRows > 0) {
        const { maxId } = await client.call('query.stats', { tableId: table.id });
        let firstId = (maxId ?? 0) + 1;
        for (let r = 0; r < plan.gapRows; r += 1) inserts.push({ id: firstId + r, cells: {} });
        firstId += plan.gapRows;
        for (let r = 0; r < plan.newRows; r += 1) {
          const values = converted[plan.existingRows + r] ?? [];
          /** @type {Record<string, SqlValue>} */
          const cells = {};
          targets.forEach((c, k) => {
            cells[c.id] = values[k] ?? null;
          });
          inserts.push({ id: firstId + r, cells });
        }
      }
      const result = await history.apply(
        bulkEdit({ tableId: table.id, edits, inserts, now: nowIso(), irreversible }),
      );
      if (!result) return;
    } catch (err) {
      toasts.error(toAppError(err));
      return;
    }
    if (plan.newRows > 0 && filteredView()) toasts.info('edit.rowHiddenByFilter');
    if (plan.droppedColumns > 0) {
      toasts.info('paste.columnsDropped', { count: formatInteger(plan.droppedColumns) });
    }
    toasts.info('paste.done', { rows: formatInteger(plan.rows), cols: formatInteger(plan.cols) });
    // 행 수는 다시 세어 오지만, 붙여넣은 범위를 바로 선택해 보여 주기 위해 먼저 늘려 둔다.
    grid.setRowCount(Math.max(grid.rowCount(), anchor.row + plan.rows));
    const selection = grid.selection();
    selection.setActive(anchor.row, anchor.col);
    selection.extendTo(anchor.row + plan.rows - 1, anchor.col + plan.cols - 1);
    grid.focus();
  }

  async function insertRow() {
    const table = editableTable();
    if (!table) return;
    /** @type {number} */
    let firstId;
    try {
      const { maxId } = await client.call('query.stats', { tableId: table.id });
      firstId = (maxId ?? 0) + 1;
    } catch (err) {
      toasts.error(toAppError(err));
      return;
    }
    const before = grid.rowCount();
    const result = await history.apply(
      insertRows({ tableId: table.id, count: 1, firstId, now: nowIso() }),
    );
    if (!result) return;
    if (filteredView()) {
      // 빈 새 행은 필터·검색에 걸려 보이지 않을 수 있다. 행 수는 다시 세어 온다.
      toasts.info('edit.rowHiddenByFilter');
      grid.focus();
      return;
    }
    // 정렬만 있으면 빈 값은 `NULLS LAST`라 새 행이 끝에 붙는다.
    grid.setRowCount(before + 1);
    grid.moveCursor(before, grid.selection().getActive().col);
    grid.focus();
  }

  /** @param {CellRange} range */
  async function deleteRange(range) {
    // 빈 행은 지울 행이 없다. 실제 행 부분만 지우고, 선택이 빈 행뿐이면 아무것도 하지 않는다(D-16).
    const r1 = Math.min(range.r1, grid.rowCount() - 1);
    if (r1 < range.r0) return;
    const table = editableTable();
    if (!table) return;
    const count = r1 - range.r0 + 1;
    if (count > UNDO_SNAPSHOT_MAX_ROWS) {
      if (!(await deps.confirmIrreversible({ count }))) return;
      await history.apply(
        deleteRowRange({
          tableId: table.id,
          offset: range.r0,
          count,
          clauses: buildViewClauses(table, grid.viewSpec()),
        }),
      );
    } else {
      /** @type {FullRow[]} */
      let rows;
      try {
        rows = await readRows(table.id, range.r0, count, []);
      } catch (err) {
        toasts.error(toAppError(err));
        return;
      }
      if (rows.length === 0) return;
      const result = await history.apply(deleteRows({ tableId: table.id, rows }));
      if (!result) return;
    }
    grid.moveCursor(range.r0, grid.selection().getActive().col);
    grid.focus();
  }

  /** @type {GridHooks} */
  const hooks = {
    onEdit: (row, col, initialText) => void openEditor(row, col, initialText),
    onClear: (range) => void clearRange(range),
    onCopy: (range) => void copyRange(range),
    onPaste: (text, anchor) => void pasteText(text, anchor),
    onRowInsert: () => void insertRow(),
    onRowDelete: (range) => void deleteRange(range),
    onReset: () => {
      inline.cancel();
      longtext.close();
    },
    onGhostDisabled: () => {
      const cell = inline.cell();
      const ghostInline = cell !== null && cell.row >= grid.rowCount();
      const ghostLongtext = longtext.target()?.rowId === null;
      if (!ghostInline && !ghostLongtext) return;
      // 빈 행 자리가 더 이상 행을 가리키지 않는다. 값은 버리고 알린다(Step 12 예외 처리).
      if (ghostInline) inline.cancel();
      if (ghostLongtext) longtext.close();
      toasts.info('grid.ghostClosed');
    },
    onRelayout: () => {
      // 고정 열의 칸은 렌더마다 `scrollLeft`만큼 다시 놓이고, 열 너비 조절도 칸을 옮긴다.
      // 편집기가 열 때 잰 좌표에 머물면 편집 중인 칸에서 떨어져 나간다.
      const cell = inline.cell();
      if (cell) inline.moveTo(grid.cellRect(cell.row, cell.col));
    },
  };
  grid.setHooks(hooks);

  // 데이터가 바뀌면(되돌리기, 저널 재생, 다른 편집) 장문 편집기가 보던 행이 아직 있는지 확인한다.
  const unsubscribe = store.on('data:changed', () => {
    void longtext.refresh();
  });

  return {
    hooks,
    dispose() {
      unsubscribe();
      grid.setHooks(null);
      inline.dispose();
    },
  };
}
