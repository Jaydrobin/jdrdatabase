// @ts-check
/**
 * 히스토리(Step 5): apply → undo → redo가 DB와 저널을 함께 되돌리고, 상한·되돌릴 수 없는 커맨드·
 * 실패 경로·스키마 op의 유입·파일 열기 시 비움을 검사한다. 실제 wasm DB와 스토어를 쓴다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { editCell, insertRows } from '../../../src/app/commands.js';
import { createHistory, HISTORY_LIMIT } from '../../../src/app/history.js';
import { createStore } from '../../../src/app/store.js';
import { createClient, createInlineTransport } from '../../../src/db/client.js';
import { createAutosave } from '../../../src/io/autosave.js';
import { gunzip, gzip, gzipSupported, isGzip } from '../../../src/io/filesystem.js';
import { createMemoryIdb } from '../../../src/io/idb.js';
import { createTabLock } from '../../../src/io/tablock.js';
import { AppError } from '../../../src/util/errors.js';
import { loadWasmBinary } from '../db/helpers.js';

/** @typedef {import('../../../src/db/command.js').Command} Command */

const NOW = '2026-09-20T00:00:00.000Z';

async function setup() {
  const client = createClient({ transport: createInlineTransport() });
  const init = await client.call('engine.init', {
    mode: 'wasm',
    wasmBinary: await loadWasmBinary(),
    appVersion: 'test',
  });
  const idb = createMemoryIdb();
  const autosave = createAutosave({ idb });
  /** @type {Array<{ kind: 'error' | 'info' | 'warn', value: string }>} */
  const notices = [];
  const notify = {
    /** @param {{ code: string }} err */
    error: (err) => notices.push({ kind: 'error', value: err.code }),
    /** @param {string} key */
    info: (key) => notices.push({ kind: 'info', value: key }),
    /** @param {string} key */
    warn: (key) => notices.push({ kind: 'warn', value: key }),
  };
  const store = createStore({
    client,
    caps: init.capabilities,
    fs: {
      pickOpen: async () => null,
      pickSaveAs: async () => ({ kind: 'cancelled' }),
      readAll: async (source) =>
        source instanceof File ? new Uint8Array(await source.arrayBuffer()) : new Uint8Array(0),
      write: async () => {},
      download: () => {},
      ensurePermission: async () => {},
      openSink: async () => ({
        write: async () => {},
        close: async () => {},
        abort: async () => {},
      }),
      gzip,
      gunzip,
      isGzip,
      gzipSupported,
    },
    idb,
    autosave,
    tablock: createTabLock(),
    prompts: {
      discardUnsaved: async () => true,
      adoptExternal: async () => true,
      largeFile: async () => true,
      revisionBehind: async () => true,
      journalRecover: async () => 'discard',
      journalMismatch: async () => 'discard',
      originalChanged: async () => 'cancel',
      workcopyRecover: async () => 'discard',
    },
    notify,
    deviceName: '테스트',
    defaultFileName: 'database.db',
  });
  await store.newDatabase({ force: true });
  const history = createHistory({ client, store, notify });
  const { tableId } = await client.call('schema.create', { name: '고객' });
  const name = (await client.call('schema.addColumn', { tableId, name: '이름', type: 'text' }))
    .columnId;
  await store.refreshTables();
  /** @param {number} rowId */
  const cellOf = async (rowId) =>
    (await client.call('query.row', { tableId, rowId }))?.row?.cells[name] ?? null;
  return { client, store, history, autosave, notices, tableId, name, cellOf };
}

