// @ts-check
/**
 * 네이티브 엔진의 적합성 테스트(Step 11 완료 기준): `engine-native.js`가 실제 rusqlite 엔진(러스트 코어의
 * `jdr-ipc-stdio`)에 대해 `engine-contract.js`의 검사를 모두 통과한다. `npm run test:native`가 하네스를 빌드해
 * `JDR_IPC_STDIO`로 넘긴다.
 *
 * 브리지는 worker_threads 스레드(`bridge-worker.js`)에서 돌고, 이 스레드의 엔진이 `SharedArrayBuffer`와 `Atomics.wait`로
 * 동기 응답을 기다린다. 브라우저에서 Worker(엔진)와 메인(브리지)이 나뉘는 것과 같은 구조를 스레드만 바꿔 실행한다.
 */
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { Worker } from 'node:worker_threads';
import { createNativeEngine, createPortCaller } from '../../src/db/engine-native.js';
import { withCommonChecks } from '../../src/db/engine.js';
import { defineCleanupContract } from '../unit/db/cleanup-contract.js';
import { defineEngineContract } from '../unit/db/engine-contract.js';

/** @typedef {import('../../src/db/engine.js').Engine} Engine */
/** @typedef {import('../../src/db/engine-native.js').NativeCaller} NativeCaller */

const binary = process.env.JDR_IPC_STDIO;
if (!binary) throw new Error('JDR_IPC_STDIO is not set; run via `npm run test:native`');

/** @type {Worker | null} */
let worker = null;
/** @type {NativeCaller | null} */
let caller = null;
/** @type {string} */
let scratch = '';
let fileCounter = 0;

before(async () => {
  scratch = await mkdtemp(path.join(os.tmpdir(), 'jdr-native-'));
  const bridge = new Worker(new URL('./bridge-worker.js', import.meta.url), {
    workerData: { binary, appData: path.join(scratch, '앱 데이터') },
  });
  worker = bridge;
  caller = createPortCaller({
    postMessage: (message) => bridge.postMessage(message),
    subscribe: (handler) => {
      bridge.on('message', handler);
      return () => bridge.off('message', handler);
    },
  });
});

after(async () => {
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
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

/**
 * 초기화되고 (bytes가 있으면 그것을 파일로 써서) 열린 네이티브 엔진.
 * @param {Uint8Array} [bytes]
 * @returns {Promise<Engine>}
 */
async function openNativeEngine(bytes) {
  if (!caller) throw new Error('bridge is not ready');
  const engine = withCommonChecks(createNativeEngine({ caller }));
  await engine.init({});
  if (bytes) {
    fileCounter += 1;
    const file = path.join(scratch, `입력 ${fileCounter}.db`);
    await writeFile(file, bytes);
    await engine.open({ originalPath: file });
  } else {
    await engine.open();
  }
  return engine;
}

defineEngineContract('native', openNativeEngine);
// 데이터베이스 정리(Step 13 완료 기준): 같은 정리 시나리오를 rusqlite 엔진에 대해 돌린다.
defineCleanupContract('native', openNativeEngine);

test('native: 동기 응답이 처음 버퍼보다 크면 더 큰 버퍼로 다시 받는다', async () => {
  if (!caller) throw new Error('bridge is not ready');
  // 작은 버퍼로 만든 호출자: 64 KB 문자열 하나만으로 TOO_SMALL 경로를 지난다.
  const small = createPortCaller(
    {
      postMessage: (m) => worker?.postMessage(m),
      subscribe: (handler) => {
        worker?.on('message', handler);
        return () => worker?.off('message', handler);
      },
    },
    { bufferBytes: 1024 },
  );
  const engine = withCommonChecks(createNativeEngine({ caller: small }));
  await engine.init({});
  await engine.open();
  const big = '가'.repeat(64 * 1024);
  const r = engine.exec('SELECT ? AS s', [big]);
  assert.equal(r.rows[0]?.[0], big);
  assert.deepEqual(engine.exec('SELECT 1').rows, [[1]]);
  await engine.close({ discard: true });
  small.dispose();
});

test('native: 작업 사본 위에서 열고 저장하면 원본이 바뀌고 .bak이 남는다', async () => {
  if (!caller) throw new Error('bridge is not ready');
  const engine = withCommonChecks(createNativeEngine({ caller }));
  await engine.init({});
  const first = await engine.open();
  assert.ok(first && first.workcopyKey.startsWith('new-'));
  await engine.transaction(() => {
    engine.run('CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT) STRICT');
    engine.run('INSERT INTO t (s) VALUES (?)', ['하나']);
  });
  const file = path.join(scratch, '저장 대상.db');
  const saved = await engine.saveTo(file);
  assert.ok(saved && saved.backupPath === null && saved.size > 0);
  await engine.transaction(() => {
    engine.run('INSERT INTO t (s) VALUES (?)', ['둘']);
  });
  const second = await engine.saveTo(file);
  assert.equal(second?.backupPath, `${file}.bak`);
  await engine.close({ discard: true });

  const reopened = await engine.open({ originalPath: file });
  assert.ok(reopened && !reopened.dirty && reopened.originalPath === file);
  assert.deepEqual(engine.exec('SELECT count(*) FROM t').rows, [[2]]);
  await engine.close({ discard: true });
});
