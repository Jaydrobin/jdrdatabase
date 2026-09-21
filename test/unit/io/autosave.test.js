// @ts-check
/**
 * 저널(D-04 3층): 기록·복구 요약·비움·dbId 전환·용량 상한·재생.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createClient, createInlineTransport } from '../../../src/db/client.js';
import { createAutosave, JOURNAL_LIMIT_BYTES } from '../../../src/io/autosave.js';
import { createMemoryIdb } from '../../../src/io/idb.js';
import { MB } from '../../../src/util/bytes.js';
import { loadWasmBinary } from '../db/helpers.js';

/** @typedef {import('../../../src/db/command.js').Command} Command */

/**
 * @param {string} table
 * @param {string} value
 * @returns {Command}
 */
function insertCmd(table, value) {
  return {
    type: 'row.insert',
    tableId: table,
    do: [{ sql: `INSERT INTO ${table} (s) VALUES (?)`, params: [value] }],
    undo: [{ sql: `DELETE FROM ${table} WHERE s = ?`, params: [value] }],
    summary: `insert ${value}`,
  };
}

test('recordCommand → recoverable → clear', async () => {
  const idb = createMemoryIdb();
  const autosave = createAutosave({ idb });
  assert.equal(
    await autosave.recordCommand(insertCmd('t', 'x')),
    false,
    'attach 전에는 기록하지 않음',
  );
  autosave.attach({ dbId: 'db-1', baseRevision: 2, fileName: 'a.db' });
  assert.equal(await autosave.recordCommand(insertCmd('t', 'a')), true);
  assert.equal(await autosave.recordCommand(insertCmd('t', 'b')), true);

  const summary = await autosave.recoverable('db-1');
  assert.ok(summary);
  assert.equal(summary.dbId, 'db-1');
  assert.equal(summary.baseRevision, 2);
  assert.equal(summary.fileName, 'a.db');
  assert.equal(summary.truncated, false);
  assert.deepEqual(
    summary.commands.map((c) => c.summary),
    ['insert a', 'insert b'],
  );
  assert.equal(await autosave.recoverable('db-2'), null);
  assert.equal((await autosave.pending())?.dbId, 'db-1');

  await autosave.clear();
  assert.equal(await autosave.recoverable('db-1'), null);
  assert.equal(await autosave.pending(), null);
});

test('다른 dbId의 기록이 시작되면 이전 기록은 지운다', async () => {
  const idb = createMemoryIdb();
  const autosave = createAutosave({ idb });
  autosave.attach({ dbId: 'db-1', baseRevision: 0, fileName: null });
  await autosave.recordCommand(insertCmd('t', 'a'));
  autosave.attach({ dbId: 'db-2', baseRevision: 7, fileName: 'b.db' });
  await autosave.recordCommand(insertCmd('t', 'z'));
  assert.equal(await autosave.recoverable('db-1'), null);
  const two = await autosave.recoverable('db-2');
  assert.equal(two?.commands.length, 1);
  assert.equal(two?.baseRevision, 7);
});

test('새 인스턴스가 스토어에 남은 기록을 이어서 읽는다(순번 유지)', async () => {
  const idb = createMemoryIdb();
  const first = createAutosave({ idb });
  first.attach({ dbId: 'db-1', baseRevision: 0, fileName: null });
  await first.recordCommand(insertCmd('t', 'a'));
  const second = createAutosave({ idb });
  second.attach({ dbId: 'db-1', baseRevision: 0, fileName: null });
  await second.recordCommand(insertCmd('t', 'b'));
  const summary = await second.recoverable('db-1');
  assert.deepEqual(
    summary?.commands.map((c) => c.summary),
    ['insert a', 'insert b'],
  );
});

test('용량 상한을 넘으면 기록을 멈추고 onFull, 요약에 truncated', async () => {
  const idb = createMemoryIdb();
  let fullCalls = 0;
  const autosave = createAutosave({
    idb,
    limitBytes: 4096,
    onFull: () => {
      fullCalls += 1;
    },
  });
  autosave.attach({ dbId: 'db-1', baseRevision: 0, fileName: null });
  assert.equal(await autosave.recordCommand(insertCmd('t', 'a'.repeat(200))), true);
  assert.equal(autosave.isFull(), false);
  assert.equal(await autosave.recordCommand(insertCmd('t', 'b'.repeat(1500))), false);
  assert.equal(autosave.isFull(), true);
  assert.equal(fullCalls, 1);
  assert.equal(
    await autosave.recordCommand(insertCmd('t', 'c')),
    false,
    '상한 뒤에는 기록하지 않음',
  );
  assert.equal(fullCalls, 1, 'onFull은 한 번만');
  const summary = await autosave.recoverable('db-1');
  assert.equal(summary?.commands.length, 1);
  assert.equal(summary?.truncated, true);
  await autosave.clear();
  assert.equal(autosave.isFull(), false);
  assert.equal(JOURNAL_LIMIT_BYTES, 50 * MB);
});

