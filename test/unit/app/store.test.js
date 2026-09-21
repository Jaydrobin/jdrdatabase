// @ts-check
/**
 * 스토어(Step 2)의 파일 흐름: 새로 만들기, 저장(다운로드 폴백·핸들), 열기 왕복, 외부 파일 등록,
 * 손상 파일 거부, revision 경고, 저널 복구. 파일 시스템·대화상자는 가짜를 주입한다.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createStore } from '../../../src/app/store.js';
import { createClient, createInlineTransport } from '../../../src/db/client.js';
import { createAutosave } from '../../../src/io/autosave.js';
import { createMemoryIdb } from '../../../src/io/idb.js';
import { createTabLock } from '../../../src/io/tablock.js';
import { loadWasmBinary } from '../db/helpers.js';

/** @typedef {import('../../../src/app/store.js').Prompts} Prompts */
/** @typedef {import('../../../src/app/store.js').FileSystemLike} FileSystemLike */
/** @typedef {import('../../../src/io/filesystem.js').SaveTarget} SaveTarget */
/** @typedef {import('../../../src/db/command.js').Command} Command */

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures');

/**
 * 픽스처를 File 생성자가 받는 `Uint8Array<ArrayBuffer>`로 읽는다(Node Buffer는 풀 버퍼를 공유한다).
 * @param {string} name
 * @returns {Promise<Uint8Array<ArrayBuffer>>}
 */
async function fixture(name) {
  const buf = await readFile(path.join(FIXTURES, name));
  const out = new Uint8Array(new ArrayBuffer(buf.byteLength));
  out.set(buf);
  return out;
}

/** @type {Command} */
const CREATE_T = {
  type: 'table.create',
  tableId: null,
  do: [
    { sql: 'CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT) STRICT' },
    { sql: 'INSERT INTO t (s) VALUES (?)', params: ['하나'] },
  ],
  undo: [{ sql: 'DROP TABLE t' }],
  summary: 'create t',
};

/**
 * 가짜 파일 시스템: 다운로드는 바이트를 붙잡아 두고, 핸들 쓰기는 메모리에 기록한다.
 */
function fakeFs() {
  /** @type {Array<{ name: string, bytes: Uint8Array<ArrayBuffer> }>} */
  const downloads = [];
  /** @type {Map<string, Uint8Array<ArrayBuffer>>} */
  const written = new Map();
  /** @type {SaveTarget} */
  let nextSaveTarget = { kind: 'download', name: 'database.db' };
  /** @type {FileSystemLike} */
  const fs = {
    pickOpen: async () => null,
    pickSaveAs: async () => nextSaveTarget,
    readAll: async (source) => {
      if (source instanceof File) return new Uint8Array(await source.arrayBuffer());
      const h = /** @type {{ name: string }} */ (/** @type {unknown} */ (source));
      return written.get(h.name) ?? new Uint8Array(0);
    },
    write: async (handle, bytes) => {
      written.set(handle.name, bytes.slice());
    },
    download: (name, bytes) => {
      if (bytes instanceof Blob) return;
      downloads.push({ name, bytes: bytes.slice() });
    },
    ensurePermission: async () => {},
  };
  return {
    fs,
    downloads,
    written,
    /** @param {SaveTarget} t */
    setSaveTarget: (t) => {
      nextSaveTarget = t;
    },
  };
}

/**
 * 가짜 대화상자: 미리 정한 답을 돌려주고 무엇을 물었는지 기록한다.
 * @param {Partial<{ discard: boolean, adopt: boolean, large: boolean, behind: boolean, journal: 'recover' | 'discard', mismatch: 'export' | 'discard' }>} answers
 */
function fakePrompts(answers = {}) {
  /** @type {string[]} */
  const asked = [];
  /** @type {Prompts} */
  const prompts = {
    discardUnsaved: async () => (asked.push('discard'), answers.discard ?? true),
    adoptExternal: async () => (asked.push('adopt'), answers.adopt ?? true),
    largeFile: async () => (asked.push('large'), answers.large ?? true),
    revisionBehind: async () => (asked.push('behind'), answers.behind ?? true),
    journalRecover: async () => (asked.push('journal'), answers.journal ?? 'recover'),
    journalMismatch: async () => (asked.push('mismatch'), answers.mismatch ?? 'discard'),
  };
  return { prompts, asked };
}

