// @ts-check
/**
 * 값 검증(4.2, Step 3 완료 기준): 각 논리 타입의 경계값. 정수 2^53, 잘못된 날짜 2026-02-30, 빈 문자열 → NULL.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  coerce,
  INTEGER_MAX,
  isLogicalType,
  LOGICAL_TYPES,
  toDisplay,
  validate,
} from '../../../src/db/values.js';
import { AppError } from '../../../src/util/errors.js';

test('빈 값은 모든 타입에서 NULL', () => {
  for (const type of LOGICAL_TYPES) {
    assert.deepEqual(validate(type, null, { choices: ['a'] }), { ok: true, value: null }, type);
    assert.deepEqual(
      validate(type, undefined, { choices: ['a'] }),
      { ok: true, value: null },
      type,
    );
    assert.deepEqual(validate(type, '', { choices: ['a'] }), { ok: true, value: null }, type);
    assert.deepEqual(validate(type, '   ', { choices: ['a'] }), { ok: true, value: null }, type);
  }
});

test('integer: 안전 정수 범위(±2^53), 문자열 파싱, 실수·문자 거부', () => {
  assert.deepEqual(validate('integer', 42), { ok: true, value: 42 });
  assert.deepEqual(validate('integer', '  -17 '), { ok: true, value: -17 });
  assert.deepEqual(validate('integer', '1,000'), { ok: true, value: 1000 });
  assert.deepEqual(validate('integer', '3.0'), { ok: true, value: 3 });
  assert.deepEqual(validate('integer', 3.0), { ok: true, value: 3 });
  assert.deepEqual(validate('integer', true), { ok: true, value: 1 });
  assert.deepEqual(validate('integer', INTEGER_MAX), { ok: true, value: 2 ** 53 - 1 });
  assert.deepEqual(validate('integer', String(INTEGER_MAX)), { ok: true, value: 2 ** 53 - 1 });
  assert.deepEqual(validate('integer', 2 ** 53), { ok: false, reason: 'out_of_range' });
  assert.deepEqual(validate('integer', String(2 ** 53)), { ok: false, reason: 'out_of_range' });
  assert.deepEqual(validate('integer', BigInt(2 ** 53)), { ok: false, reason: 'out_of_range' });
  assert.deepEqual(validate('integer', 7n), { ok: true, value: 7 });
  assert.deepEqual(validate('integer', 3.5), { ok: false, reason: 'not_integer' });
  assert.deepEqual(validate('integer', '3.5'), { ok: false, reason: 'not_integer' });
  assert.deepEqual(validate('integer', 'abc'), { ok: false, reason: 'not_integer' });
  assert.deepEqual(validate('integer', '1e3'), { ok: false, reason: 'not_integer' });
  assert.deepEqual(validate('integer', new Uint8Array(2)), { ok: false, reason: 'unsupported' });
});

test('real: 유한 수만, 지수 표기 허용, NaN·Infinity 거부', () => {
  assert.deepEqual(validate('real', 1.5), { ok: true, value: 1.5 });
  assert.deepEqual(validate('real', '-2.25'), { ok: true, value: -2.25 });
  assert.deepEqual(validate('real', '1e3'), { ok: true, value: 1000 });
  assert.deepEqual(validate('real', '.5'), { ok: true, value: 0.5 });
  assert.deepEqual(validate('real', '1,234.5'), { ok: true, value: 1234.5 });
  assert.deepEqual(validate('real', Infinity), { ok: false, reason: 'not_number' });
  assert.deepEqual(validate('real', NaN), { ok: false, reason: 'not_number' });
  assert.deepEqual(validate('real', 'x1'), { ok: false, reason: 'not_number' });
});

test('숫자: 천 단위 쉼표만 지우고, 그 밖의 쉼표는 거부한다', () => {
  // 모든 쉼표를 지우면 "1,2"가 12로 조용히 저장된다(세션 B 점검이 남기고 세션 J가 고친 항목).
  for (const type of /** @type {const} */ (['integer', 'real'])) {
    assert.deepEqual(
      validate(type, '1,2'),
      { ok: false, reason: type === 'integer' ? 'not_integer' : 'not_number' },
      type,
    );
    assert.deepEqual(
      validate(type, '12,34'),
      { ok: false, reason: type === 'integer' ? 'not_integer' : 'not_number' },
      type,
    );
    assert.deepEqual(
      validate(type, '1,2345'),
      { ok: false, reason: type === 'integer' ? 'not_integer' : 'not_number' },
      type,
    );
    assert.deepEqual(
      validate(type, '1,,234'),
      { ok: false, reason: type === 'integer' ? 'not_integer' : 'not_number' },
      type,
    );
  }
  // 천 단위 구분은 그대로 받는다.
  assert.deepEqual(validate('integer', '1,234'), { ok: true, value: 1234 });
  assert.deepEqual(validate('integer', '-1,234,567'), { ok: true, value: -1234567 });
  assert.deepEqual(validate('real', '1,234.5'), { ok: true, value: 1234.5 });
  assert.deepEqual(validate('real', '-12,345.25'), { ok: true, value: -12345.25 });
});

