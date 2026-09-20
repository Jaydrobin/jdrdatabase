// @ts-check
/**
 * 사이드바(Step 3): 테이블 목록과 선택한 테이블의 열 관리(추가·이름·타입·순서·소프트 삭제·복원).
 * 그리드(Step 4)가 오기 전까지 열 관리는 여기서 한다. 사용자 데이터(이름)는 textContent로만 넣는다.
 * 이벤트 리스너는 위임으로 컨테이너에 한 번만 건다(행마다 익명 리스너를 달지 않는다).
 */
import { t } from '../i18n/index.js';
import { WARN_COLUMNS } from '../db/schema.js';
import { toAppError } from '../util/errors.js';
import {
  confirmDeleteColumn,
  promptChangeType,
  promptColumnName,
  promptNewColumn,
  typeLabel,
} from './dialogs/column.js';
import { confirmDropTable, promptTableName } from './dialogs/table.js';

/** @typedef {import('../app/store.js').Store} Store */
/** @typedef {import('../app/commands.js').SchemaCommands} SchemaCommands */
/** @typedef {import('../db/tables.js').TableInfo} TableInfo */
/** @typedef {import('../db/tables.js').ColumnInfo} ColumnInfo */
/** @typedef {import('./toast.js').Toasts} Toasts */

/**
 * @typedef {object} Sidebar
 * @property {HTMLElement} el
 * @property {() => void} unmount
 */

/**
 * @param {string} label
 * @param {string} action
 * @param {Record<string, string>} [data]
 * @returns {HTMLButtonElement}
 */
function makeButton(label, action, data = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'jdr-sidebar__button';
  button.dataset.action = action;
  for (const [k, v] of Object.entries(data)) button.dataset[k] = v;
  button.textContent = label;
  return button;
}

/**
 * @param {HTMLElement} parent
 * @param {{ store: Store, commands: SchemaCommands, toasts: Toasts }} deps
 * @returns {Sidebar}
 */
