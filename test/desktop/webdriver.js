// @ts-check
/**
 * 데스크톱 검사(`run.mjs` E2E, `perf.mjs` 성능)가 함께 쓰는 tauri-driver·WebDriver 도우미. WebDriver 프로토콜은
 * fetch로 직접 말한다(런타임 의존 없음).
 */
import { spawn, spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
export const TAURI_DIR = path.join(ROOT, 'src-tauri');
export const DRIVER_PORT = Number(process.env.JDR_DRIVER_PORT ?? 4444);
export const BASE = `http://127.0.0.1:${DRIVER_PORT}`;
const TEST_CONFIG = JSON.stringify({
  build: { frontendDist: '../dist/test/tauri', beforeBuildCommand: '' },
});

/** @param {string} label */
export function step(label) {
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
  // 실행 자체가 실패하면 status가 null이고 원인은 error에 있다.
  if (r.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed with ${r.status ?? r.error?.message}`);
  }
}

export function binaryPath() {
  if (process.env.JDR_DESKTOP_BINARY) return process.env.JDR_DESKTOP_BINARY;
  const exe = process.platform === 'win32' ? 'jdrdatabase-desktop.exe' : 'jdrdatabase-desktop';
  return path.join(TAURI_DIR, 'target', 'debug', exe);
}

export async function buildTestApp() {
  step('build: dist/test/tauri/index.html');
  run(process.execPath, [path.join(ROOT, 'build', 'build.mjs'), '--test']);
  step('build: debug desktop binary with the test variant');
  // npx 대신 CLI 진입 스크립트를 Node로 직접 부른다. Windows의 Node 20은 `.cmd`를 셸 없이 띄우지 않고
  // (CVE-2024-27980), 셸을 거치면 cmd.exe가 JSON 인자의 따옴표를 깨뜨린다.
  const cli = path.join(ROOT, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
  run(process.execPath, [cli, 'build', '--debug', '--no-bundle', '--config', TEST_CONFIG], {
    cwd: TAURI_DIR,
  });
}

/**
 * @param {string} method
 * @param {string} route
 * @param {unknown} [body]
 * @returns {Promise<unknown>}
 */
export async function wd(method, route, body) {
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
export async function execute(sessionId, script, args = [], async = false) {
  return wd('POST', `/session/${sessionId}/execute/${async ? 'async' : 'sync'}`, { script, args });
}

/**
 * 앱의 테스트 훅으로 Promise를 돌려주는 식을 실행한다. 거부는 `{ __error }`로 온다.
 * @param {string} sessionId
 * @param {string} expression `hook`(window.__jdrTest)을 쓰는 식
 * @param {unknown[]} [args]
 */
export async function hook(sessionId, expression, args = []) {
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
export async function text(sessionId, selector) {
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
export async function waitFor(predicate, what, timeoutMs = 20_000) {
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
export async function startApp(binary) {
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
export async function stopApp(sessionId) {
  await wd('DELETE', `/session/${sessionId}`);
}

/**
 * 포커스된 요소에 실제 키 입력(WebDriver Actions)을 보낸다.
 * @param {string} sessionId
 * @param {string} key WebDriver 키 코드(예: Enter는 '\uE007')
 */
export async function pressKey(sessionId, key) {
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

/**
 * tauri-driver를 띄우고 응답할 때까지 기다린다. Windows는 WebView2 런타임과 같은 버전의 msedgedriver가 필요하다.
 * CI는 그 경로를 JDR_NATIVE_DRIVER로 준다.
 * @returns {Promise<import('node:child_process').ChildProcess>}
 */
export async function startDriver() {
  const nativeDriver = process.env.JDR_NATIVE_DRIVER;
  const driverArgs = ['--port', String(DRIVER_PORT)];
  if (nativeDriver) driverArgs.push('--native-driver', nativeDriver);
  const driver = spawn('tauri-driver', driverArgs, { stdio: 'inherit' });
  driver.on('error', (err) => {
    console.error(`tauri-driver failed to start: ${err.message}`);
    process.exit(2);
  });
  await waitFor(async () => {
    try {
      await fetch(`${BASE}/status`);
      return true;
    } catch {
      return false;
    }
  }, 'tauri-driver');
  return driver;
}
