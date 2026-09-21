// @ts-check
/**
 * CSV 내보내기(Step 9): RFC 4180 인용, BOM, 구분자, 수식 주입 방지, 값 규칙, 페이지 조각, 뷰 적용, 취소,
 * 그리고 완료 기준의 왕복(내보낸 CSV를 다시 가져오면 타입·값이 같다). 실제 wasm DB로 검사한다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { migrate } from '../../../src/db/schema.js';
import * as tables from '../../../src/db/tables.js';
import {
  cellText,
  exportCsv,
  normalizeCsvOptions,
  quoteField,
  UTF8_BOM,
} from '../../../src/export/csv.js';
import { exportColumns, PAGE_ROWS, readPages } from '../../../src/export/rows.js';
import { run as importRun } from '../../../src/import/pipeline.js';
import { AppError } from '../../../src/util/errors.js';
import { openWasmEngine } from '../db/helpers.js';

/** @typedef {import('../../../src/db/engine.js').Engine} Engine */
/** @typedef {import('../../../src/db/engine.js').SqlValue} SqlValue */
/** @typedef {import('../../../src/db/tables.js').ColumnInfo} ColumnInfo */
/** @typedef {import('../../../src/db/values.js').LogicalType} LogicalType */

/** 조각을 모아 두는 싱크. */
function memorySink() {
  /** @type {Uint8Array[]} */
  const chunks = [];
  return {
    chunks,
    write: (/** @type {Uint8Array} */ bytes) => {
      chunks.push(bytes);
    },
    text: () => new TextDecoder().decode(concat(chunks)),
    bytes: () => concat(chunks),
  };
}

/** @param {Uint8Array[]} parts */
function concat(parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.byteLength;
  }
  return out;
}

/**
 * @param {LogicalType} type
 * @returns {ColumnInfo}
 */
function col(type) {
  return { id: 'c_1', name: 'x', type, position: 0, width: 160, options: null, deletedAt: null };
}

/**
 * 테이블 하나를 만들고 행을 넣는다.
 * @param {Engine} engine
 * @param {Array<{ name: string, type: LogicalType, options?: import('../../../src/db/values.js').ColumnOptions }>} columns
 * @param {SqlValue[][]} rows
 */
async function seed(engine, columns, rows) {
  const { tableId } = await tables.create(engine, { name: '표' });
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
  const table = tables.requireTable(engine, tableId);
  return { table, ids };
}

async function setup() {
  const engine = await openWasmEngine();
  await migrate(engine, { appVersion: 'test' });
  return engine;
}

test('quoteField: 구분자·따옴표·개행이 있으면 감싸고 따옴표는 두 번', () => {
  assert.equal(quoteField('plain', ','), 'plain');
  assert.equal(quoteField('a,b', ','), '"a,b"');
  assert.equal(quoteField('a;b', ','), 'a;b');
  assert.equal(quoteField('a;b', ';'), '"a;b"');
  assert.equal(quoteField('say "hi"', ','), '"say ""hi"""');
  assert.equal(quoteField('line1\nline2', ','), '"line1\nline2"');
  assert.equal(quoteField('x\r', ','), '"x\r"');
  assert.equal(quoteField('', ','), '');
});

test('cellText: NULL·불리언·숫자·날짜·BLOB 규칙과 수식 주입 방지', () => {
  const on = { formulaGuard: true };
  const off = { formulaGuard: false };
  assert.equal(cellText(col('text'), null, on), '');
  assert.equal(cellText(col('boolean'), 1, on), 'true');
  assert.equal(cellText(col('boolean'), 0, on), 'false');
  assert.equal(cellText(col('integer'), -42, on), '-42', '숫자는 수식 주입 대상이 아니다');
  assert.equal(cellText(col('real'), 1.5, on), '1.5');
  assert.equal(cellText(col('date'), '2024-02-29', on), '2024-02-29');
  assert.equal(cellText(col('datetime'), '2024-02-29T10:20:30', on), '2024-02-29T10:20:30');
  assert.equal(cellText(col('text'), new Uint8Array([1, 2]), on), '', 'BLOB은 빈 필드');
  for (const lead of ['=', '+', '-', '@']) {
    assert.equal(cellText(col('text'), `${lead}SUM(A1)`, on), `'${lead}SUM(A1)`);
    assert.equal(cellText(col('text'), `${lead}SUM(A1)`, off), `${lead}SUM(A1)`);
  }
  assert.equal(cellText(col('select'), '=x', on), "'=x");
  assert.equal(cellText(col('longtext'), '@x', on), "'@x");
  assert.equal(cellText(col('text'), 'a=b', on), 'a=b', '첫 글자만 본다');
});

test('normalizeCsvOptions: 기본값과 잘못된 구분자', () => {
  assert.deepEqual(normalizeCsvOptions(undefined), {
    encoding: 'utf-8-bom',
    delimiter: ',',
    formulaGuard: true,
  });
  assert.deepEqual(
    normalizeCsvOptions({ encoding: 'utf-8', delimiter: '\t', formulaGuard: false }),
    {
      encoding: 'utf-8',
      delimiter: '\t',
      formulaGuard: false,
    },
  );
  assert.equal(normalizeCsvOptions({ delimiter: 'ab' }).delimiter, ',', '한 글자가 아니면 기본');
  assert.throws(
    () => normalizeCsvOptions({ delimiter: '"' }),
    (err) => err instanceof AppError && err.code === 'E_DB_QUERY',
  );
});