test('apply → undo → redo: DB가 되돌아가고 저널에는 역커맨드가 쌓인다', async () => {
  const { client, store, history, autosave, tableId, name, cellOf } = await setup();
  const dbId = store.getState().meta.db_id ?? '';
  const insert = insertRows({ tableId, count: 1, firstId: 1, now: NOW });
  assert.ok(await history.apply(insert));
  const edit = editCell({
    tableId,
    rowId: 1,
    colId: name,
    oldValue: null,
    newValue: '하나',
    oldUpdatedAt: NOW,
    now: NOW,
  });
  assert.ok(await history.apply(edit));
  assert.deepEqual(history.state(), { undo: 2, redo: 0, busy: false });
  assert.equal(await cellOf(1), '하나');

  assert.equal(await history.undo(), true);
  assert.equal(await cellOf(1), null);
  assert.deepEqual(history.state(), { undo: 1, redo: 1, busy: false });
  assert.equal(await history.redo(), true);
  assert.equal(await cellOf(1), '하나');
  assert.deepEqual(history.state(), { undo: 2, redo: 0, busy: false });
  assert.equal(await history.redo(), false, '다시 실행할 것이 없다');

  // 저널: insert, edit, undo(edit), redo(edit). 새 DB에 재생하면 같은 상태가 된다.
  const journal = await autosave.recoverable(dbId);
  assert.equal(journal?.commands.length, 4);
  assert.equal(journal?.commands[2]?.summary, `undo ${edit.summary}`);
  const replayClient = createClient({ transport: createInlineTransport() });
  await replayClient.call('engine.init', { mode: 'wasm', wasmBinary: await loadWasmBinary() });
  await replayClient.call('db.open', {});
  await replayClient.call('schema.create', { name: '고객' });
  // 같은 물리 이름을 쓰도록 메타를 맞춘다(재생 대상 DB는 같은 파일이므로 실제로는 이미 같다).
  const { tables: created } = await replayClient.call('schema.list');
  const replayTable = created[0];
  assert.ok(replayTable);
  await replayClient.call('command.apply', {
    cmd: {
      type: 'test.rename',
      tableId: null,
      do: [
        { sql: `ALTER TABLE "${replayTable.id}" RENAME TO "${tableId}"` },
        { sql: 'UPDATE _jdr_tables SET id = ? WHERE id = ?', params: [tableId, replayTable.id] },
      ],
      undo: [],
      summary: '',
    },
  });
  await replayClient.call('schema.addColumn', { tableId, name: '이름', type: 'text' });
  const { tables: after } = await replayClient.call('schema.list');
  const col = after[0]?.columns[0];
  assert.ok(col);
  await replayClient.call('command.apply', {
    cmd: {
      type: 'test.rename',
      tableId: null,
      do: [
        { sql: `ALTER TABLE "${tableId}" RENAME COLUMN "${col.id}" TO "${name}"` },
        { sql: 'UPDATE _jdr_columns SET id = ? WHERE id = ?', params: [name, col.id] },
      ],
      undo: [],
      summary: '',
    },
  });
  await autosave.replay(replayClient, journal?.commands ?? []);
  assert.equal(
    (await replayClient.call('query.row', { tableId, rowId: 1 })).row?.cells[name],
    '하나',
  );
  replayClient.close();
  client.close();
});

test('스키마 op의 커맨드는 스토어 알림으로 히스토리에 들어오고 되돌릴 수 있다', async () => {
  const { client, store, history, tableId } = await setup();
  assert.deepEqual(
    history.state(),
    { undo: 0, redo: 0, busy: false },
    '테이블 생성 뒤 refreshTables 전에 만든 히스토리는 비어 있다',
  );
  await store.runSchemaOp('schema.addColumn', { tableId, name: '나이', type: 'integer' });
  assert.equal(history.state().undo, 1);
  assert.equal(store.getState().tables[0]?.columns.length, 2);
  assert.equal(await history.undo(), true);
  assert.equal(store.getState().tables[0]?.columns.length, 1, '되돌리기 뒤 목록을 다시 읽는다');
  assert.equal(await history.redo(), true);
  assert.equal(store.getState().tables[0]?.columns.length, 2);
  client.close();
});

