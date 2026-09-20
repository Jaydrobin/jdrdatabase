// @ts-check
/**
 * 부트스트랩(3.1): 기능 감지, 모드 판정, Worker 기동, IndexedDB·스토어·UI 마운트, 초기 화면.
 *
 * 모드 문자열('wasm' | 'native') 판정은 이 파일에서만 한다(D-15). 다른 모듈은 `capabilities()`를 읽는다.
 * 데스크톱 모드는 Step 11에서 채워지며, 그 전까지는 `E_UNSUPPORTED`로 잠긴다(wasm 폴백 없음, D-15).
 */
import { createSchemaCommands, editCell } from './app/commands.js';
import { createHistory } from './app/history.js';
import { createStore } from './app/store.js';
import { createClient, createTransport } from './db/client.js';
import { nowIso } from './db/schema.js';
import { t } from './i18n/index.js';
import { createAutosave } from './io/autosave.js';
import * as filesystem from './io/filesystem.js';
import { openIdb } from './io/idb.js';
import { createTabLock } from './io/tablock.js';
import { createPrompts } from './ui/dialogs/conflict.js';
import { confirmDialog } from './ui/dialogs/dialog.js';
import { mountLongtextPanel } from './ui/editor/longtext.js';
import { mountGridHost } from './ui/grid/grid.js';
import { mountSidebar } from './ui/sidebar.js';
import { mountStatusbar } from './ui/statusbar.js';
import { mountToasts } from './ui/toast.js';
import { mountToolbar } from './ui/toolbar.js';
import { base64ToBytes } from './util/bytes.js';
import { AppError, toAppError } from './util/errors.js';
import { formatInteger } from './util/format.js';

/** @typedef {import('./db/client.js').Client} Client */
/** @typedef {import('./db/engine.js').EngineMode} EngineMode */
/** @typedef {import('./db/engine.js').EngineCapabilities} EngineCapabilities */
/** @typedef {import('./i18n/index.js').MessageKey} MessageKey */
/** @typedef {import('./ui/statusbar.js').Statusbar} Statusbar */
/** @typedef {import('./ui/toast.js').Toasts} Toasts */
/** @typedef {import('./app/store.js').Store} Store */
/** @typedef {import('./io/idb.js').Idb} Idb */
/** @typedef {import('./ui/grid/grid.js').GridHost} GridHost */

/** IDB `settings`에서 이 기기 이름(`saved_by`)을 두는 키. */
const DEVICE_NAME_KEY = 'device_name';

/**
 * @typedef {object} Shell
 * @property {HTMLElement} toolbarHost
 * @property {HTMLElement} body 사이드바와 메인 영역을 담는 가로 배치 컨테이너
 * @property {HTMLElement} main
 * @property {HTMLElement} welcome 테이블을 고르기 전에 보이는 제목·설명 블록
 * @property {Statusbar} statusbar
 * @property {Toasts} toasts
 */

/**
 * 정적 마크업을 만들고 문구는 textContent로 넣는다(CLAUDE.md 5.5).
 * @param {HTMLElement} root
 * @returns {Shell}
 */
