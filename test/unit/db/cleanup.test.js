// @ts-check
/**
 * 데이터베이스 정리(D-17, Step 13): wasm 엔진에 대해 `cleanup-contract.js`를 돌리고, 엔진과 무관한 순수 부분
 * (`purgeCommand`, `physicalColumns`의 거부 규칙)을 검사한다. 같은 계약은 `npm run test:native`가 rusqlite 엔진에 대해 돌린다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as cleanup from '../../../src/db/cleanup.js';
import { migrate } from '../../../src/db/schema.js';
import * as tables from '../../../src/db/tables.js';
import { AppError } from '../../../src/util/errors.js';
import { defineCleanupContract } from './cleanup-contract.js';
import { openWasmEngine } from './helpers.js';

defineCleanupContract('wasm', openWasmEngine);

test('purgeCommand: 되돌릴 수 없는 column.purge, 시스템 열은 거부, 인덱스 없는 테이블은 트리거 문장이 없다', async () => {
  const engine = await openWasmEngine();
  await migrate(engine, { appVersion: 'test' });
  const { tableId } = await tables.create(engine, {
    name: '표',
    columns: [
      { name: 'a', type: 'text' },
      { name: 'b', type: 'integer' },
    ],
  });
  const table = tables.requireTable(engine, tableId);
  const target = { ...table, physical: cleanup.physicalColumns(engine, tableId) };
  const b = table.columns[1]?.id ?? '';
  const cmd = cleanup.purgeCommand(target, [b]);
  assert.equal(cmd.type, 'column.purge');
  assert.equal(cmd.irreversible, true);
  assert.deepEqual(cmd.undo, []);
  assert.ok(cmd.do.every((s) => !('sql' in s) || !/TRIGGER|fts5/.test(s.sql)));
  assert.match(cmd.summary, /표: b$/);
  assert.throws(
    () => cleanup.purgeCommand(target, ['id']),
    (err) => err instanceof AppError && err.code === 'E_SYSTEM_COLUMN',
  );
  await engine.close();
});

test('physicalColumns: 이 앱이 만들지 않은 형태(기본값, 복합 기본 키)는 E_DB_QUERY', async () => {
  const engine = await openWasmEngine();
  await engine.transaction(() => {
    engine.run("CREATE TABLE d (id INTEGER PRIMARY KEY, s TEXT DEFAULT 'x') STRICT");
    engine.run('CREATE TABLE k (a INTEGER, b INTEGER, PRIMARY KEY (a, b)) STRICT');
  });
  for (const name of ['d', 'k']) {
    assert.throws(
      () => cleanup.physicalColumns(engine, name),
      (err) => err instanceof AppError && err.code === 'E_DB_QUERY',
    );
  }
  await engine.close();
});

test('vacuum(wasm): 트랜잭션 안에서는 E_DB_QUERY', async () => {
  const engine = await openWasmEngine();
  await assert.rejects(
    engine.transaction(() => engine.vacuum()),
    (err) => err instanceof AppError && err.code === 'E_DB_QUERY',
  );
  engine.vacuum();
  await engine.close();
});
