// @ts-check
/**
 * 장문 편집기(Step 5, D-05): 그리드 오른쪽 사이드 패널의 `<textarea>`.
 *
 * - 열 때 `query.row`로 전문을 읽는다(그리드는 256자 미리보기만 가진다).
 * - 자동 저장은 없다. "확정" 버튼(또는 Ctrl+Enter)이 `onSave`를 부르고 성공하면 닫힌다.
 * - 입력값이 5 MB를 넘으면 경고만 하고 저장은 허용한다.
 * - 편집 중인 행이 사라지면(`refresh()`가 null을 받으면) 편집기를 닫고 알린다.
 * - 빈 행(D-16)은 DB에 없으므로 `rowId`가 null이고 빈 값으로 연다. 확정은 대상의 `commit`이 맡는다
 *   (그 줄까지 행을 만드는 커맨드. 편집 컨트롤러가 준다).
 */
import { t } from '../../i18n/index.js';
import { formatBytes, MB } from '../../util/bytes.js';
import { toAppError } from '../../util/errors.js';

/** @typedef {import('../../db/client.js').Client} Client */
/** @typedef {import('../../db/tables.js').ColumnInfo} ColumnInfo */
/** @typedef {import('../../db/engine.js').SqlValue} SqlValue */
/** @typedef {import('../toast.js').Toasts} Toasts */

/** 경고를 띄우는 입력 크기(바이트, Step 5 예외 처리). */
export const LONGTEXT_WARN_BYTES = 5 * MB;

/**
 * 열 대상.
 * @typedef {object} LongtextTarget
 * @property {string} tableId
 * @property {string} tableName
 * @property {number | null} rowId 빈 행(D-16)이면 null
 * @property {number} rowIndex 그리드 행 번호 표시용(0부터)
 * @property {ColumnInfo} column
 * @property {(newValue: string | null) => Promise<boolean>} [commit] 있으면 `onSave` 대신 부른다(빈 행의 확정)
 */

/**
 * 확정 요청. 성공(true)이면 패널을 닫는다.
 * @typedef {(input: { target: LongtextTarget, oldValue: SqlValue, oldUpdatedAt: string | null, newValue: string | null }) => Promise<boolean>} SaveHandler
 */

/**
 * @typedef {object} LongtextPanel
 * @property {HTMLElement} el
 * @property {(target: LongtextTarget) => Promise<void>} open 전문을 읽어 연다. 실패는 알리고 닫힌 채로 둔다
 * @property {() => Promise<boolean>} save
 * @property {() => void} close
 * @property {() => boolean} isOpen
 * @property {() => LongtextTarget | null} target
 * @property {() => Promise<void>} refresh 데이터가 바뀐 뒤 행이 아직 있는지 확인한다. 없으면 닫고 알린다
 * @property {() => void} unmount
 */

/**
 * @param {HTMLElement} parent
 * @param {{ client: Client, toasts: Toasts, onSave: SaveHandler, onClose?: () => void }} deps
 * @returns {LongtextPanel}
 */