export function mountSidebar(parent, deps) {
  const { store, commands, toasts } = deps;
  const el = document.createElement('aside');
  el.className = 'jdr-sidebar';
  el.setAttribute('aria-label', t('sidebar.label'));

  const tablesHeader = document.createElement('div');
  tablesHeader.className = 'jdr-sidebar__header';
  const tablesTitle = document.createElement('h2');
  tablesTitle.className = 'jdr-sidebar__title';
  tablesTitle.textContent = t('sidebar.tables');
  const addTable = makeButton(t('sidebar.addTable'), 'table-create');
  tablesHeader.append(tablesTitle, addTable);

  const tableList = document.createElement('ul');
  tableList.className = 'jdr-sidebar__list';
  tableList.setAttribute('role', 'listbox');
  tableList.setAttribute('aria-label', t('sidebar.tables'));

  const columnsHeader = document.createElement('div');
  columnsHeader.className = 'jdr-sidebar__header';
  const columnsTitle = document.createElement('h2');
  columnsTitle.className = 'jdr-sidebar__title';
  const addColumn = makeButton(t('sidebar.addColumn'), 'column-add');
  columnsHeader.append(columnsTitle, addColumn);

  const columnList = document.createElement('ul');
  columnList.className = 'jdr-sidebar__list jdr-sidebar__list--columns';

  const empty = document.createElement('p');
  empty.className = 'jdr-sidebar__empty';

  el.append(tablesHeader, tableList, columnsHeader, columnList, empty);
  parent.append(el);

  /** @returns {TableInfo | null} */
  function currentTable() {
    const { tables, currentTableId } = store.getState();
    return tables.find((tb) => tb.id === currentTableId) ?? null;
  }

  /**
   * @param {TableInfo} table
   * @param {ColumnInfo} column
   * @param {number} liveIndex
   * @param {number} liveCount
   * @returns {HTMLLIElement}
   */
  function renderColumn(table, column, liveIndex, liveCount) {
    const li = document.createElement('li');
    li.className = 'jdr-sidebar__column';
    li.dataset.columnId = column.id;
    const deleted = column.deletedAt !== null;
    if (deleted) li.classList.add('jdr-sidebar__column--deleted');

    const name = document.createElement('span');
    name.className = 'jdr-sidebar__column-name';
    name.textContent = column.name;
    const type = document.createElement('span');
    type.className = 'jdr-sidebar__column-type';
    type.textContent = typeLabel(column.type);
    li.append(name, type);

    if (!table.strict) return li;
    const actions = document.createElement('span');
    actions.className = 'jdr-sidebar__column-actions';
    const data = { tableId: table.id, columnId: column.id };
    if (deleted) {
      actions.append(makeButton(t('column.restore'), 'column-restore', data));
    } else {
      const up = makeButton('↑', 'column-up', data);
      up.setAttribute('aria-label', t('column.moveUp'));
      up.disabled = liveIndex === 0;
      const down = makeButton('↓', 'column-down', data);
      down.setAttribute('aria-label', t('column.moveDown'));
      down.disabled = liveIndex === liveCount - 1;
      actions.append(
        makeButton(t('column.rename'), 'column-rename', data),
        makeButton(t('column.changeType'), 'column-type', data),
        up,
        down,
        makeButton(t('column.delete'), 'column-delete', data),
      );
    }
    li.append(actions);
    return li;
  }

  function render() {
    const state = store.getState();
    const writable = state.readOnly === 'none';
    addTable.disabled = !writable;

    tableList.textContent = '';
    for (const table of state.tables) {
      const li = document.createElement('li');
      li.className = 'jdr-sidebar__table';
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(table.id === state.currentTableId));
      if (table.id === state.currentTableId) li.classList.add('jdr-sidebar__table--active');
      const select = makeButton(table.name, 'table-select', { tableId: table.id });
      select.className = 'jdr-sidebar__table-name';
      if (!table.strict) {
        const badge = document.createElement('span');
        badge.className = 'jdr-sidebar__badge';
        badge.textContent = t('sidebar.external');
        select.append(badge);
      }
      li.append(select);
      if (writable) {
        li.append(
          makeButton(t('table.rename'), 'table-rename', { tableId: table.id }),
          makeButton(t('table.drop'), 'table-drop', { tableId: table.id }),
        );
      }
      tableList.append(li);
    }

    const table = currentTable();
    columnList.textContent = '';
    if (!table) {
      columnsHeader.hidden = true;
      empty.textContent = state.tables.length === 0 ? t('sidebar.noTables') : '';
      empty.hidden = state.tables.length !== 0;
      return;
    }
    columnsHeader.hidden = false;
    columnsTitle.textContent = t('sidebar.columnsOf', { name: table.name });
    addColumn.disabled = !writable || !table.strict;
    const live = table.columns.filter((c) => c.deletedAt === null);
    live.forEach((column, index) => {
      columnList.append(renderColumn(table, column, index, live.length));
    });
    for (const column of table.columns.filter((c) => c.deletedAt !== null)) {
      columnList.append(renderColumn(table, column, -1, live.length));
    }
    const noColumns = table.columns.length === 0;
    empty.hidden = !noColumns;
    empty.textContent = noColumns ? t('sidebar.noColumns') : '';
  }

  /**
   * @param {TableInfo} table
   * @returns {string[]}
   */
  function liveNames(table) {
    return table.columns.filter((c) => c.deletedAt === null).map((c) => c.name);
  }

  /**
   * @param {string} action
   * @param {DOMStringMap} data
   */
  async function run(action, data) {
    const state = store.getState();
    const tableId = data.tableId ?? '';
    const table = state.tables.find((tb) => tb.id === tableId) ?? null;
    const columnId = data.columnId ?? '';
    const column = table?.columns.find((c) => c.id === columnId) ?? null;
    switch (action) {
      case 'table-create': {
        const name = await promptTableName({
          mode: 'create',
          taken: state.tables.map((tb) => tb.name),
        });
        if (name !== null) await commands.createTable({ name });
        return;
      }
      case 'table-select':
        store.selectTable(tableId);
        return;
      case 'table-rename': {
        if (!table) return;
        const name = await promptTableName({
          mode: 'rename',
          value: table.name,
          taken: state.tables.filter((tb) => tb.id !== tableId).map((tb) => tb.name),
        });
        if (name !== null && name !== table.name) await commands.renameTable(tableId, name);
        return;
      }
      case 'table-drop': {
        if (!table) return;
        if (await confirmDropTable(table.name)) await commands.dropTable(tableId);
        return;
      }
      case 'column-add': {
        const target = currentTable();
        if (!target) return;
        const input = await promptNewColumn({ taken: liveNames(target) });
        if (!input) return;
        const result = await commands.addColumn(target.id, input);
        if (result && result.columnCount >= WARN_COLUMNS) {
          toasts.info('column.manyWarning', { count: result.columnCount });
        }
        return;
      }
      case 'column-rename': {
        if (!table || !column) return;
        const name = await promptColumnName({
          value: column.name,
          taken: liveNames(table).filter((n) => n !== column.name),
        });
        if (name !== null && name !== column.name) {
          await commands.renameColumn(tableId, columnId, name);
        }
        return;
      }
      case 'column-type': {
        if (!table || !column) return;
        const input = await promptChangeType({
          name: column.name,
          current: column.type,
          choices: column.options?.choices,
        });
        if (!input) return;
        // 10만 행 이상에서는 청크마다 진행률이 오고, 취소는 다음 청크 전에 롤백된다(Step 3 예외 처리).
        const controller = new AbortController();
        const result = await commands.changeColumnType(tableId, columnId, input, {
          signal: controller.signal,
          onProgress: (p) => {
            toasts.progress('column.changeType.progress', { done: p.done, total: p.total }, () =>
              controller.abort(),
            );
          },
        });
        toasts.progress(null);
        if (result && result.nulled > 0)
          toasts.info('column.changeType.nulled', { count: result.nulled });
        return;
      }
      case 'column-up':
      case 'column-down': {
        if (!table || !column) return;
        const ids = table.columns.filter((c) => c.deletedAt === null).map((c) => c.id);
        const index = ids.indexOf(columnId);
        const target = action === 'column-up' ? index - 1 : index + 1;
        if (index < 0 || target < 0 || target >= ids.length) return;
        const swapped = ids[target];
        if (swapped === undefined) return;
        ids[target] = columnId;
        ids[index] = swapped;
        await commands.reorderColumns(tableId, ids);
        return;
      }
      case 'column-delete': {
        if (!table || !column) return;
        if (await confirmDeleteColumn(column.name)) {
          await commands.softDeleteColumn(tableId, columnId);
        }
        return;
      }
      case 'column-restore':
        if (table && column) await commands.restoreColumn(tableId, columnId);
        return;
      default:
        return;
    }
  }

  let busy = false;
  /** @param {Event} ev */
  const onClick = (ev) => {
    const target = /** @type {HTMLElement | null} */ (ev.target);
    const button = target?.closest('button[data-action]');
    if (!(button instanceof HTMLButtonElement) || busy) return;
    const action = button.dataset.action ?? '';
    busy = action !== 'table-select';
    run(action, button.dataset)
      .catch((/** @type {unknown} */ err) => toasts.error(toAppError(err)))
      .finally(() => {
        busy = false;
      });
  };
  el.addEventListener('click', onClick);

  const unsubscribe = [
    store.on('tables:changed', render),
    store.on('selection:changed', render),
    store.on('file:opened', render),
    store.on('state:changed', render),
  ];
  render();

  return {
    el,
    unmount() {
      el.removeEventListener('click', onClick);
      for (const off of unsubscribe) off();
      el.remove();
    },
  };
}
