// @ts-check
/**
 * 데스크톱 E2E(Step 11): tauri-driver(WebDriver)로 테스트 빌드 앱을 띄워 브라우저 E2E와 같은 시나리오를 검사한다.
 *
 * 준비물: Linux는 `WebKitWebDriver`(webkit2gtk-driver)와 `Xvfb`(또는 실제 디스플레이), Windows는 Microsoft Edge Driver.
 * `tauri-driver`는 `cargo install tauri-driver`. 파일 대화상자는 자동화할 수 없으므로 테스트 훅
 * `__jdrTest.setPickedPath()`로 경로를 넣는다(DESIGN.md Step 11 완료 기준).
 *
 * 흐름: `npm run build -- --test`(dist/test/tauri/index.html) → `tauri build --debug --no-bundle`(그 변형을 담은 바이너리)
 *      → tauri-driver 기동 → WebDriver 세션 → 검사 → 종료. `JDR_DESKTOP_BINARY`가 있으면 빌드를 건너뛴다.
 * WebDriver 프로토콜은 fetch로 직접 말한다(런타임 의존 없음). node:test 없이 순서대로 돌리고 실패는 예외로 끝낸다.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const TAURI_DIR = path.join(ROOT, 'src-tauri');
const DRIVER_PORT = Number(process.env.JDR_DRIVER_PORT ?? 4444);
const BASE = `http://127.0.0.1:${DRIVER_PORT}`;
const TEST_CONFIG = JSON.stringify({
  build: { frontendDist: '../dist/test/tauri', beforeBuildCommand: '' },
});

/** @param {string} label */
function step(label) {
  console.log(`[desktop] ${label}`);
}

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{ cwd?: string, env?: NodeJS.ProcessEnv }} [options]
 */
function run(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: options.cwd ?? ROOT,
    env: options.env ?? process.env,
  });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed with ${r.status}`);
}

function binaryPath() {
  if (process.env.JDR_DESKTOP_BINARY) return process.env.JDR_DESKTOP_BINARY;
  const exe = process.platform === 'win32' ? 'jdrdatabase-desktop.exe' : 'jdrdatabase-desktop';
  return path.join(TAURI_DIR, 'target', 'debug', exe);
}

async function buildTestApp() {
  step('build: dist/test/tauri/index.html');
  run(process.execPath, [path.join(ROOT, 'build', 'build.mjs'), '--test']);
  step('build: debug desktop binary with the test variant');
  const tauri = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  run(tauri, ['tauri', 'build', '--debug', '--no-bundle', '--config', TEST_CONFIG], {
    cwd: TAURI_DIR,
  });
}

/**
 * @param {string} method
 * @param {string} route
 * @param {unknown} [body]
 * @returns {Promise<unknown>}
 */
async function wd(method, route, body) {
  const res = await fetch(`${BASE}${route}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = /** @type {{ value: unknown }} */ (await res.json());
  if (!res.ok) {
    const value = /** @type {{ error?: string, message?: string }} */ (json.value ?? {});
    throw new Error(
      `WebDriver ${method} ${route}: ${value.error ?? res.status} ${value.message ?? ''}`,
    );
  }
  return json.value;
}

/**
 * @param {string} sessionId
 * @param {string} script `arguments[0..]`를 받고 값을 돌려주는 함수 본문. 비동기면 마지막 인자(콜백)에 결과를 준다
 * @param {unknown[]} [args]
 * @param {boolean} [async]
 */
async function execute(sessionId, script, args = [], async = false) {
  return wd('POST', `/session/${sessionId}/execute/${async ? 'async' : 'sync'}`, { script, args });
}

/**
 * 앱의 테스트 훅으로 Promise를 돌려주는 식을 실행한다. 거부는 `{ __error }`로 온다.
 * @param {string} sessionId
 * @param {string} expression `hook`(window.__jdrTest)을 쓰는 식
 * @param {unknown[]} [args]
 */
