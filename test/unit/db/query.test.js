// @ts-check
/**
 * 창 질의 빌더(Step 4): SQL 형태(파라미터 바인딩·LIMIT·id 보조 정렬), 미리보기·길이 배지, 숨김 열,
 * 상한 검사, count, 전문 로드. 실제 wasm DB로 검사한다(모킹 금지).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MAX_RESULT_ROWS } from '../../../src/db/engine.js';
import {
  buildOrderBy,
  buildWhere,
  buildWindowSQL,
  count,
  denseFromId,
  fetchRow,
  fetchRows,
  fetchWindow,
  isPlainView,
  normalizeViewSpec,
  PREVIEW_CHARS,
  pruneViewSpec,
  stats,
  toggleSort,
  visibleColumns,
} from '../../../src/db/query.js';
import { AppError } from '../../../src/util/errors.js';
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

// ---- Step 6: 뷰 스펙·필터·정렬 빌더 ----

test('buildWhere: 값은 항상 바인딩(따옴표가 든 값이 SQL에 나타나지 않음), 연산자별 SQL', async () => {
  const { engine, table, name, age, flag } = await setup();
  const columns = visibleColumns(table);
  const evil = "O'Brien; DROP TABLE x --";
  const where = buildWhere(
    {
      logic: 'and',
      conditions: [
        { colId: name, op: '=', value: evil },
        { colId: name, op: 'contains', value: "50%_'" },
        { colId: age, op: '>=', value: '30' },
        { colId: flag, op: '=', value: '참' },
      ],
    },
    columns,
  );
  assert.ok(!where.sql.includes("O'Brien"), '값이 SQL 문자열에 들어가지 않는다');
  assert.ok(!where.sql.includes('50%'));
  assert.equal(
    where.sql,
    `("${name}" COLLATE NOCASE = ? AND "${name}" LIKE ? ESCAPE '\\' AND "${age}" >= ? AND "${flag}" = ?)`,
  );
  assert.deepEqual(where.params, [evil, "%50\\%\\_'%", 30, 1]);

  // 실제 DB에서: 대소문자 무시 등호, 부분 일치, 숫자 비교, OR.
  const again = tables.requireTable(engine, table.id);
  const cols = visibleColumns(again);
  /** @param {import('../../../src/db/query.js').FilterSpec} filter */
  const ids = (filter) =>
    fetchWindow(engine, again, { filter }, { offset: 0, limit: 10 }).rows.map((r) => r.id);
  assert.deepEqual(
    ids({ logic: 'and', conditions: [{ colId: name, op: '=', value: "o'brien" }] }),
    [1],
  );
  assert.deepEqual(
    ids({ logic: 'and', conditions: [{ colId: name, op: 'starts', value: 'o' }] }),
    [1],
  );
  assert.deepEqual(
    ids({
      logic: 'or',
      conditions: [
        { colId: age, op: '<', value: '35' },
        { colId: name, op: 'empty' },
      ],
    }),
    [1, 3],
  );
  assert.deepEqual(ids({ logic: 'and', conditions: [{ colId: age, op: 'not_empty' }] }), [1, 3]);
  assert.deepEqual(
    ids({ logic: 'and', conditions: [{ colId: age, op: '!=', value: '30' }] }),
    [2, 3],
    '!=는 빈 값도 포함',
  );
  assert.deepEqual(
    ids({ logic: 'and', conditions: [{ colId: age, op: 'in', values: ['40', '30'] }] }),
    [1, 3],
  );
  assert.deepEqual(
    ids({ logic: 'and', conditions: [{ colId: name, op: 'in', values: ['둘', 'x'] }] }),
    [2],
  );
  assert.deepEqual(
    ids({ logic: 'and', conditions: [{ colId: age, op: 'contains', value: '4' }] }),
    [3],
    '숫자 열의 contains는 문자열로',
  );
  assert.deepEqual(
    ids({ logic: 'and', conditions: [{ colId: name, op: '=', value: '' }] }),
    [3],
    '빈 값과의 =는 IS NULL',
  );
  assert.equal(
    count(engine, again, {
      filter: { logic: 'and', conditions: [{ colId: age, op: '>', value: '0' }] },
    }),
    2,
  );
  void cols;
  await engine.close();
});

