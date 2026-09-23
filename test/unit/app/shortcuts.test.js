// @ts-check
/**
 * 단축키 매핑(Step 5): 조합·범위별 해석, 조합 중 무시, 입력 요소 판정.
 * 도움말의 단축키 목록(Step 14): `describe()`가 표의 모든 항목을 표시용 키와 설명 키로 돌려준다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { describe, resolveShortcut, SHORTCUTS } from '../../../src/app/shortcuts.js';

/**
 * @param {string} key
 * @param {Partial<{ ctrl: boolean, meta: boolean, shift: boolean, alt: boolean, composing: boolean }>} [mods]
 */
function key(key, mods = {}) {
  return {
    key,
    ctrlKey: mods.ctrl ?? false,
    metaKey: mods.meta ?? false,
    shiftKey: mods.shift ?? false,
    altKey: mods.alt ?? false,
    isComposing: mods.composing ?? false,
  };
}

test('문서 수준: 저장·되돌리기·다시 실행(Ctrl과 Meta 모두)', () => {
  assert.equal(resolveShortcut(key('s', { ctrl: true }), 'document'), 'save');
  assert.equal(resolveShortcut(key('S', { meta: true, shift: true }), 'document'), 'saveAs');
  assert.equal(resolveShortcut(key('z', { ctrl: true }), 'document'), 'undo');
  assert.equal(resolveShortcut(key('Z', { ctrl: true, shift: true }), 'document'), 'redo');
  assert.equal(resolveShortcut(key('y', { ctrl: true }), 'document'), 'redo');
  assert.equal(resolveShortcut(key('z', { ctrl: true, alt: true }), 'document'), null);
  assert.equal(resolveShortcut(key('z'), 'document'), null);
  assert.equal(resolveShortcut(key('Enter'), 'document'), null, '그리드 단축키는 문서 범위에 없다');
});

test('그리드 수준: 편집·취소·지우기·복사·전체 선택·행 추가·행 삭제', () => {
  assert.equal(resolveShortcut(key('Enter'), 'grid'), 'edit');
  assert.equal(resolveShortcut(key('F2'), 'grid'), 'edit');
  assert.equal(resolveShortcut(key('Escape'), 'grid'), 'cancel');
  assert.equal(resolveShortcut(key('Delete'), 'grid'), 'clear');
  assert.equal(resolveShortcut(key('Backspace'), 'grid'), 'clear');
  assert.equal(resolveShortcut(key('c', { ctrl: true }), 'grid'), 'copy');
  assert.equal(resolveShortcut(key('a', { meta: true }), 'grid'), 'selectAll');
  assert.equal(resolveShortcut(key('Enter', { ctrl: true, shift: true }), 'grid'), 'rowInsert');
  assert.equal(resolveShortcut(key('Delete', { ctrl: true, shift: true }), 'grid'), 'rowDelete');
  assert.equal(resolveShortcut(key('Enter', { shift: true }), 'grid'), null);
  assert.equal(resolveShortcut(key('s', { ctrl: true }), 'grid'), null);
});

test('한글 조합 중(isComposing, key Process)의 Enter·Esc는 어떤 행동도 아니다', () => {
  assert.equal(resolveShortcut(key('Enter', { composing: true }), 'grid'), null);
  assert.equal(resolveShortcut(key('Escape', { composing: true }), 'grid'), null);
  assert.equal(resolveShortcut(key('Process'), 'grid'), null);
});

test('그리드 수준: 열 메뉴는 Shift+F10과 ContextMenu 키(D-16), 문서 범위와 조합 중에는 없다', () => {
  assert.equal(resolveShortcut(key('F10', { shift: true }), 'grid'), 'columnMenu');
  assert.equal(resolveShortcut(key('ContextMenu'), 'grid'), 'columnMenu');
  assert.equal(resolveShortcut(key('F10'), 'grid'), null, 'Shift 없는 F10은 브라우저의 것');
  assert.equal(resolveShortcut(key('F10', { shift: true }), 'document'), null);
  assert.equal(resolveShortcut(key('ContextMenu', { composing: true }), 'grid'), null);
});

test('문서 수준: F1은 도움말(D-19), 그리드 범위와 조합 중에는 없다', () => {
  assert.equal(resolveShortcut(key('F1'), 'document'), 'help');
  assert.equal(resolveShortcut(key('F1'), 'grid'), null);
  assert.equal(resolveShortcut(key('F1', { shift: true }), 'document'), null);
  assert.equal(resolveShortcut(key('F1', { composing: true }), 'document'), null);
});

test('describe(): SHORTCUTS의 모든 항목을 표의 순서대로, shortcut.<action> 설명 키와 함께 담는다', () => {
  const rows = describe({ mac: false });
  assert.equal(rows.length, SHORTCUTS.length);
  for (const [i, shortcut] of SHORTCUTS.entries()) {
    assert.equal(rows[i]?.action, shortcut.action);
    assert.equal(rows[i]?.scope, shortcut.scope);
    assert.equal(rows[i]?.labelKey, `shortcut.${shortcut.action}`);
  }
});

test('describe(): 표시용 키 조합(Windows·Linux는 Ctrl+Shift+키, macOS는 ⌘⇧키)', () => {
  /** @param {boolean} mac */
  const keysOf = (mac) => describe({ mac }).map((d) => `${d.action}:${d.keys}`);
  const pc = keysOf(false);
  assert.ok(pc.includes('saveAs:Ctrl+Shift+S'));
  assert.ok(pc.includes('save:Ctrl+S'));
  assert.ok(pc.includes('redo:Ctrl+Y'));
  assert.ok(pc.includes('help:F1'));
  assert.ok(pc.includes('columnMenu:Shift+F10'));
  assert.ok(pc.includes('columnMenu:Menu'));
  assert.ok(pc.includes('cancel:Esc'));
  assert.ok(pc.includes('rowInsert:Ctrl+Shift+Enter'));
  const mac = keysOf(true);
  assert.ok(mac.includes('saveAs:⌘⇧S'));
  assert.ok(mac.includes('undo:⌘Z'));
  assert.ok(mac.includes('help:F1'));
});
