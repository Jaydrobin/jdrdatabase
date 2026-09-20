// @ts-check
/**
 * 창 질의 빌더(Step 4): SQL 형태(파라미터 바인딩·LIMIT·id 보조 정렬), 미리보기·길이 배지, 숨김 열,
 * 상한 검사, count, 전문 로드. 실제 wasm DB로 검사한다(모킹 금지).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_RESULT_ROWS } from '../../../src/db/engine.js';
import {
  buildWindowSQL,
  count,
  denseFromId,
  fetchRow,
  fetchRows,
  fetchWindow,
  PREVIEW_CHARS,
  stats,
  visibleColumns,
} from '../../../src/db/query.js';
import { migrate } from '../../../src/db/schema.js';
import * as tables from '../../../src/db/tables.js';
import { openWasmEngine } from './helpers.js';

/** 테이블 하나(텍스트·정수·장문·불리언 열)와 행 몇 개가 든 엔진. */
async function setup() {
  const engine = await openWasmEngine();
  await migrate(engine, { appVersion: 'test' });
  const { tableId } = await tables.create(engine, { name: '고객' });
  const name = (await tables.addColumn(engine, tableId, { name: '이름', type: 'text' })).columnId;
  const age = (await tables.addColumn(engine, tableId, { name: '나이', type: 'integer' })).columnId;
  const body = (await tables.addColumn(engine, tableId, { name: '본문', type: 'longtext' }))
    .columnId;
  const flag = (await tables.addColumn(engine, tableId, { name: '활성', type: 'boolean' }))
    .columnId;
  const long = '가'.repeat(PREVIEW_CHARS + 44);
  await engine.transaction(() => {
    const insert = engine.prepareCached(
      `INSERT INTO "${tableId}" ("${name}", "${age}", "${body}", "${flag}") VALUES (?, ?, ?, ?)`,
    );
    engine.run(insert, ["O'Brien", 30, '짧은 글', 1]);
    engine.run(insert, ['둘', null, long, 0]);
    engine.run(insert, [null, 40, null, null]);
  });
  const table = tables.requireTable(engine, tableId);
  return { engine, table, tableId, name, age, body, flag, long };
}

test('buildWindowSQL: 값은 바인딩, 식별자는 인용, id 보조 정렬과 LIMIT/OFFSET', async () => {
  const { table, tableId, name, age, body } = await setup();
  const columns = visibleColumns(table);
  const { sql, params } = buildWindowSQL(table, columns, {}, { offset: 200, limit: 200 });
  assert.equal(
    sql,
    `SELECT "id", substr("${name}", 1, ${PREVIEW_CHARS}), length("${name}"), "${age}", substr("${body}", 1, ${PREVIEW_CHARS}), length("${body}"), "${table.columns[3]?.id}" FROM "${tableId}" ORDER BY "id" LIMIT ? OFFSET ?`,
  );
  assert.deepEqual(params, [200, 200]);
  assert.ok(!sql.includes('200'), 'offset·limit 값이 SQL 문자열에 들어가지 않는다');
});

test('buildWindowSQL: limit은 1만 이하, offset은 음수 불가', async () => {
  const { table } = await setup();
  const columns = visibleColumns(table);
  assert.throws(
    () => buildWindowSQL(table, columns, {}, { offset: 0, limit: MAX_RESULT_ROWS + 1 }),
    /limit/,
  );
  assert.throws(() => buildWindowSQL(table, columns, {}, { offset: -1, limit: 10 }), /offset/);
  assert.throws(() => buildWindowSQL(table, columns, {}, { offset: 1.5, limit: 10 }), /offset/);
});

