// @ts-check
/**
 * 전문 검색(Step 6, D-07): FTS5 인덱스 생성·삭제 커맨드의 대칭성, 트리거 동기화, 질의 조각의 이스케이프,
 * LIKE 폴백, 취소 시 롤백. 실제 wasm DB로 검사한다(모킹 금지).
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyCommand, isCommand } from '../../../src/db/command.js';
import { buildSearchWhere, count, fetchWindow } from '../../../src/db/query.js';
import { ftsTableFor, ftsTriggersFor, migrate } from '../../../src/db/schema.js';
import * as search from '../../../src/db/search.js';
import * as tables from '../../../src/db/tables.js';
import { AppError } from '../../../src/util/errors.js';
import { dumpDb } from './command.test.js';
import { openWasmEngine } from './helpers.js';

/** @typedef {import('../../../src/db/engine.js').Engine} Engine */

/** 텍스트·장문·정수·날짜 열과 행 몇 개. */
async function setup() {
  const engine = await openWasmEngine();
  await migrate(engine, { appVersion: 'test' });
  const { tableId } = await tables.create(engine, { name: '주소' });
  const name = (await tables.addColumn(engine, tableId, { name: '이름', type: 'text' })).columnId;
  const body = (await tables.addColumn(engine, tableId, { name: '주소', type: 'longtext' }))
    .columnId;
  const age = (await tables.addColumn(engine, tableId, { name: '나이', type: 'integer' })).columnId;
  const day = (await tables.addColumn(engine, tableId, { name: '날짜', type: 'date' })).columnId;
  await engine.transaction(() => {
    const insert = engine.prepareCached(
      `INSERT INTO "${tableId}" ("${name}", "${body}", "${age}", "${day}") VALUES (?, ?, ?, ?)`,
    );
    engine.run(insert, ['홍길동', '서울특별시 강남구 테헤란로', 30, '2024-01-01']);
    engine.run(insert, ['김철수', '부산광역시 해운대구', 25, '2024-02-02']);
    engine.run(insert, ["O'Brien", '100% "quoted" a_b', null, null]);
    engine.run(insert, [null, null, 40, '2025-03-03']);
  });
  return { engine, tableId, name, body, age, day };
}

/**
 * @param {Engine} engine
 * @param {string} tableId
 */
function objectsOf(engine, tableId) {
  return engine
    .exec(
      "SELECT type, name FROM sqlite_master WHERE name LIKE ? ESCAPE '\\' ORDER BY name LIMIT 100",
      [`${ftsTableFor(tableId).replace(/_/g, '\\_')}%`],
    )
    .rows.map((r) => `${r[0]}:${r[1]}`);
}

test('searchableColumns: 물리 타입이 TEXT인 살아 있는 열만', async () => {
  const { engine, tableId, name, body, day } = await setup();
  const table = tables.requireTable(engine, tableId);
  assert.deepEqual(
    search.searchableColumns(table).map((c) => c.id),
    [name, body, day],
  );
  await tables.softDeleteColumn(engine, tableId, body);
  assert.deepEqual(
    search.searchableColumns(tables.requireTable(engine, tableId)).map((c) => c.id),
    [name, day],
  );
});

test('ftsMatchQuery·likePattern: 따옴표·와일드카드 이스케이프', () => {
  assert.equal(search.ftsMatchQuery('a"b'), '"a""b"');
  assert.equal(
    search.ftsMatchQuery('강남구 OR 부산'),
    '"강남구 OR 부산"',
    '연산자도 구절 안의 글자',
  );
  assert.equal(search.likePattern('50%_x\\y'), '%50\\%\\_x\\\\y%');
});

test('fallbackLike: 열마다 LIKE ... ESCAPE, 값은 바인딩, 열이 없으면 0', async () => {
  const { engine, tableId } = await setup();
  const table = tables.requireTable(engine, tableId);
  const fragment = search.fallbackLike(search.searchableColumns(table), "O'Br");
  assert.equal((fragment.sql.match(/LIKE \? ESCAPE '\\'/g) ?? []).length, 3);
  assert.ok(!fragment.sql.includes("O'Br"));
  assert.deepEqual(fragment.params, ["%O'Br%", "%O'Br%", "%O'Br%"]);
  assert.deepEqual(search.fallbackLike([], 'x'), { sql: '0', params: [] });
});