test('"+ 열" 직후의 이름 확정(mergeWithAdd)은 열 추가와 한 항목: 되돌리기 한 번에 열이 사라지고 저널에는 역커맨드가 남는다(D-16)', async () => {
  const { client, store, history, autosave, tableId } = await setup();
  const columns = () => (store.getState().tables[0]?.columns ?? []).map((c) => c.name);
  const added = await store.addDefaultColumn(tableId);
  assert.ok(added);
  assert.equal(
    await store.renameColumn(tableId, added.columnId, '메모', { mergeWithAdd: true }),
    true,
  );
  assert.deepEqual(columns(), ['이름', '메모']);
  assert.equal(history.state().undo, 1, '추가와 이름이 한 항목');
  assert.equal(await history.undo(), true);
  assert.deepEqual(columns(), ['이름'], '되돌리기 한 번에 열이 사라진다');
  assert.equal(await history.redo(), true);
  assert.deepEqual(columns(), ['이름', '메모']);
  assert.equal(await history.undo(), true);

  // 저널: add, rename, 합친 항목의 역(되돌리기), 합친 항목(다시 실행), 다시 역. 재생은 do 방향이므로 열이 없다.
  const dbId = store.getState().meta.db_id ?? '';
  const journal = (await autosave.recoverable(dbId))?.commands.slice(-5) ?? [];
  assert.deepEqual(
    journal.map((c) => c.type),
    ['column.add', 'column.rename', 'column.add', 'column.add', 'column.add'],
  );
  assert.deepEqual(
    journal.map((c) => c.summary.startsWith('undo ')),
    [false, false, true, false, true],
  );

  // 표시가 없는 이름 바꾸기(머리글 더블클릭·사이드바)는 합치지 않는다.
  const again = await store.addDefaultColumn(tableId);
  assert.ok(again);
  const undoBefore = history.state().undo;
  await store.renameColumn(tableId, again.columnId, '비고');
  assert.equal(history.state().undo, undoBefore + 1);
  // 맨 위가 열 추가가 아니면 표시가 있어도 따로 쌓는다.
  await store.renameColumn(tableId, again.columnId, '비고2', { mergeWithAdd: true });
  assert.equal(history.state().undo, undoBefore + 2);
  client.close();
});

test('이름 확정이 끝나기 전에 누른 되돌리기는 확정이 히스토리에 들어간 뒤에 돈다: 합친 항목을 되돌리고 다시 실행하면 이름까지 돌아온다(D-16)', async () => {
  const { client, store, history, tableId } = await setup();
  const columns = () => (store.getState().tables[0]?.columns ?? []).map((c) => c.name);
  const added = await store.addDefaultColumn(tableId);
  assert.ok(added);
  const undoBefore = history.state().undo;
  // 머리글 이름 편집기의 포커스 이탈 확정(pointerdown) 직후 도구 모음의 되돌리기(click)가 오는 순서.
  const renaming = store.renameColumn(tableId, added.columnId, '메모', { mergeWithAdd: true });
  const undone = history.undo();
  assert.equal(await renaming, true);
  assert.equal(await undone, true);
  assert.deepEqual(columns(), ['이름'], '되돌리기 한 번에 열이 사라진다');
  assert.deepEqual(
    history.state(),
    { undo: undoBefore - 1, redo: 1, busy: false },
    '없는 열의 이름 바꾸기가 스택에 남지 않고, 다시 실행할 항목이 있다',
  );
  assert.equal(await history.redo(), true);
  assert.deepEqual(columns(), ['이름', '메모'], '다시 실행하면 이름까지 돌아온다');
  client.close();
});

test('mergeWithAdd는 스택 맨 위의 열 추가가 같은 열일 때만 합친다', async () => {
  const { client, store, history, tableId } = await setup();
  const first = await store.addDefaultColumn(tableId);
  const second = await store.addDefaultColumn(tableId);
  assert.ok(first && second);
  const undoBefore = history.state().undo;
  // 맨 위는 두 번째 열의 추가다. 첫 번째 열의 이름을 합치면 되돌리기가 엉뚱한 열을 지운다.
  await store.renameColumn(tableId, first.columnId, '메모', { mergeWithAdd: true });
  assert.equal(history.state().undo, undoBefore + 1, '다른 열의 추가와는 합치지 않는다');
  assert.equal(await history.undo(), true);
  const names = () => (store.getState().tables[0]?.columns ?? []).map((c) => c.name);
  assert.deepEqual(names(), ['이름', '열 1', '열 2'], '이름 바꾸기만 되돌린다');
  client.close();
});

test('되돌릴 수 없는 커맨드가 들어오면 스택을 비우고, 파일을 열어도 비운다', async () => {
  const { client, store, history, tableId } = await setup();
  await history.apply(insertRows({ tableId, count: 1, firstId: 1, now: NOW }));
  assert.equal(history.state().undo, 1);
  await store.runSchemaOp('schema.drop', { tableId });
  assert.deepEqual(history.state(), { undo: 0, redo: 0, busy: false });

  const { tableId: t2 } = await client.call('schema.create', { name: '둘' });
  await store.refreshTables();
  await history.apply(insertRows({ tableId: t2, count: 1, firstId: 1, now: NOW }));
  assert.equal(history.state().undo, 1);
  await store.newDatabase({ force: true });
  assert.equal(history.state().undo, 0);
  client.close();
});

