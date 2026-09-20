// @ts-check
/**
 * 부트스트랩(3.1): 기능 감지, 모드 판정, Worker 기동, 초기 화면.
 *
 * 모드 문자열('wasm' | 'native') 판정은 이 파일에서만 한다(D-15). 다른 모듈은 `capabilities()`를 읽는다.
 * 데스크톱 모드는 Step 11에서 채워지며, 그 전까지는 `E_UNSUPPORTED`로 잠긴다(wasm 폴백 없음, D-15).
 */
import { createClient, createTransport } from './db/client.js';
import { t } from './i18n/index.js';
import { base64ToBytes } from './util/bytes.js';
import { AppError, toAppError } from './util/errors.js';

/** @typedef {import('./db/client.js').Client} Client */
/** @typedef {import('./db/engine.js').EngineMode} EngineMode */
/** @typedef {import('./i18n/index.js').MessageKey} MessageKey */

/**
 * @typedef {object} Shell
 * @property {HTMLElement} main
 * @property {HTMLElement} status
 * @property {HTMLElement} mode
 * @property {HTMLElement} engine
 */

/**
 * 정적 마크업을 만들고 문구는 textContent로 넣는다(CLAUDE.md 5.5).
 * @param {HTMLElement} root
 * @returns {Shell}
 */
function mount(root) {
  root.textContent = '';

  const main = document.createElement('main');
  main.className = 'jdr-app__main';

  const title = document.createElement('h1');
  title.className = 'jdr-app__title';
  title.textContent = t('app.title');

  const subtitle = document.createElement('p');
  subtitle.className = 'jdr-app__subtitle';
  subtitle.textContent = t('app.subtitle');

  main.append(title, subtitle);

  const statusbar = document.createElement('footer');
  statusbar.className = 'jdr-statusbar';
  const status = document.createElement('span');
  status.className = 'jdr-statusbar__item';
  status.textContent = t('status.booting');
  const mode = document.createElement('span');
  mode.className = 'jdr-statusbar__item';
  const engine = document.createElement('span');
  engine.className = 'jdr-statusbar__item';
  const version = document.createElement('span');
  version.className = 'jdr-statusbar__item';
  version.textContent = t('app.version', { version: __JDR_VERSION__ });
  statusbar.append(status, mode, engine, version);

  root.append(main, statusbar);
  return { main, status, mode, engine };
}

/**
 * 시작 실패 화면. 원인과 지원 브라우저를 보여 주고 앱을 잠근다.
 * @param {Shell} shell
 * @param {AppError} err
 */
function showLock(shell, err) {
  shell.main.textContent = '';
  const box = document.createElement('section');
  box.className = 'jdr-lock';
  box.setAttribute('role', 'alert');

  const title = document.createElement('h2');
  title.className = 'jdr-lock__title';
  title.textContent = t('lock.title');

  const message = document.createElement('p');
  message.className = 'jdr-lock__message';
  message.textContent = t(/** @type {MessageKey} */ (`error.${err.code}`));

  const supported = document.createElement('p');
  supported.className = 'jdr-lock__message';
  supported.textContent = t('lock.supportedBrowsers');

  const detail = document.createElement('p');
  detail.className = 'jdr-lock__detail';
  const cause = err.cause instanceof Error ? err.cause.message : err.message;
  detail.textContent = t('lock.cause', { message: `${err.code}: ${cause.slice(0, 300)}` });

  box.append(title, message, supported, detail);
  shell.main.append(box);
  shell.status.textContent = t('lock.title');
  shell.status.classList.add('jdr-statusbar__item--danger');
}

/**
 * 타우리 전역 객체의 존재로 모드를 판정한다(D-15). 기능 감지는 try/catch로 감싼다(CLAUDE.md 5.6).
 * @returns {EngineMode}
 */
function detectMode() {
  try {
    return '__TAURI_INTERNALS__' in window ? 'native' : 'wasm';
  } catch {
    return 'wasm';
  }
}