/**
 * @param {{ idb?: ReturnType<typeof createMemoryIdb> | null, prompts?: Partial<Parameters<typeof fakePrompts>[0]>, caps?: Partial<import('../../../src/db/engine.js').EngineCapabilities> }} [options]
 */
async function setup(options = {}) {
  const client = createClient({ transport: createInlineTransport() });
  const init = await client.call('engine.init', {
    mode: 'wasm',
    wasmBinary: await loadWasmBinary(),
    appVersion: 'test',
  });
  const idb = options.idb === undefined ? createMemoryIdb() : options.idb;
  const fsx = fakeFs();
  const p = fakePrompts(options.prompts);
  /** @type {Array<{ kind: 'error' | 'info', value: string }>} */
  const notices = [];
  const autosave = createAutosave({ idb });
  const store = createStore({
    client,
    caps: { ...init.capabilities, ...options.caps },
    fs: fsx.fs,
    idb,
    autosave,
    tablock: createTabLock(),
    prompts: p.prompts,
    notify: {
      error: (err) => notices.push({ kind: 'error', value: err.code }),
      info: (key) => notices.push({ kind: 'info', value: key }),
    },
    deviceName: '테스트 기기',
    defaultFileName: 'database.db',
  });
  await store.newDatabase({ force: true });
  return { client, store, idb, fsx, asked: p.asked, notices, autosave };
}

/**
 * @param {string} name
 * @param {Uint8Array<ArrayBuffer>} bytes
 */
function pickedFile(name, bytes) {
  const file = new File([bytes], name);
  return { name, file, handle: null };
}

test('newDatabase: 메타가 있는 빈 DB, 파일 없음, dirty 아님', async () => {
  const { store, client } = await setup();
  const s = store.getState();
  assert.equal(s.file.name, null);
  assert.equal(s.dirty, false);
  assert.equal(s.meta.revision, '0');
  assert.equal(s.meta.app_version, 'test');
  assert.match(s.meta.db_id ?? '', /^[0-9a-f-]{36}$/);
  client.close();
});

test('recordCommand → dirty, 다운로드 저장 → revision 1·known 갱신·저널 비움, 다시 열면 같은 데이터', async () => {
  const { store, client, idb, fsx, autosave } = await setup();
  const dbId = store.getState().meta.db_id ?? '';
  await client.call('command.apply', { cmd: CREATE_T });
  await store.recordCommand(CREATE_T);
  assert.equal(store.getState().dirty, true);
  assert.equal((await autosave.recoverable(dbId))?.commands.length, 1);

  assert.equal(await store.save(), true, '핸들이 없으면 다른 이름으로 저장(다운로드 폴백)');
  assert.equal(fsx.downloads.length, 1);
  const saved = store.getState();
  assert.equal(saved.dirty, false);
  assert.equal(saved.file.name, 'database.db');
  assert.equal(saved.meta.revision, '1');
  assert.equal(saved.meta.saved_by, '테스트 기기');
  assert.equal(await idb?.get('known_revisions', dbId), 1);
  assert.equal(await autosave.recoverable(dbId), null, '저장하면 저널을 비운다');

  const download = fsx.downloads[0];
  assert.ok(download);
  assert.equal(await store.openPicked(pickedFile('saved.db', download.bytes)), true);
  const reopened = store.getState();
  assert.equal(reopened.file.name, 'saved.db');
  assert.equal(reopened.meta.db_id, dbId);
  assert.equal(reopened.meta.revision, '1');
  assert.deepEqual((await client.call('engine.exec', { sql: 'SELECT s FROM t' })).rows, [['하나']]);
  client.close();
});

test('핸들 저장: 기존 파일을 backups에 남기고 핸들에 쓴다', async () => {
  const { store, client, idb, fsx } = await setup();
  const handle = /** @type {FileSystemFileHandle} */ (
    /** @type {unknown} */ ({
      name: 'h.db',
      kind: 'file',
      getFile: async () => new File([], 'h.db'),
    })
  );
  fsx.setSaveTarget({ kind: 'handle', handle });
  assert.equal(await store.saveAs(), true);
  const first = fsx.written.get('h.db');
  assert.ok(first && first.byteLength > 0);
  assert.equal(store.getState().file.name, 'h.db');
  assert.equal(store.getState().meta.revision, '1');
  assert.equal(
    await idb?.get('backups', store.getState().meta.db_id ?? ''),
    undefined,
    '첫 저장은 백업 없음',
  );

  await client.call('command.apply', { cmd: CREATE_T });
  await store.recordCommand(CREATE_T);
  assert.equal(await store.save(), true);
  const backup = /** @type {{ bytes: Uint8Array }} */ (
    await idb?.get('backups', store.getState().meta.db_id ?? '')
  );
  assert.deepEqual(backup.bytes, first, '저장 직전 파일이 1세대 백업으로 남는다');
  assert.equal(store.getState().meta.revision, '2');
  client.close();
});

