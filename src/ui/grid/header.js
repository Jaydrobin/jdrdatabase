// @ts-check
/**
 * 열 머리글(D-16): 머리글 칸 하나를 [이름][정렬 버튼][메뉴 버튼 ▾][너비 조절 손잡이]로 그리고,
 * 이름 더블클릭 편집기와 열 메뉴를 연다.
 *
 * - 머리글 칸을 클릭해도 정렬이 바뀌지 않는다. `dblclick`은 `click` 두 번 뒤에 오므로 칸 클릭 정렬을 남기면
 *   이름을 고치려 할 때마다 정렬이 두 번 바뀐다. 정렬은 정렬 버튼(Shift+클릭은 보조 정렬)과 열 메뉴에서 한다.
 * - 이벤트는 머리글 행 하나에 위임한다(`mount`/`unmount`). 칸마다 리스너를 달지 않는다.
 * - 머리글의 버튼은 `tabindex="-1"`이다. 그리드의 탭 정지는 스크롤 영역 하나이며, 키보드로는 활성 셀에서
 *   Shift+F10·ContextMenu로 그 열의 메뉴를 연다(`app/shortcuts.js`의 `columnMenu`).
 * - 사용자 데이터(열 이름)는 textContent·value로만 넣는다(CLAUDE.md 5.5).
 */
import { setSortDirection } from '../../db/query.js';
import { t } from '../../i18n/index.js';
import { formatInteger } from '../../util/format.js';
import { changeColumnTypeFlow, deleteColumnFlow } from '../dialogs/column.js';
import { nameValidator } from '../dialogs/table.js';
import * as menu from '../menu.js';

/** @typedef {import('../../app/store.js').Store} Store */
/** @typedef {import('../../app/commands.js').SchemaCommands} SchemaCommands */
/** @typedef {import('../../db/tables.js').TableInfo} TableInfo */
/** @typedef {import('../../db/tables.js').ColumnInfo} ColumnInfo */
/** @typedef {import('../toast.js').Toasts} Toasts */

/**
 * 머리글 칸이 그리는 정렬 상태.
 * @typedef {object} SortEntry
 * @property {'asc' | 'desc'} dir
 * @property {number} index 정렬 목록에서의 순번(0부터)
 * @property {number} count 정렬 목록의 길이(2 이상이면 순번을 함께 보인다)
 */

/**
 * 머리글이 그리드에서 읽는 것. 그리드가 클로저로 넘긴다.
 * @typedef {object} HeaderHost
 * @property {() => TableInfo | null} table
 * @property {() => ColumnInfo[]} columns 지금 그리는 열(표시 순서)
 * @property {(col: number) => HTMLElement | null} revealColumn 그 열이 보이게 가로로 스크롤하고 바로 그린 뒤 머리글 칸을 돌려준다
 * @property {(col: number) => number} columnLeft 편집 오버레이 기준의 열 왼쪽 위치(px)
 * @property {HTMLElement} overlay 편집 오버레이(머리글 아래). 이름 편집기의 오류 문구를 여기에 둔다
 * @property {() => void} focus 그리드 스크롤 영역에 포커스
 * @property {HTMLElement} focusTarget 그리드의 탭 정지(스크롤 영역). 메뉴가 닫히면 포커스를 여기로 돌려준다
 */

/**
 * @typedef {object} HeaderDeps
 * @property {HeaderHost} host
 * @property {Store} store
 * @property {Toasts} toasts
 * @property {SchemaCommands} commands
 */

