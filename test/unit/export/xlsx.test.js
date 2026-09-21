// @ts-check
/**
 * XLSX 내보내기(Step 9): 셀 타입 규칙, 시트 이름, 행 상한, 그리고 왕복(내보낸 xlsx를 Step 8 어댑터로 다시 가져오면
 * 타입·값이 같다). 실제 wasm DB로 검사한다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrate } from '../../../src/db/schema.js';
import * as tables from '../../../src/db/tables.js';
import {
  cellObject,
  exportXlsx,
  localDate,
  sheetName,
  XLSX_MAX_ROWS,
} from '../../../src/export/xlsx.js';
import { listSheets } from '../../../src/import/xlsx.js';
import { preview, run as importRun } from '../../../src/import/pipeline.js';
import { AppError } from '../../../src/util/errors.js';
import { openWasmEngine } from '../db/helpers.js';

/** @typedef {import('../../../src/db/engine.js').Engine} Engine */
/** @typedef {import('../../../src/db/engine.js').SqlValue} SqlValue */
/** @typedef {import('../../../src/db/tables.js').ColumnInfo} ColumnInfo */
/** @typedef {import('../../../src/db/values.js').LogicalType} LogicalType */

/**
 * @param {LogicalType} type
 * @returns {ColumnInfo}
 */
function col(type) {
  return { id: 'c_1', name: 'x', type, position: 0, width: 160, options: null, deletedAt: null };
}

/**
 * @param {Engine} engine
 * @param {string} name
 * @param {Array<{ name: string, type: LogicalType, options?: import('../../../src/db/values.js').ColumnOptions }>} columns
 * @param {SqlValue[][]} rows
 */
async function seed(engine, name, columns, rows) {
  const { tableId } = await tables.create(engine, { name });
  /** @type {string[]} */
  const ids = [];
  for (const c of columns) {
    ids.push(
      (await tables.addColumn(engine, tableId, { name: c.name, type: c.type, options: c.options }))
        .columnId,
    );
  }
  await engine.transaction(async () => {
    const sql = `INSERT INTO "${tableId}" (${ids.map((id) => `"${id}"`).join(', ')}) VALUES (${ids.map(() => '?').join(', ')})`;
    await engine.runBatch(sql, rows);
  });
  return { table: tables.requireTable(engine, tableId), ids };
}

function memorySink() {
  /** @type {Uint8Array<ArrayBuffer>[]} */
  const chunks = [];
  return {
    chunks,
    write: (/** @type {Uint8Array<ArrayBuffer>} */ bytes) => {
      chunks.push(bytes);
    },
  };
}

test('sheetName: 금지 문자 치환, 31자, 빈 이름', () => {
  assert.equal(sheetName('고객'), '고객');
  assert.equal(sheetName('a/b:c*d?e[f]g\\h'), 'a_b_c_d_e_f_g_h');
  assert.equal(sheetName('x'.repeat(40)).length, 31);
  assert.equal(sheetName('  '), 'Sheet1');
});

test('localDate/cellObject: 타입별 셀', () => {
  assert.equal(localDate('2024-02-29')?.getDate(), 29);
  assert.equal(localDate('2024-02-29T10:20:30')?.getHours(), 10);
  assert.equal(localDate('nope'), null);
  assert.equal(cellObject(col('text'), null), null);
  assert.equal(cellObject(col('text'), new Uint8Array(2)), null);
  assert.deepEqual(cellObject(col('integer'), 5), { t: 'n', v: 5 });
  assert.deepEqual(cellObject(col('boolean'), 1), { t: 'b', v: true });
  assert.deepEqual(
    cellObject(col('text'), '=1+1'),
    { t: 's', v: '=1+1' },
    '문자열 셀은 수식이 아니다',
  );
  const d = cellObject(col('date'), '2024-02-29');
  assert.equal(d?.t, 'd');
  assert.equal(d?.z, 'yyyy-mm-dd');
  assert.deepEqual(cellObject(col('date'), 'bad'), { t: 's', v: 'bad' });
});