test('상한 200개: 넘치면 가장 오래된 것부터 버린다', async () => {
  const { client, history, tableId } = await setup();
  for (let i = 0; i < HISTORY_LIMIT + 5; i += 1) {
    history.push(insertRows({ tableId, count: 1, firstId: i + 1, now: NOW }));
  }
  assert.equal(history.state().undo, HISTORY_LIMIT);
  client.close();
});

test('실패한 apply·undo는 알리고 히스토리에서 빠지며 DB는 그대로다', async () => {
  const { client, store, history, notices, tableId, name, cellOf } = await setup();
  await history.apply(insertRows({ tableId, count: 1, firstId: 1, now: NOW }));
  /** @type {Command} */
  const bad = {
    type: 'cell.edit',
    tableId,
    do: [
      { sql: `UPDATE "${tableId}" SET "${name}" = ? WHERE "id" = ?`, params: ['값', 1] },
      { sql: 'INSERT INTO nope VALUES (1)' },
    ],
    undo: [{ sql: `UPDATE "${tableId}" SET "${name}" = ? WHERE "id" = ?`, params: [null, 1] }],
    summary: 'bad',
  };
  let refreshes = 0;
  store.on('data:changed', () => {
    refreshes += 1;
  });
  assert.equal(await history.apply(bad), null);
  assert.equal(notices.at(-1)?.value, 'E_DB_QUERY');
  assert.equal(await cellOf(1), null, '트랜잭션이 롤백되어 값이 바뀌지 않았다');
  assert.equal(history.state().undo, 1);
  assert.equal(refreshes, 1, '그리드가 다시 읽게 한다');

  // undo가 실패하는 커맨드(undo 문장이 틀림): 스택에서 빠지고 DB는 그대로.
  /** @type {Command} */
  const badUndo = {
    type: 'cell.edit',
    tableId,
    do: [{ sql: `UPDATE "${tableId}" SET "${name}" = ? WHERE "id" = ?`, params: ['값', 1] }],
    undo: [{ sql: 'UPDATE nope SET x = 1' }],
    summary: 'badUndo',
  };
  await history.apply(badUndo);
  assert.equal(await cellOf(1), '값');
  assert.equal(await history.undo(), false);
  assert.equal(await cellOf(1), '값');
  assert.equal(history.state().undo, 1);
  client.close();
});

test('읽기 전용이면 apply·undo를 하지 않고 안내한다', async () => {
  const { client, store, history, notices, tableId } = await setup();
  await history.apply(insertRows({ tableId, count: 1, firstId: 1, now: NOW }));
  // 다른 탭이 잠근 상황을 흉내 내기 어렵다. 앱보다 새 schema_version 파일을 여는 대신 상태만 만든다.
  const snap = await client.call('db.snapshot', { bumpRevision: false });
  await client.call('command.apply', {
    cmd: {
      type: 'test.newer',
      tableId: null,
      do: [{ sql: "UPDATE _jdr_meta SET value = '999' WHERE key = 'schema_version'" }],
      undo: [],
      summary: '',
    },
  });
  const newer = await client.call('db.snapshot', { bumpRevision: false });
  const file = new File([newer.bytes], 'newer.db');
  await store.openPicked({ name: 'newer.db', file, handle: null });
  assert.equal(store.getState().readOnly, 'newerSchema');
  assert.equal(await history.apply(insertRows({ tableId, count: 1, firstId: 2, now: NOW })), null);
  assert.equal(notices.at(-1)?.value, 'file.readOnlyBlocked');
  assert.equal(await history.undo(), false);
  void snap;
  client.close();
});