/**
 * @typedef {object} HeaderController
 * @property {(cell: HTMLElement, column: ColumnInfo, sortEntry: SortEntry | null, options: { writable: boolean }) => void} render 머리글 칸의 내용을 그린다
 * @property {(col: number, options?: { mergeWithAdd?: boolean }) => void} openRename 이름 편집기를 연다(읽기 전용·외부 테이블이면 안내만). `mergeWithAdd`는 "+ 열" 직후에 연 편집기라는 표시로, 확정한 이름을 열 추가와 한 히스토리 항목으로 합친다(D-16)
 * @property {(col: number, anchor?: HTMLElement | null) => void} openMenu 열 메뉴를 연다. 앵커가 없으면 그 열의 머리글 칸
 * @property {() => void} beforeBuild 그리드가 머리글 칸을 지우기 전. 편집기를 떼어 두고 포커스·선택 범위를 기억한다(떼어 낼 때의 blur는 확정이 아니다)
 * @property {() => void} afterBuild 그리드가 머리글을 다시 만든 뒤. 편집기의 열이 사라졌으면 닫고, 있으면 새 칸에 다시 붙인다
 * @property {() => boolean} isRenaming
 * @property {() => void} close 편집기(값을 버림)와 메뉴를 닫는다
 * @property {(header: HTMLElement) => void} mount
 * @property {() => void} unmount
 */

/**
 * 테이블을 바꿀 수 있는가(읽기 전용 파일이나 외부 테이블이 아닌가).
 * @param {Store} store
 * @param {TableInfo | null} table
 * @returns {boolean}
 */
function writableTable(store, table) {
  return table !== null && table.strict && store.getState().readOnly === 'none';
}

/**
 * @param {HeaderDeps} deps
 * @returns {HeaderController}
 */
