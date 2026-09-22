// @ts-check
/**
 * 데스크톱 모드 스토어 흐름을 실제 rusqlite 엔진(러스트 코어의 `jdr-ipc-stdio`)으로 검사한다(Step 11).
 * 열기(작업 사본) → 편집 → 저장(.bak) → 다른 이름으로 저장 → 원본 변경 감지(덮어쓰기·다른 이름·취소) →
 * dirty 사본 복구·버리기 → 새 DB 사본의 시작 복구 → 내보내기 경로 싱크 → `.bak` 복원.
 *
 * 인라인 전송의 디스패처가 `selectEngine('native')`로 만든 엔진은 미리 등록한 호출자(worker_threads 브리지)를 쓴다.
 * 러스트 백엔드는 프로세스에 하나뿐이라 열린 세션도 하나뿐이다. 저장된 파일의 내용은 wasm 엔진으로 읽어 본다.
 */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { createStore } from '../../src/app/store.js';
import { createClient, createInlineTransport } from '../../src/db/client.js';
import { createPortCaller, setNativeCaller } from '../../src/db/engine-native.js';
import { createAutosave } from '../../src/io/autosave.js';
import { createMemoryIdb } from '../../src/io/idb.js';
import { createTabLock } from '../../src/io/tablock.js';
import { AppError } from '../../src/util/errors.js';
import { openWasmEngine } from '../unit/db/helpers.js';

/** @typedef {import('../../src/app/store.js').FileSystemLike} FileSystemLike */
/** @typedef {import('../../src/app/store.js').Prompts} Prompts */
/** @typedef {import('../../src/db/command.js').Command} Command */
/** @typedef {import('../../src/db/engine-native.js').NativeCaller} NativeCaller */

const binary = process.env.JDR_IPC_STDIO;
if (!binary) throw new Error('JDR_IPC_STDIO is not set; run via `npm run test:native`');

/** @type {Worker | null} */
let worker = null;
/** @type {NativeCaller | null} */
let caller = null;
let scratch = '';
let appData = '';
/** 앱에는 탭 잠금이 하나뿐이다. 세션마다 새로 만들면 앞 세션의 잠금이 같은 프로세스 안에서 "다른 탭"으로 보인다. */
const tablock = createTabLock();

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
/** @type {Command} */
const INSERT_TWO = {
  type: 'row.insert',
  tableId: null,
  do: [{ sql: 'INSERT INTO t (s) VALUES (?)', params: ['둘'] }],
  undo: [{ sql: 'DELETE FROM t WHERE s = ?', params: ['둘'] }],
  summary: 'insert',
};

before(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'jdr-store-native-'));
  appData = path.join(scratch, '앱 데이터');
  const bridge = new Worker(new URL('./bridge-worker.js', import.meta.url), {
    workerData: { binary, appData },
  });
  worker = bridge;
  caller = createPortCaller({
    postMessage: (message) => bridge.postMessage(message),
    subscribe: (handler) => {
      bridge.on('message', handler);
      return () => bridge.off('message', handler);
    },
  });
  setNativeCaller(caller);
});