/**
 * @param {string} id
 * @returns {string}
 */
function readEmbedded(id) {
  const el = document.getElementById(id);
  if (!el) throw new AppError('E_UNKNOWN', `embedded block #${id} is missing`);
  return el.textContent ?? '';
}

/**
 * @typedef {object} EngineSession
 * @property {Client} client
 * @property {'worker' | 'inline'} transportKind
 * @property {AppError | null} fallbackError
 * @property {string} sqliteVersion
 */

/**
 * 전송 계층을 만들고 엔진을 초기화한 뒤 빈 메모리 DB를 연다.
 * @param {{ mode: EngineMode, transport: 'auto' | 'inline', workerSource: string, wasmB64: string }} opts
 * @returns {Promise<EngineSession>}
 */
async function startEngine(opts) {
  const { transport, fallbackError } = await createTransport({
    workerSource: opts.transport === 'inline' ? undefined : opts.workerSource,
  });
  const client = createClient({ transport });
  const wasmBinary = base64ToBytes(opts.wasmB64).buffer;
  try {
    const info = await client.call(
      'engine.init',
      { mode: opts.mode, wasmBinary },
      { transfer: [wasmBinary] },
    );
    await client.call('db.open', {});
    return { client, transportKind: transport.kind, fallbackError, sqliteVersion: info.version };
  } catch (err) {
    client.close();
    throw toAppError(err);
  }
}

async function boot() {
  const root = document.getElementById('app');
  if (!root) throw new Error('#app 루트 요소가 없습니다.');
  document.title = t('app.title');
  const shell = mount(root);

  const mode = detectMode();
  const workerSource = readEmbedded('jdr-worker-src');
  const wasmB64 = readEmbedded('jdr-wasm-b64');

  /** @type {Promise<EngineSession>} */
  const ready = startEngine({ mode, transport: 'auto', workerSource, wasmB64 });

  if (__JDR_TEST__) {
    // 테스트 빌드 전용 훅(CLAUDE.md 6장). 릴리스 빌드에서는 define으로 제거된다.
    Object.defineProperty(window, '__jdrTest', {
      value: Object.freeze({
        version: __JDR_VERSION__,
        mode,
        ready: ready.then((s) => ({
          transportKind: s.transportKind,
          sqliteVersion: s.sqliteVersion,
        })),
        /**
         * 지정한 전송 계층으로 별도 세션을 띄워 SQL을 실행하고 마지막 문장의 결과를 돌려준다.
         * 문장 목록을 주면 같은 세션에서 차례로 실행한다(E2E의 FTS5 준비처럼 DDL → INSERT → SELECT).
         * @param {'auto' | 'inline'} transport
         * @param {string | string[]} sql
         */
        async exec(transport, sql) {
          const statements = Array.isArray(sql) ? sql : [sql];
          const session = await startEngine({ mode, transport, workerSource, wasmB64 });
          try {
            /** @type {import('./db/engine.js').ExecResult} */
            let result = { columns: [], rows: [] };
            for (const statement of statements) {
              result = await session.client.call('engine.exec', { sql: statement });
            }
            return { transportKind: session.transportKind, ...result };
          } finally {
            await session.client.call('db.close');
            session.client.close();
          }
        },
      }),
      configurable: false,
      writable: false,
    });
  }

  try {
    const session = await ready;
    shell.status.textContent = t('status.ready');
    shell.mode.textContent = t(
      session.transportKind === 'worker' ? 'status.mode.worker' : 'status.mode.inline',
    );
    shell.engine.textContent = t('status.engine', { version: session.sqliteVersion });
    if (session.fallbackError) {
      console.warn(`${session.fallbackError.code}: ${session.fallbackError.message}`);
    }
  } catch (err) {
    const appErr = toAppError(err);
    console.error(appErr);
    showLock(shell, appErr);
  }
}

void boot();
