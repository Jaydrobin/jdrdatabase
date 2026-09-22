// @ts-check
/**
 * 테이블·열 관리(Step 3). 모든 커맨드 타입에 대해 "적용 → 되돌리기 → DB 덤프 동일"(CLAUDE.md 6장)과
 * 예외 처리(이름 규칙, 시스템 열, 외부 테이블, 열 상한, 타입 변경 정책·진행률·취소)를 검사한다.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { applyCommand } from '../../../src/db/command.js';
import { adoptExternal, MAX_COLUMNS, migrate, SYSTEM_COLUMNS } from '../../../src/db/schema.js';
import * as tables from '../../../src/db/tables.js';
import { AppError } from '../../../src/util/errors.js';
import { dumpDb } from './command.test.js';
import { openWasmEngine } from './helpers.js';

/** @typedef {import('../../../src/db/engine.js').Engine} Engine */

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures');

/** 메타가 있는 빈 DB. */
async function freshDb() {
  const engine = await openWasmEngine();
  await migrate(engine, { appVersion: 'test' });
  return engine;
}

/**
 * 표본 테이블: 열 셋과 행 몇 개.
 * @param {Engine} engine
 */
async function sampleTable(engine) {
  const { tableId } = await tables.create(engine, { name: '고객' });
  const name = await tables.addColumn(engine, tableId, { name: '이름', type: 'text' });
  const age = await tables.addColumn(engine, tableId, { name: '나이', type: 'text' });
  const flag = await tables.addColumn(engine, tableId, { name: '활성', type: 'boolean' });
  await engine.transaction(() => {
    const stmt = engine.prepareCached(
      `INSERT INTO "${tableId}" ("${name.columnId}", "${age.columnId}", "${flag.columnId}") VALUES (?, ?, ?)`,
    );
    engine.run(stmt, ['홍길동', '30', 1]);
    engine.run(stmt, ['김철수', '25', 0]);
    engine.run(stmt, ['이영희', 'unknown', null]);
  });
  return { tableId, nameId: name.columnId, ageId: age.columnId, flagId: flag.columnId };
}

/**
 * "적용 → 되돌리기 → 덤프 동일" 검사. 커맨드는 이미 적용된 상태로 받는다.
 * @param {Engine} engine
 * @param {Record<string, unknown>} before 적용 전 덤프
 * @param {import('../../../src/db/command.js').Command} cmd
 */
async function assertUndoRestores(engine, before, cmd) {
  await applyCommand(engine, cmd, 'undo');
  assert.deepEqual(dumpDb(engine), before, `${cmd.type}: 되돌리기 뒤 덤프가 같아야 한다`);
  // 다시 적용할 수 있어야 한다(redo). 물리 열·테이블 이름이 충돌하지 않는지 확인한다.
  await applyCommand(engine, cmd, 'do');
}

test('create: STRICT 테이블 + 시스템 열, 메타 등록, 되돌리기로 완전 복원, 이름 규칙', async () => {
  const engine = await freshDb();
  const before = dumpDb(engine);
  const { tableId, cmd } = await tables.create(engine, { name: ' 주문 ' });
  assert.match(tableId, /^t_[0-9a-f]{8}$/);
  const [table] = tables.list(engine);
  assert.ok(table);
  assert.equal(table.name, '주문', '앞뒤 공백은 지운다');
  assert.equal(table.strict, true);
  assert.deepEqual(table.columns, []);
  const info = engine.exec('SELECT name, type FROM pragma_table_info(?) ORDER BY cid', [
    tableId,
  ]).rows;
  assert.deepEqual(info, [
    ['id', 'INTEGER'],
    ['_created_at', 'TEXT'],
    ['_updated_at', 'TEXT'],
  ]);
  assert.match(
    String(engine.exec('SELECT sql FROM sqlite_master WHERE name = ?', [tableId]).rows[0]?.[0]),
    /STRICT$/,
  );

  await assertUndoRestores(engine, before, cmd);

  for (const bad of ['', '   ', '주문']) {
    await assert.rejects(
      tables.create(engine, { name: bad }),
      (e) => e instanceof AppError && e.code === 'E_NAME_INVALID',
      JSON.stringify(bad),
    );
  }
  await assert.rejects(
    tables.create(engine, { name: 'x'.repeat(201) }),
    (e) => e instanceof AppError && e.code === 'E_NAME_INVALID',
  );
  await engine.close();
});

