// @ts-check
/**
 * 모달 대화상자 기반. 포커스 트랩, Esc, 버튼 행, 열기 전 포커스 복원.
 * 문구는 호출자가 i18n 키로 만든 문자열을 넘기고, 이 파일은 textContent로만 넣는다(CLAUDE.md 5.5).
 */
import { t } from '../../i18n/index.js';

/**
 * @typedef {object} DialogButton
 * @property {string} label
 * @property {string} value 버튼을 누르면 이 값으로 resolve
 * @property {boolean} [primary]
 * @property {boolean} [danger]
 */

/**
 * @typedef {object} DialogOptions
 * @property {string} title
 * @property {string} [message] 본문 문단. 줄바꿈(`\n`)은 문단 구분
 * @property {(body: HTMLElement) => void} [body] 폼 등 추가 내용을 채우는 함수
 * @property {DialogButton[]} buttons
 * @property {string} cancelValue Esc·배경 클릭 시 resolve 값
 * @property {() => string | null | Promise<string | null>} [validate] 확인(primary) 전에 검사. 오류 문구를 돌려주면 닫지 않고 표시. Promise면 끝날 때까지 버튼을 잠근다(가져오기 실행처럼 긴 작업)
 * @property {() => boolean} [beforeCancel] 취소(취소 버튼·Esc·배경)를 가로챈다. false를 돌려주면 닫지 않는다(진행 중인 작업을 먼저 멈출 때)
 * @property {boolean} [wide] 넓은 대화상자(미리보기 표 등)
 */

/** @type {HTMLElement | null} */
let openBackdrop = null;

/**
 * 모달이 떠 있는가. 전역 단축키가 모달 뒤의 앱을 움직이지 않도록 확인한다.
 * @returns {boolean}
 */
export function isDialogOpen() {
  return openBackdrop !== null;
}

const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * 대화상자를 열고 사용자의 선택 값을 돌려준다. 한 번에 하나만 열린다(열려 있으면 먼저 닫힌 것으로 처리).
 * @param {DialogOptions} options
 * @returns {Promise<string>}
 */
