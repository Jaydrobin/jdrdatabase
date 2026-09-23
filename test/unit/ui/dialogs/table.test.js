// @ts-check
/**
 * 이름 입력의 UI 측 사전 검사(Step 3). 최종 판정은 Worker(`E_NAME_INVALID`)가 하지만,
 * Worker가 거절할 이름을 대화상자가 통과시키면 사용자는 확인 버튼을 누른 뒤에야 이유를 본다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_NAME_LENGTH } from '../../../../src/db/tables.js';
import { nameValidator } from '../../../../src/ui/dialogs/table.js';

test('nameValidator: 빈 이름·상한 초과·중복을 Worker보다 먼저 잡는다', () => {
  const validate = nameValidator(['이미있음']);
  assert.equal(validate('  '), '이름을 입력하세요.');
  assert.equal(validate('이미있음'), '같은 이름이 이미 있습니다.');
  assert.equal(validate(' 이미있음 '), '같은 이름이 이미 있습니다.', '앞뒤 공백을 뗀 뒤 비교');
  assert.equal(validate('괜찮은 이름'), null);

  // `normalizeName`이 거절하는 길이는 대화상자에서 먼저 막는다.
  assert.equal(validate('가'.repeat(MAX_NAME_LENGTH)), null, '상한 자체는 통과');
  const tooLong = validate('가'.repeat(MAX_NAME_LENGTH + 1));
  assert.ok(tooLong, '상한을 넘으면 문구가 나온다');
  assert.match(
    /** @type {string} */ (tooLong),
    new RegExp(String(MAX_NAME_LENGTH)),
    '상한을 알린다',
  );
});
