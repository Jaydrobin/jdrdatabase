// @ts-check
/**
 * 공용 팝업 메뉴(D-16의 열 메뉴가 처음 쓴다). `role="menu"`와 `menuitem`, ↑↓·Home·End로 이동,
 * Enter·Space로 실행, Esc·Tab·바깥 누르기로 닫는다. 닫으면 호출한 곳으로 포커스를 돌려준다.
 *
 * - 한 번에 하나만 열린다. 새 메뉴는 열려 있는 메뉴를 닫고 연다.
 * - 항목의 문구는 호출자가 i18n으로 만든 문자열이며 textContent로만 넣는다(CLAUDE.md 5.5).
 * - 위치는 열 때 `anchor.getBoundingClientRect()` 한 번으로 정하고, 인라인 스타일은 `transform`만 쓴다.
 * - 항목의 `run`은 메뉴를 닫고 포커스를 돌려준 뒤에 부른다. 항목이 대화상자를 열면 대화상자가 그 포커스를
 *   기억했다가 닫힐 때 돌려준다.
 */

/**
 * @typedef {object} MenuItem
 * @property {string} key 항목 식별자(`data-key`. 테스트·진단용)
 * @property {string} label
 * @property {boolean} [disabled]
 * @property {boolean} [danger]
 * @property {() => void} run
 */

/**
 * @typedef {object} MenuOptions
 * @property {string} [label] 메뉴의 접근 가능한 이름
 * @property {HTMLElement | null} [returnFocus] 닫을 때 포커스를 돌려줄 요소. 없으면 열 때 포커스가 있던 요소
 * @property {() => void} [onClose]
 */

/**
 * @typedef {object} OpenMenu
 * @property {HTMLElement} el
 * @property {() => void} close 실행 없이 닫는다
 */

/** 화면 가장자리에서 띄우는 여백(px). */
const EDGE = 4;

/** @type {OpenMenu | null} */
let current = null;

/**
 * 열려 있는 메뉴(없으면 null). 그리드가 다시 그려질 때 닫을지 판단하는 데 쓴다.
 * @returns {OpenMenu | null}
 */
export function openMenuOf() {
  return current;
}

/**
 * `anchor` 아래에 메뉴를 연다.
 * @param {HTMLElement} anchor
 * @param {MenuItem[]} items
 * @param {MenuOptions} [options]
 * @returns {OpenMenu}
 */
export function open(anchor, items, options = {}) {
  current?.close();
  const returnFocus =
    options.returnFocus ?? /** @type {HTMLElement | null} */ (document.activeElement);

  const el = document.createElement('div');
  el.className = 'jdr-menu';
  el.setAttribute('role', 'menu');
  if (options.label) el.setAttribute('aria-label', options.label);
  /** @type {HTMLButtonElement[]} */
  const buttons = [];
  for (const item of items) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'jdr-menu__item';
    if (item.danger) button.classList.add('jdr-menu__item--danger');
    button.setAttribute('role', 'menuitem');
    button.tabIndex = -1;
    button.dataset.key = item.key;
    button.textContent = item.label;
    if (item.disabled) {
      button.disabled = true;
      button.setAttribute('aria-disabled', 'true');
    }
    buttons.push(button);
    el.append(button);
  }
  document.body.append(el);

  // 위치: 앵커 아래 왼쪽 정렬. 화면 밖으로 나가면 위로 올리거나 왼쪽으로 당긴다.
  const a = anchor.getBoundingClientRect();
  const m = el.getBoundingClientRect();
  let x = a.left;
  let y = a.bottom;
  if (x + m.width > window.innerWidth - EDGE)
    x = Math.max(EDGE, window.innerWidth - m.width - EDGE);
  if (y + m.height > window.innerHeight - EDGE) y = Math.max(EDGE, a.top - m.height);
  el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px)`;

  const enabled = () => buttons.filter((b) => !b.disabled);

  /** @param {number} index */
  function focusAt(index) {
    const list = enabled();
    if (list.length === 0) return;
    const i = ((index % list.length) + list.length) % list.length;
    list[i]?.focus();
  }

  /** @returns {number} */
  function focusedIndex() {
    return enabled().indexOf(/** @type {HTMLButtonElement} */ (document.activeElement));
  }

  let closed = false;
  /** @param {boolean} restoreFocus */
  function close(restoreFocus) {
    if (closed) return;
    closed = true;
    document.removeEventListener('pointerdown', onOutside, true);
    el.removeEventListener('keydown', onKeydown);
    el.removeEventListener('click', onClick);
    el.remove();
    if (current === handle) current = null;
    if (restoreFocus) returnFocus?.focus?.();
    options.onClose?.();
  }

  /** @param {HTMLButtonElement} button */
  function activate(button) {
    if (button.disabled) return;
    const item = items[buttons.indexOf(button)];
    close(true);
    item?.run();
  }

  /** @param {KeyboardEvent} ev */
  function onKeydown(ev) {
    if (ev.isComposing) return;
    let handled = true;
    switch (ev.key) {
      case 'ArrowDown':
        focusAt(focusedIndex() + 1);
        break;
      case 'ArrowUp':
        focusAt(focusedIndex() < 0 ? -1 : focusedIndex() - 1);
        break;
      case 'Home':
        focusAt(0);
        break;
      case 'End':
        focusAt(-1);
        break;
      case 'Enter':
      case ' ': {
        const target = document.activeElement;
        if (target instanceof HTMLButtonElement && buttons.includes(target)) activate(target);
        break;
      }
      case 'Escape':
        close(true);
        break;
      case 'Tab':
        // 메뉴는 탭 정지가 아니다. Tab은 메뉴를 닫고 원래 자리로 돌아간다.
        close(true);
        break;
      default:
        handled = false;
    }
    if (handled) {
      ev.preventDefault();
      // 그리드·문서 단축키가 같은 키를 다시 처리하지 않게 한다.
      ev.stopPropagation();
    }
  }

  /** @param {MouseEvent} ev */
  function onClick(ev) {
    const button = /** @type {HTMLElement | null} */ (ev.target)?.closest('.jdr-menu__item');
    if (button instanceof HTMLButtonElement) activate(button);
  }

  /** @param {PointerEvent} ev */
  function onOutside(ev) {
    if (ev.target instanceof Node && el.contains(ev.target)) return;
    // 바깥을 누른 포인터는 그 자리에 포커스를 줄 것이므로 돌려주지 않는다.
    close(false);
  }

  el.addEventListener('keydown', onKeydown);
  el.addEventListener('click', onClick);
  document.addEventListener('pointerdown', onOutside, true);

  /** @type {OpenMenu} */
  const handle = { el, close: () => close(true) };
  current = handle;
  focusAt(0);
  return handle;
}
