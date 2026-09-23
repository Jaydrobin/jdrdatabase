// @ts-check
/**
 * 데이터베이스 정리(D-17, Step 13)의 엔진 공통 검사. `cleanup.test.js`(wasm)와 `test/native/engine-native.test.js`
 * (실제 rusqlite 엔진)가 같은 `defineCleanupContract(label, open)`를 돌린다. 이 파일은 `.test.js`가 아니므로 러너가
 * 직접 돌리지 않는다.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import * as cleanup from '../../../src/db/cleanup.js';
import { applyCommand } from '../../../src/db/command.js';
import * as query from '../../../src/db/query.js';
import { ftsTableFor, ftsTriggersFor, migrate, tmpTableFor } from '../../../src/db/schema.js';
import * as search from '../../../src/db/search.js';
import * as tables from '../../../src/db/tables.js';
import { AppError } from '../../../src/util/errors.js';

/** @typedef {import('../../../src/db/engine.js').Engine} Engine */
/** @typedef {import('../../../src/db/command.js').Command} Command */

/**
 * 스키마와 데이터 덤프(`_jdr_meta` 제외: `db_id`·`created_at`은 DB마다 다르다).
 * @param {Engine} engine
 * @returns {Record<string, unknown>}
 */
export function dumpWithoutMeta(engine) {
  const objects = engine
    .exec(
      "SELECT type, name, sql FROM sqlite_master WHERE name <> '_jdr_meta' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' ORDER BY type, name LIMIT 1000",
    )
    .rows.map((r) => ({ type: String(r[0]), name: String(r[1]), sql: String(r[2]) }));
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const o of objects) {
    if (o.type !== 'table') {
      out[`${o.type}:${o.name}`] = o.sql;
      continue;
    }
    const ident = `"${o.name.replace(/"/g, '""')}"`;
    // 가상 테이블 자체는 읽으면 원본(content) 테이블을 다시 읽을 뿐이다. 그림자 테이블이 실제 내용이다.
    const rows = /VIRTUAL TABLE/i.test(o.sql)
      ? []
      : engine.exec(
          /WITHOUT ROWID/i.test(o.sql)
            ? `SELECT * FROM ${ident} LIMIT 10000`
            : `SELECT * FROM ${ident} ORDER BY rowid LIMIT 10000`,
        ).rows;
    out[o.name] = { sql: o.sql, rows };
  }
  return out;
}

/**
 * @param {Engine} engine
 * @param {string} tableId
 * @returns {string[]}
 */
function physicalNames(engine, tableId) {
  return engine
    .exec('SELECT name FROM pragma_table_info(?) ORDER BY cid LIMIT 2000', [tableId])
    .rows.map((r) => String(r[0]));
}

/**
 * @param {Engine} engine
 * @param {string} tableId
 * @returns {number}
 */
function triggerCount(engine, tableId) {
  const names = Object.values(ftsTriggersFor(tableId));
  return Number(
    engine.exec(
      "SELECT count(*) FROM sqlite_master WHERE type = 'trigger' AND name IN (?, ?, ?) LIMIT 1",
      names,
    ).rows[0]?.[0],
  );
}

/**
 * 행을 넣는 커맨드(저널에 남는 형태와 같게 커맨드로 적용한다). 시각은 고정해 재생 결과를 비교할 수 있게 한다.
 * @param {string} tableId
 * @param {string[]} columnIds
 * @param {Array<Array<string | number | null>>} rows
 * @returns {Command}
 */
function insertRows(tableId, columnIds, rows) {
  const cols = columnIds.map((c) => `"${c}"`).join(', ');
  const marks = columnIds.map(() => '?').join(', ');
  return {
    type: 'row.insert',
    tableId,
    do: [
      {
        batch: {
          sql: `INSERT INTO "${tableId}" ("_created_at", "_updated_at", ${cols}) VALUES ('2026-09-23T00:00:00', '2026-09-23T00:00:00', ${marks})`,
          paramsList: rows,
        },
      },
    ],
    undo: [],
    summary: 'test rows',
    irreversible: true,
  };
}