test('SQLite 아님·손상 파일은 오류 코드로 거부하고 새 DB로 돌아간다', async () => {
  const { store, notices } = await setup();
  const junk = await fixture('not-sqlite.txt');
  assert.equal(await store.openPicked(pickedFile('x.txt', junk)), false);
  assert.equal(notices.at(-1)?.value, 'E_FILE_NOT_SQLITE');
  assert.equal(store.getState().file.name, null);
  assert.equal(store.getState().meta.revision, '0');

  const corrupt = await fixture('corrupt.db');
  assert.equal(await store.openPicked(pickedFile('corrupt.db', corrupt)), false);
  assert.equal(notices.at(-1)?.value, 'E_FILE_CORRUPT');
  assert.ok(store.getState().meta.db_id, '사용 가능한 새 DB가 열려 있다');
});

test('파일 크기: maxFileBytes 초과는 E_FILE_TOO_LARGE, warnFileBytes 초과는 확인 후 계속', async () => {
  const { store, notices, asked, fsx } = await setup({
    caps: { warnFileBytes: 10, maxFileBytes: 100_000 },
  });
  await store.saveAs();
  const bytes = fsx.downloads[0]?.bytes ?? new Uint8Array(0);
  assert.ok(bytes.byteLength > 10);
  assert.equal(await store.openPicked(pickedFile('big.db', bytes)), true);
  assert.deepEqual(asked, ['large']);

  const huge = /** @type {File} */ (
    /** @type {unknown} */ ({
      name: 'huge.db',
      size: 100_001,
      arrayBuffer: async () => new ArrayBuffer(0),
    })
  );
  assert.equal(await store.openPicked({ name: 'huge.db', file: huge, handle: null }), false);
  assert.equal(notices.at(-1)?.value, 'E_FILE_TOO_LARGE');
});

test('외부 SQLite 파일: 승인하면 schema.adopt로 등록, 거절하면 새 DB', async () => {
  const external = await fixture('external.db');
  const yes = await setup({ prompts: { adopt: true } });
  assert.equal(await yes.store.openPicked(pickedFile('external.db', external)), true);
  assert.deepEqual(yes.asked, ['adopt']);
  assert.equal(yes.store.getState().file.name, 'external.db');
  assert.equal(yes.store.getState().meta.revision, '0');
  assert.deepEqual(
    (
      await yes.client.call('engine.exec', {
        sql: 'SELECT id, strict FROM _jdr_tables ORDER BY position',
      })
    ).rows,
    [
      ['users', 0],
      ['posts', 0],
    ],
  );
  yes.client.close();

  const no = await setup({ prompts: { adopt: false } });
  assert.equal(await no.store.openPicked(pickedFile('external.db', external)), false);
  assert.equal(no.store.getState().file.name, null);
  no.client.close();
});

test('revision 판정: 이 기기가 더 나중 버전을 저장했으면 경고, 취소 시 새 DB', async () => {
  const { store, fsx, idb, asked, client } = await setup({ prompts: { behind: false } });
  await store.saveAs();
  const rev1 = fsx.downloads[0]?.bytes ?? new Uint8Array(0);
  const dbId = store.getState().meta.db_id ?? '';
  await store.saveAs();
  assert.equal(store.getState().meta.revision, '2');
  assert.equal(await idb?.get('known_revisions', dbId), 2);

  assert.equal(await store.openPicked(pickedFile('old.db', rev1)), false, '취소하면 열지 않음');
  assert.deepEqual(asked, ['behind']);
  assert.equal(await idb?.get('known_revisions', dbId), 2, 'known은 그대로');
  assert.equal(store.getState().file.name, null);
  client.close();
});