test('exportXlsx: 시트 하나에 헤더와 행, 행 상한을 넘으면 E_FILE_TOO_LARGE', async () => {
  const engine = await openWasmEngine();
  await migrate(engine, { appVersion: 'test' });
  const { table } = await seed(
    engine,
    '판매/2024',
    [
      { name: 'n', type: 'integer' },
      { name: 's', type: 'text' },
    ],
    [
      [1, 'a'],
      [2, null],
    ],
  );
  const sink = memorySink();
  const result = await exportXlsx(engine, table, {}, sink);
  assert.equal(sink.chunks.length, 1);
  assert.equal(result.rows, 2);
  assert.equal(result.bytes, sink.chunks[0]?.byteLength);
  const sheets = listSheets(/** @type {Uint8Array} */ (sink.chunks[0]));
  assert.deepEqual(sheets, [{ name: '판매_2024', rows: 3, cols: 2 }]);

  const huge = { ...table, id: table.id };
  const fake = /** @type {Engine} */ (
    /** @type {unknown} */ ({
      ...engine,
      exec: (/** @type {string} */ sql, /** @type {unknown} */ params) =>
        String(sql).includes('count(*)')
          ? { columns: ['c'], rows: [[XLSX_MAX_ROWS + 1]] }
          : engine.exec(sql, /** @type {never} */ (params)),
      prepareCached: (/** @type {string} */ sql) => sql,
    })
  );
  await assert.rejects(
    exportXlsx(fake, huge, {}, memorySink()),
    (err) =>
      err instanceof AppError &&
      err.code === 'E_FILE_TOO_LARGE' &&
      /** @type {{ format: string }} */ (err.detail).format === 'xlsx',
  );
});

test('왕복: 내보낸 xlsx를 다시 가져오면 타입·값이 같다(날짜·일시·불리언·NULL·따옴표 텍스트)', async () => {
  const engine = await openWasmEngine();
  await migrate(engine, { appVersion: 'test' });
  const { table, ids } = await seed(
    engine,
    '원본',
    [
      { name: '텍스트', type: 'text' },
      { name: '정수', type: 'integer' },
      { name: '실수', type: 'real' },
      { name: '참거짓', type: 'boolean' },
      { name: '날짜', type: 'date' },
      { name: '일시', type: 'datetime' },
    ],
    [
      ['say "hi", ok\nline2', 1, 1.5, 1, '2024-02-29', '2024-02-29T10:20:30'],
      [null, null, null, null, null, null],
      ['=1+1', -7, 0.25, 0, '1999-01-01', '1999-01-01T00:00:01'],
    ],
  );
  const sink = memorySink();
  await exportXlsx(engine, table, {}, sink);
  const file = new Blob([/** @type {Uint8Array<ArrayBuffer>} */ (sink.chunks[0])]);
  const p = await preview(file, { format: 'xlsx' });
  assert.deepEqual(p.headers, ['텍스트', '정수', '실수', '참거짓', '날짜', '일시']);
  assert.deepEqual(
    p.inferred.map((i) => i.type),
    ['text', 'integer', 'real', 'boolean', 'date', 'datetime'],
    '추론이 원본 타입과 같다',
  );
  const { report } = await importRun({
    engine,
    file,
    options: { format: 'xlsx' },
    mapping: { columns: table.columns.map((c, i) => ({ source: i, name: c.name, type: c.type })) },
    target: { kind: 'new', name: '복사' },
  });
  assert.equal(report.inserted, 2);
  assert.equal(report.nulled, 0);
  const copy = tables.requireTable(engine, report.tableId);
  const select = (/** @type {string} */ tid, /** @type {string[]} */ cols) =>
    engine.exec(
      `SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${tid}" WHERE "${cols[0]}" IS NOT NULL ORDER BY "id" LIMIT 100`,
    ).rows;
  assert.deepEqual(
    select(
      copy.id,
      copy.columns.map((c) => c.id),
    ),
    select(table.id, ids),
  );
});
