// @ts-check
/**
 * 타입 추론(Step 7): 우선순위, longtext·선행 0·date/datetime 규칙, 표본 수집·조기 종료, 열 이름 정리.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_NAME_LENGTH } from '../../../src/db/tables.js';
import { column, columnName, LONGTEXT_THRESHOLD, sample } from '../../../src/import/infer.js';

test('column: 우선순위 boolean → integer → real → date → datetime → text', () => {
  assert.equal(column(['true', 'false', '1', '0', '참']).type, 'boolean');
  assert.equal(column([1, 0, true, false]).type, 'boolean');
  assert.equal(column(['1', '2', '3']).type, 'integer');
  assert.equal(column(['1', '2,000', '-3', '4.0']).type, 'integer');
  assert.equal(column([1, 2.5, '3e2']).type, 'real');
  assert.equal(column(['2024-01-01', '2024-02-29', '']).type, 'date');
  assert.equal(column(['2024-01-01 10:20:30', '2024-02-29T00:00:00']).type, 'datetime');
  assert.equal(column(['2024-01-01', '2024-01-02 10:00:00']).type, 'datetime', '섞이면 datetime');
  assert.equal(column(['2024-02-30']).type, 'text', '달력에 없는 날짜');
  assert.equal(column(['1', 'x']).type, 'text');
  assert.equal(column(['abc', 'def']).type, 'text');
});

test('column: 빈 값은 판정에서 빼고, 전부 비면 text·confidence 0', () => {
  const r = column(['', null, '  ', undefined]);
  assert.deepEqual(r, { type: 'text', confidence: 0, examples: [] });
  const half = column(['5', '', '7', null]);
  assert.equal(half.type, 'integer');
  assert.equal(half.confidence, 0.5);
  assert.deepEqual(half.examples, ['5', '7']);
});

test('column: 2,000자 초과가 하나라도 있으면 longtext, 선행 0 숫자 문자열이 있으면 text', () => {
  assert.equal(column(['짧음', 'x'.repeat(LONGTEXT_THRESHOLD + 1)]).type, 'longtext');
  assert.equal(column(['x'.repeat(LONGTEXT_THRESHOLD)]).type, 'text');
  assert.equal(column(['01234', '00042']).type, 'text', '우편번호');
  assert.equal(column(['0', '1']).type, 'boolean', '한 자리 0은 선행 0이 아니다');
  assert.equal(column(['0.5', '1.5']).type, 'real');
});

test('column: 예시는 서로 다른 값 앞 3개, 80자로 자른다', () => {
  const long = 'a'.repeat(200);
  const r = column(['x', 'x', 'y', long, 'z']);
  assert.deepEqual(r.examples, ['x', 'y', 'a'.repeat(80)]);
});

test('sample: 상한에 닿으면 이터레이터를 닫고 exhausted=false, 다 읽으면 true', async () => {
  let closed = false;
  async function* gen() {
    try {
      for (let i = 1; i <= 10; i += 1) yield { rowIndex: i, cells: [String(i)] };
    } finally {
      closed = true;
    }
  }
  const partial = await sample(gen(), 4);
  assert.equal(partial.rows.length, 4);
  assert.equal(partial.exhausted, false);
  assert.equal(closed, true, '상한에 닿으면 return()으로 닫는다');
  closed = false;
  const all = await sample(gen(), 100);
  assert.equal(all.rows.length, 10);
  assert.equal(all.exhausted, true);
  assert.equal(closed, true);
  assert.deepEqual(await sample(gen(), 0), { rows: [], exhausted: false });
});

test('columnName: 비어 있으면 열N, 겹치면 (2)·(3), 앞뒤 공백 제거, 길이 상한', () => {
  const taken = new Set();
  assert.equal(columnName(' 이름 ', 0, taken), '이름');
  assert.equal(columnName('', 1, taken), '열2');
  assert.equal(columnName(null, 2, taken), '열3');
  assert.equal(columnName('이름', 3, taken), '이름 (2)');
  assert.equal(columnName('이름', 4, taken), '이름 (3)');
  assert.equal(columnName(42, 5, taken), '42');
  assert.equal(columnName('x'.repeat(300), 6, taken).length, 200);
  assert.deepEqual([...taken].length, 7);
});

test('columnName: 상한 길이 헤더가 겹쳐도 접미사까지 상한 안에 든다', () => {
  // 자동으로 만든 이름은 그대로 `addColumn`에 간다. 접미사를 덧붙여 상한을 넘기면
  // 가져오기 전체가 `E_NAME_INVALID`로 실패한다(사용자가 고칠 수 없는 이름이다).
  const taken = new Set();
  const long = '가'.repeat(210);
  const first = columnName(long, 0, taken);
  const second = columnName(long, 1, taken);
  const third = columnName(long, 2, taken);
  assert.equal(first.length, MAX_NAME_LENGTH);
  assert.ok(second.length <= MAX_NAME_LENGTH, `두 번째 이름이 ${second.length}자`);
  assert.ok(third.length <= MAX_NAME_LENGTH, `세 번째 이름이 ${third.length}자`);
  assert.ok(second.endsWith(' (2)'));
  assert.ok(third.endsWith(' (3)'));
  assert.equal(new Set([first, second, third]).size, 3, '이름은 서로 다르다');
});