test('fetchWindow: 미리보기 256자와 길이 배지, NULL, 따옴표가 든 값', async () => {
  const { engine, table, name, age, body, flag, long } = await setup();
  const result = fetchWindow(engine, table, {}, { offset: 0, limit: 200 });
  assert.deepEqual(result.columnIds, [name, age, body, flag]);
  assert.equal(result.rows.length, 3);
  assert.ok(result.elapsedMs >= 0);
  const [first, second, third] = result.rows;
  assert.deepEqual(first, {
    id: 1,
    cells: ["O'Brien", 30, '짧은 글', 1],
    lengths: [null, null, null, null],
  });
  assert.equal(second?.id, 2);
  assert.equal(second?.cells[2], long.slice(0, PREVIEW_CHARS));
  assert.deepEqual(second?.lengths, [null, null, long.length, null]);
  assert.deepEqual(third, {
    id: 3,
    cells: [null, 40, null, null],
    lengths: [null, null, null, null],
  });
});

test('fetchWindow: offset·limit이 창을 자르고, 범위 밖이면 빈 배열', async () => {
  const { engine, table } = await setup();
  const mid = fetchWindow(engine, table, {}, { offset: 1, limit: 1 });
  assert.deepEqual(
    mid.rows.map((r) => r.id),
    [2],
  );
  const beyond = fetchWindow(engine, table, {}, { offset: 100, limit: 200 });
  assert.deepEqual(beyond.rows, []);
});

test('fetchWindow: 숨김 열과 소프트 삭제 열은 결과에서 빠진다', async () => {
  const { engine, table, tableId, name, age, body, flag } = await setup();
  await tables.softDeleteColumn(engine, tableId, age);
  const after = tables.requireTable(engine, tableId);
  const result = fetchWindow(engine, after, { hidden: [body] }, { offset: 0, limit: 10 });
  assert.deepEqual(result.columnIds, [name, flag]);
  assert.deepEqual(result.rows[0]?.cells, ["O'Brien", 1]);
  void table;
});

test('count: 전체 행 수', async () => {
  const { engine, table } = await setup();
  assert.equal(count(engine, table, {}), 3);
});

test('fetchRow: 전문 로드(미리보기 없음), 없는 행은 null, 없는 열은 E_DB_QUERY', async () => {
  const { engine, table, name, body, long } = await setup();
  const row = fetchRow(engine, table, 2);
  assert.equal(row?.id, 2);
  assert.equal(row?.cells[body], long);
  assert.equal(row?.cells[name], '둘');
  const only = fetchRow(engine, table, 2, [body]);
  assert.deepEqual(Object.keys(only?.cells ?? {}), [body]);
  assert.equal(fetchRow(engine, table, 999), null);
  assert.throws(() => fetchRow(engine, table, 1, ['c_nope0000']), /column not found/);
  // 시스템 열의 시각도 함께 온다(되돌리기가 원래대로 되돌려 놓는 데 쓴다). 직접 넣은 행이라 null.
  assert.equal(row?.createdAt, null);
  assert.equal(row?.updatedAt, null);
});

test('fetchRows: 뷰 순서로 offset·limit, 열을 비우면 소프트 삭제된 열까지, stats는 count·minId·maxId', async () => {
  const { engine, table, tableId, name, age, body, flag, long } = await setup();
  await engine.transaction(() => {
    engine.run(`UPDATE "${tableId}" SET "_updated_at" = ? WHERE "id" = ?`, [
      '2026-01-01T00:00:00.000Z',
      1,
    ]);
  });
  const all = fetchRows(engine, table, {}, { offset: 0, limit: 10 });
  assert.equal(all.length, 3);
  assert.deepEqual(
    all.map((r) => r.id),
    [1, 2, 3],
  );
  assert.equal(all[0]?.updatedAt, '2026-01-01T00:00:00.000Z');
  assert.equal(all[1]?.cells[body], long, '미리보기가 아니라 전문');
  const page = fetchRows(engine, table, {}, { offset: 1, limit: 1 }, [name, age]);
  assert.deepEqual(page, [
    { id: 2, cells: { [name]: '둘', [age]: null }, createdAt: null, updatedAt: null },
  ]);
  assert.throws(() => fetchRows(engine, table, {}, { offset: 0, limit: 20_000 }), /limit/);
  assert.throws(
    () => fetchRows(engine, table, {}, { offset: 0, limit: 1 }, ['c_nope0000']),
    /column not found/,
  );

  // 소프트 삭제된 열: 열 목록을 비우면 스냅샷에 포함되고, 명시하면 살아 있는 열만 고를 수 있다.
  await tables.softDeleteColumn(engine, tableId, flag);
  const after = tables.requireTable(engine, tableId);
  const snapshot = fetchRows(engine, after, {}, { offset: 0, limit: 1 });
  assert.deepEqual(Object.keys(snapshot[0]?.cells ?? {}).sort(), [name, age, body, flag].sort());
  assert.throws(
    () => fetchRows(engine, after, {}, { offset: 0, limit: 1 }, [flag]),
    /column not found/,
  );

  assert.deepEqual(stats(engine, after), { count: 3, minId: 1, maxId: 3 });
  await engine.transaction(() => {
    engine.run(`DELETE FROM "${tableId}"`);
  });
  assert.deepEqual(stats(engine, after), { count: 0, minId: null, maxId: null });
  await engine.close();
});