export function mountLongtextPanel(parent, deps) {
  const { client, toasts } = deps;
  const el = document.createElement('aside');
  el.className = 'jdr-longtext';
  el.setAttribute('aria-label', t('longtext.title'));
  el.hidden = true;

  const header = document.createElement('div');
  header.className = 'jdr-longtext__header';
  const title = document.createElement('h2');
  title.className = 'jdr-longtext__title';
  title.textContent = t('longtext.title');
  const where = document.createElement('p');
  where.className = 'jdr-longtext__where';
  header.append(title, where);

  const textarea = document.createElement('textarea');
  textarea.className = 'jdr-longtext__textarea';
  textarea.setAttribute('aria-label', t('longtext.title'));
  textarea.spellcheck = false;

  const warning = document.createElement('p');
  warning.className = 'jdr-longtext__warning';
  warning.setAttribute('role', 'status');
  warning.hidden = true;

  const buttons = document.createElement('div');
  buttons.className = 'jdr-longtext__buttons';
  const saveButton = document.createElement('button');
  saveButton.type = 'button';
  saveButton.className = 'jdr-dialog__button jdr-dialog__button--primary';
  saveButton.dataset.action = 'longtext-save';
  saveButton.dataset.hint = 'hint.longtext-save';
  saveButton.textContent = t('longtext.save');
  const cancelButton = document.createElement('button');
  cancelButton.type = 'button';
  cancelButton.className = 'jdr-dialog__button';
  cancelButton.dataset.action = 'longtext-cancel';
  cancelButton.dataset.hint = 'hint.longtext-cancel';
  cancelButton.textContent = t('dialog.cancel');
  buttons.append(saveButton, cancelButton);

  el.append(header, textarea, warning, buttons);
  parent.append(el);

  /** @type {LongtextTarget | null} */
  let current = null;
  /** @type {SqlValue} */
  let oldValue = null;
  /** @type {string | null} */
  let oldUpdatedAt = null;
  let saving = false;
  const encoder = new TextEncoder();

  function updateWarning() {
    const bytes = encoder.encode(textarea.value).byteLength;
    warning.hidden = bytes <= LONGTEXT_WARN_BYTES;
    warning.textContent = warning.hidden
      ? ''
      : t('longtext.sizeWarning', { size: formatBytes(bytes) });
  }

  /** @param {KeyboardEvent} ev */
  const onKeydown = (ev) => {
    if (ev.isComposing) return;
    if (ev.key === 'Escape') {
      ev.preventDefault();
      panel.close();
    } else if (ev.key === 'Enter' && (ev.ctrlKey || ev.metaKey)) {
      ev.preventDefault();
      void panel.save();
    }
  };
  const onInput = () => updateWarning();
  const onSave = () => void panel.save();
  const onCancel = () => panel.close();
  textarea.addEventListener('keydown', onKeydown);
  textarea.addEventListener('input', onInput);
  saveButton.addEventListener('click', onSave);
  cancelButton.addEventListener('click', onCancel);

  /**
   * @param {LongtextTarget} target
   * @param {string} text
   */
  function showTarget(target, text) {
    where.textContent = t('longtext.where', {
      table: target.tableName,
      column: target.column.name,
      row: target.rowIndex + 1,
    });
    textarea.value = text;
    updateWarning();
    el.hidden = false;
    textarea.focus();
  }

  /** @type {LongtextPanel} */
  const panel = {
    el,

    async open(target) {
      if (target.rowId === null) {
        current = target;
        oldValue = null;
        oldUpdatedAt = null;
        showTarget(target, '');
        return;
      }
      /** @type {import('../../db/query.js').FullRow | null} */
      let row;
      try {
        row = (
          await client.call('query.row', {
            tableId: target.tableId,
            rowId: target.rowId,
            colIds: [target.column.id],
          })
        ).row;
      } catch (err) {
        toasts.error(toAppError(err));
        return;
      }
      if (!row) {
        toasts.info('edit.rowGone');
        return;
      }
      current = target;
      oldValue = row.cells[target.column.id] ?? null;
      oldUpdatedAt = row.updatedAt;
      showTarget(target, oldValue === null || oldValue === undefined ? '' : String(oldValue));
    },

    async save() {
      if (!current || saving) return false;
      const value = textarea.value;
      const newValue = value.trim() === '' ? null : value;
      saving = true;
      /** @type {boolean} */
      let ok;
      try {
        ok = current.commit
          ? await current.commit(newValue)
          : await deps.onSave({ target: current, oldValue, oldUpdatedAt, newValue });
      } finally {
        saving = false;
      }
      if (ok) panel.close();
      return ok;
    },

    close() {
      if (!current) return;
      current = null;
      oldValue = null;
      oldUpdatedAt = null;
      textarea.value = '';
      warning.hidden = true;
      el.hidden = true;
      deps.onClose?.();
    },

    isOpen: () => current !== null,
    target: () => current,

    async refresh() {
      // 빈 행에는 다시 읽을 행이 없다. 빈 행이 꺼지는 전환은 편집 컨트롤러가 닫는다.
      if (!current || current.rowId === null) return;
      const target = current;
      const rowId = current.rowId;
      /** @type {import('../../db/query.js').FullRow | null} */
      let row;
      try {
        row = (
          await client.call('query.row', {
            tableId: target.tableId,
            rowId,
            colIds: [target.column.id],
          })
        ).row;
      } catch (err) {
        // 테이블 자체가 사라진 경우도 행이 없는 것과 같다.
        toasts.error(toAppError(err));
        row = null;
      }
      if (current !== target) return;
      if (!row) {
        panel.close();
        toasts.info('edit.rowGone');
        return;
      }
      // 다른 경로(되돌리기 등)가 이 셀을 바꿨으면 확정 시 옛 값으로 되돌릴 기준도 그에 맞춘다.
      oldValue = row.cells[target.column.id] ?? null;
      oldUpdatedAt = row.updatedAt;
    },

    unmount() {
      textarea.removeEventListener('keydown', onKeydown);
      textarea.removeEventListener('input', onInput);
      saveButton.removeEventListener('click', onSave);
      cancelButton.removeEventListener('click', onCancel);
      el.remove();
    },
  };
  return panel;
}