export function openDialog(options) {
  return new Promise((resolve) => {
    if (openBackdrop) {
      openBackdrop.remove();
      openBackdrop = null;
    }
    const previouslyFocused = /** @type {HTMLElement | null} */ (document.activeElement);

    const backdrop = document.createElement('div');
    backdrop.className = 'jdr-dialog__backdrop';

    const dialog = document.createElement('div');
    dialog.className = options.wide ? 'jdr-dialog jdr-dialog--wide' : 'jdr-dialog';
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    const titleId = `jdr-dialog-title-${Date.now().toString(36)}`;
    dialog.setAttribute('aria-labelledby', titleId);

    const title = document.createElement('h2');
    title.className = 'jdr-dialog__title';
    title.id = titleId;
    title.textContent = options.title;
    dialog.append(title);

    const body = document.createElement('div');
    body.className = 'jdr-dialog__body';
    if (options.message) {
      for (const paragraph of options.message.split('\n')) {
        const p = document.createElement('p');
        p.className = 'jdr-dialog__message';
        p.textContent = paragraph;
        body.append(p);
      }
    }
    options.body?.(body);
    dialog.append(body);

    const error = document.createElement('p');
    error.className = 'jdr-dialog__error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    dialog.append(error);

    const row = document.createElement('div');
    row.className = 'jdr-dialog__buttons';
    /** @type {HTMLButtonElement | null} */
    let primaryButton = null;
    for (const spec of options.buttons) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'jdr-dialog__button';
      if (spec.primary) {
        button.classList.add('jdr-dialog__button--primary');
        primaryButton = button;
      }
      if (spec.danger) button.classList.add('jdr-dialog__button--danger');
      button.textContent = spec.label;
      button.dataset.value = spec.value;
      button.addEventListener('click', onButtonClick);
      row.append(button);
    }
    dialog.append(row);
    backdrop.append(dialog);

    /** 비동기 검사가 진행 중이다. 그동안 확인·Enter는 무시하고 취소만 `beforeCancel`로 넘긴다. */
    let pending = false;

    /** @param {boolean} on */
    function setBusy(on) {
      pending = on;
      for (const b of row.querySelectorAll('button')) {
        // 취소 버튼은 열어 둔다(진행 중인 작업을 멈추는 손잡이다).
        if (b.dataset.value !== options.cancelValue) b.disabled = on;
      }
    }

    /**
     * 취소 경로. `beforeCancel`이 false면 열린 채로 둔다.
     * @returns {boolean} 닫혔는가
     */
    function cancel() {
      if (options.beforeCancel && options.beforeCancel() === false) return false;
      close(options.cancelValue);
      return true;
    }

    /** @param {string} value */
    function close(value) {
      document.removeEventListener('keydown', onKeydown, true);
      backdrop.removeEventListener('mousedown', onBackdropClick);
      for (const b of row.querySelectorAll('button')) b.removeEventListener('click', onButtonClick);
      backdrop.remove();
      if (openBackdrop === backdrop) openBackdrop = null;
      previouslyFocused?.focus?.();
      resolve(value);
    }

    /** @param {string} value */
    function submit(value) {
      if (value === options.cancelValue) {
        cancel();
        return;
      }
      if (pending) return;
      const isPrimary = options.buttons.find((b) => b.value === value)?.primary;
      if (isPrimary && options.validate) {
        const outcome = options.validate();
        if (outcome instanceof Promise) {
          error.hidden = true;
          setBusy(true);
          outcome
            .then((problem) => {
              setBusy(false);
              if (problem) {
                error.textContent = problem;
                error.hidden = false;
                return;
              }
              close(value);
            })
            .catch((/** @type {unknown} */ err) => {
              // validate는 오류를 문구로 바꿔 돌려주는 계약이다. 그래도 던지면 문구로 보여 주고 열어 둔다.
              setBusy(false);
              error.textContent = err instanceof Error ? err.message : String(err);
              error.hidden = false;
            });
          return;
        }
        if (outcome) {
          error.textContent = outcome;
          error.hidden = false;
          return;
        }
      }
      close(value);
    }

    /** @param {Event} ev */
    function onButtonClick(ev) {
      const target = /** @type {HTMLButtonElement} */ (ev.currentTarget);
      submit(target.dataset.value ?? options.cancelValue);
    }

    /** @param {MouseEvent} ev */
    function onBackdropClick(ev) {
      if (ev.target === backdrop) cancel();
    }

    /** @param {KeyboardEvent} ev */
    function onKeydown(ev) {
      // 한글 조합 중의 Enter/Esc는 IME가 소비한다(CLAUDE.md 5.5).
      if (ev.isComposing) return;
      if (ev.key === 'Escape') {
        ev.preventDefault();
        cancel();
        return;
      }
      if (ev.key === 'Enter' && primaryButton && !pending) {
        const target = /** @type {HTMLElement | null} */ (ev.target);
        if (target && target.tagName === 'TEXTAREA') return;
        if (target && target.tagName === 'BUTTON') return;
        ev.preventDefault();
        submit(primaryButton.dataset.value ?? options.cancelValue);
        return;
      }
      if (ev.key === 'Tab') {
        const focusable = /** @type {HTMLElement[]} */ ([...dialog.querySelectorAll(FOCUSABLE)]);
        if (focusable.length === 0) return;
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!first || !last) return;
        if (ev.shiftKey && document.activeElement === first) {
          ev.preventDefault();
          last.focus();
        } else if (!ev.shiftKey && document.activeElement === last) {
          ev.preventDefault();
          first.focus();
        }
      }
    }

    document.addEventListener('keydown', onKeydown, true);
    backdrop.addEventListener('mousedown', onBackdropClick);
    document.body.append(backdrop);
    openBackdrop = backdrop;

    const firstInput = /** @type {HTMLElement | null} */ (
      body.querySelector('input, select, textarea')
    );
    (firstInput ?? primaryButton ?? row.querySelector('button'))?.focus();
  });
}

/**
 * 확인/취소 대화상자.
 * @param {{ title: string, message: string, okLabel?: string, cancelLabel?: string, danger?: boolean }} options
 * @returns {Promise<boolean>}
 */
export async function confirmDialog(options) {
  const value = await openDialog({
    title: options.title,
    message: options.message,
    buttons: [
      { label: options.cancelLabel ?? t('dialog.cancel'), value: 'cancel' },
      {
        label: options.okLabel ?? t('dialog.ok'),
        value: 'ok',
        primary: true,
        danger: options.danger,
      },
    ],
    cancelValue: 'cancel',
  });
  return value === 'ok';
}

/**
 * 한 줄 텍스트 입력 대화상자. 취소하면 null.
 * @param {{ title: string, label: string, value?: string, okLabel?: string, validate?: (value: string) => string | null }} options
 * @returns {Promise<string | null>}
 */
export async function promptText(options) {
  /** @type {HTMLInputElement | null} */
  let input = null;
  const value = await openDialog({
    title: options.title,
    body: (body) => {
      const label = document.createElement('label');
      label.className = 'jdr-dialog__label';
      const span = document.createElement('span');
      span.textContent = options.label;
      input = document.createElement('input');
      input.type = 'text';
      input.className = 'jdr-dialog__input';
      input.value = options.value ?? '';
      label.append(span, input);
      body.append(label);
    },
    buttons: [
      { label: t('dialog.cancel'), value: 'cancel' },
      { label: options.okLabel ?? t('dialog.ok'), value: 'ok', primary: true },
    ],
    cancelValue: 'cancel',
    validate: () => (options.validate && input ? options.validate(input.value) : null),
  });
  if (value !== 'ok' || !input) return null;
  return /** @type {HTMLInputElement} */ (input).value;
}
