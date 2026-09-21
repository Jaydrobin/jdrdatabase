// @ts-check
/**
 * 도구 모음(Step 2): 새로 만들기, 열기, 최근 파일, 저장, 다른 이름으로 저장, 파일 이름과 dirty 표시, 저널 상한 배너.
 * Step 5: 되돌리기·다시 실행 버튼. 문서 수준 단축키(저장·되돌리기)는 `app/shortcuts.js`의 표를 따른다.
 * Step 6: 표 도구 줄 — 검색 상자, 정렬·필터 대화상자, 뷰 선택·저장·삭제, 검색 인덱스 만들기·삭제.
 * 표 도구는 지금 고른 테이블에 대한 것이며 테이블이 없으면 숨긴다.
 * 사용자 데이터(파일 이름·뷰 이름)는 textContent로만 넣는다.
 */
import { mountShortcuts } from '../app/shortcuts.js';
import { t } from '../i18n/index.js';
import { capabilities, fileFromInput, getFileInput } from '../io/filesystem.js';
import { toAppError } from '../util/errors.js';
import { formatInteger } from '../util/format.js';
import { isDialogOpen } from './dialogs/dialog.js';
import { confirmDeleteView, promptFilter, promptSort, promptViewName } from './dialogs/filter.js';

/** @typedef {import('../app/store.js').Store} Store */
/** @typedef {import('../app/history.js').History} History */
/** @typedef {import('../db/tables.js').TableInfo} TableInfo */
/** @typedef {import('../db/views.js').View} View */
/** @typedef {import('./toast.js').Toasts} Toasts */

/** 검색 상자 입력을 질의로 보내기 전에 기다리는 시간(ms). */
export const SEARCH_DEBOUNCE_MS = 300;

/**
 * @typedef {object} Toolbar
 * @property {HTMLElement} el
 * @property {() => void} unmount
 */

/**
 * @param {string} label
 * @param {string} action data-action 값(E2E 셀렉터)
 * @returns {HTMLButtonElement}
 */
function makeButton(label, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'jdr-toolbar__button';
  button.dataset.action = action;
  button.textContent = label;
  return button;
}

/**
 * @param {HTMLElement} parent
 * @param {Store} store
 * @param {History} history
 * @param {{ toasts: Toasts }} deps
 * @returns {Toolbar}
 */
