// @ts-check
/**
 * 토스트 알림. 오류는 `error.<코드>` 문구로, 안내는 i18n 키로 표시한다. 문구는 textContent로만 넣는다.
 */
import { hasMessage, t } from '../i18n/index.js';

/** @typedef {import('../util/errors.js').AppError} AppError */
/** @typedef {import('../i18n/index.js').MessageKey} MessageKey */
/** @typedef {import('../i18n/index.js').MessageParams} MessageParams */

/** 토스트가 사라지는 시간(ms). 오류는 더 오래 둔다. */
export const TOAST_INFO_MS = 4_000;
export const TOAST_ERROR_MS = 10_000;

/**
 * @typedef {object} Toasts
 * @property {HTMLElement} el
 * @property {(key: MessageKey, params?: MessageParams) => void} info
 * @property {(err: AppError) => void} error
 * @property {(text: string, kind: 'info' | 'error', timeoutMs: number) => HTMLElement} show 이미 만든 문구를 표시(내부·테스트용)
 */

/**
 * @param {HTMLElement} parent
 * @returns {Toasts}
 */
export function mountToasts(parent) {
  const el = document.createElement('div');
  el.className = 'jdr-toasts';
  el.setAttribute('aria-live', 'polite');
  parent.append(el);

  /** @type {Toasts['show']} */
  function show(text, kind, timeoutMs) {
    const item = document.createElement('div');
    item.className = `jdr-toast jdr-toast--${kind}`;
    item.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    const message = document.createElement('span');
    message.className = 'jdr-toast__message';
    message.textContent = text;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'jdr-toast__close';
    close.setAttribute('aria-label', t('dialog.close'));
    close.textContent = '×';
    const remove = () => {
      close.removeEventListener('click', remove);
      item.remove();
    };
    close.addEventListener('click', remove);
    item.append(message, close);
    el.append(item);
    setTimeout(remove, timeoutMs);
    return item;
  }

  return {
    el,
    show,
    info(key, params) {
      show(t(key, params), 'info', TOAST_INFO_MS);
    },
    error(err) {
      const key = `error.${err.code}`;
      const text = hasMessage(key) ? t(key) : t('error.E_UNKNOWN');
      // 원인은 콘솔에만 남긴다. 사용자 문구는 i18n 키에서만 온다(CLAUDE.md 5.5).
      console.error(err);
      show(`${text} (${err.code})`, 'error', TOAST_ERROR_MS);
    },
  };
}