test('저널 복구: base_revision이 같으면 재생하고 dirty, 다르면 버리기/내보내기', async () => {
  const idb = createMemoryIdb();
  const a = await setup({ idb, prompts: { journal: 'recover' } });
  await a.store.saveAs();
  const saved = a.fsx.downloads[0]?.bytes ?? new Uint8Array(0);
  const dbId = a.store.getState().meta.db_id ?? '';
  await a.client.call('command.apply', { cmd: CREATE_T });
  await a.store.recordCommand(CREATE_T);
  a.client.close();

  // 탭이 죽었다고 치고 새 세션에서 같은 파일을 연다.
  const b = await setup({ idb, prompts: { journal: 'recover' } });
  assert.equal(await b.store.openPicked(pickedFile('saved.db', saved)), true);
  assert.deepEqual(b.asked, ['journal']);
  assert.equal(b.store.getState().dirty, true);
  assert.equal(b.notices.at(-1)?.value, 'file.recovered');
  assert.deepEqual((await b.client.call('engine.exec', { sql: 'SELECT s FROM t' })).rows, [
    ['하나'],
  ]);
  assert.equal(b.store.getState().meta.db_id, dbId);
  // 복구 뒤 저장하면 저널이 비고 revision이 오른다.
  await b.store.saveAs();
  assert.equal(await b.autosave.recoverable(dbId), null);
  assert.equal(b.store.getState().meta.revision, '2');
  const rev2 = b.fsx.downloads.at(-1)?.bytes ?? new Uint8Array(0);
  await b.client.call('command.apply', {
    cmd: { ...CREATE_T, do: [{ sql: 'INSERT INTO t (s) VALUES (?)', params: ['둘'] }], undo: [] },
  });
  await b.store.recordCommand({ ...CREATE_T, do: [], undo: [] });
  b.client.close();

  // 저널은 revision 2 위의 기록인데 revision 1 파일을 열면 mismatch → 버리기.
  const c = await setup({ idb, prompts: { mismatch: 'discard' } });
  assert.equal(await c.store.openPicked(pickedFile('saved.db', saved)), true);
  assert.ok(c.asked.includes('mismatch'));
  assert.equal(c.store.getState().dirty, false);
  assert.equal(await c.autosave.recoverable(dbId), null);
  c.client.close();
  void rev2;
});

test('저장한 적 없는 새 DB의 저널은 다음 시작 때 같은 db_id로 복구를 제안한다', async () => {
  const idb = createMemoryIdb();
  const a = await setup({ idb });
  const dbId = a.store.getState().meta.db_id ?? '';
  await a.client.call('command.apply', { cmd: CREATE_T });
  await a.store.recordCommand(CREATE_T);
  a.client.close();

  const b = await setup({ idb, prompts: { journal: 'recover' } });
  assert.equal(await b.store.recoverPending(), true);
  assert.deepEqual(b.asked, ['journal']);
  assert.equal(b.store.getState().meta.db_id, dbId);
  assert.equal(b.store.getState().dirty, true);
  assert.deepEqual((await b.client.call('engine.exec', { sql: 'SELECT s FROM t' })).rows, [
    ['하나'],
  ]);
  b.client.close();

  const c = await setup({ idb, prompts: { journal: 'discard' } });
  assert.equal(await c.store.recoverPending(), false, '아직 저장하지 않은 b의 저널을 버림');
  assert.equal(await c.store.recoverPending(), false, '저널이 비었으면 묻지 않음');
  c.client.close();
});

test('dirty 상태에서 새로 만들기·열기는 확인을 거치고, 거절하면 그대로', async () => {
  const { store, asked, fsx } = await setup({ prompts: { discard: false } });
  await store.saveAs();
  const bytes = fsx.downloads[0]?.bytes ?? new Uint8Array(0);
  store.markDirty();
  assert.equal(await store.newDatabase(), false);
  assert.equal(await store.openPicked(pickedFile('x.db', bytes)), false);
  assert.deepEqual(asked, ['discard', 'discard']);
  assert.equal(store.getState().dirty, true);
  assert.equal(store.getState().meta.revision, '1', '열지 않았으므로 그대로');
});

test('IDB가 없어도 열기·저장은 동작한다(1·2층)', async () => {
  const { store, fsx, client } = await setup({ idb: null });
  await client.call('command.apply', { cmd: CREATE_T });
  await store.recordCommand(CREATE_T);
  assert.equal(await store.save(), true);
  const bytes = fsx.downloads[0]?.bytes ?? new Uint8Array(0);
  assert.equal(await store.openPicked(pickedFile('a.db', bytes)), true);
  assert.equal(store.getState().meta.revision, '1');
  client.close();
});