/**
 * 정리 대상이 있는 DB. 모든 변경을 커맨드로 적용하고 그 목록을 돌려준다(저널 재생 검사에 쓴다).
 * - "고객": 이름(text), 메모(longtext, 삭제), 나이(integer → text 타입 변경. 옛 물리 열은 삭제 상태로 남는다), 검색 인덱스
 * - "주문": 품목(text), 수량(integer, 삭제)
 * @param {Engine} engine
 */
async function seed(engine) {
  await migrate(engine, { appVersion: 'test' });
  /** @type {Command[]} */
  const journal = [];
  /**
   * @template {{ cmd: Command }} T
   * @param {T} r
   * @returns {T}
   */
  const keep = (r) => {
    journal.push(r.cmd);
    return r;
  };
  const now = '2026-09-23T01:00:00.000Z';
  const customers = keep(
    await tables.create(engine, {
      name: '고객',
      columns: [
        { name: '이름', type: 'text' },
        { name: '메모', type: 'longtext' },
        { name: '나이', type: 'integer' },
      ],
      now,
    }),
  ).tableId;
  const orders = keep(
    await tables.create(engine, {
      name: '주문',
      columns: [
        { name: '품목', type: 'text' },
        { name: '수량', type: 'integer' },
      ],
      now,
    }),
  ).tableId;
  const [nameCol, memoCol, ageCol] = tables
    .requireTable(engine, customers)
    .columns.map((c) => c.id);
  const [itemCol, qtyCol] = tables.requireTable(engine, orders).columns.map((c) => c.id);
  if (!nameCol || !memoCol || !ageCol || !itemCol || !qtyCol) throw new Error('seed columns');
  /** @type {Array<Array<string | number | null>>} */
  const customerRows = [];
  for (let i = 0; i < 40; i += 1) {
    customerRows.push([`고객${i} 강남구`, `메모 ${i} `.repeat(50), 100 + i]);
  }
  const insertCustomers = insertRows(customers, [nameCol, memoCol, ageCol], customerRows);
  await applyCommand(engine, insertCustomers);
  journal.push(insertCustomers);
  const insertOrders = insertRows(
    orders,
    [itemCol, qtyCol],
    [
      ['사과', 3],
      ['배', null],
      ['귤', 12],
    ],
  );
  await applyCommand(engine, insertOrders);
  journal.push(insertOrders);
  keep(await search.enable(engine, customers));
  const changed = keep(
    await tables.changeColumnType(engine, customers, ageCol, { type: 'text', now }),
  ).columnId;
  keep(await tables.softDeleteColumn(engine, customers, memoCol, { now }));
  keep(await tables.softDeleteColumn(engine, orders, qtyCol, { now }));
  return {
    journal,
    customers,
    orders,
    cols: { nameCol, memoCol, ageCol, changed, itemCol, qtyCol },
  };
}

/**
 * @param {Engine} engine
 * @param {string} tableId
 * @param {string[]} columnIds
 */
function readValues(engine, tableId, columnIds) {
  const cols = ['id', '_created_at', '_updated_at', ...columnIds].map((c) => `"${c}"`).join(', ');
  return engine.exec(`SELECT ${cols} FROM "${tableId}" ORDER BY "id" LIMIT 10000`).rows;
}

/**
 * @param {Promise<unknown>} action
 * @param {string} code
 */
async function expectCode(action, code) {
  await assert.rejects(action, (err) => {
    assert.ok(err instanceof AppError, String(err));
    assert.equal(err.code, code, err.message);
    return true;
  });
}

/**
 * @param {Engine} engine
 * @param {Partial<Engine>} overrides
 * @returns {Engine}
 */
function wrap(engine, overrides) {
  return { ...engine, ...overrides };
}

/**
 * @param {string} label
 * @param {(bytes?: Uint8Array) => Promise<Engine>} open 초기화되고 빈 DB가 열린 엔진
 */
