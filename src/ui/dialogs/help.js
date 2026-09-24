// @ts-check
/**
 * 도움말 대화상자(D-19, Step 14). 한 문장으로 설명되지 않는 개념을 주제별로 담는다.
 *
 * - 왼쪽은 세로 탭 목록(고른 탭만 탭 정지, ↑↓·Home·End로 옮기면 그 주제를 보인다), 오른쪽은 본문이다.
 * - 본문은 `help.<주제>.body`를 빈 줄로 나눠 문단마다 `p`에 textContent로 넣는다(CLAUDE.md 5.5).
 * - 저장 주제는 모드마다 다르다(`persistence`: `snapshot`은 브라우저의 저널·직전 저장본, `native`는 작업 사본·`.bak`).
 * - 단축키 주제는 문구가 아니라 `app/shortcuts.js`의 표(`describe()`)로 그린다. 따로 적으면 단축키를 바꿀 때 어긋난다.
 * - 모달은 v1 `dialog.js`를 쓴다(포커스 트랩, Esc, 닫을 때 포커스 복귀).
 */
import { describe } from '../../app/shortcuts.js';
import { t } from '../../i18n/index.js';
import { openDialog } from './dialog.js';

/** @typedef {import('../../i18n/index.js').MessageKey} MessageKey */
/** @typedef {import('../../db/engine.js').EngineCapabilities['persistence']} Persistence */

/** 주제 순서. 도움말 목록과 문구 키(`help.<주제>.title`·`.body`)가 이 이름을 쓴다. */
export const HELP_TOPICS = Object.freeze(
  /** @type {const} */ ([
    'basics',
    'types',
    'columns',
    'sortFilter',
    'search',
    'views',
    'importExport',
    'saving',
    'multiPc',
    'appData',
    'shortcuts',
  ]),
);

/** @typedef {typeof HELP_TOPICS[number]} HelpTopic */

/**
 * 주제 본문의 문구 키. 저장 주제만 모드에 따라 다르다.
 * @param {HelpTopic} topic
 * @param {Persistence} persistence
 * @returns {MessageKey}
 */
export function bodyKey(topic, persistence) {
  // 모드 문자열이 아니라 저장 방식을 읽는다(CLAUDE.md 5.3).
  if (topic === 'saving' && persistence !== 'snapshot') return 'help.saving.bodyNative';
  return /** @type {MessageKey} */ (`help.${topic}.body`);
}

/**
 * 빈 줄로 나눈 문단들. 한 문단 안의 줄바꿈은 CSS(`white-space: pre-line`)가 그대로 보인다.
 * @param {string} text
 * @returns {string[]}
 */