test('적용이 도는 중에 눌린 되돌리기는 차례를 기다리고, 히스토리를 잃지 않는다', async () => {
  const { client, history, notices, tableId, name, cellOf } = await setup();
  assert.ok(await history.apply(insertRows({ tableId, count: 1, firstId: 1, now: NOW })));
  assert.ok(
    await history.apply(
      editCell({
        tableId,
        rowId: 1,
        colId: name,
        oldValue: null,
        newValue: '하나',
        oldUpdatedAt: NOW,
        now: NOW,
      }),
    ),
  );
  assert.deepEqual(history.state(), { undo: 2, redo: 0, busy: false });

  // 긴 붙여넣기가 도는 중의 Ctrl+Z. `command.apply`는 배타 op이므로 겹치면 Worker가
  // `E_DB_BUSY`로 거절하는데, 그 거절은 DB를 건드리지 않았으므로 히스토리를 버릴 이유가 없다.
  const applying = history.apply(insertRows({ tableId, count: 200, firstId: 100, now: NOW }));
  const undone = await history.undo();
  assert.ok(await applying, '붙여넣기는 그대로 적용된다');

  assert.equal(undone, true, '되돌리기는 차례를 기다렸다가 실행된다');
  assert.equal(
    notices.some((n) => n.value === 'E_DB_BUSY'),
    false,
    '히스토리가 스스로 낸 호출끼리는 겹치지 않는다',
  );
  // 적용 3건 - 되돌리기 1건 = 2. 되돌린 것은 다시 실행 스택으로 간다.
  assert.deepEqual(history.state(), { undo: 2, redo: 1, busy: false });
  assert.equal(await cellOf(1), '하나', '되돌려진 것은 마지막에 적용된 행 추가다');
  assert.equal(
    (await client.call('query.stats', { tableId })).count,
    1,
    '나중에 온 되돌리기가 붙여넣은 200행을 지웠다',
  );
  client.close();
});

test('히스토리 밖의 배타 op와 겹쳐 난 E_DB_BUSY는 되돌리기 항목을 지우지 않는다', async () => {
  const { client, store, history, notices, tableId, name, cellOf } = await setup();
  history.dispose();
  // 저장(`db.snapshot`)·스키마 op도 배타 op라 큐 밖에서 겹칠 수 있다. 그 거절은 커맨드가
  // 엔진에 닿기 전이므로 DB는 그대로이고 히스토리도 그대로여야 한다. 타이밍에 기대지 않도록
  // 되돌리기 호출 한 번만 `E_DB_BUSY`로 막는 전송을 끼운다.
  let blocked = false;
  /** @type {import('../../../src/db/client.js').Client} */
  const flaky = {
    ...client,
    call: async (op, args, options) => {
      const direction = /** @type {{ direction?: string }} */ (args)?.direction;
      if (op === 'command.apply' && !blocked && direction === 'undo') {
        blocked = true;
        throw new AppError('E_DB_BUSY', 'db.snapshot is in progress', {
          detail: { running: 'db.snapshot', requested: 'command.apply' },
        });
      }
      return client.call(op, args, options);
    },
  };
  const notify = {
    /** @param {{ code: string }} err */
    error: (err) => notices.push({ kind: 'error', value: err.code }),
    /** @param {string} key */
    info: (key) => notices.push({ kind: 'info', value: key }),
  };
  const guarded = createHistory({ client: flaky, store, notify });

  assert.ok(await guarded.apply(insertRows({ tableId, count: 1, firstId: 1, now: NOW })));
  assert.ok(
    await guarded.apply(
      editCell({
        tableId,
        rowId: 1,
        colId: name,
        oldValue: null,
        newValue: '하나',
        oldUpdatedAt: NOW,
        now: NOW,
      }),
    ),
  );
  assert.equal(guarded.state().undo, 2);

  assert.equal(await guarded.undo(), false);
  assert.equal(notices.at(-1)?.value, 'E_DB_BUSY');
  assert.equal(await cellOf(1), '하나', 'DB는 그대로다');
  assert.equal(guarded.state().undo, 2, '적용된 적 없는 실패가 되돌리기 항목을 지우지 않는다');
  assert.equal(await guarded.undo(), true, '다시 누르면 되돌아간다');
  assert.equal(await cellOf(1), null);
  guarded.dispose();
  client.close();
});

test('가져오기(import:done)는 되돌리기 스택을 비운다(Step 7: 커맨드가 아니다)', async () => {
  const { client, store, history, tableId, name } = await setup();
  const applied = await history.apply(insertRows({ tableId, count: 1, firstId: 1, now: NOW }));
  assert.ok(applied);
  assert.equal(history.state().undo, 1);
  const report = await store.importRun({
    file: new Blob(['이름\n둘\n']),
    options: { format: 'csv' },
    mapping: { columns: [{ source: 0, columnId: name }] },
    target: { kind: 'existing', tableId },
  });
  assert.equal(report?.inserted, 1);
  assert.deepEqual(history.state(), { undo: 0, redo: 0, busy: false });
  assert.equal(await history.undo(), false, '비어 있으니 되돌릴 것이 없다');
  assert.equal((await client.call('query.count', { tableId, viewSpec: {} })).count, 2);
  client.close();
});