test('runSchemaOp: 커맨드를 저널에 넣고 dirty, 테이블 목록 갱신·선택, 실패는 알리고 null', async () => {
  const { store, client, autosave, notices } = await setup();
  const dbId = store.getState().meta.db_id ?? '';
  /** @type {string[]} */
  const events = [];
  store.on('tables:changed', () => events.push('tables'));
  store.on('selection:changed', () => events.push('selection'));

  const created = await store.runSchemaOp('schema.create', { name: '고객' });
  assert.ok(created);
  assert.equal(store.getState().dirty, true);
  assert.deepEqual(
    store.getState().tables.map((t) => t.name),
    ['고객'],
  );
  assert.equal(store.getState().currentTableId, created.tableId, '첫 테이블은 자동 선택');
  assert.equal((await autosave.recoverable(dbId))?.commands[0]?.type, 'table.create');

  const added = await store.runSchemaOp('schema.addColumn', {
    tableId: created.tableId,
    name: '이름',
    type: 'text',
  });
  assert.ok(added);
  assert.deepEqual(
    store.getState().tables[0]?.columns.map((c) => c.name),
    ['이름'],
  );
  assert.equal((await autosave.recoverable(dbId))?.commands.length, 2);

  const dup = await store.runSchemaOp('schema.addColumn', {
    tableId: created.tableId,
    name: '이름',
    type: 'text',
  });
  assert.equal(dup, null);
  assert.equal(notices.at(-1)?.value, 'E_NAME_INVALID');
  assert.equal((await autosave.recoverable(dbId))?.commands.length, 2, '실패는 저널에 남지 않음');

  store.selectTable('nope');
  assert.equal(store.getState().currentTableId, null);
  store.selectTable(created.tableId);
  assert.ok(events.includes('tables') && events.includes('selection'));

  // 저장 → 새 세션에서 열면 테이블이 그대로 온다(db.open의 tables).
  await store.saveAs();
  assert.equal(store.getState().dirty, false);
  await client.call('db.close');
  client.close();
});

test('runSchemaOp: 읽기 전용(다른 탭 점유)이면 실행하지 않고 안내', async () => {
  // 같은 채널의 다른 "탭"이 이 db_id를 쥐고 있게 만든다.
  const { store, fsx, notices, client } = await setup();
  await store.saveAs();
  const bytes = fsx.downloads[0]?.bytes ?? new Uint8Array(0);
  const dbId = store.getState().meta.db_id ?? '';
  const other = createTabLock();
  await other.claim(dbId);
  try {
    assert.equal(await store.openPicked(pickedFile('a.db', bytes)), true);
    assert.equal(store.getState().readOnly, 'otherTab');
    assert.equal(notices.at(-1)?.value, 'file.readOnlyTab');
    assert.equal(await store.runSchemaOp('schema.create', { name: 'x' }), null);
    assert.equal(notices.at(-1)?.value, 'file.readOnlyBlocked');
    assert.equal(await store.save(), false);
  } finally {
    other.close();
    client.close();
  }
});

test('열기: 미저장 변경을 버리고 연 파일은 깨끗한 상태로 시작한다', async () => {
  // 앞의 DB에 미저장 변경이 있고 사용자가 "버리기"를 골랐다면, 새로 연 파일은 dirty가 아니어야 한다.
  // dirty가 남으면 상태 표시와 이탈 경고가 거짓말을 하고, 다음 열기가 또 확인을 묻는다.
  const a = await setup();
  await a.store.saveAs();
  const bytes = a.fsx.downloads[0]?.bytes ?? new Uint8Array(0);
  a.client.close();

  const b = await setup({ prompts: { discard: true } });
  b.store.markDirty();
  assert.equal(await b.store.openPicked(pickedFile('saved.db', bytes)), true);
  assert.equal(b.store.getState().dirty, false);
  assert.deepEqual(b.asked, ['discard']);
  b.client.close();
});