export function createHeader(deps) {
  const { host, store, toasts, commands } = deps;
  /** @type {HTMLElement | null} */
  let headerEl = null;

  // ---- 이름 편집기 ----

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'jdr-grid__hrename';
  input.spellcheck = false;
  const error = document.createElement('div');
  error.className = 'jdr-grid__hrename-error';
  error.setAttribute('role', 'alert');
  error.hidden = true;
  /** @type {{ columnId: string, tableId: string, name: string, mergeWithAdd: boolean } | null} */
  let renaming = null;
  /** 확정이 진행 중이다(겹치는 확정·취소를 막는다). */
  let committing = false;
  /** 편집기를 다른 칸으로 옮기는 중이다. 그때 나는 blur는 확정이 아니다. */
  let moving = false;
  /**
   * 머리글을 다시 만드는 동안 편집기가 떨어져 있던 사이의 포커스·선택 범위. 다시 붙일 때 되살린다.
   * @type {{ focused: boolean, start: number | null, end: number | null } | null}
   */
  let parked = null;

  /** @param {string} message */
  function showError(message) {
    error.textContent = message;
    error.hidden = false;
    input.setAttribute('aria-invalid', 'true');
    const col = host.columns().findIndex((c) => c.id === renaming?.columnId);
    error.style.transform = `translate(${Math.max(0, host.columnLeft(col))}px, 0px)`;
  }

  function hideError() {
    error.hidden = true;
    error.textContent = '';
    input.removeAttribute('aria-invalid');
  }

  /**
   * 편집기를 닫는다. 값은 버린다.
   * @param {boolean} refocus 그리드로 포커스를 돌려줄지(포커스 이탈로 닫힐 때는 사용자가 옮긴 자리를 존중한다)
   */
  function closeRename(refocus) {
    if (!renaming) return;
    renaming = null;
    parked = null;
    hideError();
    moving = true;
    input.remove();
    moving = false;
    error.remove();
    if (refocus) host.focus();
  }

  /**
   * @param {'enter' | 'blur'} reason
   * @returns {Promise<void>}
   */
  async function commitRename(reason) {
    const target = renaming;
    if (!target || committing) return;
    const name = input.value.trim();
    if (name === target.name) {
      // 이름이 그대로면 커맨드를 만들지 않는다.
      closeRename(reason === 'enter');
      return;
    }
    const table = host.table();
    const others = (table?.columns ?? [])
      .filter((c) => c.deletedAt === null && c.id !== target.columnId)
      .map((c) => c.name);
    const problem = nameValidator(others)(input.value);
    if (problem) {
      if (reason === 'blur') {
        // 다른 곳을 눌러 떠났는데 확정할 수 없다: 원래 이름으로 두고 알린다.
        closeRename(false);
        toasts.info('edit.reverted');
        return;
      }
      showError(problem);
      return;
    }
    committing = true;
    let ok = false;
    try {
      ok = await store.renameColumn(target.tableId, target.columnId, name, {
        mergeWithAdd: target.mergeWithAdd,
      });
    } finally {
      committing = false;
    }
    // 실패(스토어가 이미 알렸다): Enter는 편집기를 열어 두어 고칠 수 있게 하고, 포커스 이탈은 원래 이름으로 닫는다.
    if (ok || reason === 'blur') closeRename(reason === 'enter');
    else if (renaming) input.focus();
  }

  /** @param {KeyboardEvent} ev */
  const onInputKeydown = (ev) => {
    // 한글 조합 중의 Enter·Esc는 IME가 소비한다(CLAUDE.md 5.5).
    if (ev.isComposing) return;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      void commitRename('enter');
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      ev.stopPropagation();
      closeRename(true);
    }
  };
  const onInputBlur = () => {
    if (moving || committing || !renaming) return;
    void commitRename('blur');
  };
  const onInputEvent = () => {
    if (!error.hidden) hideError();
  };
  input.addEventListener('keydown', onInputKeydown);
  input.addEventListener('blur', onInputBlur);
  input.addEventListener('input', onInputEvent);

  /**
   * 편집기를 머리글 칸에 붙인다. 떨어져 있던 동안(`parked`)의 포커스·선택 범위를 되살린다.
   * @param {HTMLElement} cell
   * @param {ColumnInfo} column
   */
  function attachInput(cell, column) {
    moving = true;
    cell.append(input);
    moving = false;
    input.setAttribute('aria-label', t('grid.renameLabel', { name: column.name }));
    const restore = parked;
    parked = null;
    if (restore?.focused) {
      input.focus();
      if (restore.start !== null && restore.end !== null) {
        input.setSelectionRange(restore.start, restore.end);
      }
    }
  }

  // ---- 메뉴 ----

  /**
   * @param {TableInfo} table
   * @param {ColumnInfo} column
   * @param {number} col
   * @returns {menu.MenuItem[]}
   */
  function menuItems(table, column, col) {
    const editable = writableTable(store, table);
    const sort = store.viewSpecOf(table.id).sort;
    const sorted = sort.some((s) => s.colId === column.id);
    // 다른 열의 정렬은 그대로 두고 이 열의 방향만 정한다(D-16). 이 열 하나로 바꾸는 것은 정렬 버튼 클릭이다.
    /** @param {'asc' | 'desc'} dir */
    const sortColumn = (dir) => store.setSort(table.id, setSortDirection(sort, column.id, dir));
    return [
      {
        key: 'rename',
        label: t('columnMenu.rename'),
        disabled: !editable,
        run: () => controller.openRename(col),
      },
      {
        key: 'changeType',
        label: t('columnMenu.changeType'),
        disabled: !editable,
        run: () => void changeColumnTypeFlow({ commands, toasts, tableId: table.id, column }),
      },
      { key: 'sortAsc', label: t('columnMenu.sortAsc'), run: () => sortColumn('asc') },
      { key: 'sortDesc', label: t('columnMenu.sortDesc'), run: () => sortColumn('desc') },
      {
        key: 'sortClear',
        label: t('columnMenu.sortClear'),
        disabled: !sorted,
        run: () =>
          store.setSort(
            table.id,
            sort.filter((s) => s.colId !== column.id),
          ),
      },
      {
        key: 'hide',
        label: t('columnMenu.hide'),
        run: () => store.toggleHidden(table.id, column.id),
      },
      {
        key: 'delete',
        label: t('columnMenu.delete'),
        disabled: !editable,
        danger: true,
        run: () => void deleteColumnFlow({ commands, tableId: table.id, column }),
      },
    ];
  }

  // ---- 위임 이벤트 ----

  /**
   * 이벤트가 난 머리글 칸의 열 인덱스. 행 번호 칸·이름 편집기 안이면 -1.
   * @param {EventTarget | null} target
   * @returns {{ col: number, cell: HTMLElement | null }}
   */
  function colOf(target) {
    if (!(target instanceof HTMLElement) || target.closest('.jdr-grid__hrename')) {
      return { col: -1, cell: null };
    }
    const cell = target.closest('.jdr-grid__hcell[data-col]');
    if (!(cell instanceof HTMLElement)) return { col: -1, cell: null };
    return { col: Number(cell.dataset.col ?? -1), cell };
  }

  /** @param {MouseEvent} ev */
  const onClick = (ev) => {
    const target = /** @type {HTMLElement | null} */ (ev.target);
    const button = target?.closest('[data-hbtn]');
    if (!(button instanceof HTMLElement)) return;
    const { col } = colOf(button);
    const table = host.table();
    const column = host.columns()[col];
    if (!table || !column) return;
    // 버튼은 누를 때 포커스를 가져간다. 막으면 셀 편집기의 blur(확정)가 일어나지 않아 입력이 사라진다.
    // 버튼은 탭 정지가 아니므로 정렬 뒤에는 그리드로 포커스를 돌려준다(메뉴는 닫힐 때 돌려준다).
    if (button.dataset.hbtn === 'sort') {
      store.toggleSort(table.id, column.id, ev.shiftKey);
      host.focus();
    } else if (button.dataset.hbtn === 'menu') {
      controller.openMenu(col, button);
    }
  };
  /** @param {MouseEvent} ev */
  const onDblClick = (ev) => {
    const target = /** @type {HTMLElement | null} */ (ev.target);
    // 버튼·너비 조절 손잡이의 더블클릭은 이름 편집이 아니다.
    if (!target || target.closest('[data-hbtn], .jdr-grid__resizer')) return;
    const { col } = colOf(target);
    if (col >= 0) controller.openRename(col);
  };
  /** @param {MouseEvent} ev */
  const onContextMenu = (ev) => {
    const { col, cell } = colOf(ev.target);
    if (col < 0) return;
    ev.preventDefault();
    controller.openMenu(col, cell);
  };
  /** @type {HeaderController} */
  const controller = {
    render(cell, column, sortEntry, options) {
      cell.textContent = '';
      const name = document.createElement('span');
      name.className = 'jdr-grid__hname';
      name.textContent = column.name;

      const sortButton = document.createElement('button');
      sortButton.type = 'button';
      sortButton.tabIndex = -1;
      sortButton.className = 'jdr-grid__hbtn jdr-grid__hbtn--sort';
      sortButton.dataset.hbtn = 'sort';
      sortButton.dataset.hint = 'hint.header-sort';
      let sortLabel = t('grid.sortButton', { name: column.name });
      if (sortEntry) {
        // 정렬 표시(Step 6): 방향 기호와, 다중 정렬이면 순번. `aria-sort`는 첫 정렬 열에만 둔다(ARIA 규칙).
        sortButton.classList.add('jdr-grid__hbtn--sorted');
        const mark = document.createElement('span');
        mark.className = 'jdr-grid__hsort';
        mark.textContent =
          (sortEntry.dir === 'desc' ? t('grid.sortDescMark') : t('grid.sortAscMark')) +
          (sortEntry.count > 1 ? formatInteger(sortEntry.index + 1) : '');
        sortButton.append(mark);
        sortLabel = `${sortLabel}, ${t(sortEntry.dir === 'desc' ? 'grid.sortedDesc' : 'grid.sortedAsc')}`;
        if (sortEntry.index === 0) {
          cell.setAttribute('aria-sort', sortEntry.dir === 'desc' ? 'descending' : 'ascending');
        }
      }
      if (!sortEntry || sortEntry.index !== 0) cell.removeAttribute('aria-sort');
      sortButton.setAttribute('aria-label', sortLabel);

      const menuButton = document.createElement('button');
      menuButton.type = 'button';
      menuButton.tabIndex = -1;
      menuButton.className = 'jdr-grid__hbtn jdr-grid__hbtn--menu';
      menuButton.dataset.hbtn = 'menu';
      menuButton.dataset.hint = 'hint.header-menu';
      menuButton.setAttribute('aria-haspopup', 'menu');
      menuButton.setAttribute('aria-label', t('grid.menuButton', { name: column.name }));

      const resizer = document.createElement('div');
      resizer.className = 'jdr-grid__resizer';
      resizer.setAttribute('role', 'separator');
      resizer.setAttribute('aria-orientation', 'vertical');
      resizer.setAttribute('aria-label', t('grid.resizeHandle', { name: column.name }));

      cell.append(name, sortButton, menuButton, resizer);
      cell.classList.toggle('jdr-grid__hcell--readonly', !options.writable);
    },

    openRename(col, options = {}) {
      const table = host.table();
      const column = host.columns()[col];
      if (!table || !column) return;
      if (!writableTable(store, table)) {
        toasts.info('file.readOnlyBlocked');
        return;
      }
      menu.openMenuOf()?.close();
      if (renaming) closeRename(false);
      const cell = host.revealColumn(col);
      if (!cell) return;
      renaming = {
        columnId: column.id,
        tableId: table.id,
        name: column.name,
        mergeWithAdd: options.mergeWithAdd === true,
      };
      hideError();
      input.value = column.name;
      host.overlay.append(error);
      attachInput(cell, column);
      input.focus();
      input.select();
    },

    openMenu(col, anchor) {
      const table = host.table();
      const column = host.columns()[col];
      if (!table || !column) return;
      if (renaming) closeRename(false);
      const target = anchor ?? host.revealColumn(col);
      if (!target) return;
      menu.open(target, menuItems(table, column, col), {
        label: t('grid.menuButton', { name: column.name }),
        // 메뉴를 어디서 열었든(버튼·우클릭·Shift+F10) 닫히면 그리드로 돌아간다. 머리글 버튼은 탭 정지가 아니다.
        returnFocus: host.focusTarget,
      });
    },

    beforeBuild() {
      if (!renaming || !input.isConnected) return;
      parked = {
        focused: document.activeElement === input,
        start: input.selectionStart,
        end: input.selectionEnd,
      };
      moving = true;
      input.remove();
      moving = false;
    },

    afterBuild() {
      if (!renaming) return;
      const cols = host.columns();
      const col = cols.findIndex((c) => c.id === renaming?.columnId);
      const column = cols[col];
      // 편집하던 열이 사라졌다(저널 재생, 다른 커맨드의 되돌리기). 확정 중이면 끝난 뒤 확정 경로가 닫는다.
      if (!column) {
        if (!committing) closeRename(false);
        parked = null;
        return;
      }
      const cell = headerEl?.querySelector(`.jdr-grid__hcell[data-col="${col}"]`);
      if (cell instanceof HTMLElement) attachInput(cell, column);
      else if (!committing) closeRename(false);
    },

    isRenaming: () => renaming !== null,

    close() {
      closeRename(false);
      menu.openMenuOf()?.close();
    },

    mount(header) {
      headerEl = header;
      header.addEventListener('click', onClick);
      header.addEventListener('dblclick', onDblClick);
      header.addEventListener('contextmenu', onContextMenu);
    },

    unmount() {
      controller.close();
      if (!headerEl) return;
      headerEl.removeEventListener('click', onClick);
      headerEl.removeEventListener('dblclick', onDblClick);
      headerEl.removeEventListener('contextmenu', onContextMenu);
      headerEl = null;
    },
  };
  return controller;
}
