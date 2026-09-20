// @ts-check
/**
 * 셀 렌더러(Step 4): 타입별 표시, 256자 미리보기와 길이 배지(D-05). 값은 textContent로만 넣는다.
 *
 * 핫 경로(스크롤 렌더)에서 불리므로 요소를 새로 만들지 않고 첫 텍스트 노드와 배지 span만 갱신한다.
 */
import { toDisplay } from '../../db/values.js';
import { t } from '../../i18n/index.js';
import { formatInteger } from '../../util/format.js';

/** @typedef {import('../../db/tables.js').ColumnInfo} ColumnInfo */
/** @typedef {import('../../db/values.js').LogicalType} LogicalType */
/** @typedef {import('../../db/engine.js').SqlValue} SqlValue */

/**
 * 셀 부가 정보.
 * @typedef {object} CellMeta
 * @property {number | null} length 미리보기가 잘렸을 때만 전체 문자 수, 아니면 null
 */

/** 미리보기 뒤에 붙는 말줄임 문자. */
export const ELLIPSIS = '…';

/**
 * 타입별 정렬. CSS는 `data-align`으로 읽는다.
 * @param {LogicalType} type
 * @returns {'left' | 'right' | 'center'}
 */
export function alignOf(type) {
  switch (type) {
    case 'integer':
    case 'real':
      return 'right';
    case 'boolean':
      return 'center';
    default:
      return 'left';
  }
}

/**
 * 미리보기 문자열. 전체 길이가 미리보기보다 길면 말줄임을 붙인다.
 * @param {string} text 이미 잘린 미리보기(최대 256자)
 * @param {number | null} length 전체 문자 수(잘렸을 때만), 아니면 null
 * @returns {{ text: string, truncated: boolean }}
 */
export function preview(text, length) {
  if (length === null || length <= text.length) return { text, truncated: false };
  return { text: `${text}${ELLIPSIS}`, truncated: true };
}

/**
 * 표시 문자열. boolean은 기호로, 나머지는 `values.toDisplay`.
 * @param {ColumnInfo} column
 * @param {SqlValue} value
 * @returns {string}
 */
export function displayText(column, value) {
  if (value === null || value === undefined) return '';
  if (column.type === 'boolean') return Number(value) === 1 ? t('cell.true') : t('cell.false');
  if (value instanceof Uint8Array)
    return t('cell.blob', { bytes: formatInteger(value.byteLength) });
  return toDisplay(
    column.type,
    typeof value === 'bigint' ? String(value) : value,
    column.options ?? undefined,
  );
}

/**
 * 셀 요소의 내용을 채운다. 첫 자식은 텍스트 노드, 잘린 값이면 그 뒤에 길이 배지 span이 붙는다.
 * @param {HTMLElement} el
 * @param {ColumnInfo} column
 * @param {SqlValue} value
 * @param {CellMeta} meta
 */
export function render(el, column, value, meta) {
  const shown = preview(displayText(column, value), meta.length);
  let textNode = el.firstChild;
  if (!textNode || textNode.nodeType !== Node.TEXT_NODE) {
    el.textContent = '';
    textNode = document.createTextNode('');
    el.append(textNode);
  }
  if (textNode.nodeValue !== shown.text) textNode.nodeValue = shown.text;
  const existing = textNode.nextSibling;
  if (shown.truncated && meta.length !== null) {
    let badge = existing instanceof HTMLElement ? existing : null;
    if (!badge) {
      badge = document.createElement('span');
      badge.className = 'jdr-grid__badge';
      el.append(badge);
    }
    badge.textContent = t('grid.lengthBadge', { length: formatInteger(meta.length) });
  } else if (existing) {
    existing.remove();
  }
  const align = alignOf(column.type);
  if (el.dataset.align !== align) el.dataset.align = align;
}