export function paragraphs(text) {
  return text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * 단축키 표. 같은 행동의 조합 여럿은 한 줄에 모은다(표의 순서를 지킨다).
 * @returns {HTMLTableElement}
 */
function shortcutTable() {
  /** @type {Map<MessageKey, string[]>} */
  const rows = new Map();
  for (const entry of describe()) {
    const key = /** @type {MessageKey} */ (entry.labelKey);
    const keys = rows.get(key) ?? [];
    keys.push(entry.keys);
    rows.set(key, keys);
  }
  const table = document.createElement('table');
  table.className = 'jdr-help__keys';
  const head = document.createElement('tr');
  for (const key of /** @type {const} */ (['help.shortcuts.keys', 'help.shortcuts.action'])) {
    const th = document.createElement('th');
    th.scope = 'col';
    th.textContent = t(key);
    head.append(th);
  }
  const thead = document.createElement('thead');
  thead.append(head);
  const tbody = document.createElement('tbody');
  for (const [labelKey, keys] of rows) {
    const tr = document.createElement('tr');
    const keyCell = document.createElement('td');
    for (const [i, combo] of keys.entries()) {
      if (i > 0) keyCell.append(' / ');
      const kbd = document.createElement('kbd');
      kbd.textContent = combo;
      keyCell.append(kbd);
    }
    const label = document.createElement('td');
    label.textContent = t(labelKey);
    tr.append(keyCell, label);
    tbody.append(tr);
  }
  table.append(thead, tbody);
  return table;
}

/**
 * 도움말 대화상자를 연다. 닫히면 끝난다.
 * @param {{ topic?: HelpTopic, persistence: Persistence }} options
 * @returns {Promise<void>}
 */
export async function open(options) {
  const idBase = `jdr-help-${Date.now().toString(36)}`;
  /** @type {Map<HelpTopic, HTMLButtonElement>} */
  const tabs = new Map();
  /** @type {HTMLElement | null} */
  let panel = null;
  /** @type {HelpTopic} */
  let selected = options.topic ?? 'basics';

  /** @param {HelpTopic} topic */
  function renderPanel(topic) {
    if (!panel) return;
    selected = topic;
    for (const [name, tab] of tabs) {
      const on = name === topic;
      tab.setAttribute('aria-selected', String(on));
      tab.tabIndex = on ? 0 : -1;
    }
    panel.setAttribute('aria-labelledby', `${idBase}-tab-${topic}`);
    panel.dataset.topic = topic;
    const heading = document.createElement('h3');
    heading.className = 'jdr-help__heading';
    heading.textContent = t(/** @type {MessageKey} */ (`help.${topic}.title`));
    /** @type {HTMLElement[]} */
    const children = [heading];
    for (const text of paragraphs(t(bodyKey(topic, options.persistence)))) {
      const p = document.createElement('p');
      p.className = 'jdr-help__paragraph';
      p.textContent = text;
      children.push(p);
    }
    if (topic === 'shortcuts') children.push(shortcutTable());
    panel.replaceChildren(...children);
    panel.scrollTop = 0;
  }

  /** @param {KeyboardEvent} ev */
  function onTabKeydown(ev) {
    if (ev.isComposing) return;
    const index = HELP_TOPICS.indexOf(selected);
    /** @type {number | null} */
    let next = null;
    if (ev.key === 'ArrowDown') next = (index + 1) % HELP_TOPICS.length;
    else if (ev.key === 'ArrowUp') next = (index - 1 + HELP_TOPICS.length) % HELP_TOPICS.length;
    else if (ev.key === 'Home') next = 0;
    else if (ev.key === 'End') next = HELP_TOPICS.length - 1;
    const topic = next === null ? undefined : HELP_TOPICS[next];
    if (!topic) return;
    ev.preventDefault();
    renderPanel(topic);
    tabs.get(topic)?.focus();
  }

  /** @param {MouseEvent} ev */
  function onTabClick(ev) {
    const tab = /** @type {HTMLElement} */ (ev.currentTarget);
    const topic = HELP_TOPICS.find((name) => name === tab.dataset.topic);
    if (topic) renderPanel(topic);
  }

  await openDialog({
    title: t('help.title'),
    wide: true,
    body: (body) => {
      const layout = document.createElement('div');
      layout.className = 'jdr-help';
      const list = document.createElement('div');
      list.className = 'jdr-help__topics';
      list.setAttribute('role', 'tablist');
      list.setAttribute('aria-orientation', 'vertical');
      list.setAttribute('aria-label', t('help.topics'));
      for (const topic of HELP_TOPICS) {
        const tab = document.createElement('button');
        tab.type = 'button';
        tab.className = 'jdr-help__topic';
        tab.id = `${idBase}-tab-${topic}`;
        tab.dataset.topic = topic;
        tab.setAttribute('role', 'tab');
        tab.setAttribute('aria-controls', `${idBase}-panel`);
        tab.textContent = t(/** @type {MessageKey} */ (`help.${topic}.title`));
        tab.addEventListener('click', onTabClick);
        tab.addEventListener('keydown', onTabKeydown);
        tabs.set(topic, tab);
        list.append(tab);
      }
      panel = document.createElement('section');
      panel.className = 'jdr-help__panel';
      panel.id = `${idBase}-panel`;
      panel.setAttribute('role', 'tabpanel');
      // 긴 본문은 패널 안에서 스크롤된다. 키보드로 스크롤할 수 있게 탭 정지를 둔다(axe scrollable-region-focusable).
      panel.tabIndex = 0;
      layout.append(list, panel);
      body.append(layout);
      renderPanel(selected);
    },
    buttons: [{ label: t('dialog.close'), value: 'close', primary: true }],
    cancelValue: 'close',
    initialFocus: () => tabs.get(selected) ?? null,
  });
  for (const tab of tabs.values()) {
    tab.removeEventListener('click', onTabClick);
    tab.removeEventListener('keydown', onTabKeydown);
  }
}
