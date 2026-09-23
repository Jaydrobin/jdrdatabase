// @ts-check
/**
 * XLSX 어댑터(Step 8): 시트 목록, 셀 타입 변환(n/s/b/d/e/z, 수식은 계산값), 날짜 문자열 규칙, 헤더 행,
 * 병합·오류 셀 경고, 1904 체계, 암호화·손상·크기 상한 오류 코드. 픽스처는 `scripts/gen-import-fixtures.mjs`.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  cellValue,
  dateString,
  listSheets,
  openXlsx,
  readWorkbook,
  XLSX_MAX_FILE_BYTES,
} from '../../../src/import/xlsx.js';
import { AppError } from '../../../src/util/errors.js';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/import',
);

/** @param {string} name */
async function fixture(name) {
  const buf = await readFile(path.join(FIXTURES, name));
  const out = new Uint8Array(new ArrayBuffer(buf.byteLength));
  out.set(buf);
  return out;
}

/** @param {AsyncIterable<import('../../../src/import/infer.js').Row>} rows */
async function collect(rows) {
  /** @type {import('../../../src/import/infer.js').Row[]} */
  const out = [];
  for await (const r of rows) out.push(r);
  return out;
}

test('listSheets: 시트 이름과 잘리지 않은 행·열 수', async () => {
  assert.deepEqual(listSheets(await fixture('basic.xlsx')), [
    { name: '데이터', rows: 5, cols: 12 },
    { name: '둘째', rows: 5, cols: 2 },
  ]);
  assert.deepEqual(listSheets(await fixture('date1904.xlsx')), [{ name: 'S', rows: 2, cols: 2 }]);
});

test('cellValue·dateString: 셀 타입별 변환', () => {
  assert.equal(cellValue(undefined), null);
  assert.equal(cellValue({ t: 'n', v: 1.5 }), 1.5);
  assert.equal(cellValue({ t: 'n', v: Number.NaN }), null);
  assert.equal(cellValue({ t: 's', v: 'x' }), 'x');
  assert.equal(cellValue({ t: 'b', v: true }), true);
  assert.equal(cellValue({ t: 'e', v: 0x2a, w: '#N/A' }), null);
  assert.equal(cellValue({ t: 'z' }), null);
  assert.equal(cellValue({ t: 'n', v: 42, f: 'A1*2' }), 42, '수식 셀은 계산값');
  assert.equal(cellValue({ t: 'd', v: new Date(2024, 0, 5) }), '2024-01-05');
  assert.equal(cellValue({ t: 'd', v: new Date(2024, 0, 5, 10, 20, 30) }), '2024-01-05T10:20:30');
  assert.equal(dateString(new Date(Number.NaN)), null);
  assert.equal(dateString(new Date(999, 0, 1, 0, 0, 0)), '0999-01-01');
});

