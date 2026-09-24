// @ts-check
/**
 * 공용 툴팁(D-19, Step 14). 버튼·선택 상자 하나가 무엇을 하는지 한 문장으로 보인다.
 *
 * - 대상은 `data-hint` 속성(i18n 키)을 가진 요소다. HTML `title`은 쓰지 않는다(키보드·터치에서 보이지 않고
 *   WCAG 1.4.13을 만족하지 못한다).
 * - 마우스는 올린 뒤 500 ms, 키보드 포커스(`:focus-visible`)는 즉시 보인다. 터치에는 보이지 않는다.
 * - Esc·포커스 이탈·포인터 이탈·누름·스크롤로 닫는다. Esc는 전파를 막지 않는다(대화상자·편집기의 Esc도 돈다).
 * - 누르면 닫고, 포인터가 누른 자리(그때 대상의 사각형)를 떠날 때까지 다시 띄우지 않는다. 요소가 아니라 자리로
 *   기억한다: 누른 결과로 대상이 다시 그려지면(머리글 정렬, 사이드바 목록) 포인터 아래의 새 노드가 `pointerover`를
 *   다시 받기 때문이다.
 * - 툴팁 요소는 문서에 하나이고 포인터 이벤트를 받지 않는다. 받으면 아래의 버튼을 덮어 클릭을 가로챈다.
 *   대신 포인터가 대상과 툴팁을 함께 감싼 사각형 안에 있는 동안은 닫지 않는다(가리킬 수 있음).
 * - 보일 때 대상에 `aria-describedby`를 달고, 숨길 때 뗀다. 숨긴 툴팁은 문구를 비운다.
 * - 대상이 DOM에서 사라지면(그리드 다시 마운트, 대화상자 닫힘) 다음 이벤트를 기다리지 않고 숨긴다.
 *   보이는 동안만 `MutationObserver`를 건다(가상 그리드는 스크롤마다 노드를 바꾼다).
 */
import { hasMessage, t } from '../i18n/index.js';

/** 마우스를 올린 뒤 툴팁이 보일 때까지(ms). */
export const HOVER_DELAY_MS = 500;
/** 대상과 툴팁 사이의 간격(px). */
const GAP = 6;
/** 화면 가장자리와의 최소 간격(px). */
const MARGIN = 4;
const TOOLTIP_ID = 'jdr-tooltip';
/** 대상 셀렉터. */
const TARGET = '[data-hint]';

/**
 * @typedef {object} Mounted
 * @property {HTMLElement} root
 * @property {HTMLElement} el 툴팁 요소
 * @property {() => void} detach 리스너 해제
 */

/** @type {Mounted | null} */
let mounted = null;
/** 툴팁이 가리키는 대상(보이는 중이거나 500 ms를 기다리는 중). */
/** @type {HTMLElement | null} */
let current = null;
let visible = false;
let showTimer = 0;
/** 누르거나 Esc로 닫은 대상. 포인터·포커스가 떠날 때까지 다시 띄우지 않는다. */
/** @type {HTMLElement | null} */
let suppressed = null;
/**
 * 누른 자리(그때 대상의 사각형, 화면 좌표). 포인터가 이 안에 있는 동안은 어떤 대상의 `pointerover`에도 띄우지
 * 않는다. 벗어나면 지운다.
 * @type {Rect | null}
 */
let pressed = null;
/** 마우스로 띄운 툴팁인가(포인터 이탈 판정은 이때만 한다). */
let byPointer = false;
/** @typedef {{ left: number, top: number, right: number, bottom: number }} Rect */

/** 보이는 동안 대상과 툴팁을 함께 감싼 사각형. 포인터가 이 안에 있으면 닫지 않는다. */
/** @type {Rect | null} */
let hull = null;
/** @type {MutationObserver | null} */
let observer = null;

/**
 * 이벤트 대상에서 가장 가까운 툴팁 대상. 툴팁 요소 자신과 그 안은 대상이 아니다.
 * @param {EventTarget | null} target
 * @returns {HTMLElement | null}
 */