test('enable: FTS 테이블·트리거·fts_enabled, 초기 인덱싱 진행률, 되돌리기로 덤프 동일, 다시 실행', async () => {
  const { engine, tableId } = await setup();
  const before = dumpDb(engine);
  /** @type {Array<{ phase: string, done: number, total: number }>} */
  const progress = [];
  const { cmd } = await search.enable(engine, tableId, { progress: (p) => progress.push(p) });
  assert.equal(isCommand(cmd), true);
  assert.equal(cmd.type, 'search.enable');
  assert.ok(progress.some((p) => p.phase === 'index' && p.done === 4 && p.total === 4));
  const triggers = ftsTriggersFor(tableId);
  assert.deepEqual(
    objectsOf(engine, tableId).filter((o) => o.startsWith('trigger:')),
    [`trigger:${triggers.delete}`, `trigger:${triggers.insert}`, `trigger:${triggers.update}`],
  );
  assert.ok(objectsOf(engine, tableId).includes(`table:${ftsTableFor(tableId)}`));
  const table = tables.requireTable(engine, tableId);
  assert.equal(table.ftsEnabled, true);

  // 인덱스가 쓰인다: 한글 부분 일치, 따옴표가 든 검색어, 대소문자 무시.
  assert.equal(count(engine, table, { search: '강남구' }), 1);
  assert.equal(count(engine, table, { search: '"quoted"' }), 1);
  assert.equal(count(engine, table, { search: "o'brien" }), 1);
  assert.equal(count(engine, table, { search: '없는말' }), 0);
  assert.match(buildSearchWhere(table, '강남구').sql, /MATCH \?/);
  // 3자 미만은 LIKE 폴백.
  assert.match(buildSearchWhere(table, '강남').sql, /LIKE \?/);
  assert.equal(count(engine, table, { search: '강남' }), 1);

  // 이미 켜져 있으면 거부.
  await assert.rejects(
    search.enable(engine, tableId),
    (e) => e instanceof AppError && e.code === 'E_DB_QUERY' && /already/.test(e.message),
  );

  const after = dumpDb(engine);
  await applyCommand(engine, cmd, 'undo');
  assert.deepEqual(dumpDb(engine), before, '되돌리기 뒤 덤프 동일(FTS·그림자 테이블·플래그)');
  assert.deepEqual(objectsOf(engine, tableId), []);
  await applyCommand(engine, cmd, 'do');
  assert.deepEqual(dumpDb(engine), after, '다시 실행은 같은 결과');
  await engine.close();
});

test('트리거: 삽입·갱신·삭제가 인덱스를 따라가고, 인덱스 열 밖의 갱신은 건드리지 않는다', async () => {
  const { engine, tableId, name, body, age } = await setup();
  await search.enable(engine, tableId);
  const table = tables.requireTable(engine, tableId);
  const fts = `"${ftsTableFor(tableId)}"`;
  await engine.transaction(() => {
    engine.run(`INSERT INTO "${tableId}" ("${name}", "${body}") VALUES (?, ?)`, [
      '새사람',
      '대전광역시 유성구',
    ]);
  });
  assert.equal(count(engine, table, { search: '유성구' }), 1);
  await engine.transaction(() => {
    engine.run(`UPDATE "${tableId}" SET "${body}" = ? WHERE "${name}" = ?`, [
      '광주광역시',
      '새사람',
    ]);
    // 인덱스에 없는 열만 바꾸는 갱신: 트리거가 돌지 않아야 한다(`UPDATE OF`).
    engine.run(`UPDATE "${tableId}" SET "${age}" = ? WHERE "${name}" = ?`, [99, '새사람']);
  });
  assert.equal(count(engine, table, { search: '유성구' }), 0);
  assert.equal(count(engine, table, { search: '광주광역' }), 1);
  await engine.transaction(() => {
    engine.run(`DELETE FROM "${tableId}" WHERE "${name}" = ?`, ['새사람']);
  });
  assert.equal(count(engine, table, { search: '광주광역' }), 0);
  // external-content 무결성 검사: 인덱스와 본문이 어긋나면 오류를 낸다.
  await engine.transaction(() => {
    engine.run(`INSERT INTO ${fts}(${fts}) VALUES ('integrity-check')`);
  });
  await engine.close();
});