test('openXlsx: 헤더·행·병합·오류 셀·시트 선택·헤더 행·헤더 없음', async () => {
  const bytes = await fixture('basic.xlsx');
  const src = await openXlsx(new Blob([bytes]), { format: 'xlsx' });
  assert.deepEqual(src.resolved, {
    format: 'xlsx',
    encoding: 'utf-8',
    delimiter: ',',
    hasHeader: true,
    sheet: '데이터',
    headerRow: 1,
  });
  assert.equal(src.total, 4);
  assert.deepEqual(src.warnings, [
    { kind: 'merged', count: 1 },
    { kind: 'error_cells', count: 2 },
  ]);
  assert.deepEqual(src.header?.slice(0, 4), ['이름', '', '나이', '이름']);
  const rows = await collect(src.rows);
  assert.deepEqual(
    rows.map((r) => r.rowIndex),
    [2, 3, 4, 5],
    '시트의 행 번호',
  );
  assert.deepEqual(rows[0]?.cells, [
    '홍길동',
    'x',
    30,
    'dup',
    '2024-01-05',
    '2024-01-05T10:20:30',
    true,
    60,
    '01234',
    null,
    1.5,
    60,
  ]);
  assert.deepEqual(rows[0]?.errorCells, [9]);
  assert.deepEqual(rows[1]?.cells.slice(4, 6), ['2024-02-29', '2024-02-29'], '00:00:00은 날짜만');
  // 1900 윤년 버그(Step 8 예외 처리): 엑셀의 일련번호 60은 달력에 없는 1900-02-29다. SheetJS는 60을
  // 날짜로 바꾸지 않고 숫자 셀(`t: 'n'`)로 두며, 61은 1900-03-01로 돌려준다(위임한 대로 두고 여기서 못박는다).
  assert.equal(rows[1]?.cells[11], '1900-03-01', '일련번호 61');
  assert.deepEqual(rows[2]?.cells.slice(0, 2), ['병합', 'b']);
  assert.equal(rows[3]?.cells[0], '', '병합 범위의 나머지 칸은 비어 있다');

  const second = await openXlsx(new Blob([bytes]), { format: 'xlsx', sheet: '둘째', headerRow: 3 });
  assert.deepEqual(second.header, ['a', 'b']);
  assert.deepEqual(
    (await collect(second.rows)).map((r) => [r.rowIndex, ...r.cells]),
    [
      [4, 1, 2],
      [5, 3, 4],
    ],
  );
  const noHeader = await openXlsx(new Blob([bytes]), {
    format: 'xlsx',
    sheet: '둘째',
    headerRow: 0,
  });
  assert.equal(noHeader.header, null);
  assert.equal(noHeader.total, 5);
  const unknownSheet = await openXlsx(new Blob([bytes]), { format: 'xlsx', sheet: '없음' });
  assert.equal(unknownSheet.resolved.sheet, '데이터', '모르는 시트 이름은 첫 시트');
});

// 픽스처는 1904 체계의 일련번호 43834(= 1900 체계 45296 − 1462)로 2024-01-05를 담는다. 1904 보정을 빼먹는
// 읽기(SheetJS 0.18.12의 `cellDates`)는 이것을 2020-01-04로 읽는다.
test('openXlsx: 1904 날짜 체계는 같은 날짜로 읽힌다', async () => {
  const src = await openXlsx(new Blob([await fixture('date1904.xlsx')]), { format: 'xlsx' });
  assert.deepEqual(
    (await collect(src.rows)).map((r) => r.cells),
    [['2024-01-05', '2024-01-05T10:20:30']],
  );
});

test('readWorkbook: 암호화는 E_XLSX_ENCRYPTED, 잘린 zip은 E_XLSX_CORRUPT, 100 MB 초과는 E_FILE_TOO_LARGE', async () => {
  // 빈 입력과 평문은 SheetJS가 CSV로 읽어 버리므로(던지지 않음) 손상은 잘린 zip으로 검사한다.
  assert.equal(readWorkbook(new TextEncoder().encode('a,b\n1,2')).SheetNames.length, 1);
  await assert.rejects(
    openXlsx(new Blob([await fixture('encrypted.xlsx')]), { format: 'xlsx' }),
    (err) => err instanceof AppError && err.code === 'E_XLSX_ENCRYPTED',
  );
  const bytes = await fixture('basic.xlsx');
  await assert.rejects(
    openXlsx(new Blob([bytes.slice(0, Math.floor(bytes.length / 2))]), { format: 'xlsx' }),
    (err) => err instanceof AppError && err.code === 'E_XLSX_CORRUPT',
  );
  const huge = { size: XLSX_MAX_FILE_BYTES + 1, arrayBuffer: async () => new ArrayBuffer(0) };
  await assert.rejects(
    openXlsx(/** @type {Blob} */ (/** @type {unknown} */ (huge)), { format: 'xlsx' }),
    (err) =>
      err instanceof AppError &&
      err.code === 'E_FILE_TOO_LARGE' &&
      /** @type {{ format: string }} */ (err.detail).format === 'xlsx',
  );
});
