// @ts-check
/**
 * 데스크톱 E2E(Step 11): tauri-driver(WebDriver)로 테스트 빌드 앱을 띄워 브라우저 E2E와 같은 시나리오를 검사한다.
 *
 * 준비물: Linux는 `WebKitWebDriver`(webkit2gtk-driver)와 `Xvfb`(또는 실제 디스플레이), Windows는 WebView2 런타임과
 * 같은 버전의 Microsoft Edge Driver(`msedgedriver.exe`, 경로를 `JDR_NATIVE_DRIVER`로 준다. 없으면 tauri-driver가
 * PATH에서 찾는다). `tauri-driver`는 `cargo install tauri-driver`. 파일 대화상자는 자동화할 수 없으므로 테스트 훅
 * `__jdrTest.setPickedPath()`로 경로를 넣는다(DESIGN.md Step 11 완료 기준).
 *
 * 흐름: `npm run build -- --test`(dist/test/tauri/index.html) → `tauri build --debug --no-bundle`(그 변형을 담은 바이너리)
 *      → tauri-driver 기동 → WebDriver 세션 → 검사 → 종료. `JDR_DESKTOP_BINARY`가 있으면 빌드를 건너뛴다.
 * WebDriver 프로토콜은 fetch로 직접 말한다(런타임 의존 없음). node:test 없이 순서대로 돌리고 실패는 예외로 끝낸다.
 */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  binaryPath,
  buildTestApp,
  DRIVER_PORT,
  execute,
  hook,
  pressKey,
  startApp,
  startDriver,
  step,
  stopApp,
  text,
  waitFor,
  wd,
} from './webdriver.js';

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

