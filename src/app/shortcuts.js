// @ts-check
/**
 * 키보드 단축키 매핑(3.1). 키 이벤트를 행동 이름으로 바꾸는 순수 함수와, 문서 수준 리스너 마운트.
 *
 * - 조합 중(`isComposing`)의 키는 어떤 행동에도 대응하지 않는다(CLAUDE.md 5.5).
 * - 저장·되돌리기 같은 문서 수준 단축키는 모달이 떠 있으면 무시하고, 입력 요소 안에서는 브라우저의
 *   기본 동작(input의 되돌리기)을 빼앗지 않는다. 그리드 수준 단축키(편집·삭제·복사)는 그리드가 처리한다.
 */

/**
 * @typedef {'save' | 'saveAs' | 'undo' | 'redo' | 'edit' | 'cancel' | 'clear' | 'copy' | 'selectAll' | 'rowInsert' | 'rowDelete' | 'columnMenu'} ShortcutAction
 */

/**
 * @typedef {object} Shortcut
 * @property {ShortcutAction} action
 * @property {string} key `KeyboardEvent.key`(대소문자 구분 없음)
 * @property {boolean} [ctrl] Ctrl 또는 Meta(macOS)
 * @property {boolean} [shift]
 * @property {boolean} [alt]
 * @property {'document' | 'grid'} scope
 */

/** 단축키 표. 앞에서부터 처음 맞는 항목을 고르므로 더 구체적인 조합을 먼저 둔다. */
export const SHORTCUTS = Object.freeze(
  /** @type {readonly Shortcut[]} */ ([
    { action: 'saveAs', key: 's', ctrl: true, shift: true, scope: 'document' },
    { action: 'save', key: 's', ctrl: true, scope: 'document' },
    { action: 'redo', key: 'z', ctrl: true, shift: true, scope: 'document' },
    { action: 'redo', key: 'y', ctrl: true, scope: 'document' },
    { action: 'undo', key: 'z', ctrl: true, scope: 'document' },
    { action: 'rowInsert', key: 'Enter', ctrl: true, shift: true, scope: 'grid' },
    { action: 'rowDelete', key: 'Delete', ctrl: true, shift: true, scope: 'grid' },
    { action: 'selectAll', key: 'a', ctrl: true, scope: 'grid' },
    // 활성 셀의 열 메뉴(D-16). 머리글 버튼은 탭 정지가 아니므로 키보드로는 여기서 연다.
    { action: 'columnMenu', key: 'F10', shift: true, scope: 'grid' },
    { action: 'columnMenu', key: 'ContextMenu', scope: 'grid' },
    { action: 'copy', key: 'c', ctrl: true, scope: 'grid' },
    { action: 'edit', key: 'Enter', scope: 'grid' },
    { action: 'edit', key: 'F2', scope: 'grid' },
    { action: 'cancel', key: 'Escape', scope: 'grid' },
    { action: 'clear', key: 'Delete', scope: 'grid' },
    { action: 'clear', key: 'Backspace', scope: 'grid' },
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
    if (shortcut.scope !== scope) continue;
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
    if (options.guard && !options.guard()) return;
    const action = resolveShortcut(ev, 'document');
    if (!action) return;
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