test('rename/drop: 이름 변경은 되돌릴 수 있고, 삭제는 irreversible', async () => {
  const engine = await freshDb();
  const { tableId } = await tables.create(engine, { name: 'A' });
  await tables.create(engine, { name: 'B' });
  const before = dumpDb(engine);
  const renamed = await tables.rename(engine, tableId, { name: 'C' });
  assert.equal(tables.list(engine)[0]?.name, 'C');
  await assertUndoRestores(engine, before, renamed.cmd);
  await assert.rejects(
    tables.rename(engine, tableId, { name: 'B' }),
    (e) => e instanceof AppError && e.code === 'E_NAME_INVALID',
  );

  const dropped = await tables.drop(engine, tableId);
  assert.equal(dropped.cmd.irreversible, true);
  assert.deepEqual(dropped.cmd.undo, []);
  assert.deepEqual(
    tables.list(engine).map((t) => t.name),
    ['B'],
  );
  assert.deepEqual(
    engine.exec('SELECT count(*) FROM sqlite_master WHERE name = ?', [tableId]).rows,
    [[0]],
  );
  await assert.rejects(
    applyCommand(engine, dropped.cmd, 'undo'),
    (e) => e instanceof AppError && e.code === 'E_UNDO_LIMIT',
  );
  await engine.close();
});

test('addColumn: 물리 열 + 메타, 되돌리기(DROP COLUMN)로 완전 복원, 시스템 열·중복 이름·select 옵션', async () => {
  const engine = await freshDb();
  const { tableId } = await tables.create(engine, { name: 'T' });
  const before = dumpDb(engine);
  const added = await tables.addColumn(engine, tableId, {
    name: '상태',
    type: 'select',
    options: { choices: ['대기', '진행', '진행', ' '] },
  });
  assert.match(added.columnId, /^c_[0-9a-f]{8}$/);
  assert.equal(added.columnCount, SYSTEM_COLUMNS.length + 1);
  const [table] = tables.list(engine);
  assert.deepEqual(
    table?.columns.map((c) => [c.name, c.type, c.position, c.options]),
    [['상태', 'select', 0, { choices: ['대기', '진행'] }]],
  );
  const info = engine.exec('SELECT name, type FROM pragma_table_info(?) ORDER BY cid', [
    tableId,
  ]).rows;
  assert.deepEqual(info.at(-1), [added.columnId, 'TEXT']);
  await assertUndoRestores(engine, before, added.cmd);

  await assert.rejects(
    tables.addColumn(engine, tableId, { name: '상태', type: 'text' }),
    (e) => e instanceof AppError && e.code === 'E_NAME_INVALID',
  );
  await assert.rejects(
    tables.addColumn(engine, tableId, { name: '선택', type: 'select' }),
    (e) => e instanceof AppError && e.code === 'E_VALUE_INVALID',
  );
  await assert.rejects(
    tables.addColumn(engine, tableId, { name: 'x', type: /** @type {never} */ ('blob') }),
    (e) => e instanceof AppError && e.code === 'E_VALUE_INVALID',
  );
  await assert.rejects(
    tables.renameColumn(engine, tableId, 'id', { name: 'x' }),
    (e) => e instanceof AppError && e.code === 'E_SYSTEM_COLUMN',
  );
  await assert.rejects(
    tables.softDeleteColumn(engine, tableId, '_created_at'),
    (e) => e instanceof AppError && e.code === 'E_SYSTEM_COLUMN',
  );
  await engine.close();
});

