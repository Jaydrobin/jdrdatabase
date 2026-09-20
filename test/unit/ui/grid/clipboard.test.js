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

test('planPaste: 경계를 넘는 행은 새 행, 열은 버림, 100만 셀 초과는 E_PASTE_TOO_LARGE', () => {
  const data = Array.from({ length: 3 }, () => ['1', '2', '3', '4']);
  const plan = planPaste({ data, anchor: { row: 8, col: 2 }, rowCount: 10, colCount: 5 });
  assert.deepEqual(plan, {
    rows: 3,
    cols: 3,
    droppedColumns: 1,
    existingRows: 2,
    newRows: 1,
    cells: 9,
  });
  const beyond = planPaste({ data, anchor: { row: 20, col: 0 }, rowCount: 10, colCount: 5 });
  assert.equal(beyond.existingRows, 0);
  assert.equal(beyond.newRows, 3);
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
  assert.equal(cellToText({ ...INT, type: 'real', options: { decimals: 2 } }, 1.5), '1.50');
});