function hintTarget(target) {
  if (!(target instanceof Element)) return null;
  const el = target.closest(TARGET);
  return el instanceof HTMLElement && el.dataset.hint ? el : null;
}

/**
 * 점이 사각형 안(경계 제외)에 있는가. 이웃한 대상으로 옮긴 포인터는 경계 위에 있을 수 있으므로 경계는 밖으로 본다.
 * @param {Rect} rect
 * @param {number} x
 * @param {number} y
 * @returns {boolean}
 */
function inside(rect, x, y) {
  return x > rect.left && x < rect.right && y > rect.top && y < rect.bottom;
}

/**
 * 키보드 포커스인가. `:focus-visible`을 모르는 브라우저에서는 포커스를 모두 키보드로 본다(기능 감지).
 * @param {HTMLElement} el
 * @returns {boolean}
 */
function focusVisible(el) {
  try {
    return el.matches(':focus-visible');
  } catch {
    return true;
  }
}

/**
 * 대상의 `aria-describedby`에 툴팁 id를 더하거나 뺀다. 대상이 이미 가진 id는 남긴다.
 * @param {HTMLElement} el
 * @param {boolean} on
 */
function describedBy(el, on) {
  const ids = (el.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  const rest = ids.filter((id) => id !== TOOLTIP_ID);
  const next = on ? [...rest, TOOLTIP_ID] : rest;
  if (next.length > 0) el.setAttribute('aria-describedby', next.join(' '));
  else el.removeAttribute('aria-describedby');
}

function hide() {
  clearTimeout(showTimer);
  showTimer = 0;
  if (current && visible) describedBy(current, false);
  current = null;
  visible = false;
  hull = null;
  observer?.disconnect();
  if (!mounted) return;
  const { el } = mounted;
  el.hidden = true;
  el.textContent = '';
  document.removeEventListener('pointermove', onPointerMove, true);
  window.removeEventListener('scroll', onScroll, true);
}

/**
 * 툴팁을 대상 아래(넘치면 위)에 놓는다. 측정은 대상 한 번, 툴팁 한 번이다.
 * @param {HTMLElement} target
 * @param {HTMLElement} el
 */
function place(target, el) {
  const rect = target.getBoundingClientRect();
  el.style.transform = 'translate(0px, 0px)';
  const width = el.offsetWidth;
  const height = el.offsetHeight;
  const viewW = document.documentElement.clientWidth;
  const viewH = document.documentElement.clientHeight;
  let top = rect.bottom + GAP;
  if (top + height > viewH - MARGIN && rect.top - GAP - height >= MARGIN) {
    top = rect.top - GAP - height;
  }
  let left = rect.left + rect.width / 2 - width / 2;
  left = Math.max(MARGIN, Math.min(left, viewW - MARGIN - width));
  el.style.transform = `translate(${Math.round(left)}px, ${Math.round(top)}px)`;
  hull = {
    left: Math.min(rect.left, left),
    top: Math.min(rect.top, top),
    right: Math.max(rect.right, left + width),
    bottom: Math.max(rect.bottom, top + height),
  };
}

/** @param {HTMLElement} target */
function show(target) {
  if (!mounted || !target.isConnected) {
    hide();
    return;
  }
  const { el, root } = mounted;
  const key = target.dataset.hint ?? '';
  // 없는 키도 키 자체를 보인다(t()의 규칙). 단위 테스트가 먼저 잡는다.
  el.textContent = hasMessage(key) ? t(key) : key;
  el.hidden = false;
  current = target;
  visible = true;
  describedBy(target, true);
  place(target, el);
  observer?.observe(root, { childList: true, subtree: true });
  document.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('scroll', onScroll, true);
}

/**
 * @param {HTMLElement} target
 * @param {boolean} pointer 마우스로 띄우는가(500 ms 뒤)
 */
function schedule(target, pointer) {
  if (target === suppressed) return;
  if (current === target && (visible || showTimer)) return;
  hide();
  current = target;
  byPointer = pointer;
  if (!pointer) {
    show(target);
    return;
  }
  showTimer = window.setTimeout(() => {
    showTimer = 0;
    if (current === target) show(target);
  }, HOVER_DELAY_MS);
}

/** @param {PointerEvent} ev */
function onPointerOver(ev) {
  if (ev.pointerType === 'touch') return;
  const target = hintTarget(ev.target);
  if (!target) return;
  if (pressed) {
    // 누른 자리 안: 대상이 다시 그려져 새 노드가 됐어도 띄우지 않는다.
    if (inside(pressed, ev.clientX, ev.clientY)) return;
    pressed = null;
  }
  schedule(target, true);
}

/** @param {PointerEvent} ev */
function onPointerOut(ev) {
  if (pressed && !inside(pressed, ev.clientX, ev.clientY)) pressed = null;
  const from = hintTarget(ev.target);
  if (!from) return;
  const to = hintTarget(ev.relatedTarget);
  if (to === from) return;
  if (suppressed === from) suppressed = null;
  if (from !== current || !byPointer) return;
  // 보이는 툴팁은 포인터가 대상·툴팁을 감싼 사각형을 벗어날 때 닫는다(pointermove). 창 밖으로 나가면
  // 더 이상 pointermove가 오지 않으므로 바로 닫는다.
  if (!visible || ev.relatedTarget === null) hide();
}

/** @param {PointerEvent} ev */
function onPointerMove(ev) {
  if (!visible || !byPointer || !hull) return;
  const { clientX: x, clientY: y } = ev;
  if (x >= hull.left && x <= hull.right && y >= hull.top && y <= hull.bottom) return;
  // 다른 대상 위로 옮겼으면 그 대상의 pointerover가 새로 띄운다.
  hide();
}

/** @param {PointerEvent} ev */
function onPointerDown(ev) {
  const target = hintTarget(ev.target);
  if (target) {
    suppressed = target;
    const rect = target.getBoundingClientRect();
    pressed = { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom };
  }
  if (current) hide();
}

/** @param {FocusEvent} ev */
function onFocusIn(ev) {
  const target = hintTarget(ev.target);
  if (!target || !focusVisible(target)) return;
  schedule(target, false);
}

/** @param {FocusEvent} ev */
function onFocusOut(ev) {
  const from = hintTarget(ev.target);
  if (suppressed === from) suppressed = null;
  if (from && from === current && !byPointer) hide();
}

/** @param {KeyboardEvent} ev */
function onKeydown(ev) {
  if (ev.key !== 'Escape' || !current) return;
  suppressed = current;
  hide();
}

function onScroll() {
  hide();
}

function onMutation() {
  if (current && !current.isConnected) hide();
}

/**
 * 툴팁 요소를 만들고 `root`에 이벤트를 위임한다. 두 번 부르면 앞의 것을 해제한다.
 * @param {HTMLElement} root 대화상자까지 담는 요소(보통 `document.body`)
 */
export function mount(root) {
  unmount();
  const el = document.createElement('div');
  el.id = TOOLTIP_ID;
  el.className = 'jdr-tooltip';
  el.setAttribute('role', 'tooltip');
  el.hidden = true;
  root.append(el);
  root.addEventListener('pointerover', onPointerOver);
  root.addEventListener('pointerout', onPointerOut);
  root.addEventListener('pointerdown', onPointerDown, true);
  root.addEventListener('focusin', onFocusIn);
  root.addEventListener('focusout', onFocusOut);
  root.addEventListener('keydown', onKeydown, true);
  try {
    observer = new MutationObserver(onMutation);
  } catch {
    observer = null;
  }
  mounted = {
    root,
    el,
    detach() {
      root.removeEventListener('pointerover', onPointerOver);
      root.removeEventListener('pointerout', onPointerOut);
      root.removeEventListener('pointerdown', onPointerDown, true);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
      root.removeEventListener('keydown', onKeydown, true);
    },
  };
}

/** 리스너를 떼고 툴팁 요소를 지운다. */
export function unmount() {
  if (!mounted) return;
  hide();
  mounted.detach();
  mounted.el.remove();
  mounted = null;
  observer = null;
  suppressed = null;
  pressed = null;
}