test('exportCsv: 헤더는 표시 이름, BOM, CRLF, 인용, NULL은 빈 필드, 결과 집계', async () => {
  const engine = await setup();
  const { table } = await seed(
    engine,
    [
      { name: '이름', type: 'text' },
      { name: '나이', type: 'integer' },
      { name: '메모', type: 'longtext' },
    ],
    [
      ['홍길동', 30, 'a, "b"\nc'],
      ['김영희', null, null],
    ],
  );
  const sink = memorySink();
  const result = await exportCsv(engine, table, {}, undefined, sink);
  const bytes = sink.bytes();
  assert.deepEqual([...bytes.subarray(0, 3)], [...UTF8_BOM]);
  assert.equal(
    new TextDecoder().decode(bytes.subarray(3)),
    '이름,나이,메모\r\n홍길동,30,"a, ""b""\nc"\r\n김영희,,\r\n',
  );
  assert.deepEqual(result, { rows: 2, bytes: bytes.byteLength, blobCells: 0 });
  assert.equal(sink.chunks.length, 2, '헤더 조각 + 페이지 조각');

  const plain = memorySink();
  await exportCsv(engine, table, {}, { encoding: 'utf-8', delimiter: ';' }, plain);
  assert.equal(plain.text(), '이름;나이;메모\r\n홍길동;30;"a, ""b""\nc"\r\n김영희;;\r\n');
});

test('exportCsv: 뷰의 정렬·필터·숨김을 적용하고, 빈 결과는 헤더만', async () => {
  const engine = await setup();
  const { table, ids } = await seed(
    engine,
    [
      { name: 'n', type: 'integer' },
      { name: 's', type: 'text' },
    ],
    [
      [3, 'c'],
      [1, 'a'],
      [2, 'b'],
    ],
  );
  const [n, s] = ids;
  const sink = memorySink();
  await exportCsv(
    engine,
    table,
    {
      sort: [{ colId: String(n), dir: 'desc' }],
      filter: { logic: 'and', conditions: [{ colId: String(n), op: '>=', value: '2' }] },
      hidden: [String(s)],
    },
    { encoding: 'utf-8' },
    sink,
  );
  assert.equal(sink.text(), 'n\r\n3\r\n2\r\n');
  const none = memorySink();
  await exportCsv(
    engine,
    table,
    { filter: { logic: 'and', conditions: [{ colId: String(n), op: '>', value: '9' }] } },
    { encoding: 'utf-8' },
    none,
  );
  assert.equal(none.text(), 'n,s\r\n');
  assert.deepEqual(
    exportColumns(table, { hidden: [String(n)] }).map((c) => c.name),
    ['s'],
  );
});

test('readPages/exportCsv: 5,000행을 넘으면 페이지가 나뉘고(키셋·OFFSET 모두), 취소는 페이지 사이에서 잡힌다', async () => {
  const engine = await setup();
  const rows = [];
  for (let i = 1; i <= PAGE_ROWS + 7; i += 1) rows.push([i]);
  const { table, ids } = await seed(engine, [{ name: 'n', type: 'integer' }], rows);
  const columns = exportColumns(table, {});
  /** @type {number[]} */
  const sizes = [];
  for await (const page of readPages(engine, table, {}, columns)) sizes.push(page.length);
  assert.deepEqual(sizes, [PAGE_ROWS, 7], '키셋 경로');
  // 행 하나를 지워 id를 성기게 해도 키셋은 값으로 이어 간다.
  await engine.transaction(() => engine.run(`DELETE FROM "${table.id}" WHERE "id" = ?`, [3]));
  /** @type {number[]} */
  const flat = [];
  for await (const page of readPages(engine, table, {}, columns)) {
    for (const row of page) flat.push(Number(row[0]));
  }
  assert.equal(flat.length, PAGE_ROWS + 6);
  assert.equal(flat.includes(3), false);
  assert.equal(flat[PAGE_ROWS + 5], PAGE_ROWS + 7);
  /** @type {number[]} */
  const sorted = [];
  for await (const page of readPages(
    engine,
    table,
    { sort: [{ colId: String(ids[0]), dir: 'desc' }] },
    columns,
  )) {
    sorted.push(page.length);
  }
  assert.deepEqual(sorted, [PAGE_ROWS, 6], 'OFFSET 경로');

  const controller = new AbortController();
  const sink = memorySink();
  /** @type {Array<{ done: number, total: number }>} */
  const progress = [];
  await assert.rejects(
    exportCsv(engine, table, {}, { encoding: 'utf-8' }, sink, {
      signal: controller.signal,
      progress: (p) => {
        progress.push({ done: p.done, total: p.total });
        if (p.done >= PAGE_ROWS) controller.abort();
      },
    }),
    (err) => err instanceof AppError && err.code === 'E_IMPORT_CANCELLED',
  );
  assert.equal(progress[0]?.total, PAGE_ROWS + 6);
  assert.equal(sink.chunks.length, 2, '헤더와 첫 페이지까지만 썼다');
});

