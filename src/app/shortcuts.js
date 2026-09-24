// @ts-check
/**
 * 키보드 단축키 매핑(3.1). 키 이벤트를 행동 이름으로 바꾸는 순수 함수와, 문서 수준 리스너 마운트.
 *
 * - 조합 중(`isComposing`)의 키는 어떤 행동에도 대응하지 않는다(CLAUDE.md 5.5).
 * - 저장·되돌리기 같은 문서 수준 단축키는 모달이 떠 있으면 무시하고, 입력 요소 안에서는 브라우저의
 *   기본 동작(input의 되돌리기)을 빼앗지 않는다. 그리드 수준 단축키(편집·삭제·복사)는 그리드가 처리한다.
 * - 도움말의 단축키 주제는 이 표를 `describe()`로 읽어 그린다(D-19). 설명 문구는 `shortcut.<action>` 키다.
 * - 앱이 가로채지 않고 브라우저·편집기가 처리하는 조합(그리드 붙여넣기, 장문 편집기 저장)도 설명 전용 항목
 *   (`describeOnly`)으로 표에 둔다. 도움말에는 보이지만 `resolveShortcut`은 고르지 않는다.
 * - 툴팁은 문구에 키 조합을 적지 않고 `shortcutForHint()`로 이 표에서 붙인다(D-19).
 */

/**
 * @typedef {'save' | 'saveAs' | 'undo' | 'redo' | 'edit' | 'cancel' | 'clear' | 'copy' | 'paste' | 'selectAll' | 'rowInsert' | 'rowDelete' | 'columnMenu' | 'help' | 'longtextSave'} ShortcutAction
 */

/**
 * @typedef {object} Shortcut
 * @property {ShortcutAction} action
 * @property {string} key `KeyboardEvent.key`(대소문자 구분 없음)
 * @property {boolean} [ctrl] Ctrl 또는 Meta(macOS)
 * @property {boolean} [shift]
 * @property {boolean} [alt]
 * @property {ShortcutScope} scope
 * @property {boolean} [describeOnly] 도움말에 보이기만 한다. 키는 브라우저(붙여넣기 이벤트)나 편집기가 직접 처리하고
 *   `resolveShortcut`은 이 항목을 고르지 않는다
 */

/** @typedef {'document' | 'grid' | 'longtext'} ShortcutScope */

/** 단축키 표. 앞에서부터 처음 맞는 항목을 고르므로 더 구체적인 조합을 먼저 둔다. */
export const SHORTCUTS = Object.freeze(
  /** @type {readonly Shortcut[]} */ ([
    { action: 'saveAs', key: 's', ctrl: true, shift: true, scope: 'document' },
    { action: 'save', key: 's', ctrl: true, scope: 'document' },
    { action: 'redo', key: 'z', ctrl: true, shift: true, scope: 'document' },
    { action: 'redo', key: 'y', ctrl: true, scope: 'document' },
    { action: 'undo', key: 'z', ctrl: true, scope: 'document' },
    // 도움말(D-19). 브라우저·WebView가 F1을 먼저 가로채면 도구 모음의 버튼만 남는다(docs/support-matrix.md).
    { action: 'help', key: 'F1', scope: 'document' },
    { action: 'rowInsert', key: 'Enter', ctrl: true, shift: true, scope: 'grid' },
    { action: 'rowDelete', key: 'Delete', ctrl: true, shift: true, scope: 'grid' },
    { action: 'selectAll', key: 'a', ctrl: true, scope: 'grid' },
    // 활성 셀의 열 메뉴(D-16). 머리글 버튼은 탭 정지가 아니므로 키보드로는 여기서 연다.
    { action: 'columnMenu', key: 'F10', shift: true, scope: 'grid' },
    { action: 'columnMenu', key: 'ContextMenu', scope: 'grid' },
    { action: 'copy', key: 'c', ctrl: true, scope: 'grid' },
    // 붙여넣기는 그리드의 `paste` 이벤트가 처리한다(키를 가로채면 클립보드 읽기 권한이 필요해진다).
    { action: 'paste', key: 'v', ctrl: true, scope: 'grid', describeOnly: true },
    { action: 'edit', key: 'Enter', scope: 'grid' },
    { action: 'edit', key: 'F2', scope: 'grid' },
    { action: 'cancel', key: 'Escape', scope: 'grid' },
    { action: 'clear', key: 'Delete', scope: 'grid' },
    { action: 'clear', key: 'Backspace', scope: 'grid' },
    // 장문 편집기의 저장은 편집기의 textarea가 처리한다(editor/longtext.js).
    { action: 'longtextSave', key: 'Enter', ctrl: true, scope: 'longtext', describeOnly: true },
  ]),
);

