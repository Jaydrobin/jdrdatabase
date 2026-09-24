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
 * @property {(body: HTMLElement, actions: DialogActions) => void} [body] 폼 등 추가 내용을 채우는 함수. `actions`는 본문 안의 컨트롤이 버튼 행의 버튼을 누른 것과 같게 닫을 때 쓴다
 * @property {DialogButton[]} buttons
 * @property {string} cancelValue Esc·배경 클릭 시 resolve 값
 * @property {() => string | null | Promise<string | null>} [validate] 확인(primary) 전에 검사. 오류 문구를 돌려주면 닫지 않고 표시. Promise면 끝날 때까지 버튼을 잠근다(가져오기 실행처럼 긴 작업)
 * @property {() => boolean} [beforeCancel] 취소(취소 버튼·Esc·배경)를 가로챈다. false를 돌려주면 닫지 않는다(진행 중인 작업을 먼저 멈출 때)
 * @property {boolean} [wide] 넓은 대화상자(미리보기 표 등)
 * @property {() => HTMLElement | null} [initialFocus] 열린 뒤 포커스를 받을 요소. 없거나 null이면 첫 입력칸, 확인 버튼, 첫 버튼 순이다
 */

/**
 * 본문 콜백이 받는 손잡이.
 * @typedef {object} DialogActions
 * @property {(value: string) => void} submit 그 값의 버튼을 누른 것과 같다(확인 버튼이면 `validate`를 거친다). 본문을 만드는 동안이 아니라 사용자 동작에서 부른다
 * @property {(value: string, enabled: boolean) => void} setEnabled 그 값의 버튼을 켜거나 끈다. 꺼진 버튼은 Enter로도 제출되지 않고, 비동기 `validate`가 끝나도 꺼진 채다. 본문을 만드는 동안 불러도 된다
 */

/** @type {HTMLElement | null} */
let openBackdrop = null;
/**
 * 열려 있는 대화상자를 취소와 같은 결과로 닫는 함수. 새 대화상자가 앞의 것을 밀어낼 때 쓴다.
 * DOM에서 지우기만 하면 앞 호출자의 Promise가 끝나지 않고 `document` keydown 리스너도 남는다.
 * @type {(() => void) | null}
 */
let closeOpen = null;

/**
 * 모달이 떠 있는가. 전역 단축키가 모달 뒤의 앱을 움직이지 않도록 확인한다.
 * @returns {boolean}
 */
export function isDialogOpen() {
  return openBackdrop !== null;
}

// 로빙 tabindex(도움말의 주제 탭)의 `tabindex="-1"` 버튼은 탭 순서에 없으므로 트랩의 처음·끝이 될 수 없다.
const FOCUSABLE =
  'button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [href], [tabindex]:not([tabindex="-1"])';

/**
 * 대화상자를 열고 사용자의 선택 값을 돌려준다. 한 번에 하나만 열린다(열려 있으면 먼저 닫힌 것으로 처리).
 * @param {DialogOptions} options
 * @returns {Promise<string>}
 */
export function openDialog(options) {
  return new Promise((resolve) => {
    if (openBackdrop) {
      // 밀려나는 대화상자는 취소로 끝낸다. `beforeCancel`(진행 중 작업 확인)은 건너뛴다 —
      // 이미 화면에서 밀려난 대화상자가 새 대화상자를 막을 수는 없기 때문이다.
      const closePrevious = closeOpen;
      openBackdrop = null;
      closeOpen = null;
      if (closePrevious) closePrevious();
      else document.querySelector('.jdr-dialog__backdrop')?.remove();
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
    // 버튼 행은 본문 뒤에 붙지만 먼저 만든다. 본문 콜백의 `setEnabled`가 버튼을 찾는다.
    const row = document.createElement('div');
    row.className = 'jdr-dialog__buttons';
    /** @type {Set<string>} 본문이 끈 버튼의 값(`setEnabled`) */
    const disabledValues = new Set();
    /** 비동기 검사가 진행 중이다. 그동안 확인·Enter는 무시하고 취소만 `beforeCancel`로 넘긴다. */
    let pending = false;
    // `submit`은 아래의 함수 선언이다. 본문의 컨트롤은 사용자 동작에서만 부르므로 그때는 버튼 행이 이미 있다.
    options.body?.(body, {
      submit: (value) => submit(value),
      setEnabled: (value, enabled) => {
        if (enabled) disabledValues.delete(value);
        else disabledValues.add(value);
        applyEnabled();
      },
    });
    dialog.append(body);

    const error = document.createElement('p');
    error.className = 'jdr-dialog__error';
    error.setAttribute('role', 'alert');
    error.hidden = true;
    dialog.append(error);

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
    applyEnabled();

    /** 버튼의 켜짐: 진행 중이면 취소 말고 모두 끄고, 본문이 끈 버튼은 언제나 끈다. 버튼 행이 생기기 전에는 할 일이 없다. */
    function applyEnabled() {
      for (const b of row.querySelectorAll('button')) {
        const value = b.dataset.value ?? '';
        // 취소 버튼은 열어 둔다(진행 중인 작업을 멈추는 손잡이다).
        b.disabled = disabledValues.has(value) || (pending && value !== options.cancelValue);
      }
    }

    /** @param {boolean} on */
    function setBusy(on) {
      pending = on;
      applyEnabled();
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
      if (openBackdrop === backdrop) {
        openBackdrop = null;
        closeOpen = null;
      }
      previouslyFocused?.focus?.();
      resolve(value);
    }

    /** @param {string} value */
    function submit(value) {
      if (value === options.cancelValue) {
        cancel();
        return;
      }
      if (pending || disabledValues.has(value)) return;
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
    closeOpen = () => close(options.cancelValue);

    const firstInput = /** @type {HTMLElement | null} */ (
      body.querySelector('input, select, textarea')
    );
    const initial = options.initialFocus?.() ?? null;
    (initial ?? firstInput ?? primaryButton ?? row.querySelector('button'))?.focus();
    // 미리 채운 이름(새 테이블의 `테이블 n`, 이름 바꾸기의 옛 이름)은 전체 선택해 둔다. Enter 한 번으로
    // 그대로 받거나 바로 타이핑해 바꾼다(D-16).
    if (firstInput instanceof HTMLInputElement && firstInput.type === 'text') firstInput.select();
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
