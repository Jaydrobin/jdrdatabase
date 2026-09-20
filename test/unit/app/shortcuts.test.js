// @ts-check
/**
 * 단축키 매핑(Step 5): 조합·범위별 해석, 조합 중 무시, 입력 요소 판정.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveShortcut } from '../../../src/app/shortcuts.js';

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