test('boolean: 0/1, true/false, 예/아니오 → 0/1', () => {
  for (const t of [true, 1, 1n, 'true', 'TRUE', 'y', 'yes', '참', '예', ' on ']) {
    assert.deepEqual(validate('boolean', t), { ok: true, value: 1 }, String(t));
  }
  for (const f of [false, 0, 0n, 'false', 'n', 'no', '거짓', '아니오', 'off']) {
    assert.deepEqual(validate('boolean', f), { ok: true, value: 0 }, String(f));
  }
  assert.deepEqual(validate('boolean', 2), { ok: false, reason: 'not_boolean' });
  assert.deepEqual(validate('boolean', 'maybe'), { ok: false, reason: 'not_boolean' });
});

test('date: YYYY-MM-DD, 달력 검증(2026-02-30 거부), 시각이 있으면 날짜만', () => {
  assert.deepEqual(validate('date', '2026-02-28'), { ok: true, value: '2026-02-28' });
  assert.deepEqual(validate('date', '2024-02-29'), { ok: true, value: '2024-02-29' });
  assert.deepEqual(validate('date', '2026-02-30'), { ok: false, reason: 'bad_date' });
  assert.deepEqual(validate('date', '2026-13-01'), { ok: false, reason: 'bad_date' });
  assert.deepEqual(validate('date', '2026-1-1'), { ok: false, reason: 'bad_date' });
  assert.deepEqual(validate('date', '2026-09-20T13:45:00'), { ok: true, value: '2026-09-20' });
  assert.deepEqual(validate('date', new Date(Date.UTC(2026, 8, 20, 5))), {
    ok: true,
    value: '2026-09-20',
  });
  assert.deepEqual(validate('date', 20260920), { ok: false, reason: 'bad_date' });
  assert.deepEqual(validate('date', new Date(NaN)), { ok: false, reason: 'bad_date' });
});

test('datetime: YYYY-MM-DDTHH:mm:ss로 정규화, 날짜만이면 00:00:00, 범위 밖 시각 거부', () => {
  assert.deepEqual(validate('datetime', '2026-09-20T13:45:07'), {
    ok: true,
    value: '2026-09-20T13:45:07',
  });
  assert.deepEqual(validate('datetime', '2026-09-20 13:45'), {
    ok: true,
    value: '2026-09-20T13:45:00',
  });
  assert.deepEqual(validate('datetime', '2026-09-20'), { ok: true, value: '2026-09-20T00:00:00' });
  assert.deepEqual(validate('datetime', '2026-09-20T13:45:07.123'), {
    ok: true,
    value: '2026-09-20T13:45:07',
  });
  assert.deepEqual(validate('datetime', '2026-09-20T24:00:00'), {
    ok: false,
    reason: 'bad_datetime',
  });
  assert.deepEqual(validate('datetime', '2026-02-30T00:00:00'), {
    ok: false,
    reason: 'bad_datetime',
  });
  assert.deepEqual(validate('datetime', new Date(Date.UTC(2026, 8, 20, 1, 2, 3))), {
    ok: true,
    value: '2026-09-20T01:02:03',
  });
});

test('select: choices 안의 값만, choices 없으면 no_choices', () => {
  assert.deepEqual(validate('select', '진행', { choices: ['대기', '진행'] }), {
    ok: true,
    value: '진행',
  });
  assert.deepEqual(validate('select', '완료', { choices: ['대기', '진행'] }), {
    ok: false,
    reason: 'not_in_choices',
  });
  assert.deepEqual(validate('select', 'x'), { ok: false, reason: 'no_choices' });
});

test('text/longtext: 문자열 그대로(앞뒤 공백 유지), 숫자·불리언·Date는 문자열로', () => {
  assert.deepEqual(validate('text', '  a b  '), { ok: true, value: '  a b  ' });
  assert.deepEqual(validate('longtext', '가'.repeat(300_000)).ok, true);
  assert.deepEqual(validate('text', 12), { ok: true, value: '12' });
  assert.deepEqual(validate('text', false), { ok: true, value: 'false' });
  assert.deepEqual(validate('text', new Date(Date.UTC(2026, 0, 2, 3, 4, 5))), {
    ok: true,
    value: '2026-01-02T03:04:05',
  });
  assert.deepEqual(validate(/** @type {never} */ ('bogus'), 'x'), {
    ok: false,
    reason: 'unknown_type',
  });
});

test('coerce: null 정책은 NULL, abort 정책은 E_VALUE_INVALID(값 미리보기 80자)', () => {
  assert.equal(coerce('integer', 'abc', 'null'), null);
  assert.equal(coerce('integer', '12', 'null'), 12);
  assert.throws(
    () => coerce('integer', 'x'.repeat(200), 'abort'),
    (e) =>
      e instanceof AppError &&
      e.code === 'E_VALUE_INVALID' &&
      /** @type {{ preview: string, reason: string }} */ (e.detail).preview.length === 80 &&
      /** @type {{ preview: string, reason: string }} */ (e.detail).reason === 'not_integer',
  );
});

test('toDisplay: NULL은 빈 문자열, boolean은 true/false, real은 decimals 옵션', () => {
  assert.equal(toDisplay('text', null), '');
  assert.equal(toDisplay('boolean', 1), 'true');
  assert.equal(toDisplay('boolean', 0), 'false');
  assert.equal(toDisplay('real', 1.5, { decimals: 2 }), '1.50');
  assert.equal(toDisplay('real', 1.5), '1.5');
  assert.equal(toDisplay('integer', 3), '3');
  assert.equal(isLogicalType('date'), true);
  assert.equal(isLogicalType('blob'), false);
});
