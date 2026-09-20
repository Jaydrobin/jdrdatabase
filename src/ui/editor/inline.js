// @ts-check
/**
 * 인라인 편집기(Step 5, D-05): 셀 위에 놓이는 `<input>`(select 타입은 `<select>`).
 *
 * - Enter는 확정, Esc는 취소, Tab은 확정 뒤 오른쪽 이동. 한글 조합 중(`isComposing`)의 Enter·Esc는
 *   IME가 소비하므로 건드리지 않는다(CLAUDE.md 5.5).
 * - 확정값은 `values.validate`를 거치며, 실패하면 편집기를 닫지 않고 오류를 표시한다.
 * - 포커스가 밖으로 나가면(다른 곳 클릭) 확정을 시도하고, 실패하면 원래 값으로 되돌리고 알린다.
 * - 편집기 요소는 그리드 스크롤 영역(캔버스) 안에 절대 위치로 놓여 스크롤을 따라간다.
 * - 이 파일은 커맨드를 만들지 않는다. 확정값을 `onCommit`으로 넘기고 결과(성공 여부)를 받는다.
 */
import { validate } from '../../db/values.js';
import { t } from '../../i18n/index.js';

/** @typedef {import('../../db/tables.js').ColumnInfo} ColumnInfo */
/** @typedef {import('../../db/values.js').StoredValue} StoredValue */
/** @typedef {import('../../db/values.js').InvalidReason} InvalidReason */
/** @typedef {import('../../i18n/index.js').MessageKey} MessageKey */

/**
 * 편집기를 놓을 셀.
 * @typedef {object} EditCell
 * @property {number} row
 * @property {number} col
 * @property {ColumnInfo} column
 * @property {{ left: number, top: number, width: number, height: number }} rect 캔버스 기준 위치
 * @property {string} text 편집 전 표시 문자열(전문)
 */

/** @typedef {'enter' | 'tab' | 'blur'} CommitReason */

/**
 * @typedef {object} OpenOptions
 * @property {string} [initialText] 있으면 이 값으로 시작(셀에서 바로 타이핑). 없으면 셀의 값
 * @property {(value: StoredValue, reason: CommitReason) => Promise<boolean>} onCommit 검증을 통과한 값. false면 편집기를 닫지 않는다
 * @property {() => void} onCancel Esc로 취소
 * @property {() => void} onRevert 다른 곳을 클릭했는데 확정하지 못해 원래 값으로 되돌리고 닫음
 */

/**
 * @typedef {object} InlineEditor
 * @property {HTMLElement} el 편집기 컨테이너(마운트는 호출자가 캔버스에 한다)
 * @property {(cell: EditCell, options: OpenOptions) => void} open
 * @property {(reason?: CommitReason) => Promise<boolean>} commit 검증 → onCommit. 실패는 표시하고 false
 * @property {() => void} cancel
 * @property {() => boolean} isOpen
 * @property {() => EditCell | null} cell 지금 편집 중인 셀
 * @property {(message: string) => void} showError
 * @property {() => void} dispose
 */

/**
 * 검증 실패 사유 → 문구 키.
 * @param {InvalidReason} reason
 * @returns {MessageKey}
 */
export function reasonMessageKey(reason) {
  return /** @type {MessageKey} */ (`validate.${reason}`);
}

/**
 * @returns {InlineEditor}
 */