test('enable 취소: 트랜잭션 롤백으로 FTS·트리거가 없고 fts_enabled = 0', async () => {
  const { engine, tableId } = await setup();
  const before = dumpDb(engine);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    search.enable(engine, tableId, { signal: controller.signal }),
    (e) => e instanceof AppError && e.code === 'E_IMPORT_CANCELLED',
  );
  assert.deepEqual(dumpDb(engine), before);
  assert.deepEqual(objectsOf(engine, tableId), []);
  assert.equal(tables.requireTable(engine, tableId).ftsEnabled, false);
  await engine.close();
});

test('enable 거부: 검색할 열이 없는 테이블, 외부(비STRICT) 테이블', async () => {
  const engine = await openWasmEngine();
  await migrate(engine, { appVersion: 'test' });
  const { tableId } = await tables.create(engine, { name: '숫자만' });
  await tables.addColumn(engine, tableId, { name: 'n', type: 'integer' });
  await assert.rejects(
    search.enable(engine, tableId),
    (e) =>
      e instanceof AppError &&
      e.code === 'E_DB_QUERY' &&
      /** @type {{ reason?: string }} */ (e.detail ?? {}).reason === 'no_searchable_columns',
  );
  await engine.transaction(() => {
    engine.run('UPDATE _jdr_tables SET strict = 0 WHERE id = ?', [tableId]);
  });
  await assert.rejects(
    search.enable(engine, tableId),
    (e) =>
      e instanceof AppError &&
      /** @type {{ reason?: string }} */ (e.detail ?? {}).reason === 'external_table',
  );
  await engine.close();
});

test('disable: 인덱스를 지우고 되돌리면 같은 열로 다시 만든다(만든 뒤 추가된 열은 인덱스 밖)', async () => {
  const { engine, tableId, name, body, day } = await setup();
  await search.enable(engine, tableId);
  await tables.addColumn(engine, tableId, { name: '비고', type: 'text' });
  assert.deepEqual(search.indexedColumnIds(engine, tableId), [name, body, day]);
  const before = dumpDb(engine);
  const { cmd } = await search.disable(engine, tableId);
  assert.equal(tables.requireTable(engine, tableId).ftsEnabled, false);
  assert.deepEqual(objectsOf(engine, tableId), []);
  const table = tables.requireTable(engine, tableId);
  assert.match(buildSearchWhere(table, '강남구').sql, /LIKE/, '인덱스가 없으면 LIKE');
  assert.equal(count(engine, table, { search: '강남구' }), 1);
  await applyCommand(engine, cmd, 'undo');
  assert.deepEqual(dumpDb(engine), before);
  assert.deepEqual(search.indexedColumnIds(engine, tableId), [name, body, day]);
  await assert.rejects(
    search.disable(engine, tableId).then(() => search.disable(engine, tableId)),
    (e) => e instanceof AppError && e.code === 'E_DB_QUERY',
  );
  await engine.close();
});

test('fetchWindow: 검색이 창 질의에 붙고 정렬과 함께 동작한다', async () => {
  const { engine, tableId, name, day } = await setup();
  await search.enable(engine, tableId);
  const table = tables.requireTable(engine, tableId);
  const spec = { search: '광역시', sort: [{ colId: day, dir: /** @type {const} */ ('desc') }] };
  const result = fetchWindow(engine, table, spec, { offset: 0, limit: 10 });
  assert.deepEqual(
    result.rows.map((r) => r.cells[result.columnIds.indexOf(name)]),
    ['김철수'],
  );
  await engine.close();
});