after(async () => {
  setNativeCaller(null);
  const bridge = worker;
  if (bridge) {
    await new Promise((resolve) => {
      bridge.on('message', (data) => {
        if (data && typeof data === 'object' && 'shutdown' in data) resolve(undefined);
      });
      bridge.postMessage({ shutdown: true });
    });
    await bridge.terminate();
  }
  caller?.dispose();
  tablock.close();
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

/**
 * 러스트 코어 명령을 브리지로 직접 부른다(파일 명령 전용).
 * @param {string} cmd
 * @param {Record<string, unknown>} args
 */
function engineCall(cmd, args) {
  if (!caller) throw new Error('bridge is not ready');
  return caller.call(cmd, args);
}

/**
 * 데스크톱 모드 파일 함수(`io/filesystem.js`의 네이티브 분기와 같은 형태). 대화상자는 미리 넣은 경로를 돌려준다.
 */
function nativeFs() {
  /** @type {Array<string | null>} */
  const queue = [];
  /** @type {FileSystemLike} */
  const fs = {
    pickOpen: async () => null,
    pickSaveAs: async () => {
      const next = queue.shift() ?? null;
      return next ? { kind: 'path', path: next } : { kind: 'cancelled' };
    },
    openSink: async (target) => {
      if (target.kind !== 'path') throw new Error('desktop sink needs a path');
      const id = /** @type {number} */ (await engineCall('sink_open', { path: target.path }));
      return {
        write: async (chunk) => {
          const b64 = Buffer.from(chunk).toString('base64');
          await engineCall('sink_write', { id, bytes: { $blob: b64 } });
        },
        close: async () => {
          await engineCall('sink_close', { id });
        },
        abort: async () => {
          await engineCall('sink_abort', { id });
        },
      };
    },
    readAll: async () => new Uint8Array(0),
    write: async () => {},
    download: () => {},
    ensurePermission: async () => {},
    gzip: async (b) => new Uint8Array(b),
    gunzip: async (b) => new Uint8Array(b),
    isGzip: () => false,
    gzipSupported: () => false,
    pickOpenPath: async () => queue.shift() ?? null,
    pickSavePath: async () => queue.shift() ?? null,
    backupInfo: async (originalPath) =>
      /** @type {import('../../src/io/filesystem.js').NativeBackupInfo | null} */ (
        await engineCall('backup_info', { originalPath })
      ),
    restoreBackup: async (originalPath, targetPath) =>
      /** @type {import('../../src/io/filesystem.js').NativeBackupInfo} */ (
        await engineCall('restore_backup', { originalPath, targetPath })
      ),
    listWorkcopies: async () =>
      /** @type {import('../../src/io/filesystem.js').WorkcopyEntry[]} */ (
        await engineCall('list_workcopies', {})
      ),
    removeWorkcopy: async (key) => {
      await engineCall('remove_workcopy', { key });
    },
    baseName: (p) => path.basename(p),
  };
  return { fs, queue };
}

/**
 * @param {Partial<{ discard: boolean, originalChanged: 'overwrite' | 'saveAs' | 'cancel', workcopy: 'recover' | 'discard' }>} [answers]
 */
async function setup(answers = {}) {
  const client = createClient({ transport: createInlineTransport() });
  const init = await client.call('engine.init', { mode: 'native', appVersion: 'test' });
  assert.equal(init.capabilities.persistence, 'native');
  const idb = createMemoryIdb();
  const fsx = nativeFs();
  /** @type {string[]} */
  const asked = [];
  /** @type {Array<{ kind: 'error' | 'info', value: string, params?: unknown, saving?: boolean }>} */
  const notices = [];
  // 알림이 뜬 시점의 저장 뮤텍스를 함께 남긴다(저장 성공 알림은 뮤텍스를 놓기 전에 뜬다).
  /** @type {import('../../src/app/store.js').Store | null} */
  let made = null;
  /** @type {Prompts} */
  const prompts = {
    discardUnsaved: async () => (asked.push('discard'), answers.discard ?? true),
    adoptExternal: async () => (asked.push('adopt'), true),
    largeFile: async () => true,
    revisionBehind: async () => (asked.push('behind'), true),
    journalRecover: async () => 'discard',
    journalMismatch: async () => 'discard',
    originalChanged: async () => (
      asked.push('originalChanged'),
      answers.originalChanged ?? 'cancel'
    ),
    workcopyRecover: async () => (asked.push('workcopy'), answers.workcopy ?? 'recover'),
  };
  const store = createStore({
    client,
    caps: init.capabilities,
    fs: fsx.fs,
    idb,
    autosave: createAutosave({ idb: null }),
    tablock,
    prompts,
    notify: {
      error: (err) =>
        notices.push({ kind: 'error', value: err.code, saving: made?.getState().saving }),
      info: (key, params) =>
        notices.push({ kind: 'info', value: key, params, saving: made?.getState().saving }),
    },
    deviceName: '데스크톱',
    defaultFileName: 'database.db',
  });
  made = store;
  await store.newDatabase({ force: true });
  return { client, store, idb, fsx, asked, notices };
}

/**
 * @param {import('../../src/app/store.js').Store} store
 * @param {import('../../src/db/client.js').Client} client
 * @param {Command} cmd
 */
async function apply(store, client, cmd) {
  await client.call('command.apply', { cmd });
  await store.recordCommand(cmd);
}

/**
 * @param {import('../../src/db/client.js').Client} client
 * @param {string} sql
 */
async function count(client, sql) {
  return (await client.call('engine.exec', { sql })).rows;
}

/**
 * 저장된 파일을 wasm 엔진으로 읽어 본다(러스트 백엔드의 열린 세션을 건드리지 않는다).
 * @param {string} file
 * @param {string} sql
 */
async function queryFile(file, sql) {
  const bytes = new Uint8Array(await readFile(file));
  const probe = await openWasmEngine(bytes);
  try {
    return probe.exec(sql).rows;
  } finally {
    await probe.close();
  }
}

/**
 * "다른 PC의 동기화"를 흉내 낸다: 파일을 wasm 엔진으로 열어 행을 더 넣고 revision을 올린 뒤 같은 자리에 쓴다.
 * @param {string} file
 * @param {number} extraRows
 */
async function changeOnDisk(file, extraRows) {
  const bytes = new Uint8Array(await readFile(file));
  const probe = await openWasmEngine(bytes);
  try {
    await probe.transaction(() => {
      for (let i = 0; i < extraRows; i += 1) {
        probe.run('INSERT INTO t (s) VALUES (?)', [`동기화 ${i}`]);
      }
      probe.run(
        "UPDATE _jdr_meta SET value = CAST(CAST(value AS INTEGER) + 1 AS TEXT) WHERE key = 'revision'",
      );
    });
    const out = probe.snapshot();
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(file, out);
  } finally {
    await probe.close();
  }
}

test('desktop: 새 DB → 다른 이름으로 저장 → 편집 → 저장(.bak) → 다시 열기', async () => {
  const { store, client, fsx, notices, idb } = await setup();
  assert.equal(store.getState().file.path, null);
  await apply(store, client, CREATE_T);
  assert.equal(store.getState().dirty, true);

  const file = path.join(scratch, '한글 폴더', '데이터.db');
  await mkdir(path.dirname(file), { recursive: true });
  fsx.queue.push(file);
  assert.equal(await store.save(), true, '경로가 없으면 다른 이름으로 저장');
  const s1 = store.getState();
  assert.equal(s1.file.path, file);
  assert.equal(s1.file.name, '데이터.db');
  assert.equal(s1.dirty, false);
  assert.equal(s1.meta.revision, '1');
  assert.equal(s1.meta.saved_by, '데스크톱');
  assert.equal(notices.at(-1)?.value, 'file.saved');
  assert.equal(await idb.get('known_revisions', s1.meta.db_id ?? ''), 1);
  assert.deepEqual(await idb.get('handles', 'recent'), {
    name: '데이터.db',
    handle: null,
    path: file,
  });

  await apply(store, client, INSERT_TWO);
  assert.equal(await store.save(), true);
  const s2 = store.getState();
  assert.equal(s2.meta.revision, '2');
  assert.equal(notices.at(-1)?.value, 'file.savedBackup');
  await stat(`${file}.bak`);
  assert.deepEqual(await queryFile(file, 'SELECT s FROM t ORDER BY id'), [['하나'], ['둘']]);
  assert.deepEqual(await queryFile(`${file}.bak`, 'SELECT s FROM t ORDER BY id'), [['하나']]);
  // 저장한 파일에는 dirty가 남아도 사본에서는 0이다.
  assert.deepEqual(await count(client, "SELECT value FROM _jdr_meta WHERE key = 'dirty'"), [['0']]);

  // 최근 파일로 다시 열기.
  assert.equal(await store.newDatabase(), true);
  assert.equal(store.getState().file.path, null);
  assert.equal(await store.openRecent(), true);
  const s3 = store.getState();
  assert.equal(s3.file.path, file);
  assert.equal(s3.meta.revision, '2');
  assert.equal(s3.dirty, false);
  assert.deepEqual(await count(client, 'SELECT count(*) FROM t'), [[2]]);
  await client.call('db.close', { discardWorkcopy: true });
  client.close();
});

test('desktop: 연 뒤 원본이 바뀌면 E_ORIGINAL_CHANGED → 취소·다른 이름·덮어쓰기', async () => {
  const file = path.join(scratch, 'changed.db');
  const cancel = await setup({ originalChanged: 'cancel' });
  await apply(cancel.store, cancel.client, CREATE_T);
  cancel.fsx.queue.push(file);
  assert.equal(await cancel.store.saveAs(), true);
  await apply(cancel.store, cancel.client, INSERT_TWO);
  // 다른 PC의 동기화: 원본을 다른 내용으로 바꾼다(행 2개 더, revision +1 → 3행).
  await changeOnDisk(file, 2);
  assert.equal(await cancel.store.save(), false);
  assert.deepEqual(
    cancel.asked.filter((a) => a === 'originalChanged'),
    ['originalChanged'],
  );
  assert.equal(cancel.store.getState().dirty, true, '취소하면 미저장 상태 그대로');
  assert.deepEqual(await queryFile(file, 'SELECT count(*) FROM t'), [[3]], '원본 그대로');
  cancel.client.close();

  // 취소한 세션의 dirty 사본이 남아 있으므로 다음 열기는 복구를 묻는다(기본 답: 복구).
  const saveAs = await setup({ originalChanged: 'saveAs' });
  assert.equal(await saveAs.store.openPath(file), true);
  assert.deepEqual(saveAs.asked, ['workcopy']);
  assert.equal(saveAs.store.getState().dirty, true);
  assert.equal(saveAs.notices.at(-1)?.value, 'file.workcopyMismatch', '원본 revision이 앞서 있다');
  await apply(saveAs.store, saveAs.client, INSERT_TWO);
  const elsewhere = path.join(scratch, 'elsewhere.db');
  saveAs.fsx.queue.push(elsewhere);
  assert.equal(await saveAs.store.save(), true, '다른 이름으로 저장으로 이어진다');
  assert.deepEqual(saveAs.asked, ['workcopy', 'originalChanged']);
  assert.equal(saveAs.store.getState().file.path, elsewhere);
  assert.equal(saveAs.store.getState().dirty, false);
  assert.deepEqual(await queryFile(elsewhere, 'SELECT count(*) FROM t'), [[3]], '하나·둘·둘');
  assert.deepEqual(await queryFile(file, 'SELECT count(*) FROM t'), [[3]], '원본은 손대지 않았다');
  saveAs.client.close();

  const overwrite = await setup({ originalChanged: 'overwrite' });
  assert.equal(await overwrite.store.openPath(file), true);
  assert.deepEqual(overwrite.asked, [], '사본은 elsewhere로 저장되어 깨끗하므로 새로 복사한다');
  await apply(overwrite.store, overwrite.client, INSERT_TWO);
  await changeOnDisk(file, 0);
  assert.equal(await overwrite.store.save(), true);
  // 저장 성공 알림은 뮤텍스를 놓기 전에 뜬다. 되묻기와 다시 저장이 한 try/finally 안에 있으면 finally가
  // 다시 저장이 끝나기 전에 돌아, 저장이 도는 동안 뮤텍스가 풀린 채로 여기까지 온다.
  assert.equal(
    overwrite.notices.at(-1)?.saving,
    true,
    '되물은 뒤 다시 저장하는 동안에도 저장 뮤텍스는 잡혀 있다',
  );
  assert.deepEqual(overwrite.asked, ['originalChanged']);
  assert.deepEqual(await queryFile(file, 'SELECT count(*) FROM t'), [[4]], '덮어썼다');
  assert.deepEqual(
    await queryFile(`${file}.bak`, 'SELECT count(*) FROM t'),
    [[3]],
    '바뀐 원본은 .bak',
  );
  await overwrite.client.call('db.close', { discardWorkcopy: true });
  overwrite.client.close();
});

test('desktop: 닫지 않은 dirty 사본은 다시 열 때 복구를 묻고, 버리면 새로 복사한다', async () => {
  const file = path.join(scratch, 'recover.db');
  const first = await setup();
  await apply(first.store, first.client, CREATE_T);
  first.fsx.queue.push(file);
  assert.equal(await first.store.saveAs(), true);
  await apply(first.store, first.client, INSERT_TWO);
  assert.equal(first.store.getState().dirty, true);
  // 비정상 종료: 스토어를 버리고 엔진만 닫는다(dirty 사본은 남는다).
  await first.client.call('db.close');
  first.client.close();

  const recover = await setup({ workcopy: 'recover' });
  // 시작 복구: 파일의 dirty 사본은 안내만 한다.
  assert.equal(await recover.store.recoverPending(), false);
  assert.equal(recover.notices.at(-1)?.value, 'file.workcopyPendingFor');
  assert.equal(await recover.store.openPath(file), true);
  assert.deepEqual(recover.asked, ['workcopy']);
  assert.equal(recover.store.getState().dirty, true, '복구한 변경은 아직 파일에 없다');
  assert.notEqual(recover.notices.at(-1)?.value, 'file.workcopyMismatch', 'revision이 같다');
  assert.deepEqual(await count(recover.client, 'SELECT count(*) FROM t'), [[2]]);
  assert.equal(await recover.store.save(), true);
  assert.equal(recover.store.getState().dirty, false);
  assert.deepEqual(await queryFile(file, 'SELECT count(*) FROM t'), [[2]]);
  await apply(recover.store, recover.client, INSERT_TWO);
  await recover.client.call('db.close');
  recover.client.close();

  const discard = await setup({ workcopy: 'discard' });
  assert.equal(await discard.store.openPath(file), true);
  assert.deepEqual(discard.asked, ['workcopy']);
  assert.equal(discard.store.getState().dirty, false);
  assert.deepEqual(await count(discard.client, 'SELECT count(*) FROM t'), [[2]]);
  // 미저장 변경을 버리고 새 DB로 가면 사본도 버린다.
  await apply(discard.store, discard.client, INSERT_TWO);
  assert.equal(await discard.store.newDatabase(), true);
  assert.deepEqual(discard.asked, ['workcopy', 'discard']);
  const listed = await discard.fsx.fs.listWorkcopies?.();
  assert.ok(listed);
  assert.ok(
    !listed.some((e) => e.dirty && e.meta?.originalPath === file),
    '버린 사본은 남지 않는다',
  );
  await discard.client.call('db.close', { discardWorkcopy: true });
  discard.client.close();
});

test('desktop: 저장한 적 없는 새 DB의 dirty 사본은 시작 때 복구를 제안한다', async () => {
  const first = await setup();
  await apply(first.store, first.client, CREATE_T);
  const dbId = first.store.getState().meta.db_id;
  await first.client.call('db.close');
  first.client.close();

  const recover = await setup({ workcopy: 'recover' });
  assert.equal(await recover.store.recoverPending(), true);
  assert.equal(recover.store.getState().file.path, null);
  assert.equal(recover.store.getState().dirty, true);
  assert.equal(recover.store.getState().meta.db_id, dbId);
  assert.deepEqual(await count(recover.client, 'SELECT s FROM t'), [['하나']]);
  await recover.client.call('db.close', { discardWorkcopy: true });
  recover.client.close();

  const second = await setup();
  await apply(second.store, second.client, CREATE_T);
  await second.client.call('db.close');
  second.client.close();
  const discard = await setup({ workcopy: 'discard' });
  assert.equal(await discard.store.recoverPending(), false);
  const listed = await discard.fsx.fs.listWorkcopies?.();
  assert.ok(listed && !listed.some((e) => e.dirty && e.meta?.originalPath === null));
  await discard.client.call('db.close', { discardWorkcopy: true });
  discard.client.close();
});

test('desktop: 내보내기는 경로 싱크로 쓰고, .bak 복원은 새 파일을 만든다', async () => {
  const { store, client, fsx, notices } = await setup();
  const created = await store.runSchemaOp('schema.create', { name: '표' });
  assert.ok(created);
  const column = await store.runSchemaOp('schema.addColumn', {
    tableId: created.tableId,
    name: '이름',
    type: 'text',
  });
  assert.ok(column);
  /** @type {Command} */
  const insert = {
    type: 'row.insert',
    tableId: created.tableId,
    do: [
      {
        sql: `INSERT INTO "${created.tableId}" ("${column.columnId}") VALUES (?)`,
        params: ['하나'],
      },
    ],
    undo: [{ sql: `DELETE FROM "${created.tableId}"` }],
    summary: 'insert',
  };
  await apply(store, client, insert);
  const file = path.join(scratch, 'export-src.db');
  fsx.queue.push(file);
  assert.equal(await store.saveAs(), true);
  const table = store.getState().tables[0];
  assert.ok(table);
  const csv = path.join(scratch, '내보내기.csv');
  fsx.queue.push(csv);
  const outcome = await store.exportTable({
    tableId: table.id,
    viewSpec: {},
    format: 'csv',
    options: { encoding: 'utf-8' },
    suggestedName: 'x.csv',
  });
  assert.ok(outcome && outcome.name === '내보내기.csv');
  assert.match(await readFile(csv, 'utf8'), /하나/);

  assert.equal(await store.backupInfo(), null, '한 번 저장한 파일은 .bak이 없다');
  await apply(store, client, insert);
  assert.equal(await store.save(), true);
  const info = await store.backupInfo();
  assert.ok(info && info.name === 'export-src.db.bak' && info.bytes > 0);
  const restored = path.join(scratch, 'restored.db');
  fsx.queue.push(restored);
  assert.equal(await store.restoreBackup(), true);
  assert.equal(notices.at(-1)?.value, 'backup.restored');
  assert.deepEqual(await queryFile(restored, `SELECT count(*) FROM "${created.tableId}"`), [[1]]);
  assert.deepEqual(
    await count(client, `SELECT count(*) FROM "${created.tableId}"`),
    [[2]],
    '열린 DB는 그대로',
  );
  await assert.rejects(
    client.call('db.snapshot', {}),
    (err) => err instanceof AppError && err.code === 'E_UNSUPPORTED',
  );
  await client.call('db.close', { discardWorkcopy: true });
  client.close();
});

test('desktop: 저장한 적 없는 dirty 사본이 둘 이상이면 설정 목록으로 모두 닿는다', async () => {
  // 시작 복구는 가장 최근 것 하나만 제안한다. 나머지는 dirty라 자동 정리 대상도 아니어서,
  // 목록이 없으면 앱 데이터 폴더에 영영 쌓이고 사용자가 꺼낼 길이 없다.
  const first = await setup();
  await apply(first.store, first.client, CREATE_T);
  await apply(first.store, first.client, INSERT_TWO);
  await first.client.call('db.close', {});
  first.client.close();

  const second = await setup();
  await apply(second.store, second.client, CREATE_T);
  await second.client.call('db.close', {});

  const entries = await second.store.listWorkcopies();
  const fresh = entries.filter((e) => (e.meta?.originalPath ?? null) === null);
  assert.ok(fresh.length >= 2, `저장한 적 없는 dirty 사본이 둘 이상이어야 한다(${fresh.length})`);

  // 시작 복구가 제안하지 않는 쪽(가장 최근이 아닌 것)도 키로 열 수 있다.
  const older = fresh[fresh.length - 1];
  assert.ok(older);
  assert.equal(await second.store.openWorkcopy(older.key), true);
  assert.equal(second.store.getState().dirty, true, '복구한 사본의 변경은 아직 파일에 없다');

  // 버리면 목록에서 사라진다.
  const target = fresh.find((e) => e.key !== older.key);
  assert.ok(target);
  assert.equal(await second.store.discardWorkcopy(target.key), true);
  const after = await second.store.listWorkcopies();
  assert.ok(!after.some((e) => e.key === target.key), '버린 사본은 목록에 없다');
  second.client.close();
});