function mount(root) {
  root.textContent = '';

  const toolbarHost = document.createElement('div');
  toolbarHost.className = 'jdr-app__toolbar';

  const main = document.createElement('main');
  main.className = 'jdr-app__main';

  const title = document.createElement('h1');
  title.className = 'jdr-app__title';
  title.textContent = t('app.title');

  const subtitle = document.createElement('p');
  subtitle.className = 'jdr-app__subtitle';
  subtitle.textContent = t('app.subtitle');

  const welcome = document.createElement('div');
  welcome.className = 'jdr-app__welcome';
  welcome.append(title, subtitle);
  main.append(welcome);
  const body = document.createElement('div');
  body.className = 'jdr-app__body';
  body.append(main);
  root.append(toolbarHost, body);

  const statusbar = mountStatusbar(root, { version: __JDR_VERSION__ });
  const toasts = mountToasts(root);
  return { toolbarHost, body, main, welcome, statusbar, toasts };
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
  shell.statusbar.setStatus('lock.title');
  shell.statusbar.setDanger(true);
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
 * @property {EngineCapabilities} capabilities
 */

/**
 * 전송 계층을 만들고 엔진을 초기화한다. `openEmpty`면 빈 메모리 DB까지 연다(진단 세션용).
 * @param {{ mode: EngineMode, transport: 'auto' | 'inline', workerSource: string, wasmB64: string, openEmpty: boolean }} opts
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
      { mode: opts.mode, wasmBinary, appVersion: __JDR_VERSION__ },
      { transfer: [wasmBinary] },
    );
    if (opts.openEmpty) await client.call('db.open', {});
    return {
      client,
      transportKind: transport.kind,
      fallbackError,
      sqliteVersion: info.version,
      capabilities: info.capabilities,
    };
  } catch (err) {
    client.close();
    throw toAppError(err);
  }
}

/**
 * 이 기기 이름(`_jdr_meta.saved_by`). IDB 설정에 있으면 그것, 없으면 만들어 저장한다(D-10).
 * @param {Idb | null} idb
 * @returns {Promise<string>}
 */
async function loadDeviceName(idb) {
  const generated = t('device.defaultName', {
    id: Math.random().toString(36).slice(2, 6).toUpperCase(),
  });
  if (!idb) return generated;
  try {
    const stored = await idb.get('settings', DEVICE_NAME_KEY);
    if (typeof stored === 'string' && stored) return stored;
    await idb.put('settings', DEVICE_NAME_KEY, generated);
  } catch (err) {
    console.warn(toAppError(err));
  }
  return generated;
}

/**
 * 셸을 띄운 뒤의 모든 시작 작업. 여기서 던지는 오류는 `boot()`가 잠금 화면으로 바꾼다.
 * @param {Shell} shell
 */
async function start(shell) {
  const mode = detectMode();
  const workerSource = readEmbedded('jdr-worker-src');
  const wasmB64 = readEmbedded('jdr-wasm-b64');

  /** @type {Promise<EngineSession>} */
  const ready = startEngine({ mode, transport: 'auto', workerSource, wasmB64, openEmpty: false });

  /** @type {Store | null} */
  let store = null;
  /** @type {Idb | null} */
  let idb = null;
  let tabLockAvailable = false;
  /** @type {import('./io/autosave.js').Autosave | null} */
  let journal = null;
  /** @type {GridHost | null} */
  let gridHost = null;
  /** @type {import('./app/history.js').History | null} */
  let historyRef = null;

  if (__JDR_TEST__) {
    /** @type {Promise<{ transportKind: string, sqliteVersion: string }>} */
    const readyInfo = ready.then((s) => ({
      transportKind: s.transportKind,
      sqliteVersion: s.sqliteVersion,
    }));
    // 훅을 아무도 기다리지 않을 때의 미처리 거부를 막는다. 훅 사용자는 readyInfo를 그대로 받는다.
    readyInfo.catch(() => {});
    // 테스트 빌드 전용 훅(CLAUDE.md 6장). 릴리스 빌드에서는 define으로 제거된다.
    Object.defineProperty(window, '__jdrTest', {
      value: Object.freeze({
        version: __JDR_VERSION__,
        mode,
        ready: readyInfo,
        /**
         * 지정한 전송 계층으로 별도 세션을 띄워 SQL을 실행하고 마지막 문장의 결과를 돌려준다.
         * 문장 목록을 주면 같은 세션에서 차례로 실행한다(E2E의 FTS5 준비처럼 DDL → INSERT → SELECT).
         * @param {'auto' | 'inline'} transport
         * @param {string | string[]} sql
         */
        async exec(transport, sql) {
          const statements = Array.isArray(sql) ? sql : [sql];
          const session = await startEngine({
            mode,
            transport,
            workerSource,
            wasmB64,
            openEmpty: true,
          });
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
        /** 스토어 상태 스냅샷(구조화 복제 가능한 부분만). */
        state() {
          if (!store) return null;
          const s = store.getState();
          return {
            file: { name: s.file.name, hasHandle: s.file.handle !== null, size: s.file.size },
            meta: s.meta,
            tables: s.tables,
            dirty: s.dirty,
            readOnly: s.readOnly,
            journalFull: s.journalFull,
          };
        },
        /** IndexedDB를 실제로 열 수 있었는가(지원 매트릭스 실측용). */
        idbAvailable: () => idb !== null,
        /** BroadcastChannel을 쓸 수 있는가(지원 매트릭스 실측용). */
        tabLockAvailable: () => tabLockAvailable,
        /** 저널에 남은 기록 요약(없으면 null). E2E가 비움이 끝났는지 확인한다. */
        journalPending: () => (journal ? journal.pending() : Promise.resolve(null)),
        /**
         * 메인 세션에 커맨드를 적용하고 저널·dirty에 반영한다(Step 3 전에 저널 복구 E2E가 쓴다).
         * @param {import('./db/command.js').Command} cmd
         */
        async apply(cmd) {
          const s = await ready;
          if (!store) throw new AppError('E_UNKNOWN', 'store is not ready');
          const result = await s.client.call('command.apply', { cmd });
          await store.recordCommand(cmd);
          return result;
        },
        /**
         * 메인 세션의 DB에 진단 질의를 보낸다.
         * @param {string} sql
         */
        async query(sql) {
          const s = await ready;
          return s.client.call('engine.exec', { sql });
        },
        /** 열린 그리드의 렌더·질의 통계(Step 4 성능 측정용). 그리드가 없으면 null. */
        grid: () => (gridHost ? gridHost.stats() : null),
        /** 히스토리 스택 크기(Step 5 E2E용). */
        history: () => (historyRef ? historyRef.state() : null),
      }),
      configurable: false,
      writable: false,
    });
  }

  const session = await ready;
  const opened = await openIdb();
  idb = opened.idb;
  if (opened.error) console.warn(`${opened.error.code}: ${opened.error.message}`);

  const deviceName = await loadDeviceName(idb);
  const tablock = createTabLock();
  tabLockAvailable = tablock.available;
  const autosave = createAutosave({ idb });
  journal = autosave;
  store = createStore({
    client: session.client,
    caps: session.capabilities,
    fs: filesystem,
    idb,
    autosave,
    tablock,
    prompts: createPrompts(),
    notify: { error: (err) => shell.toasts.error(err), info: (k, p) => shell.toasts.info(k, p) },
    deviceName,
    defaultFileName: t('file.defaultName'),
  });
  const active = store;
  const history = createHistory({
    client: session.client,
    store: active,
    notify: { error: (err) => shell.toasts.error(err), info: (k, p) => shell.toasts.info(k, p) },
  });

  historyRef = history;
  mountToolbar(shell.toolbarHost, active, history);
  const sidebar = mountSidebar(shell.body, {
    store: active,
    commands: createSchemaCommands(active),
    toasts: shell.toasts,
  });
  shell.body.prepend(sidebar.el);
  // 장문 편집기는 그리드 오른쪽의 사이드 패널이다. 확정은 셀 편집 커맨드 하나로 히스토리에 들어간다.
  const longtext = mountLongtextPanel(shell.body, {
    client: session.client,
    toasts: shell.toasts,
    onSave: async ({ target, oldValue, oldUpdatedAt, newValue }) => {
      if (oldValue === newValue) return true;
      const result = await history.apply(
        editCell({
          tableId: target.tableId,
          rowId: target.rowId,
          colId: target.column.id,
          oldValue,
          newValue,
          oldUpdatedAt,
          now: nowIso(),
        }),
      );
      return result !== null;
    },
  });
  gridHost = mountGridHost(shell.main, {
    store: active,
    client: session.client,
    toasts: shell.toasts,
    history,
    longtext,
    confirmIrreversible: ({ count }) =>
      confirmDialog({
        title: t('confirm.irreversible.title'),
        message: t('confirm.irreversible.message', { count: formatInteger(count) }),
        okLabel: t('confirm.irreversible.ok'),
        danger: true,
      }),
  });

  /** @param {BeforeUnloadEvent} ev */
  const onBeforeUnload = (ev) => {
    if (!active.getState().dirty) return;
    ev.preventDefault();
    // 문구는 브라우저가 정하지만 옛 브라우저 호환을 위해 값을 둔다.
    ev.returnValue = t('unload.dirty');
  };
  window.addEventListener('beforeunload', onBeforeUnload);

  active.on('state:changed', () => {
    const s = active.getState();
    shell.statusbar.setNote(
      s.readOnly !== 'none' ? 'status.readOnly' : idb ? null : 'status.noIdb',
    );
    shell.welcome.hidden = s.currentTableId !== null;
  });

  await active.newDatabase({ force: true });
  shell.statusbar.setStatus('status.ready');
  shell.statusbar.setMode(
    session.transportKind === 'worker' ? 'status.mode.worker' : 'status.mode.inline',
  );
  shell.statusbar.setEngine(session.sqliteVersion);
  shell.statusbar.setNote(idb ? null : 'status.noIdb');
  if (session.fallbackError) {
    console.warn(`${session.fallbackError.code}: ${session.fallbackError.message}`);
  }
  await active.recoverPending();
}

async function boot() {
  const root = document.getElementById('app');
  if (!root) throw new AppError('E_UNKNOWN', 'root element #app is missing');
  document.title = t('app.title');
  const shell = mount(root);
  // 셸을 띄운 뒤의 실패는 모두 잠금 화면으로 간다. 기능 감지·임베드 블록 읽기처럼
  // 엔진 기동 전에 던지는 것도 포함된다.
  try {
    await start(shell);
  } catch (err) {
    const appErr = toAppError(err);
    console.error(appErr);
    showLock(shell, appErr);
  }
}

// 잠금 화면조차 띄울 수 없는 경우(#app 없음, mount 실패)를 미처리 거부로 남기지 않는다.
void boot().catch((err) => {
  console.error(toAppError(err));
});