export function mountToolbar(parent, store, history, deps) {
  const { toasts } = deps;
  const el = document.createElement('header');
  el.className = 'jdr-toolbar';
  el.setAttribute('role', 'toolbar');
  el.setAttribute('aria-label', t('toolbar.label'));

  const newButton = makeButton(t('toolbar.new'), 'new');
  const openButton = makeButton(t('toolbar.open'), 'open');
  const recentButton = makeButton('', 'recent');
  recentButton.hidden = true;
  const saveButton = makeButton(t('toolbar.save'), 'save');
  const saveAsButton = makeButton(t('toolbar.saveAs'), 'save-as');
  const undoButton = makeButton(t('toolbar.undo'), 'undo');
  const redoButton = makeButton(t('toolbar.redo'), 'redo');

  const fileName = document.createElement('span');
  fileName.className = 'jdr-toolbar__file';
  const dirtyMark = document.createElement('span');
  dirtyMark.className = 'jdr-toolbar__dirty';
  dirtyMark.setAttribute('aria-label', t('file.dirtyLabel'));
  const readOnlyMark = document.createElement('span');
  readOnlyMark.className = 'jdr-toolbar__readonly';

  const banner = document.createElement('div');
  banner.className = 'jdr-toolbar__banner';
  banner.setAttribute('role', 'alert');
  banner.textContent = t('toolbar.journalFull');
  banner.hidden = true;

  // ---- 표 도구 줄 (Step 6) ----
  const tools = document.createElement('div');
  tools.className = 'jdr-toolbar__tools';
  tools.setAttribute('role', 'toolbar');
  tools.setAttribute('aria-label', t('toolbar.tools'));
  tools.hidden = true;

  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'jdr-toolbar__search';
  searchInput.dataset.action = 'search';
  searchInput.setAttribute('aria-label', t('toolbar.searchLabel'));
  searchInput.placeholder = t('toolbar.searchPlaceholder');

  const sortButton = makeButton(t('toolbar.sort'), 'sort');
  const filterButton = makeButton(t('toolbar.filter'), 'filter');
  const clearButton = makeButton(t('toolbar.viewClear'), 'view-clear');

  const viewLabel = document.createElement('label');
  viewLabel.className = 'jdr-toolbar__view';
  const viewText = document.createElement('span');
  viewText.textContent = t('toolbar.viewLabel');
  const viewSelect = document.createElement('select');
  viewSelect.className = 'jdr-toolbar__view-select';
  viewSelect.dataset.action = 'view-select';
  viewLabel.append(viewText, viewSelect);
  const viewSaveButton = makeButton(t('toolbar.viewSave'), 'view-save');
  const viewDeleteButton = makeButton(t('toolbar.viewDelete'), 'view-delete');
  const indexButton = makeButton('', 'search-index');

  tools.append(
    searchInput,
    sortButton,
    filterButton,
    clearButton,
    viewLabel,
    viewSaveButton,
    viewDeleteButton,
    indexButton,
  );

  el.append(
    newButton,
    openButton,
    recentButton,
    saveButton,
    saveAsButton,
    undoButton,
    redoButton,
    fileName,
    dirtyMark,
    readOnlyMark,
    banner,
    tools,
  );
  parent.append(el);

  /** 표 도구가 마지막으로 그린 테이블. 바뀌면 검색 상자와 뷰 목록을 새로 채운다. */
  /** @type {string | null} */
  let toolsTableId = null;
  /** @type {View[]} */
  let views = [];
  /** 진행 중인 표 도구 작업(대화상자 답 대기, 인덱스 생성). 겹치지 않게 한다. */
  let busy = false;
  let searchTimer = 0;

  /** @returns {TableInfo | null} */
  function currentTable() {
    const { tables, currentTableId } = store.getState();
    return tables.find((tb) => tb.id === currentTableId) ?? null;
  }

  function render() {
    const state = store.getState();
    fileName.textContent = state.file.name ?? t('file.untitled');
    dirtyMark.textContent = state.dirty ? t('file.dirtyMark') : '';
    readOnlyMark.textContent = state.readOnly === 'none' ? '' : t('status.readOnly');
    saveButton.disabled = state.readOnly !== 'none';
    saveAsButton.disabled = state.readOnly !== 'none';
    banner.hidden = !state.journalFull;
    renderHistory();
    renderTools();
  }

  function renderHistory() {
    const h = history.state();
    const writable = store.getState().readOnly === 'none';
    undoButton.disabled = !writable || h.busy || h.undo === 0;
    redoButton.disabled = !writable || h.busy || h.redo === 0;
  }

  function renderTools() {
    const table = currentTable();
    tools.hidden = table === null;
    if (!table) {
      toolsTableId = null;
      return;
    }
    const view = store.getViewState(table.id);
    if (toolsTableId !== table.id) {
      toolsTableId = table.id;
      void refreshViews();
    }
    // 검색 상자는 뷰 상태를 따라간다("필터 지우기", 뷰 불러오기). 입력 중(포커스)에는 덮어쓰지 않는다.
    if (document.activeElement !== searchInput && searchInput.value !== view.search) {
      searchInput.value = view.search;
    }
    const writable = store.getState().readOnly === 'none';
    const sortCount = view.sort.length;
    const filterCount = view.filter?.conditions.length ?? 0;
    sortButton.textContent =
      sortCount > 0
        ? t('toolbar.sortCount', { count: formatInteger(sortCount) })
        : t('toolbar.sort');
    filterButton.textContent =
      filterCount > 0
        ? t('toolbar.filterCount', { count: formatInteger(filterCount) })
        : t('toolbar.filter');
    clearButton.hidden = sortCount === 0 && filterCount === 0 && view.search === '';
    viewSaveButton.disabled = !writable || busy;
    viewDeleteButton.disabled = !writable || busy || view.viewId === null;
    indexButton.textContent = table.ftsEnabled
      ? t('toolbar.searchIndexDisable')
      : t('toolbar.searchIndexEnable');
    // 외부(비STRICT) 테이블에는 인덱스를 만들지 않는다(D-07). LIKE 검색은 된다.
    indexButton.hidden = !table.strict;
    indexButton.disabled = !writable || busy;
    renderViewSelect(view.viewId);
  }

  /** @param {string | null} selectedId */
  function renderViewSelect(selectedId) {
    viewSelect.textContent = '';
    const none = document.createElement('option');
    none.value = '';
    none.textContent = t('toolbar.viewNone');
    none.selected = selectedId === null || !views.some((v) => v.id === selectedId);
    viewSelect.append(none);
    for (const view of views) {
      const option = document.createElement('option');
      option.value = view.id;
      option.textContent = view.name;
      option.selected = view.id === selectedId;
      viewSelect.append(option);
    }
    viewSelect.disabled = views.length === 0;
  }

  async function refreshViews() {
    const table = currentTable();
    if (!table) return;
    const listed = await store.listViews(table.id);
    // 기다리는 사이 다른 테이블로 옮겼으면 그 목록은 버린다.
    if (currentTable()?.id !== table.id) return;
    views = listed;
    renderViewSelect(store.getViewState(table.id).viewId);
  }

  /**
   * @param {string} action
   */
  async function run(action) {
    const table = currentTable();
    if (!table) return;
    const live = table.columns.filter((c) => c.deletedAt === null);
    const view = store.getViewState(table.id);
    switch (action) {
      case 'sort': {
        const sort = await promptSort({ columns: live, sort: view.sort });
        if (sort !== null) store.setSort(table.id, sort);
        return;
      }
      case 'filter': {
        const filter = await promptFilter({ columns: live, filter: view.filter });
        if (filter !== null)
          store.setFilter(table.id, filter.conditions.length > 0 ? filter : null);
        return;
      }
      case 'view-clear':
        store.setSort(table.id, []);
        store.clearFilters(table.id);
        return;
      case 'view-save': {
        const current = views.find((v) => v.id === view.viewId);
        const name = await promptViewName({ value: current?.name ?? '' });
        if (name === null) return;
        await store.saveView(table.id, name);
        await refreshViews();
        return;
      }
      case 'view-delete': {
        const current = views.find((v) => v.id === view.viewId);
        if (!current) return;
        if (!(await confirmDeleteView(current.name))) return;
        await store.deleteView(table.id, current.id);
        await refreshViews();
        return;
      }
      case 'search-index': {
        if (table.ftsEnabled) {
          if (await store.disableSearch(table.id)) toasts.info('search.disabled');
          return;
        }
        // 인덱스 생성은 청크마다 진행률이 오고, 취소는 다음 청크 전에 롤백된다(Step 6 예외 처리).
        const controller = new AbortController();
        const ok = await store.enableSearch(table.id, {
          signal: controller.signal,
          onProgress: (p) => {
            toasts.progress(
              'toolbar.searchIndexProgress',
              { done: formatInteger(p.done), total: formatInteger(p.total) },
              () => controller.abort(),
            );
          },
        });
        toasts.progress(null);
        if (ok) toasts.info('search.enabled');
        return;
      }
      default:
        return;
    }
  }

  /** @param {Event} ev */
  const onToolsClick = (ev) => {
    const target = /** @type {HTMLElement | null} */ (ev.target);
    const button = target?.closest('button[data-action]');
    if (!(button instanceof HTMLButtonElement) || busy) return;
    busy = true;
    renderTools();
    run(button.dataset.action ?? '')
      .catch((/** @type {unknown} */ err) => toasts.error(toAppError(err)))
      .finally(() => {
        busy = false;
        renderTools();
      });
  };

  const applySearch = () => {
    const table = currentTable();
    if (table) store.setSearch(table.id, searchInput.value);
  };
  /** @param {Event} ev */
  const onSearchInput = (ev) => {
    // 조합 중(한글 IME)의 중간 글자로는 질의하지 않는다. 조합이 끝나면 compositionend에서 반영한다.
    if (ev instanceof InputEvent && ev.isComposing) return;
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(applySearch, SEARCH_DEBOUNCE_MS);
  };
  const onSearchCompositionEnd = () => {
    clearTimeout(searchTimer);
    searchTimer = window.setTimeout(applySearch, SEARCH_DEBOUNCE_MS);
  };
  /** @param {KeyboardEvent} ev */
  const onSearchKeydown = (ev) => {
    if (ev.isComposing) return;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      clearTimeout(searchTimer);
      applySearch();
    }
  };
  const onViewSelect = () => {
    const table = currentTable();
    const selected = views.find((v) => v.id === viewSelect.value);
    if (!table) return;
    if (selected) store.applyView(table.id, selected);
    renderTools();
  };

  // 폴백 열기 경로(D-04 2층): FSA가 없으면 숨은 <input type="file">을 연다. 이 요소는 문서에 상주하며
  // 자동화 도구가 파일을 넣어도 같은 change 경로를 탄다.
  const fileInput = getFileInput();
  const onFileInputChange = () => {
    const picked = fileFromInput(fileInput);
    if (picked) void store.openPicked(picked);
  };
  fileInput.addEventListener('change', onFileInputChange);

  const onNew = () => void store.newDatabase();
  const onOpen = () => {
    if (capabilities().fsa) void store.openFile();
    else fileInput.click();
  };
  const onRecent = () => void store.openRecent();
  const onSave = () => void store.save();
  const onSaveAs = () => void store.saveAs();
  const onUndo = () => void history.undo();
  const onRedo = () => void history.redo();
  newButton.addEventListener('click', onNew);
  openButton.addEventListener('click', onOpen);
  recentButton.addEventListener('click', onRecent);
  saveButton.addEventListener('click', onSave);
  saveAsButton.addEventListener('click', onSaveAs);
  undoButton.addEventListener('click', onUndo);
  redoButton.addEventListener('click', onRedo);
  tools.addEventListener('click', onToolsClick);
  searchInput.addEventListener('input', onSearchInput);
  searchInput.addEventListener('compositionend', onSearchCompositionEnd);
  searchInput.addEventListener('keydown', onSearchKeydown);
  viewSelect.addEventListener('change', onViewSelect);

  // 모달이 떠 있으면 그 답을 기다리는 흐름(열기, 저널 복구)이 진행 중이다. 그 도중의 저장은
  // 아직 확정되지 않은 DB를 파일로 쓰고 저널을 비운다. 되돌리기도 같은 이유로 막는다.
  const unmountShortcuts = mountShortcuts(
    { save: onSave, saveAs: onSaveAs, undo: onUndo, redo: onRedo },
    { guard: () => !isDialogOpen() },
  );

  async function refreshRecent() {
    const recent = await store.recentFile();
    recentButton.hidden = !recent;
    recentButton.textContent = recent ? t('toolbar.recent', { name: recent.name }) : '';
  }

  const unsubscribe = [
    store.on('state:changed', render),
    store.on('file:saved', () => void refreshRecent()),
    store.on('file:opened', () => void refreshRecent()),
    // 뷰 저장·삭제와 되돌리기는 테이블 목록을 다시 읽게 하므로 그때 뷰 목록도 새로 읽는다.
    store.on('tables:changed', () => void refreshViews()),
    history.onChange(renderHistory),
  ];
  render();
  void refreshRecent();

  return {
    el,
    unmount() {
      clearTimeout(searchTimer);
      fileInput.removeEventListener('change', onFileInputChange);
      newButton.removeEventListener('click', onNew);
      openButton.removeEventListener('click', onOpen);
      recentButton.removeEventListener('click', onRecent);
      saveButton.removeEventListener('click', onSave);
      saveAsButton.removeEventListener('click', onSaveAs);
      undoButton.removeEventListener('click', onUndo);
      redoButton.removeEventListener('click', onRedo);
      tools.removeEventListener('click', onToolsClick);
      searchInput.removeEventListener('input', onSearchInput);
      searchInput.removeEventListener('compositionend', onSearchCompositionEnd);
      searchInput.removeEventListener('keydown', onSearchKeydown);
      viewSelect.removeEventListener('change', onViewSelect);
      unmountShortcuts();
      for (const off of unsubscribe) off();
      el.remove();
    },
  };
}
