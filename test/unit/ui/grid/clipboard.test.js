// @ts-check
/**
 * TSV 직렬화·파싱과 붙여넣기 계획(Step 5): 따옴표 필드, CRLF, 경계 초과, 100만 셀 상한, 값 변환.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  cellToText,
  convertPastedCell,
  parseTsv,
  planPaste,
  serializeTsv,
} from '../../../../src/ui/grid/clipboard.js';
import { validate } from '../../../../src/db/values.js';
import { AppError } from '../../../../src/util/errors.js';

/** @type {import('../../../../src/db/tables.js').ColumnInfo} */
const INT = {
  id: 'c_00000001',
  name: '나이',
  type: 'integer',
  position: 0,
  width: 100,
  options: null,
  deletedAt: null,
};

test('serializeTsv ↔ parseTsv 왕복: 탭·줄바꿈·따옴표·빈 셀·한글', () => {
  const rows = [
    ['가', 'a\tb', 'line1\nline2', 'say "hi"', ''],
    ['', '1', '', '', '끝'],
  ];
  const tsv = serializeTsv(rows);
  assert.equal(tsv, '가\t"a\tb"\t"line1\nline2"\t"say ""hi"""\t\n\t1\t\t\t끝');
  assert.deepEqual(parseTsv(tsv), rows);
});

test('parseTsv: CRLF·LF 혼재, 끝의 빈 줄은 버리고 중간 빈 줄은 빈 행', () => {
  assert.deepEqual(parseTsv('a\tb\r\nc\td\n'), [
    ['a', 'b'],
    ['c', 'd'],
  ]);
  assert.deepEqual(parseTsv('a\n\nb'), [['a'], [''], ['b']]);
  assert.deepEqual(parseTsv(''), []);
  assert.deepEqual(parseTsv('x'), [['x']]);
  // 셀 중간의 따옴표는 따옴표 필드가 아니다(스프레드시트 동작).
  assert.deepEqual(parseTsv('5" tall\tok'), [['5" tall', 'ok']]);
});

test('planPaste: 경계를 넘는 행은 새 행, 빈 행에서 시작하면 사이의 빈 줄, 열은 버림, 100만 셀 초과는 E_PASTE_TOO_LARGE', () => {
  const data = Array.from({ length: 3 }, () => ['1', '2', '3', '4']);
  const plan = planPaste({ data, anchor: { row: 8, col: 2 }, rowCount: 10, colCount: 5 });
  assert.deepEqual(plan, {
    gapRows: 0,
    trailingEmpty: 0,
    rows: 3,
    cols: 3,
    droppedColumns: 1,
    existingRows: 2,
    newRows: 1,
    cells: 9,
  });
  // 빈 행(D-16)에서 시작하면 마지막 실제 행(9)과 시작 행(20) 사이의 빈 줄 10개를 함께 만든다.
  const beyond = planPaste({ data, anchor: { row: 20, col: 0 }, rowCount: 10, colCount: 5 });
  assert.equal(beyond.existingRows, 0);
  assert.equal(beyond.newRows, 3);
  assert.equal(beyond.gapRows, 10);
  assert.equal(
    planPaste({ data, anchor: { row: 10, col: 0 }, rowCount: 10, colCount: 5 }).gapRows,
    0,
    '첫 빈 행에서 시작하면 사이에 빈 줄이 없다',
  );
  // 빈 줄을 버린 수(`trailingEmpty`)는 경계 안에서는 늘 0이다.
  assert.equal(plan.trailingEmpty, 0);
  const wide = Array.from({ length: 1001 }, () => new Array(1000).fill(''));
  assert.throws(
    () => planPaste({ data: wide, anchor: { row: 0, col: 0 }, rowCount: 0, colCount: 1 }),
    (e) => e instanceof AppError && e.code === 'E_PASTE_TOO_LARGE',
  );
});

test('convertPastedCell: 타입 검증, 빈 문자열은 NULL, 실패는 위치를 담은 E_VALUE_INVALID', () => {
  assert.equal(convertPastedCell(INT, ' 42 ', { row: 0, col: 0 }), 42);
  assert.equal(convertPastedCell(INT, '', { row: 0, col: 0 }), null);
  assert.throws(
    () => convertPastedCell(INT, 'abc', { row: 3, col: 1 }),
    (e) =>
      e instanceof AppError &&
      e.code === 'E_VALUE_INVALID' &&
      /** @type {{ row: number, col: number }} */ (e.detail).row === 3 &&
      /** @type {{ row: number, col: number }} */ (e.detail).col === 1,
  );
  assert.equal(cellToText(INT, null), '');
  assert.equal(cellToText({ ...INT, type: 'boolean' }, 1), 'true');
});

