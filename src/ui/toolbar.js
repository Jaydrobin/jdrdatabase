// @ts-check
/**
 * 도구 모음(Step 2): 새로 만들기, 열기, 최근 파일, 저장, 다른 이름으로 저장, 파일 이름과 dirty 표시, 저널 상한 배너.
 * 사용자 데이터(파일 이름)는 textContent로만 넣는다.
 */
import { t } from '../i18n/index.js';
import { capabilities, fileFromInput, getFileInput } from '../io/filesystem.js';

/** @typedef {import('../app/store.js').Store} Store */

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
 * @returns {Toolbar}
 */
export function mountToolbar(parent, store) {
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

  el.append(
    newButton,
    openButton,
    recentButton,
    saveButton,
    saveAsButton,
    fileName,
    dirtyMark,
    readOnlyMark,
    banner,
  );
  parent.append(el);

  function render() {
    const state = store.getState();
    fileName.textContent = state.file.name ?? t('file.untitled');
    dirtyMark.textContent = state.dirty ? t('file.dirtyMark') : '';
    readOnlyMark.textContent = state.readOnly === 'none' ? '' : t('status.readOnly');
    saveButton.disabled = state.readOnly !== 'none';
    saveAsButton.disabled = state.readOnly !== 'none';
    banner.hidden = !state.journalFull;
  }

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
  newButton.addEventListener('click', onNew);
  openButton.addEventListener('click', onOpen);
  recentButton.addEventListener('click', onRecent);
  saveButton.addEventListener('click', onSave);
  saveAsButton.addEventListener('click', onSaveAs);

  /** @param {KeyboardEvent} ev */
  const onKeydown = (ev) => {
    if ((ev.ctrlKey || ev.metaKey) && !ev.altKey && (ev.key === 's' || ev.key === 'S')) {
      ev.preventDefault();
      if (ev.shiftKey) void store.saveAs();
      else void store.save();
    }
  };
  document.addEventListener('keydown', onKeydown);

  async function refreshRecent() {
    const recent = await store.recentFile();
    recentButton.hidden = !recent;
    recentButton.textContent = recent ? t('toolbar.recent', { name: recent.name }) : '';
  }

  const unsubscribe = [
    store.on('state:changed', render),
    store.on('file:saved', () => void refreshRecent()),
    store.on('file:opened', () => void refreshRecent()),
  ];
  render();
  void refreshRecent();

  return {
    el,
    unmount() {
      fileInput.removeEventListener('change', onFileInputChange);
      newButton.removeEventListener('click', onNew);
      openButton.removeEventListener('click', onOpen);
      recentButton.removeEventListener('click', onRecent);
      saveButton.removeEventListener('click', onSave);
      saveAsButton.removeEventListener('click', onSaveAs);
      document.removeEventListener('keydown', onKeydown);
      for (const off of unsubscribe) off();
      el.remove();
    },
  };
}
