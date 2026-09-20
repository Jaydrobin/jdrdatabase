// @ts-check
/**
 * revision 판정표(DESIGN.md 4.3)의 5개 조건.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judge } from '../../../src/app/revision.js';

test('1행: known 없음 → 이 기기에서 처음 여는 파일(정상, known 갱신)', () => {
  assert.deepEqual(
    judge({ fileRevision: 3, knownRevision: undefined, journalBaseRevision: undefined }),
    { file: 'first', journal: 'none', updateKnown: true },
  );
});

test('2행: file.revision >= known.revision → 정상, known 갱신', () => {
  assert.equal(
    judge({ fileRevision: 3, knownRevision: 3, journalBaseRevision: undefined }).file,
    'ok',
  );
  const newer = judge({ fileRevision: 5, knownRevision: 3, journalBaseRevision: undefined });
  assert.equal(newer.file, 'ok');
  assert.equal(newer.updateKnown, true);
});

test('3행: file.revision < known.revision → 되돌아간 파일 경고, known은 건드리지 않음', () => {
  const r = judge({ fileRevision: 2, knownRevision: 3, journalBaseRevision: undefined });
  assert.equal(r.file, 'behind');
  assert.equal(r.updateKnown, false);
});

test('4행: 저널의 base_revision == file.revision → 미저장 변경 존재(복구/버리기)', () => {
  const r = judge({ fileRevision: 3, knownRevision: 3, journalBaseRevision: 3 });
  assert.equal(r.journal, 'match');
});

test('5행: 저널의 base_revision != file.revision → 다른 버전 위의 미저장 변경(버리기/내보내기)', () => {
  const r = judge({ fileRevision: 4, knownRevision: 3, journalBaseRevision: 3 });
  assert.equal(r.journal, 'mismatch');
  assert.equal(r.file, 'ok');
  // 파일이 되돌아갔고 저널도 다른 버전이면 두 판정이 함께 나온다.
  const both = judge({ fileRevision: 2, knownRevision: 3, journalBaseRevision: 3 });
  assert.deepEqual(both, { file: 'behind', journal: 'mismatch', updateKnown: false });
});