test('renameColumn/reorderColumns/softDeleteColumn/restoreColumn: do → undo → 덤프 동일', async () => {
  const engine = await freshDb();
  const { tableId, nameId, ageId, flagId } = await sampleTable(engine);

  let before = dumpDb(engine);
  const renamed = await tables.renameColumn(engine, tableId, nameId, { name: '성명' });
  assert.equal(tables.list(engine)[0]?.columns.find((c) => c.id === nameId)?.name, '성명');
  await assertUndoRestores(engine, before, renamed.cmd);

  before = dumpDb(engine);
  const reordered = await tables.reorderColumns(engine, tableId, {
    orderedIds: [flagId, nameId, ageId],
  });
  assert.deepEqual(
    tables
      .list(engine)[0]
      ?.columns.filter((c) => c.deletedAt === null)
      .map((c) => c.id),
    [flagId, nameId, ageId],
  );
  await assertUndoRestores(engine, before, reordered.cmd);
  await assert.rejects(
    tables.reorderColumns(engine, tableId, { orderedIds: [flagId, nameId] }),
    (e) => e instanceof AppError && e.code === 'E_DB_QUERY',
  );

  before = dumpDb(engine);
  const deleted = await tables.softDeleteColumn(engine, tableId, ageId, {
    now: '2026-09-20T00:00:00.000Z',
  });
  const afterDelete = tables.list(engine)[0];
  assert.equal(
    afterDelete?.columns.find((c) => c.id === ageId)?.deletedAt,
    '2026-09-20T00:00:00.000Z',
  );
  assert.ok(
    engine
      .exec('SELECT name FROM pragma_table_info(?)', [tableId])
      .rows.some((r) => r[0] === ageId),
    '물리 열은 남는다',
  );
  await assert.rejects(
    tables.softDeleteColumn(engine, tableId, ageId),
    (e) => e instanceof AppError && e.code === 'E_DB_QUERY',
  );
  await assertUndoRestores(engine, before, deleted.cmd);

  // 삭제된 열 이름으로 새 열을 만든 뒤 복원하면 이름 충돌로 거부된다.
  const added = await tables.addColumn(engine, tableId, { name: '나이', type: 'integer' });
  await assert.rejects(
    tables.restoreColumn(engine, tableId, ageId),
    (e) => e instanceof AppError && e.code === 'E_NAME_INVALID',
  );
  await applyCommand(engine, added.cmd, 'undo');
  before = dumpDb(engine);
  const restored = await tables.restoreColumn(engine, tableId, ageId);
  assert.equal(tables.list(engine)[0]?.columns.find((c) => c.id === ageId)?.deletedAt, null);
  await assertUndoRestores(engine, before, restored.cmd);
  await engine.close();
});

test('changeColumnType: text → integer(null 정책), 되돌리기로 완전 복원, 진행률', async () => {
  const engine = await freshDb();
  const { tableId, ageId } = await sampleTable(engine);
  const before = dumpDb(engine);
  /** @type {Array<{ phase: string, done: number, total: number }>} */
  const progress = [];
  const changed = await tables.changeColumnType(
    engine,
    tableId,
    ageId,
    { type: 'integer', policy: 'null' },
    { progress: (p) => progress.push(p) },
  );
  assert.equal(changed.result.affected, 5, '변환 3행 + 메타 문장 2건(소프트 삭제, 새 열 등록)');
  assert.equal(changed.result.nulled, 1, "'unknown' 하나가 NULL이 된다");
  assert.deepEqual(progress.at(0), { phase: 'convert', done: 0, total: 3 });
  assert.deepEqual(progress.at(-1), { phase: 'convert', done: 3, total: 3 });

  const table = tables.list(engine)[0];
  const live = table?.columns.filter((c) => c.deletedAt === null) ?? [];
  const newCol = live.find((c) => c.id === changed.columnId);
  assert.ok(newCol);
  assert.equal(newCol.type, 'integer');
  assert.equal(newCol.name, '나이');
  assert.equal(
    table?.columns.find((c) => c.id === ageId)?.deletedAt !== null,
    true,
    '옛 열은 소프트 삭제',
  );
  assert.deepEqual(
    engine.exec(`SELECT "${changed.columnId}", "${ageId}" FROM "${tableId}" ORDER BY id`).rows,
    [
      [30, '30'],
      [25, '25'],
      [null, 'unknown'],
    ],
    '원본 열의 값은 그대로 남는다',
  );
  await assertUndoRestores(engine, before, changed.cmd);
  await engine.close();
});

