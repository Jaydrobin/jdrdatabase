// @ts-check
/**
 * 정리 대화상자(Step 13)의 순수 부분: 결과 알림의 종류·문구 키와 실행 버튼을 켤지.
 * 대화상자 자체(목록, 포커스, 진행률, 밀려났을 때의 알림)는 E2E `cleanup.spec.js`가 본다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanupNotices, hasWork } from '../../../../src/ui/dialogs/cleanup.js';
import { t } from '../../../../src/i18n/index.js';

/** @typedef {import('../../../../src/db/cleanup.js').CleanupResult} CleanupResult */

/**
 * @param {Partial<CleanupResult>} over
 * @returns {CleanupResult}
 */
function result(over) {
  return {
    cmds: [],
    removedColumns: 0,
    rebuiltIndexes: 0,
    vacuumed: false,
    vacuumError: null,
    bytesBefore: 4_000_000,
    bytesAfter: 1_000_000,
    ...over,
  };
}

/** @type {import('../../../../src/util/errors.js').SerializedError} */
const VACUUM_ERROR = { code: 'E_MEM', message: 'out of memory', detail: null, recoverable: false };

test('cleanupNotices: 지운 열이 있으면 크기 변화와 함께, 저장이 빈 공간을 없애는 엔진은 크기 없이', () => {
  const wasm = cleanupNotices(result({ removedColumns: 2, vacuumed: true }), false);
  assert.deepEqual(
    wasm.map((n) => [n.kind, n.key]),
    [['info', 'cleanup.done']],
  );
  assert.equal(wasm[0]?.params.count, '2');
  assert.ok('before' in (wasm[0]?.params ?? {}) && 'after' in (wasm[0]?.params ?? {}));
  // native: 재작성은 작업 사본을 키우고 저장(VACUUM INTO)이 줄인다. 커진 크기를 보이지 않는다.
  const native = cleanupNotices(result({ removedColumns: 1, bytesAfter: 8_000_000 }), true);
  assert.deepEqual(
    native.map((n) => [n.kind, n.key]),
    [['info', 'cleanup.doneNative']],
  );
  assert.deepEqual(Object.keys(native[0]?.params ?? {}), ['count']);
  assert.doesNotMatch(t('cleanup.doneNative', { count: '1' }), /→/);
});

test('cleanupNotices: 빈 공간 줄이기만 했으면 doneCompacted, 그것이 실패했으면 "지운 열" 없는 문구', () => {
  assert.deepEqual(
    cleanupNotices(result({ vacuumed: true }), false).map((n) => n.key),
    ['cleanup.doneCompacted'],
  );
  const onlyFailed = cleanupNotices(result({ vacuumError: VACUUM_ERROR }), false);
  assert.deepEqual(
    onlyFailed.map((n) => [n.kind, n.key]),
    [['warn', 'cleanup.vacuumOnlyFailed']],
  );
  assert.doesNotMatch(t('cleanup.vacuumOnlyFailed', { message: 'x' }), /삭제한 열/);
  assert.match(String(onlyFailed[0]?.params.message), /E_MEM/);
  // 지운 열이 있는데 VACUUM이 실패했으면 완료 알림과 함께 "지웠지만" 문구.
  assert.deepEqual(
    cleanupNotices(result({ removedColumns: 1, vacuumError: VACUUM_ERROR }), false).map((n) => [
      n.kind,
      n.key,
    ]),
    [
      ['info', 'cleanup.done'],
      ['warn', 'cleanup.vacuumFailed'],
    ],
  );
});

test('hasWork: 체크된 열이 없고 저장이 빈 공간을 없애는 엔진이면 할 일이 없다(실행 버튼을 끈다, D-17)', () => {
  assert.equal(hasWork({ compactsOnSave: true }, 0), false);
  assert.equal(hasWork({ compactsOnSave: true }, 1), true);
  assert.equal(hasWork({ compactsOnSave: false }, 0), true);
});