test('IDB가 없으면 기록·복구 모두 조용히 없음', async () => {
  const autosave = createAutosave({ idb: null });
  autosave.attach({ dbId: 'db-1', baseRevision: 0, fileName: null });
  assert.equal(await autosave.recordCommand(insertCmd('t', 'a')), false);
  assert.equal(await autosave.recoverable('db-1'), null);
  assert.equal(await autosave.pending(), null);
});

test('replay: command.apply로 차례로 적용하고 실패 지점을 detail에 남긴다', async () => {
  const client = createClient({ transport: createInlineTransport() });
  await client.call('engine.init', { mode: 'wasm', wasmBinary: await loadWasmBinary() });
  await client.call('db.open', {});
  await client.call('command.apply', {
    cmd: {
      type: 'table.create',
      tableId: null,
      do: [{ sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT NOT NULL) STRICT' }],
      undo: [{ sql: 'DROP TABLE t' }],
      summary: 'create',
    },
  });
  const autosave = createAutosave({ idb: createMemoryIdb() });
  /** @type {Array<[number, number]>} */
  const progress = [];
  const done = await autosave.replay(
    client,
    [insertCmd('t', 'a'), insertCmd('t', 'b')],
    (d, total) => progress.push([d, total]),
  );
  assert.equal(done, 2);
  assert.deepEqual(progress, [
    [1, 2],
    [2, 2],
  ]);
  assert.deepEqual(
    (await client.call('engine.exec', { sql: 'SELECT s FROM t ORDER BY id' })).rows,
    [['a'], ['b']],
  );
  /** @type {Command} */
  const bad = {
    type: 'x',
    tableId: 't',
    do: [{ sql: 'INSERT INTO t (s) VALUES (NULL)' }],
    undo: [],
    summary: 'bad',
  };
  await assert.rejects(
    autosave.replay(client, [insertCmd('t', 'c'), bad]),
    (e) =>
      e instanceof Error &&
      'detail' in e &&
      /** @type {{ index: number }} */ (e.detail).index === 1,
  );
  client.close();
});

test('suspend: 기록을 멈추고 truncated로 표시하며 clear가 풀어 준다(가져오기 뒤, Step 7)', async () => {
  const idb = createMemoryIdb();
  let fullCalls = 0;
  const autosave = createAutosave({
    idb,
    onFull: () => {
      fullCalls += 1;
    },
  });
  autosave.attach({ dbId: 'db-1', baseRevision: 0, fileName: null });
  assert.equal(await autosave.recordCommand(insertCmd('t', 'a')), true);
  await autosave.suspend();
  assert.equal(autosave.isFull(), true);
  assert.equal(fullCalls, 1);
  assert.equal(
    await autosave.recordCommand(insertCmd('t', 'b')),
    false,
    '정지 뒤에는 기록하지 않음',
  );
  const summary = await autosave.recoverable('db-1');
  assert.equal(summary?.truncated, true);
  assert.deepEqual(
    summary?.commands.map((c) => c.summary),
    ['insert a'],
    '정지 전 기록은 남는다',
  );
  await autosave.suspend();
  assert.equal(fullCalls, 1, '이미 멈춘 상태에서는 다시 알리지 않는다');
  await autosave.clear();
  assert.equal(autosave.isFull(), false);
  assert.equal(await autosave.recordCommand(insertCmd('t', 'c')), true, '저장(clear) 뒤 다시 기록');
  assert.equal((await autosave.recoverable('db-1'))?.truncated, false);

  // 기록이 하나도 없는 채로 멈춰도 같은 dbId의 다음 기록은 정지 상태를 본다.
  const fresh = createAutosave({ idb: createMemoryIdb() });
  fresh.attach({ dbId: 'db-2', baseRevision: 0, fileName: null });
  await fresh.suspend();
  assert.equal(await fresh.recordCommand(insertCmd('t', 'x')), false);
});