/**
 * `KeyboardEvent`의 필요한 부분. 테스트가 가짜 이벤트를 넣는다.
 * @typedef {object} KeyLike
 * @property {string} key
 * @property {boolean} ctrlKey
 * @property {boolean} metaKey
 * @property {boolean} shiftKey
 * @property {boolean} altKey
 * @property {boolean} isComposing
 */

/**
 * 키 이벤트에 대응하는 행동. 없으면 null.
 * @param {KeyLike} ev
 * @param {'document' | 'grid'} scope
 * @returns {ShortcutAction | null}
 */
export function resolveShortcut(ev, scope) {
  if (ev.isComposing || ev.key === 'Process') return null;
  const ctrl = ev.ctrlKey || ev.metaKey;
  const key = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
  for (const shortcut of SHORTCUTS) {
    if (shortcut.describeOnly || shortcut.scope !== scope) continue;
    const want = shortcut.key.length === 1 ? shortcut.key.toLowerCase() : shortcut.key;
    if (want !== key) continue;
    if ((shortcut.ctrl ?? false) !== ctrl) continue;
    if ((shortcut.shift ?? false) !== ev.shiftKey) continue;
    if ((shortcut.alt ?? false) !== ev.altKey) continue;
    return shortcut.action;
  }
  return null;
}

/**
 * 키 입력이 텍스트 입력 요소(input·textarea·select·contenteditable) 안에서 났는가.
 * @param {EventTarget | null} target
 * @returns {boolean}
 */