test('buildWhere: 타입에 맞지 않는 값은 E_VALUE_INVALID, 빈 in 목록도, 살아 있지 않은 열은 무시, 조건 없음은 빈 조각', async () => {
  const { table, age, name } = await setup();
  const columns = visibleColumns(table);
  assert.throws(
    () =>
      buildWhere({ logic: 'and', conditions: [{ colId: age, op: '>', value: 'abc' }] }, columns),
    (e) =>
      e instanceof AppError &&
      e.code === 'E_VALUE_INVALID' &&
      /** @type {{ reason?: string, columnName?: string }} */ (e.detail ?? {}).reason ===
        'not_integer' &&
      /** @type {{ columnName?: string }} */ (e.detail ?? {}).columnName === '나이',
  );
  assert.throws(
    () => buildWhere({ logic: 'and', conditions: [{ colId: age, op: 'in', values: [] }] }, columns),
    (e) => e instanceof AppError && e.code === 'E_VALUE_INVALID',
  );
  assert.deepEqual(
    buildWhere(
      { logic: 'and', conditions: [{ colId: 'c_nope0000', op: '=', value: 'x' }] },
      columns,
    ),
    { sql: '', params: [] },
  );
  assert.deepEqual(buildWhere(null, columns), { sql: '', params: [] });
  assert.deepEqual(buildWhere({ logic: 'and', conditions: [] }, columns), { sql: '', params: [] });
  void name;
});

test('buildOrderBy: 타입별 정렬(NOCASE·수치), NULLS LAST, 항상 id로 끝나고 빈 정렬은 "id"', async () => {
  const { engine, table, tableId, name, age } = await setup();
  const columns = visibleColumns(table);
  assert.equal(buildOrderBy([], columns), '"id"');
  assert.equal(buildOrderBy(undefined, columns), '"id"');
  assert.equal(
    buildOrderBy(
      [
        { colId: name, dir: 'desc' },
        { colId: age, dir: 'asc' },
        { colId: 'c_nope0000', dir: 'asc' },
      ],
      columns,
    ),
    `"${name}" COLLATE NOCASE DESC NULLS LAST, "${age}" ASC NULLS LAST, "id"`,
  );
  await engine.transaction(() => {
    engine.run(`INSERT INTO "${tableId}" ("${name}", "${age}") VALUES (?, ?)`, ['apple', 5]);
  });
  const rows = (/** @type {import('../../../src/db/query.js').SortSpec[]} */ sort) =>
    fetchWindow(engine, table, { sort }, { offset: 0, limit: 10 }).rows.map((r) => r.id);
  // 이름 오름차순: apple(4) < O'Brien(1) < 둘(2), NULL(3)은 마지막.
  assert.deepEqual(rows([{ colId: name, dir: 'asc' }]), [4, 1, 2, 3]);
  assert.deepEqual(
    rows([{ colId: name, dir: 'desc' }]),
    [2, 1, 4, 3],
    '내림차순에서도 빈 값은 마지막',
  );
  assert.deepEqual(rows([{ colId: age, dir: 'desc' }]), [3, 1, 4, 2]);
  // 정렬이 있으면 id 탐색 빠른 경로를 쓰지 않는다(stats를 줘도 같은 결과).
  assert.deepEqual(
    fetchWindow(
      engine,
      table,
      { sort: [{ colId: age, dir: 'desc' }] },
      { offset: 1, limit: 2 },
      { count: 4 },
    ).rows.map((r) => r.id),
    [1, 4],
  );
  await assert.rejects(
    async () =>
      buildWindowSQL(
        table,
        columns,
        { sort: [{ colId: age, dir: 'asc' }] },
        { offset: 0, limit: 1, fromId: 1 },
      ),
    /plain view/,
  );
  await engine.close();
});

