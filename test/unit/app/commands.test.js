// @ts-check
/**
 * 데이터 커맨드(Step 5 완료 기준): 모든 커맨드 타입에 대해 "적용 → 되돌리기 → DB 덤프 동일"과
 * 다시 실행. 값은 파라미터 바인딩으로만 들어가고, 배치는 `runBatch` 상한 안으로 나뉜다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  bulkEdit,
  chunkParams,
  clearRowRange,
  deleteRowRange,
  deleteRows,
  editCell,
  insertRows,
  invert,
  UNDO_SNAPSHOT_MAX_ROWS,
} from '../../../src/app/commands.js';
import { applyCommand, isCommand } from '../../../src/db/command.js';
import { MAX_BATCH_PARAMS } from '../../../src/db/engine.js';
import { buildViewClauses, fetchRows, stats } from '../../../src/db/query.js';
import { migrate } from '../../../src/db/schema.js';
import * as tables from '../../../src/db/tables.js';
import { AppError } from '../../../src/util/errors.js';
import { dumpDb } from '../db/command.test.js';
import { openWasmEngine } from '../db/helpers.js';

/** @typedef {import('../../../src/db/command.js').Command} Command */

const NOW = '2026-09-20T00:00:00.000Z';
const LATER = '2026-09-20T01:00:00.000Z';

/** 텍스트·정수·장문 열과 행 3개가 든 테이블(그중 한 열은 소프트 삭제됨). */
async function setup() {
  const engine = await openWasmEngine();
  await migrate(engine, { appVersion: 'test' });
  const { tableId } = await tables.create(engine, { name: '고객' });
  const name = (await tables.addColumn(engine, tableId, { name: '이름', type: 'text' })).columnId;
  const age = (await tables.addColumn(engine, tableId, { name: '나이', type: 'integer' })).columnId;
  const memo = (await tables.addColumn(engine, tableId, { name: '메모', type: 'longtext' }))
    .columnId;
  await engine.transaction(() => {
    const insert = engine.prepareCached(
      `INSERT INTO "${tableId}" ("id", "_created_at", "_updated_at", "${name}", "${age}", "${memo}") VALUES (?, ?, ?, ?, ?, ?)`,
    );
    engine.run(insert, [1, NOW, NOW, '하나', 10, '가'.repeat(300)]);
    engine.run(insert, [2, NOW, NOW, "O'Brien", null, null]);
    engine.run(insert, [3, NOW, null, null, 30, '메모']);
  });
  await tables.softDeleteColumn(engine, tableId, memo);
  const table = tables.requireTable(engine, tableId);
  return { engine, table, tableId, name, age, memo };
}

/**
 * 적용 → 되돌리기 → 덤프 동일 → 다시 적용 → 첫 적용과 같은 덤프.
 * @param {import('../../../src/db/engine.js').Engine} engine
 * @param {Command} cmd
 */
async function roundTrip(engine, cmd) {
  assert.equal(isCommand(cmd), true);
  const before = dumpDb(engine);
  await applyCommand(engine, cmd, 'do');
  const after = dumpDb(engine);
  assert.notDeepEqual(after, before, '적용은 DB를 바꾼다');
  await applyCommand(engine, cmd, 'undo');
  assert.deepEqual(dumpDb(engine), before, '되돌리기 뒤 덤프 동일');
  await applyCommand(engine, cmd, 'do');
  assert.deepEqual(dumpDb(engine), after, '다시 실행은 같은 결과');
  await applyCommand(engine, cmd, 'undo');
  assert.deepEqual(dumpDb(engine), before);
}

test('editCell: 값과 _updated_at을 바꾸고 되돌리면 옛 값·옛 시각으로', async () => {
  const { engine, table, tableId, name } = await setup();
  const cmd = editCell({
    tableId,
    rowId: 2,
    colId: name,
    oldValue: "O'Brien",
    newValue: '둘',
    oldUpdatedAt: NOW,
    now: LATER,
  });
  const first = cmd.do[0];
  assert.ok(first && 'sql' in first && !first.sql.includes('둘'), '값은 SQL에 없다(바인딩)');
  await roundTrip(engine, cmd);
  await applyCommand(engine, cmd, 'do');
  assert.deepEqual(fetchRows(engine, table, {}, { offset: 1, limit: 1 }, [name])[0], {
    id: 2,
    cells: { [name]: '둘' },
    createdAt: NOW,
    updatedAt: LATER,
  });
  await engine.close();
});