export function isTextInputTarget(target) {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * 문서 수준 단축키를 건다. `guard`가 false를 돌려주면(모달 열림 등) 아무것도 하지 않는다.
 * @param {Partial<Record<ShortcutAction, () => void>>} handlers
 * @param {{ guard?: () => boolean }} [options]
 * @returns {() => void} 해제 함수
 */
export function mountShortcuts(handlers, options = {}) {
  /** @param {KeyboardEvent} ev */
  const onKeydown = (ev) => {
    const action = resolveShortcut(ev, 'document');
    if (!action) return;
    if (options.guard && !options.guard()) {
      // 모달이 떠 있으면 행동은 하지 않는다. 다만 F1은 그때도 브라우저의 것(Chrome의 도움말 탭)이
      // 되지 않게 막는다. 앱의 도움말 키가 때에 따라 앱을 떠나게 하면 안 된다(D-19).
      if (action === 'help') ev.preventDefault();
      return;
    }
    // 입력 요소 안의 Ctrl+Z는 그 요소의 되돌리기다. 저장은 어디서든 앱의 것이다.
    if ((action === 'undo' || action === 'redo') && isTextInputTarget(ev.target)) return;
    const handler = handlers[action];
    if (!handler) return;
    ev.preventDefault();
    handler();
  };
  document.addEventListener('keydown', onKeydown);
  return () => document.removeEventListener('keydown', onKeydown);
}

/**
 * 도움말에 보이는 키 이름. 여기 없는 키는 `KeyboardEvent.key` 그대로(글자 키는 대문자)다.
 * @type {Readonly<Record<string, string>>}
 */
const KEY_NAMES = Object.freeze({ Escape: 'Esc', ContextMenu: 'Menu' });

/**
 * 도움말 단축키 주제의 한 줄.
 * @typedef {object} ShortcutDescription
 * @property {string} keys 표시용 키 조합(`Ctrl+Shift+S`, macOS는 `⌘⇧S`)
 * @property {`shortcut.${ShortcutAction}`} labelKey 설명 문구의 i18n 키
 * @property {ShortcutAction} action
 * @property {ShortcutScope} scope
 */

/**
 * macOS인가. `navigator`가 없거나(Node) 읽을 수 없으면 아니라고 본다(기능 감지, CLAUDE.md 5.6).
 * @returns {boolean}
 */
function detectMac() {
  try {
    return /Mac|iPhone|iPad/.test(globalThis.navigator?.platform ?? '');
  } catch {
    return false;
  }
}

/**
 * 단축키 표의 항목마다 표시용 키 조합과 설명 키를 돌려준다. 표의 순서를 지킨다.
 * @param {{ mac?: boolean }} [options] `mac`이 없으면 `navigator.platform`으로 정한다
 * @returns {ShortcutDescription[]}
 */
export function describe(options = {}) {
  const mac = options.mac ?? detectMac();
  return SHORTCUTS.map((shortcut) => ({
    keys: formatKeys(shortcut, mac),
    labelKey: /** @type {const} */ (`shortcut.${shortcut.action}`),
    action: shortcut.action,
    scope: shortcut.scope,
  }));
}

/**
 * 표의 한 항목을 표시용 키 조합으로 쓴다(`Ctrl+Shift+S`, macOS는 `⌘⇧S`).
 * @param {Shortcut} shortcut
 * @param {boolean} mac
 * @returns {string}
 */
function formatKeys(shortcut, mac) {
  const key =
    KEY_NAMES[shortcut.key] ??
    (shortcut.key.length === 1 ? shortcut.key.toUpperCase() : shortcut.key);
  /** @type {string[]} */
  const parts = [];
  if (shortcut.ctrl) parts.push(mac ? '⌘' : 'Ctrl');
  if (shortcut.alt) parts.push(mac ? '⌥' : 'Alt');
  if (shortcut.shift) parts.push(mac ? '⇧' : 'Shift');
  parts.push(key);
  return parts.join(mac ? '' : '+');
}

/**
 * 단축키가 있는 요소의 툴팁 키(`data-hint`) → 표의 행동. 툴팁은 문구 뒤에 이 행동의 조합을 붙인다(D-19).
 * @type {Readonly<Record<string, ShortcutAction>>}
 */
export const HINT_SHORTCUTS = Object.freeze({
  'hint.save': 'save',
  'hint.save-as': 'saveAs',
  'hint.undo': 'undo',
  'hint.redo': 'redo',
  'hint.help-open': 'help',
  'hint.row-insert': 'rowInsert',
  'hint.row-delete': 'rowDelete',
  'hint.header-menu': 'columnMenu',
  'hint.longtext-save': 'longtextSave',
});

/**
 * 툴팁 키에 대응하는 단축키 조합. 같은 행동의 조합 여럿은 표의 순서대로 ` / `로 잇는다. 없으면 null.
 * @param {string} hintKey `data-hint` 값
 * @param {{ mac?: boolean }} [options] `mac`이 없으면 `navigator.platform`으로 정한다
 * @returns {string | null}
 */
export function shortcutForHint(hintKey, options = {}) {
  const action = Object.prototype.hasOwnProperty.call(HINT_SHORTCUTS, hintKey)
    ? HINT_SHORTCUTS[hintKey]
    : undefined;
  if (!action) return null;
  const mac = options.mac ?? detectMac();
  const combos = SHORTCUTS.filter((s) => s.action === action).map((s) => formatKeys(s, mac));
  return combos.length > 0 ? combos.join(' / ') : null;
}