test('fetchRows: 뷰의 정렬·필터가 창 질의와 같은 순서로 붙는다', async () => {
  const { engine, table, name, age } = await setup();
  const viewSpec = {
    sort: [{ colId: age, dir: /** @type {const} */ ('desc') }],
    filter: {
      logic: /** @type {const} */ ('and'),
      conditions: [{ colId: age, op: /** @type {const} */ ('not_empty') }],
    },
  };
  const window = fetchWindow(engine, table, viewSpec, { offset: 0, limit: 10 }).rows.map(
    (r) => r.id,
  );
  const rows = fetchRows(engine, table, viewSpec, { offset: 0, limit: 10 }, [name]).map(
    (r) => r.id,
  );
  assert.deepEqual(window, [3, 1]);
  assert.deepEqual(rows, window);
  assert.deepEqual(
    fetchRows(engine, table, viewSpec, { offset: 1, limit: 10 }, [name]).map((r) => r.id),
    [1],
  );
  await engine.close();
});

test('normalizeViewSpec·isPlainView·toggleSort·pruneViewSpec', async () => {
  const { engine, table, tableId, name, age } = await setup();
  assert.deepEqual(normalizeViewSpec(undefined), {
    hidden: [],
    sort: [],
    filter: null,
    search: '',
  });
  assert.deepEqual(
    normalizeViewSpec({
      hidden: [name, name, 3],
      sort: [{ colId: age, dir: 'x' }],
      filter: { logic: 'or', conditions: [] },
      search: ' a ',
    }),
    { hidden: [name], sort: [{ colId: age, dir: 'asc' }], filter: null, search: 'a' },
  );
  assert.equal(isPlainView({ hidden: [name] }), true);
  assert.equal(isPlainView({ search: ' ' }), true);
  assert.equal(isPlainView({ sort: [{ colId: age, dir: 'asc' }] }), false);

  assert.deepEqual(toggleSort([], age), [{ colId: age, dir: 'asc' }]);
  assert.deepEqual(toggleSort([{ colId: age, dir: 'asc' }], age), [{ colId: age, dir: 'desc' }]);
  assert.deepEqual(toggleSort([{ colId: age, dir: 'desc' }], age), []);
  assert.deepEqual(
    toggleSort([{ colId: age, dir: 'asc' }], name),
    [{ colId: name, dir: 'asc' }],
    '보통 클릭은 이 열만 남긴다',
  );
  assert.deepEqual(toggleSort([{ colId: age, dir: 'asc' }], name, true), [
    { colId: age, dir: 'asc' },
    { colId: name, dir: 'asc' },
  ]);
  assert.deepEqual(
    toggleSort(
      [
        { colId: age, dir: 'asc' },
        { colId: name, dir: 'asc' },
      ],
      age,
      true,
    ),
    [
      { colId: age, dir: 'desc' },
      { colId: name, dir: 'asc' },
    ],
  );
  assert.deepEqual(
    toggleSort(
      [
        { colId: age, dir: 'desc' },
        { colId: name, dir: 'asc' },
      ],
      age,
      true,
    ),
    [{ colId: name, dir: 'asc' }],
  );

  await tables.softDeleteColumn(engine, tableId, age);
  const after = tables.requireTable(engine, tableId);
  const pruned = pruneViewSpec(
    {
      sort: [
        { colId: age, dir: 'asc' },
        { colId: name, dir: 'desc' },
      ],
      filter: { logic: 'and', conditions: [{ colId: age, op: 'empty' }] },
      hidden: [age],
      search: 'x',
    },
    after,
  );
  assert.equal(pruned.changed, true);
  assert.deepEqual(pruned.spec, {
    hidden: [],
    sort: [{ colId: name, dir: 'desc' }],
    filter: null,
    search: 'x',
  });
  assert.equal(pruneViewSpec({ sort: [{ colId: name, dir: 'asc' }] }, after).changed, false);
  void table;
  await engine.close();
});
