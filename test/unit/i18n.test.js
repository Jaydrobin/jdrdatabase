// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { en } from '../../src/i18n/en.js';
import { hasMessage, t } from '../../src/i18n/index.js';
import { ko } from '../../src/i18n/ko.js';
import { ERROR_CODES } from '../../src/util/errors.js';

test('ko와 en의 키 집합이 같다', () => {
  assert.deepEqual(Object.keys(en).sort(), Object.keys(ko).sort());
});

test('t(): 자리표시자를 채우고 없는 파라미터는 그대로 둔다', () => {
  assert.equal(t('app.version', { version: '1.2.3' }), '버전 1.2.3');
  assert.equal(t('app.version'), '버전 {version}');
  assert.equal(t('app.title'), 'jdrdatabase');
});

test('hasMessage(): 키 존재 여부', () => {
  assert.equal(hasMessage('app.title'), true);
  assert.equal(hasMessage('nope'), false);
});

test('모든 오류 코드에 error.<코드> 문구가 있다 (CLAUDE.md 7.1)', () => {
  for (const code of ERROR_CODES) {
    assert.equal(hasMessage(`error.${code}`), true, code);
  }
  const extra = Object.keys(ko).filter(
    (k) => k.startsWith('error.') && !ERROR_CODES.includes(/** @type {never} */ (k.slice(6))),
  );
  assert.deepEqual(extra, []);
});