test('왕복: 내보낸 CSV를 다시 가져오면 타입·값이 같다(날짜·불리언·NULL·따옴표 텍스트·select)', async () => {
  const engine = await setup();
  const { table, ids } = await seed(
    engine,
    [
      { name: '텍스트', type: 'text' },
      { name: '장문', type: 'longtext' },
      { name: '정수', type: 'integer' },
      { name: '실수', type: 'real' },
      { name: '참거짓', type: 'boolean' },
      { name: '날짜', type: 'date' },
      { name: '일시', type: 'datetime' },
      { name: '선택', type: 'select', options: { choices: ['A', 'B'] } },
    ],
    [
      ['say "hi", ok', 'l1\r\nl2', 1, 1.5, 1, '2024-02-29', '2024-02-29T10:20:30', 'A'],
      [null, null, null, null, null, null, null, null],
      ['  spaced  ', 'x', -7, 3e2, 0, '2023-12-31', '2023-12-31T23:59:59', 'B'],
      ['한글, 쉼표', '"', 9007199254740991, 0.1, 1, '1999-01-01', '1999-01-01T00:00:00', 'A'],
    ],
  );
  const sink = memorySink();
  await exportCsv(engine, table, {}, undefined, sink);
  const file = new Blob([sink.bytes()]);
  // 새 테이블로 가져올 때 select는 항목을 미리 알 수 없어 text로 받는다(가져오기 대화상자와 같다).
  const { report } = await importRun({
    engine,
    file,
    options: { format: 'csv' },
    mapping: {
      columns: table.columns.map((c, i) => ({
        source: i,
        name: `${c.name}2`,
        type: c.type === 'select' ? 'text' : c.type,
      })),
    },
    target: { kind: 'new', name: '왕복' },
  });
  assert.equal(report.inserted, 3, '모든 값이 빈 행은 건너뛴다(NULL 행)');
  assert.equal(report.nulled, 0);
  assert.equal(report.errorCount, 0);
  const copy = tables.requireTable(engine, report.tableId);
  assert.deepEqual(
    copy.columns.map((c) => c.type),
    table.columns.map((c) => (c.type === 'select' ? 'text' : c.type)),
    '타입이 같다',
  );
  const select = (
    /** @type {import('../../../src/db/tables.js').TableInfo} */ t,
    /** @type {string[]} */ cols,
  ) =>
    engine.exec(
      `SELECT ${cols.map((c) => `"${c}"`).join(', ')} FROM "${t.id}" WHERE "${cols[0]}" IS NOT NULL ORDER BY "id" LIMIT 100`,
    ).rows;
  const original = select(table, ids);
  const roundTripped = select(
    copy,
    copy.columns.map((c) => c.id),
  );
  assert.deepEqual(roundTripped, original);
  // 기존 select 열에 다시 가져오면 항목이 자동으로 채워진다(4.2).
  const { tableId: again } = await tables.create(engine, { name: '기존' });
  const sel = await tables.addColumn(engine, again, {
    name: '선택',
    type: 'select',
    options: { choices: ['A'] },
  });
  await importRun({
    engine,
    file,
    options: { format: 'csv' },
    mapping: { columns: [{ source: 7, columnId: sel.columnId }] },
    target: { kind: 'existing', tableId: again },
  });
  assert.deepEqual(tables.requireTable(engine, again).columns[0]?.options?.choices, ['A', 'B']);
});

test('왕복: 수식 주입 방지를 끄면 `=`로 시작하는 텍스트도 같은 값으로 돌아온다', async () => {
  const engine = await setup();
  const { table, ids } = await seed(engine, [{ name: 't', type: 'text' }], [['=1+1'], ['-x']]);
  const guarded = memorySink();
  await exportCsv(engine, table, {}, { encoding: 'utf-8' }, guarded);
  assert.equal(guarded.text(), "t\r\n'=1+1\r\n'-x\r\n");
  const raw = memorySink();
  await exportCsv(engine, table, {}, { encoding: 'utf-8', formulaGuard: false }, raw);
  assert.equal(raw.text(), 't\r\n=1+1\r\n-x\r\n');
  const { report } = await importRun({
    engine,
    file: new Blob([raw.bytes()]),
    options: { format: 'csv' },
    mapping: { columns: [{ source: 0, name: 't', type: 'text' }] },
    target: { kind: 'new', name: '복사' },
  });
  const copy = tables.requireTable(engine, report.tableId);
  const cid = copy.columns[0]?.id ?? '';
  assert.deepEqual(
    engine.exec(`SELECT "${cid}" FROM "${copy.id}" ORDER BY "id" LIMIT 10`).rows,
    engine.exec(`SELECT "${ids[0]}" FROM "${table.id}" ORDER BY "id" LIMIT 10`).rows,
  );
});