export function createInlineEditor() {
  const el = document.createElement('div');
  el.className = 'jdr-editor';
  el.hidden = true;
  const error = document.createElement('div');
  error.className = 'jdr-editor__error';
  error.setAttribute('role', 'alert');
  error.hidden = true;

  /** @type {HTMLInputElement | HTMLSelectElement | null} */
  let field = null;
  /** @type {EditCell | null} */
  let current = null;
  /** @type {OpenOptions | null} */
  let options = null;
  /** 확정이 진행 중이면(비동기 onCommit) 겹치는 확정·취소를 막는다. */
  let committing = false;

  /**
   * @param {ColumnInfo} column
   * @param {string} text
   * @returns {HTMLInputElement | HTMLSelectElement}
   */
  function buildField(column, text) {
    if (column.type === 'select') {
      const select = document.createElement('select');
      select.className = 'jdr-editor__field jdr-editor__field--select';
      const empty = document.createElement('option');
      empty.value = '';
      empty.textContent = t('editor.emptyChoice');
      select.append(empty);
      for (const choice of column.options?.choices ?? []) {
        const option = document.createElement('option');
        option.value = choice;
        option.textContent = choice;
        option.selected = choice === text;
        select.append(option);
      }
      return select;
    }
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'jdr-editor__field';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = text;
    if (column.type === 'date') input.placeholder = t('editor.datePlaceholder');
    if (column.type === 'datetime') input.placeholder = t('editor.datetimePlaceholder');
    return input;
  }

  function teardown() {
    if (field) {
      field.removeEventListener('keydown', onKeydown);
      field.removeEventListener('blur', onBlur);
      field.remove();
    }
    field = null;
    current = null;
    options = null;
    error.hidden = true;
    error.textContent = '';
    el.hidden = true;
    el.classList.remove('jdr-editor--invalid');
  }

  /** @param {Event} raw */
  function onKeydown(raw) {
    const ev = /** @type {KeyboardEvent} */ (raw);
    // 그리드의 키 처리기(화살표 이동 등)가 편집 중의 키를 받지 않게 한다.
    ev.stopPropagation();
    if (ev.isComposing || ev.key === 'Process') return;
    if (ev.key === 'Enter') {
      ev.preventDefault();
      void editor.commit('enter');
    } else if (ev.key === 'Escape') {
      ev.preventDefault();
      editor.cancel();
    } else if (ev.key === 'Tab') {
      ev.preventDefault();
      void editor.commit('tab');
    }
  }

  function onBlur() {
    // 다른 곳 클릭: 확정을 시도하고, 실패하면 원래 값으로 되돌린다(Step 5 예외 처리).
    if (!current || committing) return;
    void editor.commit('blur').then((ok) => {
      if (!ok && current) {
        const revert = options?.onRevert;
        teardown();
        revert?.();
      }
    });
  }

  /** @type {InlineEditor} */
  const editor = {
    el,

    open(cell, opts) {
      if (current) teardown();
      current = cell;
      options = opts;
      field = buildField(cell.column, opts.initialText ?? cell.text);
      el.append(field, error);
      el.style.transform = `translate(${cell.rect.left}px, ${cell.rect.top}px)`;
      el.style.width = `${cell.rect.width}px`;
      el.style.height = `${cell.rect.height}px`;
      el.hidden = false;
      field.addEventListener('keydown', onKeydown);
      field.addEventListener('blur', onBlur);
      field.focus();
      if (field instanceof HTMLInputElement) {
        // 셀에서 바로 타이핑한 첫 글자 뒤에 커서를 둔다. 기존 값을 여는 경우도 끝에서 시작한다.
        const end = field.value.length;
        field.setSelectionRange(end, end);
      }
    },

    async commit(reason = 'enter') {
      if (!current || !field || !options || committing) return false;
      const raw = field.value;
      const result = validate(current.column.type, raw, current.column.options ?? undefined);
      if (!result.ok) {
        editor.showError(t(reasonMessageKey(result.reason)));
        if (reason !== 'blur') field.focus();
        return false;
      }
      committing = true;
      /** @type {boolean} */
      let ok;
      try {
        ok = await options.onCommit(result.value, reason);
      } finally {
        committing = false;
      }
      if (ok) teardown();
      return ok;
    },

    cancel() {
      if (!current) return;
      const cancel = options?.onCancel;
      teardown();
      cancel?.();
    },

    isOpen: () => current !== null,
    cell: () => current,

    showError(message) {
      error.textContent = message;
      error.hidden = false;
      el.classList.add('jdr-editor--invalid');
      field?.setAttribute('aria-invalid', 'true');
    },

    dispose() {
      teardown();
      el.remove();
    },
  };
  return editor;
}