test('cellToText: 편집·복사는 저장된 값 그대로를 쓴다(그리드 표시의 반올림을 따르지 않는다)', () => {
  // `decimals`는 그리드에 몇 자리까지 보일지를 정하는 표시 설정이다. 편집기의 초기값과 복사한
  // 텍스트에까지 적용하면, 그 텍스트가 `validate`를 거쳐 그대로 저장값이 되므로 셀을 열었다
  // 확정하거나 복사해 붙여넣는 것만으로 값이 깎인다.
  const real = /** @type {import('../../../../src/db/tables.js').ColumnInfo} */ ({
    ...INT,
    type: 'real',
    options: { decimals: 2 },
  });
  assert.equal(cellToText(real, 3.14159), '3.14159');
  assert.equal(cellToText(real, 1.5), '1.5');
  assert.equal(cellToText({ ...real, options: { decimals: 0 } }, 0.1), '0.1');
  // 왕복: 보여 준 텍스트를 그대로 확정하면 저장값이 그대로다.
  const back = validate('real', cellToText(real, 3.14159));
  assert.equal(back.ok && back.value, 3.14159);
  // select의 choices처럼 값 자체를 정하는 옵션은 그대로 쓴다.
  const sel = /** @type {import('../../../../src/db/tables.js').ColumnInfo} */ ({
    ...INT,
    type: 'select',
    options: { choices: ['가', '나'] },
  });
  assert.equal(cellToText(sel, '나'), '나');
});

test('planPaste: 빈 행 자리(마지막 실제 행 아래)에 떨어지는 끝의 빈 줄은 버린다. 값 사이의 빈 줄과 기존 행 위의 빈 줄은 남긴다(D-16)', () => {
  const blankTail = [['a', '1'], ['', ''], ['b', ''], ['', ''], ['']];
  // 빈 행에서 시작: 끝의 빈 줄 2개를 버리고, a와 b 사이의 빈 줄은 자리를 지키므로 행이 된다.
  const ghost = planPaste({
    data: blankTail,
    anchor: { row: 5, col: 0 },
    rowCount: 5,
    colCount: 2,
  });
  assert.deepEqual(ghost, {
    gapRows: 0,
    trailingEmpty: 2,
    rows: 3,
    cols: 2,
    droppedColumns: 0,
    existingRows: 0,
    newRows: 3,
    cells: 6,
  });
  // 기존 행에 덮어쓰는 빈 줄은 값을 지우는 붙여넣기이므로 버리지 않는다. 경계를 넘는 끝의 빈 줄만 버린다.
  const over = planPaste({ data: blankTail, anchor: { row: 2, col: 0 }, rowCount: 5, colCount: 2 });
  assert.equal(over.existingRows, 3);
  assert.equal(over.newRows, 0);
  assert.equal(over.trailingEmpty, 2);
  assert.equal(over.rows, 3);
  const inside = planPaste({
    data: blankTail,
    anchor: { row: 0, col: 0 },
    rowCount: 5,
    colCount: 2,
  });
  assert.equal(inside.trailingEmpty, 0, '모든 줄이 기존 행 위에 떨어지면 버리지 않는다');
  assert.equal(inside.rows, 5);
  // 모든 줄이 빈 행 자리의 빈 줄이면 만들 것이 없다.
  const nothing = planPaste({
    data: [[''], ['']],
    anchor: { row: 7, col: 0 },
    rowCount: 5,
    colCount: 2,
  });
  assert.equal(nothing.rows, 0);
  assert.equal(nothing.newRows, 0);
  assert.equal(nothing.gapRows, 0, '만들 행이 없으면 사이의 빈 줄도 만들지 않는다');
  // 그리드 오른쪽 경계 밖에만 값이 있는 줄은 쓰는 칸이 모두 비었으므로 빈 줄이다.
  const clipped = planPaste({
    data: [
      ['x', ''],
      ['', 'y'],
    ],
    anchor: { row: 5, col: 1 },
    rowCount: 5,
    colCount: 2,
  });
  assert.equal(clipped.rows, 1);
  assert.equal(clipped.trailingEmpty, 1);
});