test('changeColumnType: id가 0 이하인 행도 빠짐없이 변환된다', async () => {
  // 변환 복사는 "id > 마지막 id"로 청크를 넘긴다. 시작값을 0으로 두면 rowid를 명시해 넣은
  // 0·음수 행이 통째로 건너뛰어지고, 옛 열은 소프트 삭제되므로 값이 조용히 사라진다.
  const engine = await freshDb();
  const { tableId } = await tables.create(engine, { name: '수입' });
  const { columnId } = await tables.addColumn(engine, tableId, { name: '금액', type: 'text' });
  await engine.transaction(() => {
    const stmt = engine.prepareCached(
      `INSERT INTO "${tableId}" ("id", "${columnId}") VALUES (?, ?)`,
    );
    for (const [id, value] of [
      [-2, '11'],
      [0, '22'],
      [1, '33'],
    ]) {
      engine.run(stmt, [id, value]);
    }
  });

  const changed = await tables.changeColumnType(engine, tableId, columnId, { type: 'integer' });
  assert.deepEqual(
    engine.exec(`SELECT "id", "${changed.columnId}" FROM "${tableId}" ORDER BY "id"`).rows,
    [
      [-2, 11],
      [0, 22],
      [1, 33],
    ],
  );
  assert.equal(changed.result.affected, 5, '변환 3행 + 메타 문장 2건');
  assert.equal(changed.result.nulled, 0);
  await engine.close();
});

test('changeColumnType: abort 정책은 변환 실패 값에서 E_VALUE_INVALID로 롤백(원상복구)', async () => {
  const engine = await freshDb();
  const { tableId, ageId } = await sampleTable(engine);
  const before = dumpDb(engine);
  await assert.rejects(
    tables.changeColumnType(engine, tableId, ageId, { type: 'integer', policy: 'abort' }),
    (e) =>
      e instanceof AppError &&
      e.code === 'E_VALUE_INVALID' &&
      /** @type {{ rowId: number, preview: string }} */ (e.detail).rowId === 3 &&
      /** @type {{ rowId: number, preview: string }} */ (e.detail).preview === 'unknown',
  );
  assert.deepEqual(dumpDb(engine), before, '트랜잭션 롤백으로 원상복구');
  await engine.close();
});

test('changeColumnType: 취소 신호가 켜지면 E_IMPORT_CANCELLED로 롤백', async () => {
  const engine = await freshDb();
  const { tableId, nameId } = await sampleTable(engine);
  // 12,000행(청크 5,000 × 3)을 넣어 청크 사이에서 취소가 확인되게 한다.
  const rows = Array.from({ length: 12_000 }, (_, i) => [`r${i}`]);
  await engine.runBatch(`INSERT INTO "${tableId}" ("${nameId}") VALUES (?)`, rows.slice(0, 6_000));
  await engine.runBatch(`INSERT INTO "${tableId}" ("${nameId}") VALUES (?)`, rows.slice(6_000));
  const before = dumpDb(engine);
  const controller = new AbortController();
  /** @type {number[]} */
  const seen = [];
  await assert.rejects(
    tables.changeColumnType(
      engine,
      tableId,
      nameId,
      { type: 'longtext' },
      {
        signal: controller.signal,
        progress: (p) => {
          seen.push(p.done);
          if (p.done >= 5_000) controller.abort();
        },
      },
    ),
    (e) => e instanceof AppError && e.code === 'E_IMPORT_CANCELLED',
  );
  assert.ok(seen.includes(5_000), '첫 청크 뒤 진행률을 보고했다');
  assert.deepEqual(dumpDb(engine), before, '취소 뒤 잔여물이 없다');
  await engine.close();
});

test('changeColumnType: select로 바꾸면 choices 밖 값은 NULL, 다른 타입 조합도 왕복', async () => {
  const engine = await freshDb();
  const { tableId, nameId, flagId } = await sampleTable(engine);
  const toSelect = await tables.changeColumnType(engine, tableId, nameId, {
    type: 'select',
    options: { choices: ['홍길동', '김철수'] },
  });
  assert.equal(toSelect.result.nulled, 1);
  assert.deepEqual(
    engine.exec(`SELECT "${toSelect.columnId}" FROM "${tableId}" ORDER BY id`).rows,
    [['홍길동'], ['김철수'], [null]],
  );
  const toText = await tables.changeColumnType(engine, tableId, flagId, { type: 'text' });
  assert.deepEqual(engine.exec(`SELECT "${toText.columnId}" FROM "${tableId}" ORDER BY id`).rows, [
    ['1'],
    ['0'],
    [null],
  ]);
  await assert.rejects(
    tables.changeColumnType(engine, tableId, nameId, { type: 'text' }),
    (e) => e instanceof AppError && e.code === 'E_DB_QUERY',
    '이미 소프트 삭제된 열은 바꿀 수 없다',
  );
  await engine.close();
});