async function hook(sessionId, expression, args = []) {
  const script = `const done = arguments[arguments.length - 1]; const hook = window.__jdrTest; const a = Array.from(arguments).slice(0, -1); Promise.resolve().then(() => (${expression})).then((v) => done(v === undefined ? null : v), (e) => done({ __error: String(e && e.code ? e.code + ': ' + e.message : e) }));`;
  const value = await execute(sessionId, script, args, true);
  if (value && typeof value === 'object' && '__error' in value) {
    throw new Error(String(/** @type {{ __error: string }} */ (value).__error));
  }
  return value;
}

/**
 * @param {string} sessionId
 * @param {string} selector
 */
async function text(sessionId, selector) {
  return execute(
    sessionId,
    'const el = document.querySelector(arguments[0]); return el ? el.textContent : null;',
    [selector],
  );
}

/**
 * @param {() => Promise<boolean>} predicate
 * @param {string} what
 * @param {number} [timeoutMs]
 */
async function waitFor(predicate, what, timeoutMs = 20_000) {
  const started = Date.now();
  for (;;) {
    if (await predicate()) return;
    if (Date.now() - started > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

/**
 * 앱을 띄워 상태바가 "준비됨"이 될 때까지 기다린다.
 * @param {string} binary
 * @returns {Promise<string>} 세션 id
 */
async function startApp(binary) {
  const created = /** @type {{ sessionId: string }} */ (
    await wd('POST', '/session', {
      capabilities: { alwaysMatch: { 'tauri:options': { application: binary } } },
    })
  );
  const id = created.sessionId;
  step('session created; waiting for app ready');
  await waitFor(
    async () => (await text(id, '.jdr-statusbar__item')) === '준비됨',
    'status ready',
    60_000,
  );
  return id;
}

/**
 * 세션을 지운다. tauri-driver가 앱 프로세스를 끝내므로 저장하지 않은 변경은 dirty 작업 사본으로 남는다.
 * @param {string} sessionId
 */
async function stopApp(sessionId) {
  await wd('DELETE', `/session/${sessionId}`);
}

/**
 * 설정 대화상자의 작업 사본 목록 행: 표시 문구와 행 순번.
 * @param {string} sessionId
 * @returns {Promise<string[]>}
 */
async function workcopyRows(sessionId) {
  return /** @type {string[]} */ (
    await execute(
      sessionId,
      'const list = document.querySelector(\'[data-role="workcopy-list"]\'); if (!list || list.hidden) return []; return Array.from(list.querySelectorAll("p")).map((p) => p.querySelector("span")?.textContent ?? "");',
    )
  );
}

/**
 * 작업 사본 목록에서 이름이 `name`으로 시작하는 행의 버튼(`열기`/`버리기`)을 포커스한다. 찾으면 true.
 * @param {string} sessionId
 * @param {string} name
 * @param {string} label
 */
async function focusWorkcopyButton(sessionId, name, label) {
  return execute(
    sessionId,
    'const rows = Array.from(document.querySelectorAll(\'[data-role="workcopy-list"] p\')); const row = rows.find((p) => (p.querySelector("span")?.textContent ?? "").startsWith(arguments[0] + " · ")); const b = row ? Array.from(row.querySelectorAll("button")).find((x) => x.textContent === arguments[1]) : null; if (!b) return false; b.focus(); return document.activeElement === b;',
    [name, label],
  );
}

/**
 * 포커스된 요소에 실제 키 입력(WebDriver Actions)을 보낸다.
 * @param {string} sessionId
 * @param {string} key WebDriver 키 코드(예: Enter는 '\uE007')
 */
async function pressKey(sessionId, key) {
  await wd('POST', `/session/${sessionId}/actions`, {
    actions: [
      {
        type: 'key',
        id: 'keyboard',
        actions: [
          { type: 'keyDown', value: key },
          { type: 'keyUp', value: key },
        ],
      },
    ],
  });
  await wd('DELETE', `/session/${sessionId}/actions`);
}

async function main() {
  if (!process.env.JDR_DESKTOP_BINARY) await buildTestApp();
  const binary = binaryPath();
  const scratch = await mkdtemp(path.join(os.tmpdir(), 'jdr-desktop-'));
  step(`tauri-driver on ${DRIVER_PORT} for ${binary}`);
  const driver = spawn('tauri-driver', ['--port', String(DRIVER_PORT)], { stdio: 'inherit' });
  driver.on('error', (err) => {
    console.error(`tauri-driver failed to start: ${err.message}`);
    process.exit(2);
  });
  /** @type {string | null} */
  let sessionId = null;
  let failed = false;
  try {
    await waitFor(async () => {
      try {
        await fetch(`${BASE}/status`);
        return true;
      } catch {
        return false;
      }
    }, 'tauri-driver');
    sessionId = await startApp(binary);

    // 1. 데스크톱 모드 기동: 상태바 모드, SharedArrayBuffer, Worker 안 네이티브 엔진.
    const modes = /** @type {string[]} */ (
      await execute(
        sessionId,
        'return Array.from(document.querySelectorAll(".jdr-statusbar__item")).map((e) => e.textContent);',
      )
    );
    assert.equal(modes[1], '데스크톱 모드', `statusbar: ${modes.join(' | ')}`);
    const isolated = await execute(
      sessionId,
      'return { isolated: window.crossOriginIsolated, sab: typeof SharedArrayBuffer };',
    );
    step(`crossOriginIsolated=${JSON.stringify(isolated)}`);
    const ready = await hook(sessionId, 'hook.ready');
    assert.equal(/** @type {{ transportKind: string }} */ (ready).transportKind, 'worker');
    const env = await hook(
      sessionId,
      '({ idb: hook.idbAvailable(), tabLock: hook.tabLockAvailable(), version: hook.version })',
    );
    step(`environment: ${JSON.stringify(env)} statusbar=${JSON.stringify(modes)}`);
    const one = await hook(sessionId, "hook.exec('auto', 'SELECT 1 AS one')");
    assert.deepEqual(/** @type {{ rows: unknown[][] }} */ (one).rows, [[1]]);
    const fts = await hook(
      sessionId,
      "hook.exec('auto', [\"CREATE VIRTUAL TABLE f USING fts5(body, tokenize = 'trigram')\", \"INSERT INTO f VALUES ('서울특별시 강남구')\", \"SELECT body FROM f WHERE f MATCH '강남구'\"])",
    );
    assert.deepEqual(/** @type {{ rows: unknown[][] }} */ (fts).rows, [['서울특별시 강남구']]);
    step('engine: SELECT 1 and FTS5 trigram OK in the Worker');

    // 2. 새 테이블 → 다른 이름으로 저장(훅으로 경로 주입) → 편집 → 저장(.bak) → 다시 열기.
    const file = path.join(scratch, '한글 폴더', '데스크톱 검사.db');
    await (await import('node:fs/promises')).mkdir(path.dirname(file), { recursive: true });
    const created2 = await hook(sessionId, "hook.call('schema.create', { name: '표' })");
    const tableId = /** @type {{ tableId: string }} */ (created2).tableId;
    await hook(
      sessionId,
      "hook.call('schema.addColumn', { tableId: a[0], name: '이름', type: 'text' })",
      [tableId],
    );
    const cmd = {
      type: 'row.insert',
      tableId,
      do: [{ sql: `INSERT INTO "${tableId}" ("_created_at") VALUES ('now')` }],
      undo: [{ sql: `DELETE FROM "${tableId}"` }],
      summary: 'insert',
    };
    await hook(sessionId, 'hook.apply(a[0])', [cmd]);
    await hook(sessionId, 'hook.setPickedPath(a[0])', [file]);
    assert.equal(await hook(sessionId, 'hook.saveAs()'), true);
    let state =
      /** @type {{ file: { path: string | null }, dirty: boolean, meta: Record<string, string> }} */ (
        await hook(sessionId, 'hook.state()')
      );
    assert.equal(state.file.path, file);
    assert.equal(state.dirty, false);
    assert.equal(state.meta.revision, '1');
    step('save as: file written, revision 1');
    await hook(sessionId, 'hook.apply(a[0])', [cmd]);
    assert.equal(await hook(sessionId, 'hook.save()'), true);
    state = /** @type {typeof state} */ (await hook(sessionId, 'hook.state()'));
    assert.equal(state.meta.revision, '2');
    await readFile(`${file}.bak`);
    step('save: .bak rotated, revision 2');
    assert.equal(await hook(sessionId, 'hook.newDatabase()'), true);
    assert.equal(await hook(sessionId, 'hook.openPath(a[0])', [file]), true);
    state = /** @type {typeof state} */ (await hook(sessionId, 'hook.state()'));
    assert.equal(state.file.path, file);
    assert.equal(state.meta.revision, '2');
    const count = await hook(sessionId, 'hook.query(a[0])', [`SELECT count(*) FROM "${tableId}"`]);
    assert.deepEqual(/** @type {{ rows: unknown[][] }} */ (count).rows, [[2]]);
    step('reopen: same data on the workcopy');

    // 3. .bak 복원(훅으로 경로 주입) → 새 파일에 이전 저장본.
    const restored = path.join(scratch, '복원.db');
    await hook(sessionId, 'hook.setPickedPath(a[0])', [restored]);
    assert.equal(await hook(sessionId, 'hook.restoreBackup()'), true);
    const bytes = await readFile(restored);
    assert.equal(bytes.subarray(0, 15).toString('latin1'), 'SQLite format 3');
    step('restore: .bak copied to a new file');

    // 4. 원본 변경 감지: 파일을 바꾸면 저장이 E_ORIGINAL_CHANGED로 멈추고(취소) 파일은 그대로다.
    await hook(sessionId, 'hook.apply(a[0])', [cmd]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(file, await readFile(`${file}.bak`));
    const beforeSize = (await readFile(file)).byteLength;
    // 취소는 대화상자 버튼을 눌러야 한다: 대화상자가 뜨면 취소 버튼을 누른다.
    const savePromise = hook(sessionId, 'hook.save()');
    await waitFor(
      async () =>
        (await execute(
          sessionId ?? '',
          'return document.querySelector(".jdr-dialog") !== null;',
        )) === true,
      'originalChanged dialog',
    );
    await execute(
      sessionId,
      'const b = Array.from(document.querySelectorAll(".jdr-dialog button")).find((x) => x.textContent === "취소"); if (b) b.click(); return !!b;',
    );
    assert.equal(await savePromise, false);
    assert.equal(
      (await readFile(file)).byteLength,
      beforeSize,
      'cancel keeps the changed original',
    );
    step('original changed: save stopped and cancelled');

    // 5. 작업 사본 목록(설정 대화상자). 4번이 저장을 취소해 이 파일의 dirty 사본이 남은 채 앱을 끝낸다.
    await stopApp(sessionId);
    sessionId = null;
    sessionId = await startApp(binary);
    // 원본이 있는 dirty 사본은 대화상자 없이 "그 파일을 열면 복구" 안내만 한다(store.recoverWorkcopies).
    await waitFor(
      async () =>
        String(
          await execute(
            sessionId ?? '',
            'return Array.from(document.querySelectorAll(".jdr-toast")).map((e) => e.textContent).join("\\n");',
          ),
        ).includes('데스크톱 검사.db의 저장되지 않은 변경이 작업 사본에 남아 있습니다'),
      'pending workcopy notice',
    );
    // 두 번째 dirty 사본: 새 파일을 저장한 뒤 편집하고 저장하지 않은 채 끝낸다.
    const second = path.join(scratch, '둘째.db');
    const created3 = await hook(sessionId, "hook.call('schema.create', { name: '둘' })");
    const tableId2 = /** @type {{ tableId: string }} */ (created3).tableId;
    await hook(
      sessionId,
      "hook.call('schema.addColumn', { tableId: a[0], name: '값', type: 'text' })",
      [tableId2],
    );
    const cmd2 = {
      type: 'row.insert',
      tableId: tableId2,
      do: [{ sql: `INSERT INTO "${tableId2}" ("_created_at") VALUES ('now')` }],
      undo: [{ sql: `DELETE FROM "${tableId2}"` }],
      summary: 'insert',
    };
    await hook(sessionId, 'hook.apply(a[0])', [cmd2]);
    await hook(sessionId, 'hook.setPickedPath(a[0])', [second]);
    assert.equal(await hook(sessionId, 'hook.saveAs()'), true);
    await hook(sessionId, 'hook.apply(a[0])', [cmd2]);
    state = /** @type {typeof state} */ (await hook(sessionId, 'hook.state()'));
    assert.equal(state.dirty, true);
    await stopApp(sessionId);
    sessionId = null;
    step('workcopies: two dirty copies left behind');

    sessionId = await startApp(binary);
    await execute(sessionId, 'document.querySelector(\'[data-action="settings"]\').click();');
    await waitFor(
      async () => (await workcopyRows(sessionId ?? '')).length >= 2,
      'workcopy list in settings',
    );
    const rows = await workcopyRows(sessionId);
    step(`settings workcopy rows: ${JSON.stringify(rows)}`);
    assert.ok(rows.some((r) => r.startsWith('데스크톱 검사.db · ')));
    assert.ok(rows.some((r) => r.startsWith('둘째.db · ')));
    assert.equal(
      await text(sessionId, '.jdr-dialog h3.jdr-import__section:last-of-type'),
      '복구를 기다리는 작업 사본',
    );
    // 키보드: 버리기 버튼에 포커스가 가고 Enter로 누를 수 있다.
    assert.equal(await focusWorkcopyButton(sessionId, '데스크톱 검사.db', '버리기'), true);
    await pressKey(sessionId, '\uE007');
    await waitFor(
      async () =>
        !(await workcopyRows(sessionId ?? '')).some((r) => r.startsWith('데스크톱 검사.db · ')),
      'discarded row removed',
    );
    step('workcopy discarded with the keyboard');
    // 열기: 둘째.db의 사본을 연다.
    assert.equal(await focusWorkcopyButton(sessionId, '둘째.db', '열기'), true);
    await pressKey(sessionId, '\uE007');
    await waitFor(
      async () =>
        /** @type {typeof state} */ (await hook(sessionId ?? '', 'hook.state()')).file.path ===
        second,
      'workcopy opened',
    );
    state = /** @type {typeof state} */ (await hook(sessionId, 'hook.state()'));
    assert.equal(state.dirty, true, '복구한 사본의 변경은 아직 파일에 없다');
    // 연 사본의 행은 목록에서 빠진다. 남겨 두면 열린 채로 그 사본의 "버리기"를 누를 수 있었고, 러스트가
    // 열린 DB를 닫고 지워 복구한 변경이 사라진 채 모든 질의가 E_DB_QUERY로 실패했다.
    await waitFor(
      async () => !(await workcopyRows(sessionId ?? '')).some((r) => r.startsWith('둘째.db · ')),
      'opened row removed',
    );
    const count2 = await hook(sessionId, 'hook.query(a[0])', [
      `SELECT count(*) FROM "${tableId2}"`,
    ]);
    assert.deepEqual(/** @type {{ rows: unknown[][] }} */ (count2).rows, [[2]]);
    await execute(
      sessionId,
      'const b = Array.from(document.querySelectorAll(".jdr-dialog button")).find((x) => x.textContent === "취소"); if (b) b.click();',
    );
    step('workcopy opened from settings: row removed, changes recovered');
    // 저장하면 dirty가 풀려 목록에 다시 나오지 않는다.
    assert.equal(await hook(sessionId, 'hook.save()'), true);
    await execute(sessionId, 'document.querySelector(\'[data-action="settings"]\').click();');
    await waitFor(
      async () =>
        (await execute(
          sessionId ?? '',
          'return document.querySelector(".jdr-dialog") !== null;',
        )) === true,
      'settings reopened',
    );
    await new Promise((resolve) => setTimeout(resolve, 500));
    const leftover = await workcopyRows(sessionId);
    assert.ok(
      !leftover.some((r) => r.startsWith('둘째.db · ') || r.startsWith('데스크톱 검사.db · ')),
      `saved copies are not pending: ${JSON.stringify(leftover)}`,
    );
    step('saved: no pending workcopies left from this run');
    console.log('[desktop] all checks passed');
  } catch (err) {
    failed = true;
    console.error(err);
  } finally {
    if (sessionId) {
      try {
        await wd('DELETE', `/session/${sessionId}`);
      } catch {
        // 세션 종료 실패는 결과에 영향이 없다(드라이버를 곧 죽인다).
      }
    }
    driver.kill();
    await rm(scratch, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

await main();
