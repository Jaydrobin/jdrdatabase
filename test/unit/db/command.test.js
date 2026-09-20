// @ts-check
/**
 * 커맨드 실행기(D-08): 문장 목록을 하나의 트랜잭션으로, do → undo 대칭, 형태 검증.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyCommand, assertCommand, isCommand } from '../../../src/db/command.js';
import { AppError } from '../../../src/util/errors.js';
import { openWasmEngine } from './helpers.js';

/** @typedef {import('../../../src/db/command.js').Command} Command */

/**
 * 스키마와 데이터를 함께 담은 덤프. "적용 → 되돌리기 → 덤프 동일" 비교에 쓴다.
 * @param {import('../../../src/db/engine.js').Engine} engine
 */
export function dumpDb(engine) {
  const tables = engine
    .exec("SELECT name, sql FROM sqlite_master WHERE type = 'table' ORDER BY name LIMIT 1000")
    .rows.map((r) => ({ name: String(r[0]), sql: String(r[1]) }));
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const t of tables) {
    const ident = `"${t.name.replace(/"/g, '""')}"`;
    out[t.name] = {
      sql: t.sql,
      info: engine.exec(`SELECT name, type FROM pragma_table_info(?) ORDER BY cid LIMIT 2000`, [
        t.name,
      ]).rows,
      rows: engine.exec(`SELECT * FROM ${ident} ORDER BY rowid LIMIT 10000`).rows,
    };
  }
  return out;
}

/** @type {Command} */
const CREATE_T = {
  type: 'table.create',
  tableId: null,
  do: [
    { sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT) STRICT' },
    { sql: 'INSERT INTO t (s) VALUES (?)', params: ['a'] },
    { sql: 'INSERT INTO t (s) VALUES (:s)', params: { s: '나' } },
  ],
  undo: [{ sql: 'DROP TABLE t' }],
  summary: 'create t',
};

test('isCommand/assertCommand: 형태 검증', () => {
  assert.equal(isCommand(CREATE_T), true);
  assert.equal(isCommand({ ...CREATE_T, do: [{ nope: 1 }] }), false);
  assert.equal(isCommand({ ...CREATE_T, tableId: 3 }), false);
  assert.equal(isCommand(null), false);
  assert.throws(
    () => assertCommand('x'),
    (e) => e instanceof AppError && e.code === 'E_DB_QUERY',
  );
});

test('applyCommand: do 적용 → undo → 덤프 동일, affected 집계', async () => {
  const engine = await openWasmEngine();
  const before = dumpDb(engine);
  const applied = await applyCommand(engine, CREATE_T, 'do');
  assert.equal(applied.affected, 2, 'INSERT 두 건이 집계된다(DDL은 0)');
  assert.deepEqual(engine.exec('SELECT s FROM t ORDER BY id').rows, [['a'], ['나']]);
  await applyCommand(engine, CREATE_T, 'undo');
  assert.deepEqual(dumpDb(engine), before);
  await engine.close();
});

test('applyCommand: 중간 문장이 실패하면 전체 롤백', async () => {
  const engine = await openWasmEngine();
  /** @type {Command} */
  const bad = {
    type: 'x',
    tableId: null,
    do: [
      { sql: 'CREATE TABLE t (a INTEGER) STRICT' },
      { sql: 'INSERT INTO t VALUES (?)', params: [1] },
      { sql: 'INSERT INTO t VALUES (?)', params: ['not-int'] },
    ],
    undo: [],
    summary: 'bad',
  };
  await assert.rejects(
    applyCommand(engine, bad),
    (e) => e instanceof AppError && e.code === 'E_DB_QUERY',
  );
  assert.deepEqual(
    engine.exec("SELECT count(*) FROM sqlite_master WHERE name = 't'").rows,
    [[0]],
    '테이블 생성까지 되돌아간다',
  );
  await engine.close();
});

test('applyCommand: irreversible 또는 undo가 비면 되돌리기 거부(E_UNDO_LIMIT)', async () => {
  const engine = await openWasmEngine();
  /** @type {Command} */
  const drop = {
    type: 'table.drop',
    tableId: 't',
    do: [],
    undo: [],
    summary: '',
    irreversible: true,
  };
  await assert.rejects(
    applyCommand(engine, drop, 'undo'),
    (e) => e instanceof AppError && e.code === 'E_UNDO_LIMIT',
  );
  await engine.close();
});

test('applyCommand: 취소 신호가 켜져 있으면 시작 전에 E_IMPORT_CANCELLED', async () => {
  const engine = await openWasmEngine();
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    applyCommand(engine, CREATE_T, 'do', { signal: controller.signal }),
    (e) => e instanceof AppError && e.code === 'E_IMPORT_CANCELLED',
  );
  assert.deepEqual(engine.exec("SELECT count(*) FROM sqlite_master WHERE name = 't'").rows, [[0]]);
  await engine.close();
});

test('convert 단계: 형태 검증과 정책별 동작, 진행률', async () => {
  const engine = await openWasmEngine();
  await engine.transaction(() => {
    engine.run('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b INTEGER) STRICT');
    engine.run("INSERT INTO t (a) VALUES ('1'), ('x'), (NULL), (' 4 ')");
  });
  assert.equal(
    isCommand({
      type: 'x',
      tableId: 't',
      do: [{ convert: { table: 't', from: 'a', to: 'b', type: 'integer', policy: 'null' } }],
      undo: [],
      summary: '',
    }),
    true,
  );
  assert.equal(
    isCommand({
      type: 'x',
      tableId: 't',
      do: [{ convert: { table: 't', from: 'a', to: 'b', type: 'integer', policy: 'maybe' } }],
      undo: [],
      summary: '',
    }),
    false,
  );
  /** @type {Array<{ done: number, total: number }>} */
  const progress = [];
  const result = await applyCommand(
    engine,
    {
      type: 'x',
      tableId: 't',
      do: [{ convert: { table: 't', from: 'a', to: 'b', type: 'integer', policy: 'null' } }],
      undo: [],
      summary: '',
    },
    'do',
    { progress: (p) => progress.push({ done: p.done, total: p.total }) },
  );
  assert.deepEqual(result, { affected: 4, nulled: 1 });
  assert.deepEqual(progress, [
    { done: 0, total: 4 },
    { done: 4, total: 4 },
  ]);
  assert.deepEqual(engine.exec('SELECT b FROM t ORDER BY id').rows, [[1], [null], [null], [4]]);
  await engine.close();
});
