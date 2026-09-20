// @ts-check
/**
 * 상태바(3.1): 상태 문구, 전송 모드, 엔진 버전, 앱 버전.
 * 문구는 모두 i18n 키로 받고 textContent로만 넣는다(CLAUDE.md 5.5).
 */
import { t } from '../i18n/index.js';

/** @typedef {import('../i18n/index.js').MessageKey} MessageKey */
/** @typedef {import('../i18n/index.js').MessageParams} MessageParams */

/**
 * @typedef {object} Statusbar
 * @property {HTMLElement} el
 * @property {(key: MessageKey, params?: MessageParams) => void} setStatus 첫 칸의 상태 문구
 * @property {(key: MessageKey) => void} setMode 전송 모드(Worker / 단일 스레드)
 * @property {(version: string) => void} setEngine SQLite 버전
 * @property {(danger: boolean) => void} setDanger 상태 칸을 경고색으로
 * @property {(key: MessageKey | null, params?: MessageParams) => void} setNote 부가 안내(읽기 전용, 저널 꺼짐 등). null이면 비움
 */

/**
 * @param {HTMLElement} parent
 * @param {{ version: string }} opts
 * @returns {Statusbar}
 */
export function mountStatusbar(parent, opts) {
  const el = document.createElement('footer');
  el.className = 'jdr-statusbar';

  const status = document.createElement('span');
  status.className = 'jdr-statusbar__item';
  status.textContent = t('status.booting');

  const mode = document.createElement('span');
  mode.className = 'jdr-statusbar__item';

  const engine = document.createElement('span');
  engine.className = 'jdr-statusbar__item';

  const version = document.createElement('span');
  version.className = 'jdr-statusbar__item';
  version.textContent = t('app.version', { version: opts.version });

  const note = document.createElement('span');
  note.className = 'jdr-statusbar__item jdr-statusbar__item--note';

  el.append(status, mode, engine, version, note);
  parent.append(el);

  return {
    el,
    setStatus(key, params) {
      status.textContent = t(key, params);
    },
    setMode(key) {
      mode.textContent = t(key);
    },
    setEngine(sqliteVersion) {
      engine.textContent = t('status.engine', { version: sqliteVersion });
    },
    setDanger(danger) {
      status.classList.toggle('jdr-statusbar__item--danger', danger);
    },
    setNote(key, params) {
      note.textContent = key ? t(key, params) : '';
    },
  };
}