test('insertRows: firstId부터 연속 id로 빈 행을 붙이고 되돌리면 지운다', async () => {
  const { engine, table, tableId } = await setup();
  const { maxId } = stats(engine, table);
  const cmd = insertRows({ tableId, count: 3, firstId: (maxId ?? 0) + 1, now: LATER });
  await roundTrip(engine, cmd);
  await applyCommand(engine, cmd, 'do');
  assert.deepEqual(stats(engine, table), { count: 6, minId: 1, maxId: 6 });
  assert.throws(() => insertRows({ tableId, count: 0, firstId: 1, now: LATER }), /positive/);
  await engine.close();
});

test('deleteRows: 스냅샷(소프트 삭제된 열 포함)으로 되살려 덤프가 같다', async () => {
  const { engine, table, tableId, memo } = await setup();
  const rows = fetchRows(engine, table, {}, { offset: 0, limit: 2 });
  assert.ok(rows[0] && memo in rows[0].cells, '스냅샷은 소프트 삭제된 열을 담는다');
  const cmd = deleteRows({ tableId, rows });
  await roundTrip(engine, cmd);
  await applyCommand(engine, cmd, 'do');
  assert.deepEqual(stats(engine, table), { count: 1, minId: 3, maxId: 3 });
  // 스냅샷이 없는 삭제(빈 목록)는 아무것도 하지 않는 커맨드다.
  assert.deepEqual(deleteRows({ tableId, rows: [] }).do, []);
  await engine.close();
});

test('deleteRowRange: 되돌릴 수 없는 범위 삭제(스냅샷 상한 초과용)', async () => {
  const { engine, table, tableId } = await setup();
  const cmd = deleteRowRange({ tableId, offset: 1, count: 5 });
  assert.equal(cmd.irreversible, true);
  assert.deepEqual(cmd.undo, []);
  await applyCommand(engine, cmd, 'do');
  assert.deepEqual(stats(engine, table), { count: 1, minId: 1, maxId: 1 });
  await assert.rejects(
    applyCommand(engine, cmd, 'undo'),
    (e) => e instanceof AppError && e.code === 'E_UNDO_LIMIT',
  );
  assert.throws(
    () => invert(cmd),
    (e) => e instanceof AppError && e.code === 'E_UNDO_LIMIT',
  );
  await engine.close();
});

test('clearRowRange: 되돌릴 수 없는 범위 지우기는 옛 값을 읽지 않고 문장 하나로 한다', async () => {
  const { engine, table, tableId, name, age } = await setup();
  const cmd = clearRowRange({ tableId, colIds: [name, age], offset: 0, count: 2, now: LATER });
  assert.equal(cmd.irreversible, true);
  assert.deepEqual(cmd.undo, []);
  assert.equal(cmd.do.length, 1, '범위가 얼마나 크든 문장 하나다');
  // 값은 전부 바인딩이고 SQL에는 식별자와 NULL만 들어간다.
  const only = /** @type {{ sql: string, params: unknown[] }} */ (cmd.do[0]);
  assert.deepEqual(only.params, [LATER, 2, 0]);
  assert.equal(only.sql.includes('고객'), false);

  await applyCommand(engine, cmd, 'do');
  const rows = fetchRows(engine, table, {}, { offset: 0, limit: 10 });
  assert.deepEqual(
    rows.map((r) => [r.id, r.cells[name] ?? null, r.cells[age] ?? null, r.updatedAt]),
    [
      [1, null, null, LATER],
      // 행 2는 이름만 차 있었고 나이는 원래 NULL이었다.
      [2, null, null, LATER],
      // 범위 밖(행 3)은 그대로다.
      [3, null, 30, null],
    ],
  );
  await assert.rejects(
    applyCommand(engine, cmd, 'undo'),
    (e) => e instanceof AppError && e.code === 'E_UNDO_LIMIT',
  );

  // 이미 모두 NULL인 행은 건드리지 않아 `_updated_at`이 헛돌지 않는다.
  const again = clearRowRange({ tableId, colIds: [name], offset: 0, count: 1, now: NOW });
  await applyCommand(engine, again, 'do');
  assert.equal(
    fetchRows(engine, table, {}, { offset: 0, limit: 1 })[0]?.updatedAt,
    LATER,
    '비어 있던 행은 다시 쓰지 않는다',
  );

  assert.throws(
    () => clearRowRange({ tableId, colIds: [], offset: 0, count: 1, now: NOW }),
    (e) => e instanceof AppError && e.code === 'E_DB_QUERY',
  );
  await engine.close();
});