export function defineCleanupContract(label, open) {
  describe(`cleanup contract: ${label}`, () => {
    test('plan: 소프트 삭제된 열이 있는 STRICT 테이블만, 크기와 빈 공간, compactsOnSave', async () => {
      const engine = await open();
      const { customers, orders, cols } = await seed(engine);
      const planned = cleanup.plan(engine);
      assert.deepEqual(
        planned.tables.map((t) => [t.tableId, t.columns.map((c) => c.id).sort(), t.ftsEnabled]),
        [
          [customers, [cols.memoCol, cols.ageCol].sort(), true],
          [orders, [cols.qtyCol], false],
        ],
      );
      assert.equal(planned.compactsOnSave, engine.capabilities().compactsOnSave);
      assert.ok(
        planned.dbBytes > 0 && planned.freeBytes >= 0 && planned.freeBytes < planned.dbBytes,
      );
      await engine.close();
    });

    test('run: 지운 열이 물리적으로 없고, 남은 열·시스템 열 값과 물리 순서가 그대로다', async () => {
      const engine = await open();
      const { customers, orders, cols } = await seed(engine);
      const keptCustomers = [cols.nameCol, cols.changed];
      const beforeCustomers = readValues(engine, customers, keptCustomers);
      const beforeOrders = readValues(engine, orders, [cols.itemCol]);
      const namesBefore = physicalNames(engine, customers);
      const progress = /** @type {string[]} */ ([]);
      const result = await cleanup.run(
        engine,
        {
          columns: [
            { tableId: orders, columnId: cols.qtyCol },
            { tableId: customers, columnId: cols.memoCol },
            { tableId: customers, columnId: cols.ageCol },
          ],
        },
        { progress: (p) => progress.push(p.phase) },
      );
      assert.equal(result.removedColumns, 3);
      assert.equal(result.rebuiltIndexes, 1);
      assert.deepEqual(
        result.cmds.map((c) => [c.type, c.tableId, c.irreversible, c.undo.length]),
        [
          ['column.purge', customers, true, 0],
          ['column.purge', orders, true, 0],
        ],
      );
      assert.deepEqual(
        physicalNames(engine, customers),
        namesBefore.filter((n) => n !== cols.memoCol && n !== cols.ageCol),
      );
      assert.deepEqual(physicalNames(engine, orders), [
        'id',
        '_created_at',
        '_updated_at',
        cols.itemCol,
      ]);
      assert.deepEqual(readValues(engine, customers, keptCustomers), beforeCustomers);
      assert.deepEqual(readValues(engine, orders, [cols.itemCol]), beforeOrders);
      // 메타에서도 사라지고, 임시 테이블은 남지 않고, 테이블은 여전히 STRICT이며 id가 rowid 별칭이다.
      assert.deepEqual(
        tables.requireTable(engine, customers).columns.map((c) => [c.id, c.deletedAt]),
        [
          [cols.nameCol, null],
          [cols.changed, null],
        ],
      );
      const master = engine.exec(
        "SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name IN (?, ?, ?) ORDER BY name LIMIT 5",
        [customers, tmpTableFor(customers), tmpTableFor(orders)],
      ).rows;
      assert.equal(master.length, 1);
      assert.match(String(master[0]?.[1]), /STRICT\s*$/);
      assert.match(String(master[0]?.[1]), /"id" INTEGER PRIMARY KEY/);
      assert.deepEqual(engine.exec('PRAGMA integrity_check').rows, [['ok']]);
      assert.deepEqual(cleanup.plan(engine).tables, []);
      assert.ok(progress.includes('purge') && progress.includes('index'));
      // 정리 뒤에도 행 추가가 이어진다(id 연속, 새 행이 끝).
      const stats = query.stats(engine, tables.requireTable(engine, orders));
      assert.equal(stats.count, 3);
      await engine.close();
    });

    test('run: 검색 인덱스는 지금 검색 대상 열로 다시 만들어지고 트리거·검색 결과가 같으며 낡은 인덱스가 바로잡힌다', async () => {
      const engine = await open();
      const { customers, cols } = await seed(engine);
      const before = tables.requireTable(engine, customers);
      // 타입 변경으로 새 텍스트 열이 인덱스에 없어 낡은 상태다(D-07).
      assert.equal(before.ftsStale, true);
      const hits = query.count(engine, before, { search: '강남구' });
      assert.equal(hits, 40);
      await cleanup.run(engine, {
        columns: [
          { tableId: customers, columnId: cols.memoCol },
          { tableId: customers, columnId: cols.ageCol },
        ],
      });
      const after = tables.requireTable(engine, customers);
      assert.equal(after.ftsEnabled, true);
      assert.equal(after.ftsStale, false);
      assert.deepEqual(search.indexedColumnIds(engine, customers), [cols.nameCol, cols.changed]);
      assert.equal(triggerCount(engine, customers), 3);
      assert.equal(query.count(engine, after, { search: '강남구' }), hits);
      assert.equal(query.count(engine, after, { search: '139' }), 1);
      // 트리거가 살아 있다: 넣은 행과 고친 행이 검색에 반영된다.
      await engine.transaction(() => {
        engine.run(
          `INSERT INTO "${customers}" ("${cols.nameCol}", "${cols.changed}") VALUES (?, ?)`,
          ['새 고객 강남구', '31'],
        );
        engine.run(`UPDATE "${customers}" SET "${cols.nameCol}" = ? WHERE "id" = 1`, ['서초구']);
        // 타입 변경으로 생긴 텍스트 열(나이)은 낡은 인덱스에 없었다. 이제 그 열의 갱신도 트리거가 반영한다.
        engine.run(`UPDATE "${customers}" SET "${cols.changed}" = ? WHERE "id" = 2`, ['777살']);
      });
      assert.equal(query.count(engine, after, { search: '777살' }), 1);
      assert.equal(query.count(engine, after, { search: '강남구' }), hits);
      assert.equal(query.count(engine, after, { search: '서초구' }), 1);
      assert.deepEqual(engine.exec(`SELECT count(*) FROM "${ftsTableFor(customers)}"`).rows, [
        [41],
      ]);
      await engine.close();
    });

    test('run: 두 번째 테이블의 재작성에 실패를 주입하면 DB 덤프가 정리 전과 같다', async () => {
      const engine = await open();
      const { customers, orders, cols } = await seed(engine);
      const before = dumpWithoutMeta(engine);
      const failing = wrap(engine, {
        run(sql, params) {
          const text = typeof sql === 'string' ? sql : sql.sql;
          if (text.startsWith(`INSERT INTO "${tmpTableFor(orders)}"`)) {
            throw new AppError('E_MEM', 'injected out of memory');
          }
          return engine.run(sql, params);
        },
      });
      await expectCode(
        cleanup.run(failing, {
          columns: [
            { tableId: customers, columnId: cols.memoCol },
            { tableId: orders, columnId: cols.qtyCol },
          ],
        }),
        'E_MEM',
      );
      assert.deepEqual(dumpWithoutMeta(engine), before);
      // DB는 계속 쓸 수 있고, 다시 정리하면 된다.
      const again = await cleanup.run(engine, {
        columns: [{ tableId: orders, columnId: cols.qtyCol }],
      });
      assert.equal(again.removedColumns, 1);
      await engine.close();
    });

    test('run: 테이블 사이에서 취소하면 E_IMPORT_CANCELLED이고 DB 덤프가 정리 전과 같다', async () => {
      const engine = await open();
      const { customers, orders, cols } = await seed(engine);
      const before = dumpWithoutMeta(engine);
      const controller = new AbortController();
      await expectCode(
        cleanup.run(
          engine,
          {
            columns: [
              { tableId: customers, columnId: cols.memoCol },
              { tableId: orders, columnId: cols.qtyCol },
            ],
          },
          {
            signal: controller.signal,
            progress: (p) => {
              if (p.phase === 'purge' && p.done === 1) controller.abort();
            },
          },
        ),
        'E_IMPORT_CANCELLED',
      );
      assert.deepEqual(dumpWithoutMeta(engine), before);
      await engine.close();
    });

    test('run: 요청한 열이 복원되었거나 없거나 외부 테이블이면 E_DB_QUERY이고 아무것도 바뀌지 않는다', async () => {
      const engine = await open();
      const { customers, orders, cols, journal } = await seed(engine);
      void journal;
      await tables.restoreColumn(engine, orders, cols.qtyCol);
      const before = dumpWithoutMeta(engine);
      for (const columns of [
        [{ tableId: orders, columnId: cols.qtyCol }],
        [{ tableId: customers, columnId: cols.nameCol }],
        [{ tableId: customers, columnId: 'c_00000000' }],
        [{ tableId: 't_00000000', columnId: cols.memoCol }],
        [
          { tableId: customers, columnId: cols.memoCol },
          { tableId: orders, columnId: cols.qtyCol },
        ],
      ]) {
        await expectCode(cleanup.run(engine, { columns }), 'E_DB_QUERY');
        assert.deepEqual(dumpWithoutMeta(engine), before);
      }
      await engine.close();
    });

    test('run: 저장이 빈 공간을 없애는 엔진은 vacuum을 부르지 않고, 아니면 큰 열을 지운 뒤 크기가 줄어든다', async () => {
      const engine = await open();
      const { customers, cols } = await seed(engine);
      // 큰 장문 열: 행마다 20 KB, 200행(약 4 MB).
      const bigCol = (await tables.addColumn(engine, customers, { name: '본문', type: 'longtext' }))
        .columnId;
      await engine.transaction(async () => {
        await engine.runBatch(
          `INSERT INTO "${customers}" ("${cols.nameCol}", "${bigCol}") VALUES (?, ?)`,
          Array.from({ length: 200 }, (_, i) => [`큰 행 ${i}`, `${i}`.padEnd(20_000, '가')]),
        );
      });
      await tables.softDeleteColumn(engine, customers, bigCol);
      let vacuumCalls = 0;
      const spied = wrap(engine, {
        vacuum() {
          vacuumCalls += 1;
          engine.vacuum();
        },
      });
      const result = await cleanup.run(spied, {
        columns: [{ tableId: customers, columnId: bigCol }],
      });
      if (engine.capabilities().compactsOnSave) {
        assert.equal(vacuumCalls, 0);
        assert.equal(result.vacuumed, false);
        assert.equal(result.vacuumError, null);
      } else {
        assert.equal(vacuumCalls, 1);
        assert.equal(result.vacuumed, true);
        assert.equal(result.vacuumError, null);
        assert.ok(
          result.bytesAfter < result.bytesBefore - 3_000_000,
          `page_count가 줄어야 한다: ${result.bytesBefore} → ${result.bytesAfter}`,
        );
        assert.deepEqual(engine.exec('PRAGMA freelist_count').rows, [[0]]);
      }
      // 저장이 빈 공간을 없애는 엔진이라고 보고하면 어느 엔진에서든 vacuum을 부르지 않는다.
      const compacting = wrap(spied, {
        capabilities: () => ({ ...engine.capabilities(), compactsOnSave: true }),
      });
      vacuumCalls = 0;
      const none = await cleanup.run(compacting, { columns: [] });
      assert.equal(vacuumCalls, 0);
      assert.deepEqual(none.cmds, []);
      await engine.close();
    });

    test('run: VACUUM이 실패해도 재작성은 커밋되고 vacuumError로 알린다', async () => {
      const engine = await open();
      const { orders, cols } = await seed(engine);
      const failing = wrap(engine, {
        capabilities: () => ({ ...engine.capabilities(), compactsOnSave: false }),
        vacuum() {
          throw new AppError('E_MEM', 'injected vacuum failure');
        },
      });
      const result = await cleanup.run(failing, {
        columns: [{ tableId: orders, columnId: cols.qtyCol }],
      });
      assert.equal(result.vacuumed, false);
      assert.equal(result.vacuumError?.code, 'E_MEM');
      assert.equal(result.removedColumns, 1);
      assert.ok(!physicalNames(engine, orders).includes(cols.qtyCol));
      await engine.close();
    });

    test('저널 재생: 기록된 column.purge를 새 DB에 재생하면 같은 스키마·데이터가 된다', async () => {
      const engine = await open();
      const { journal, customers, orders, cols } = await seed(engine);
      const result = await cleanup.run(engine, {
        columns: [
          { tableId: customers, columnId: cols.memoCol },
          { tableId: customers, columnId: cols.ageCol },
          { tableId: orders, columnId: cols.qtyCol },
        ],
      });
      const replica = await open();
      await migrate(replica, { appVersion: 'test' });
      for (const cmd of [...journal, ...result.cmds]) {
        // 저널은 구조화 복제를 거친다(IDB). 같은 형태로 넘긴다.
        await applyCommand(replica, structuredClone(cmd), 'do');
      }
      assert.deepEqual(dumpWithoutMeta(replica), dumpWithoutMeta(engine));
      await replica.close();
      await engine.close();
    });
  });
}