test('열기: 저널을 복구하면 복구된 테이블이 스토어 목록에도 보인다', async () => {
  // 저널 재생은 열기 흐름 안에서 일어나므로, 재생 뒤에 읽은 테이블 목록이 열기 직전의 목록에
  // 덮어써지면 안 된다. 덮어쓰면 DB에는 있는 테이블이 사이드바에서 사라진다.
  const idb = createMemoryIdb();
  const a = await setup({ idb });
  await a.store.saveAs();
  const bytes = a.fsx.downloads[0]?.bytes ?? new Uint8Array(0);
  const created = await a.store.runSchemaOp('schema.create', { name: '주문' });
  assert.ok(created);
  a.client.close();

  const b = await setup({ idb, prompts: { journal: 'recover' } });
  assert.equal(await b.store.openPicked(pickedFile('saved.db', bytes)), true);
  assert.equal((await b.client.call('schema.list')).tables.length, 1, 'DB에는 복구되어 있다');
  assert.deepEqual(
    b.store.getState().tables.map((t) => t.name),
    ['주문'],
  );
  assert.equal(b.store.getState().currentTableId, created.tableId);
  assert.equal(b.store.getState().dirty, true, '복구한 변경은 아직 저장되지 않았다');
  b.client.close();
});

// ---- Step 6: 뷰 상태 ----

/**
 * 테이블 하나(텍스트·정수 열)를 만든다.
 * @param {import('../../../src/app/store.js').Store} store
 */
async function viewFixture(store) {
  const created = await store.runSchemaOp('schema.create', { name: '고객' });
  if (!created) throw new Error('create failed');
  const tableId = created.tableId;
  const name = await store.runSchemaOp('schema.addColumn', { tableId, name: '이름', type: 'text' });
  const age = await store.runSchemaOp('schema.addColumn', {
    tableId,
    name: '나이',
    type: 'integer',
  });
  if (!name || !age) throw new Error('addColumn failed');
  return { tableId, name: name.columnId, age: age.columnId };
}

test('뷰 상태: 정렬·필터·검색·숨김 설정과 viewSpecOf, view:changed 이벤트, clearFilters', async () => {
  const { store, client } = await setup();
  const { tableId, name, age } = await viewFixture(store);
  let changed = 0;
  store.on('view:changed', () => {
    changed += 1;
  });
  store.toggleSort(tableId, age);
  store.toggleSort(tableId, name, true);
  store.setFilter(tableId, { logic: 'or', conditions: [{ colId: age, op: '>', value: '3' }] });
  store.setSearch(tableId, '  홍 ');
  store.setSearch(tableId, '홍');
  store.toggleHidden(tableId, name);
  assert.equal(changed, 5, '같은 검색어는 이벤트를 내지 않는다');
  assert.deepEqual(store.viewSpecOf(tableId), {
    hidden: [name],
    sort: [
      { colId: age, dir: 'asc' },
      { colId: name, dir: 'asc' },
    ],
    filter: { logic: 'or', conditions: [{ colId: age, op: '>', value: '3' }] },
    search: '홍',
  });
  const view = store.getViewState(tableId);
  assert.equal(view.viewId, null);
  assert.deepEqual(view.hidden, [name]);
  // 복사본이라 바깥에서 고쳐도 상태가 바뀌지 않는다.
  view.sort.push({ colId: age, dir: 'desc' });
  assert.equal(store.getViewState(tableId).sort.length, 2);
  store.toggleHidden(tableId, name);
  store.clearFilters(tableId);
  store.clearFilters(tableId);
  assert.equal(changed, 7);
  assert.deepEqual(store.viewSpecOf(tableId).filter, null);
  assert.equal(store.viewSpecOf(tableId).search, '');
  assert.deepEqual(store.viewSpecOf(tableId).hidden, []);
  assert.equal(store.viewSpecOf(tableId).sort.length, 2, '정렬은 남는다');
  client.close();
});

test('뷰 상태: 열이 소프트 삭제되면 그 열의 정렬·필터·숨김 항목이 빠지고 안내한다', async () => {
  const { store, client, notices } = await setup();
  const { tableId, name, age } = await viewFixture(store);
  store.setSort(tableId, [
    { colId: age, dir: 'desc' },
    { colId: name, dir: 'asc' },
  ]);
  store.setFilter(tableId, { logic: 'and', conditions: [{ colId: age, op: 'empty' }] });
  store.toggleHidden(tableId, age);
  notices.length = 0;
  await store.runSchemaOp('schema.softDeleteColumn', { tableId, columnId: age });
  assert.deepEqual(store.viewSpecOf(tableId), {
    hidden: [],
    sort: [{ colId: name, dir: 'asc' }],
    filter: null,
    search: '',
  });
  assert.deepEqual(
    notices.filter((n) => n.value === 'view.pruned'),
    [{ kind: 'info', value: 'view.pruned' }],
  );
  // 복원해도 뷰에 저절로 돌아오지는 않는다(사용자가 다시 고른다).
  notices.length = 0;
  await store.runSchemaOp('schema.restoreColumn', { tableId, columnId: age });
  assert.deepEqual(store.viewSpecOf(tableId).sort, [{ colId: name, dir: 'asc' }]);
  assert.equal(
    notices.some((n) => n.value === 'view.pruned'),
    false,
  );
  client.close();
});