test('외부 파일에서 등록한 테이블(strict = 0)은 스키마 변경을 거부한다', async () => {
  const engine = await openWasmEngine(
    new Uint8Array(await readFile(path.join(FIXTURES, 'external.db'))),
  );
  await adoptExternal(engine, { appVersion: 'test' });
  const users = tables.list(engine).find((t) => t.id === 'users');
  assert.ok(users);
  assert.equal(users.strict, false);
  assert.deepEqual(
    users.columns.map((c) => [c.id, c.type]),
    [
      ['id', 'text'],
      ['name', 'text'],
      ['age', 'text'],
    ],
  );
  await assert.rejects(
    tables.addColumn(engine, 'users', { name: 'x', type: 'text' }),
    (e) =>
      e instanceof AppError &&
      e.code === 'E_DB_QUERY' &&
      /** @type {{ reason: string }} */ (e.detail).reason === 'external_table',
  );
  // 표시 이름 변경은 메타만 바꾸고 되돌릴 수 있으므로 읽기 전용 테이블에도 허용된다.
  await tables.rename(engine, 'users', { name: '사용자' });
  assert.equal(tables.list(engine).find((t) => t.id === 'users')?.name, '사용자');
  // 삭제는 되돌릴 수 없고 남의 파일의 데이터를 지운다. 읽기 전용 테이블에서는 막는다.
  await assert.rejects(
    tables.drop(engine, 'users'),
    (e) =>
      e instanceof AppError &&
      e.code === 'E_DB_QUERY' &&
      /** @type {{ reason: string }} */ (e.detail).reason === 'external_table',
  );
  assert.equal(
    engine.exec("SELECT count(*) FROM sqlite_master WHERE name = 'users'").rows[0]?.[0],
    1,
    '물리 테이블이 남아 있다',
  );
  assert.equal(engine.exec('SELECT count(*) FROM "users"').rows[0]?.[0], 2, '행도 그대로다');
  await engine.close();
});

test('열 상한: 물리 열이 2,000개에 이르면 E_DB_QUERY(column_limit)', async () => {
  const engine = await freshDb();
  const { tableId } = await tables.create(engine, { name: 'wide' });
  // 메타를 직접 채워 상한 직전 상태를 만든다(ALTER 2,000번은 느리다).
  await engine.transaction(() => {
    const stmt = engine.prepareCached(
      'INSERT INTO _jdr_columns (id, table_id, name, type, position, width) VALUES (?, ?, ?, ?, ?, 160)',
    );
    for (let i = 0; i < MAX_COLUMNS - SYSTEM_COLUMNS.length; i += 1) {
      engine.run(stmt, [`c_${String(i).padStart(8, '0')}`, tableId, `col${i}`, 'text', i]);
    }
  });
  await assert.rejects(
    tables.addColumn(engine, tableId, { name: 'one more', type: 'text' }),
    (e) =>
      e instanceof AppError &&
      e.code === 'E_DB_QUERY' &&
      /** @type {{ reason: string }} */ (e.detail).reason === 'column_limit',
  );
  await engine.close();
});

test('addColumn: select 항목 수 상한을 넘으면 거부한다', async () => {
  // 상한이 없으면 가져오기가 열의 모든 고유값을 선택지로 만들 수 있고, 그 목록이
  // `_jdr_columns.options`에 JSON으로 들어가 스키마를 읽을 때마다 파싱된다.
  const engine = await freshDb();
  const { tableId } = await tables.create(engine, { name: 'T' });
  const tooMany = Array.from({ length: tables.MAX_SELECT_CHOICES + 1 }, (_, i) => `항목${i}`);
  await assert.rejects(
    tables.addColumn(engine, tableId, {
      name: '많음',
      type: 'select',
      options: { choices: tooMany },
    }),
    (err) =>
      err instanceof AppError &&
      err.code === 'E_VALUE_INVALID' &&
      /** @type {{ reason?: string }} */ (err.detail ?? {}).reason === 'too_many_choices',
  );
  // 상한까지는 받는다.
  const ok = await tables.addColumn(engine, tableId, {
    name: '딱맞음',
    type: 'select',
    options: { choices: tooMany.slice(0, tables.MAX_SELECT_CHOICES) },
  });
  assert.ok(ok.columnId);
  await engine.close();
});