test('visibleColumns: position 순서, 소프트 삭제·숨김 제외', async () => {
  const { engine, table, tableId, name, age, body, flag } = await setup();
  await tables.reorderColumns(engine, tableId, { orderedIds: [flag, body, age, name] });
  const after = tables.requireTable(engine, tableId);
  assert.deepEqual(
    visibleColumns(after, { hidden: [body] }).map((c) => c.id),
    [flag, age, name],
  );
  void table;
});

test('denseFromId: id가 연속이면 offset번째 id, 빈틈이 있으면 undefined (OFFSET 폴백)', async () => {
  const { engine, table, tableId } = await setup();
  assert.equal(denseFromId(engine, table, { count: 3 }, 0), 1);
  assert.equal(denseFromId(engine, table, { count: 3 }, 2), 3);
  assert.equal(denseFromId(engine, table, { count: 3 }, 3), undefined, '범위 밖');
  assert.equal(denseFromId(engine, table, { count: 0 }, 0), undefined);
  await engine.transaction(() => {
    engine.run(`DELETE FROM "${tableId}" WHERE "id" = 2`);
  });
  assert.equal(denseFromId(engine, table, { count: 2 }, 1), undefined, '빈틈: max-min+1 ≠ count');
  // 폴백 경로도 같은 행을 돌려준다.
  const rows = fetchWindow(engine, table, {}, { offset: 1, limit: 10 }, { count: 2 }).rows;
  assert.deepEqual(
    rows.map((r) => r.id),
    [3],
  );
});

test('fetchWindow: 연속 id의 빠른 경로와 OFFSET 경로가 같은 창을 돌려준다', async () => {
  const { engine, table, tableId, name } = await setup();
  await engine.transaction(() => {
    const insert = engine.prepareCached(`INSERT INTO "${tableId}" ("${name}") VALUES (?)`);
    for (let i = 4; i <= 500; i += 1) engine.run(insert, [`r${i}`]);
  });
  const fast = fetchWindow(engine, table, {}, { offset: 200, limit: 200 }, { count: 500 });
  const slow = fetchWindow(engine, table, {}, { offset: 200, limit: 200 });
  assert.deepEqual(fast.rows, slow.rows);
  assert.equal(fast.rows[0]?.id, 201);
  assert.equal(fast.rows.length, 200);
  const tail = fetchWindow(engine, table, {}, { offset: 400, limit: 200 }, { count: 500 });
  assert.equal(tail.rows.length, 100);
  // id가 1부터 시작하지 않아도(min 기준) 맞는다.
  await engine.transaction(() => {
    engine.run(`DELETE FROM "${tableId}" WHERE "id" <= 10`);
  });
  const shifted = fetchWindow(engine, table, {}, { offset: 0, limit: 3 }, { count: 490 });
  assert.deepEqual(
    shifted.rows.map((r) => r.id),
    [11, 12, 13],
  );
  const { sql } = buildWindowSQL(
    table,
    visibleColumns(table),
    {},
    { offset: 5, limit: 3, fromId: 16 },
  );
  assert.match(sql, /WHERE "id" >= \? ORDER BY "id" LIMIT \?$/);
  assert.ok(!sql.includes('OFFSET'));
});