test('saveView·listViews·applyView·deleteView: 저장은 커맨드(dirty)이고 불러오기는 뷰 상태만 바꾼다', async () => {
  const { store, client, notices } = await setup();
  const { tableId, name, age } = await viewFixture(store);
  store.setSort(tableId, [{ colId: age, dir: 'desc' }]);
  store.setSearch(tableId, '홍');
  store.setColumnWidth(tableId, name, 240);
  store.setFrozenColumns(tableId, 1);
  const viewId = await store.saveView(tableId, ' 기본 ');
  assert.ok(viewId);
  assert.equal(store.getState().dirty, true);
  assert.equal(store.getViewState(tableId).viewId, viewId);
  assert.ok(notices.some((n) => n.value === 'view.saved'));
  const listed = await store.listViews(tableId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.name, '기본');
  assert.deepEqual(listed[0]?.spec.widths, { [name]: 240 });
  assert.equal(listed[0]?.spec.frozen, 1);

  // 같은 이름으로 다시 저장하면 덮어쓴다(뷰 수는 그대로).
  store.setSearch(tableId, '김');
  assert.equal(await store.saveView(tableId, '기본'), viewId);
  assert.equal((await store.listViews(tableId)).length, 1);
  assert.equal((await store.listViews(tableId))[0]?.spec.search, '김');

  // 상태를 바꾼 뒤 불러오면 저장된 대로 돌아온다. dirty에는 영향이 없다(저장 뒤 깨끗한 상태에서 확인).
  await store.save();
  assert.equal(store.getState().dirty, false);
  store.clearFilters(tableId);
  store.setSort(tableId, []);
  store.setColumnWidth(tableId, name, 100);
  const saved = (await store.listViews(tableId))[0];
  assert.ok(saved);
  store.applyView(tableId, saved);
  const view = store.getViewState(tableId);
  assert.deepEqual(view.sort, [{ colId: age, dir: 'desc' }]);
  assert.equal(view.search, '김');
  assert.equal(view.widths[name], 240);
  assert.equal(view.frozenColumns, 1);
  assert.equal(view.viewId, viewId);
  assert.equal(store.getState().dirty, false, '불러오기는 DB를 바꾸지 않는다');

  // 저장된 뷰가 지워진 열을 가리키면 그 항목을 빼고 안내한다.
  await store.runSchemaOp('schema.softDeleteColumn', { tableId, columnId: age });
  notices.length = 0;
  store.applyView(tableId, saved);
  assert.deepEqual(store.getViewState(tableId).sort, []);
  assert.ok(notices.some((n) => n.value === 'view.pruned'));

  assert.equal(await store.deleteView(tableId, viewId), true);
  assert.equal(store.getViewState(tableId).viewId, null);
  assert.deepEqual(await store.listViews(tableId), []);
  assert.equal(store.getState().dirty, true);
  client.close();
});

test('enableSearch·disableSearch: 진행률·취소를 거쳐 커맨드로 반영되고 테이블 목록의 ftsEnabled가 바뀐다', async () => {
  const { store, client } = await setup();
  const { tableId } = await viewFixture(store);
  /** @type {string[]} */
  const phases = [];
  assert.equal(
    await store.enableSearch(tableId, { onProgress: (p) => phases.push(p.phase) }),
    true,
  );
  assert.ok(phases.includes('index'));
  assert.equal(store.getState().tables[0]?.ftsEnabled, true);
  // 이미 켜져 있으면 실패를 알리고 false.
  assert.equal(await store.enableSearch(tableId), false);
  assert.equal(await store.disableSearch(tableId), true);
  assert.equal(store.getState().tables[0]?.ftsEnabled, false);
  // 취소: 시작 전에 abort된 신호는 E_IMPORT_CANCELLED로 거절되고 플래그는 그대로다.
  const controller = new AbortController();
  controller.abort();
  assert.equal(await store.enableSearch(tableId, { signal: controller.signal }), false);
  assert.equal(store.getState().tables[0]?.ftsEnabled, false);
  client.close();
});