test('bulkEdit: 열 집합별 배치 갱신 + 새 행 삽입, 되돌리면 덤프 동일', async () => {
  const { engine, table, tableId, name, age } = await setup();
  const cmd = bulkEdit({
    tableId,
    edits: [
      {
        rowId: 1,
        oldUpdatedAt: NOW,
        cells: [
          { colId: name, oldValue: '하나', newValue: '일' },
          { colId: age, oldValue: 10, newValue: 11 },
        ],
      },
      {
        rowId: 2,
        oldUpdatedAt: NOW,
        cells: [
          { colId: name, oldValue: "O'Brien", newValue: '이' },
          { colId: age, oldValue: null, newValue: 22 },
        ],
      },
      { rowId: 3, oldUpdatedAt: null, cells: [{ colId: age, oldValue: 30, newValue: null }] },
    ],
    inserts: [
      { id: 4, cells: { [name]: '넷', [age]: 44 } },
      { id: 5, cells: { [name]: '다섯' } },
    ],
    now: LATER,
  });
  // 같은 열 집합 [name, age] 두 행이 배치 하나, [age] 한 행이 배치 하나, 삽입 배치 하나.
  assert.equal(cmd.do.length, 3);
  assert.equal(cmd.undo.length, 3);
  await roundTrip(engine, cmd);
  await applyCommand(engine, cmd, 'do');
  const rows = fetchRows(engine, table, {}, { offset: 0, limit: 10 }, [name, age]);
  assert.deepEqual(
    rows.map((r) => [r.id, r.cells[name], r.cells[age], r.updatedAt]),
    [
      [1, '일', 11, LATER],
      [2, '이', 22, LATER],
      [3, null, null, LATER],
      [4, '넷', 44, LATER],
      [5, '다섯', null, LATER],
    ],
  );
  // 편집이 없고 삽입만 있는 경우(빈 테이블에 붙여넣기)도 성립한다.
  await applyCommand(engine, cmd, 'undo');
  await roundTrip(
    engine,
    bulkEdit({ tableId, edits: [], inserts: [{ id: 9, cells: { [name]: '아홉' } }], now: LATER }),
  );
  await engine.close();
});

test('invert: do/undo를 맞바꾸고, 역커맨드를 do로 적용하면 되돌리기와 같다', async () => {
  const { engine, tableId, name } = await setup();
  const cmd = editCell({
    tableId,
    rowId: 1,
    colId: name,
    oldValue: '하나',
    newValue: '일',
    oldUpdatedAt: NOW,
    now: LATER,
  });
  const before = dumpDb(engine);
  await applyCommand(engine, cmd, 'do');
  const inverse = invert(cmd);
  assert.deepEqual(inverse.do, cmd.undo);
  assert.deepEqual(inverse.undo, cmd.do);
  assert.equal(inverse.type, cmd.type);
  await applyCommand(engine, inverse, 'do');
  assert.deepEqual(dumpDb(engine), before);
  await engine.close();
});

test('되돌리기 스냅샷 상한: 1만 행을 넘는 삭제·다중 편집은 E_UNDO_LIMIT', () => {
  const rows = Array.from({ length: UNDO_SNAPSHOT_MAX_ROWS + 1 }, (_, i) => ({
    id: i + 1,
    cells: {},
    createdAt: null,
    updatedAt: null,
  }));
  assert.throws(
    () => deleteRows({ tableId: 't_00000000', rows }),
    (e) => e instanceof AppError && e.code === 'E_UNDO_LIMIT',
  );
  assert.throws(
    () =>
      bulkEdit({
        tableId: 't_00000000',
        edits: [],
        inserts: rows.map((r) => ({ id: r.id, cells: {} })),
        now: NOW,
      }),
    (e) => e instanceof AppError && e.code === 'E_UNDO_LIMIT',
  );
});