async function main() {
  if (!process.env.JDR_DESKTOP_BINARY) await buildTestApp();
  const binary = binaryPath();
  // Windows 러너의 임시 폴더는 8.3 짧은 이름(RUNNER~1)일 수 있다. 앱이 돌려주는 경로와 비교하므로 긴 이름으로 둔다.
  const scratch = await realpath(await mkdtemp(path.join(os.tmpdir(), 'jdr-desktop-')));
  step(`tauri-driver on ${DRIVER_PORT} for ${binary}`);
  const driver = await startDriver();
  /** @type {string | null} */
  let sessionId = null;
  let failed = false;
  try {
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
    // 취소는 대화상자 버튼을 눌러야 한다: 대화상자가 뜨면 취소 버튼을 누른다. 저장은 페이지 안에서 시작만 하고
    // Promise를 창에 둔다. Edge Driver(Windows)는 세션의 명령을 하나씩 처리하므로, 저장을 기다리는 비동기 스크립트를
    // 걸어 둔 채 대화상자를 찾는 스크립트를 보내면 서로 기다리다 스크립트 시간 초과로 끝난다(WebKitWebDriver는 동시에 받는다).
    await execute(sessionId, 'window.__jdrPendingSave = window.__jdrTest.save(); return true;');
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
    assert.equal(await hook(sessionId, 'window.__jdrPendingSave'), false);
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
    await execute(
      sessionId,
      'const b = Array.from(document.querySelectorAll(".jdr-dialog button")).find((x) => x.textContent === "취소"); if (b) b.click();',
    );

    // 6. 작업 사본 모두 버리기(D-18, Step 13): dirty 사본 두 개를 남긴 뒤 "모두 버리기" → 목록이 비고 원본 파일은 그대로.
    await hook(sessionId, 'hook.apply(a[0])', [cmd2]);
    const secondBytes = await readFile(second);
    await stopApp(sessionId);
    sessionId = null;
    sessionId = await startApp(binary);
    const third = path.join(scratch, '셋째.db');
    const created4 = await hook(sessionId, "hook.call('schema.create', { name: '셋' })");
    const tableId3 = /** @type {{ tableId: string }} */ (created4).tableId;
    const cmd3 = {
      type: 'row.insert',
      tableId: tableId3,
      do: [{ sql: `INSERT INTO "${tableId3}" ("_created_at") VALUES ('now')` }],
      undo: [{ sql: `DELETE FROM "${tableId3}"` }],
      summary: 'insert',
    };
    await hook(sessionId, 'hook.apply(a[0])', [cmd3]);
    await hook(sessionId, 'hook.setPickedPath(a[0])', [third]);
    assert.equal(await hook(sessionId, 'hook.saveAs()'), true);
    await hook(sessionId, 'hook.apply(a[0])', [cmd3]);
    const thirdBytes = await readFile(third);
    await stopApp(sessionId);
    sessionId = null;
    step('discard all: two dirty copies left behind');

    sessionId = await startApp(binary);
    await execute(sessionId, 'document.querySelector(\'[data-action="settings"]\').click();');
    await waitFor(async () => {
      const r = await workcopyRows(sessionId ?? '');
      return r.some((x) => x.startsWith('둘째.db · ')) && r.some((x) => x.startsWith('셋째.db · '));
    }, 'two dirty copies in settings');
    const pending = (await workcopyRows(sessionId)).length;
    await execute(
      sessionId,
      'document.querySelector(\'[data-action="workcopy-discard-all"]\').click();',
    );
    await waitFor(
      async () =>
        String(
          await execute(
            sessionId ?? '',
            'const c = document.querySelector(\'[data-role="workcopy-discard"]\'); return c && !c.hidden ? c.textContent : "";',
          ),
        ).includes(`작업 사본 ${pending}개`),
      'discard-all confirm row',
    );
    await execute(
      sessionId,
      'document.querySelector(\'[data-action="workcopy-discard-ok"]\').click();',
    );
    await waitFor(async () => (await workcopyRows(sessionId ?? '')).length === 0, 'list emptied');
    assert.deepEqual(await readFile(second), secondBytes, '둘째.db 원본은 그대로');
    assert.deepEqual(await readFile(third), thirdBytes, '셋째.db 원본은 그대로');
    await execute(
      sessionId,
      'const b = Array.from(document.querySelectorAll(".jdr-dialog button")).find((x) => x.textContent === "취소"); if (b) b.click();',
    );
    // 다시 열어도 목록이 없다(사본이 실제로 지워졌다).
    await execute(sessionId, 'document.querySelector(\'[data-action="settings"]\').click();');
    await new Promise((resolve) => setTimeout(resolve, 500));
    assert.deepEqual(await workcopyRows(sessionId), []);
    step(`discard all: ${pending} copies removed, originals unchanged`);

    // 7. 도움말(D-19, Step 14): 저장 주제가 데스크톱 문구(작업 사본·.bak)다. F1과 툴팁은 WebView별 실측을 남긴다.
    // 콜백 안에서는 null 좁히기가 풀리므로 지금 세션을 상수로 둔다.
    const sid = sessionId;
    await execute(
      sid,
      // 설정 본문의 확인 줄에도 "취소"가 있으므로 버튼 행의 취소를 누른다.
      'document.querySelector(\'.jdr-dialog__buttons button[data-value="cancel"]\')?.click();',
    );
    await waitFor(
      async () =>
        (await execute(sid, 'return document.querySelector(".jdr-dialog") === null;')) === true,
      'settings closed',
    );
    // 스크립트의 click()은 포커스를 옮기지 않는다. 닫힌 뒤 포커스가 돌아오는지 보려면 먼저 버튼에 포커스를 둔다.
    await execute(
      sid,
      'const b = document.querySelector(\'[data-action="help-open"]\'); b.focus(); b.click();',
    );
    await waitFor(async () => (await text(sid, '.jdr-dialog__title')) === '도움말', 'help dialog');
    await execute(
      sid,
      'Array.from(document.querySelectorAll(\'.jdr-dialog [role="tab"]\')).find((x) => x.textContent === "저장과 복구").click();',
    );
    const saving = /** @type {string} */ (await text(sid, '.jdr-dialog [role="tabpanel"]'));
    assert.match(saving, /작업 사본/);
    assert.match(saving, /\.bak/);
    assert.doesNotMatch(saving, /저널/);
    step('help: saving topic describes the work copy and .bak');
    await pressKey(sid, '\uE00C');
    await waitFor(
      async () =>
        (await execute(
          sid,
          'return document.querySelector(".jdr-dialog") === null && document.activeElement?.dataset.action === "help-open";',
        )) === true,
      'help closed with Esc and focus back on the help button',
    );
    // 툴팁: 키보드 포커스로 즉시 보인다(도움말 버튼에서 Shift+Tab → 앞 버튼).
    await wd('POST', `/session/${sid}/actions`, {
      actions: [
        {
          type: 'key',
          id: 'keyboard',
          actions: [
            { type: 'keyDown', value: '\uE008' },
            { type: 'keyDown', value: '\uE004' },
            { type: 'keyUp', value: '\uE004' },
            { type: 'keyUp', value: '\uE008' },
          ],
        },
      ],
    });
    await wd('DELETE', `/session/${sid}/actions`);
    await waitFor(
      async () =>
        (await execute(
          sid,
          'const t = document.getElementById("jdr-tooltip"); return !!t && !t.hidden && t.textContent !== "" && document.activeElement?.getAttribute("aria-describedby") === "jdr-tooltip";',
        )) === true,
      'tooltip on keyboard focus',
      3_000,
    );
    step(`tooltip on keyboard focus: ${JSON.stringify(await text(sid, '#jdr-tooltip'))}`);
    await pressKey(sid, '\uE00C');
    // F1: WebView가 가로채지 않으면 도움말이 열린다(실측만 남기고 실패로 보지 않는다. 버튼 경로는 위에서 확인).
    await pressKey(sid, '\uE031');
    let f1 = false;
    try {
      await waitFor(async () => (await text(sid, '.jdr-dialog__title')) === '도움말', 'F1', 3_000);
      f1 = true;
      await pressKey(sid, '\uE00C');
    } catch {
      f1 = false;
    }
    step(`F1 opens help: ${f1}`);
    // 비활성 버튼의 툴팁: 포인터를 꺼진 버튼(고른 뷰가 없으면 "뷰 삭제", 테이블이 없으면 "되돌리기")에 올린다.
    const disabled = /** @type {{ x: number, y: number, action: string } | null} */ (
      await execute(
        sid,
        'const b = document.querySelector("button[data-action][disabled]"); if (!b) return null; const r = b.getBoundingClientRect(); return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2), action: b.dataset.action };',
      )
    );
    if (disabled) {
      await wd('POST', `/session/${sid}/actions`, {
        actions: [
          {
            type: 'pointer',
            id: 'mouse',
            parameters: { pointerType: 'mouse' },
            actions: [
              {
                type: 'pointerMove',
                duration: 0,
                origin: 'viewport',
                x: disabled.x,
                y: disabled.y,
              },
            ],
          },
        ],
      });
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      const shown = await execute(
        sid,
        'const t = document.getElementById("jdr-tooltip"); return !!t && !t.hidden && t.textContent !== "";',
      );
      await wd('DELETE', `/session/${sid}/actions`);
      step(`tooltip on disabled button (${disabled.action}): ${shown}`);
    }
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