test('bulkEdit irreversible: 상한을 넘어도 만들고 undo가 비며 irreversible', async () => {
  const { engine, table, tableId, age } = await setup();
  const edits = Array.from({ length: UNDO_SNAPSHOT_MAX_ROWS + 1 }, (_, i) => ({
    rowId: i + 1,
    oldUpdatedAt: null,
    cells: [{ colId: age, oldValue: null, newValue: 1 }],
  }));
  const cmd = bulkEdit({ tableId, edits, now: LATER, irreversible: true });
  assert.equal(cmd.irreversible, true);
  assert.deepEqual(cmd.undo, []);
  assert.equal(cmd.do.length, 2, '배치가 상한 단위로 나뉜다');
  await applyCommand(engine, cmd, 'do');
  assert.deepEqual(
    fetchRows(engine, table, {}, { offset: 0, limit: 3 }, [age]).map((r) => r.cells[age]),
    [1, 1, 1],
  );
  await engine.close();
});

test('chunkParams: 건수 상한과 직렬화 예산으로 나눈다', () => {
  const many = Array.from({ length: MAX_BATCH_PARAMS * 2 + 1 }, (_, i) => [i]);
  const byCount = chunkParams(many);
  assert.deepEqual(
    byCount.map((c) => c.length),
    [MAX_BATCH_PARAMS, MAX_BATCH_PARAMS, 1],
  );
  const big = 'x'.repeat(10 * 1024 * 1024);
  const byBytes = chunkParams([[big], [big], [big], [big]]);
  assert.ok(byBytes.length >= 2, '10 MB 값 넷은 32 MB 예산에서 둘 이상으로 나뉜다');
  assert.equal(byBytes.flat().length, 4);
  assert.deepEqual(chunkParams([]), []);
  const cmd = insertRows({
    tableId: 't_00000000',
    count: MAX_BATCH_PARAMS + 5,
    firstId: 1,
    now: NOW,
  });
  assert.equal(cmd.do.length, 2, '배치 문장이 상한 단위로 나뉜다');
});

test('deleteRowRange·clearRowRange: 뷰 조각(clauses)이 있으면 부분 질의에 필터·정렬이 붙고 값은 바인딩', async () => {
  const { engine, table, tableId, name, age } = await setup();
  const clauses = buildViewClauses(table, {
    sort: [{ colId: age, dir: 'desc' }],
    filter: { logic: 'and', conditions: [{ colId: name, op: 'contains', value: "O'" }] },
  });
  const del = deleteRowRange({ tableId, offset: 0, count: 1, clauses });
  const stmt = /** @type {{ sql: string, params: unknown[] }} */ (del.do[0]);
  assert.match(
    stmt.sql,
    /WHERE "id" IN \(SELECT "id" FROM "t_[0-9a-f]{8}" WHERE \(.*LIKE \? ESCAPE '\\'\) ORDER BY "[^"]+" DESC NULLS LAST, "id" LIMIT \? OFFSET \?\)/,
  );
  assert.ok(!stmt.sql.includes("O'"));
  assert.deepEqual(stmt.params, ["%O'%", 1, 0]);
  await applyCommand(engine, del);
  assert.deepEqual(
    fetchRows(engine, table, {}, { offset: 0, limit: 10 }).map((r) => r.id),
    [1, 3],
    "O'Brien 행만 지운다",
  );

  const clear = clearRowRange({
    tableId,
    colIds: [name],
    offset: 0,
    count: 1,
    now: LATER,
    clauses: buildViewClauses(table, { sort: [{ colId: age, dir: 'desc' }] }),
  });
  const cstmt = /** @type {{ sql: string, params: unknown[] }} */ (clear.do[0]);
  assert.deepEqual(cstmt.params, [LATER, 1, 0]);
  await applyCommand(engine, clear);
  // 나이 내림차순의 첫 행(id 3, 나이 30)의 이름만 비운다.
  const rows = fetchRows(engine, table, {}, { offset: 0, limit: 10 }, [name]);
  assert.deepEqual(
    rows.map((r) => [r.id, r.cells[name]]),
    [
      [1, '하나'],
      [3, null],
    ],
  );
  await engine.close();
});
