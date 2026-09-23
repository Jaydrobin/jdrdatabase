// @ts-check
/**
 * 데스크톱 성능(Step 11, DESIGN.md 8장 데스크톱 표): 500만 행 × 20열(약 5 GB) DB로 열기·작업 사본 복사·창 질의·
 * `run_batch`·저장·상주 메모리를 실제 앱(Worker → 엔진 프로토콜 → rusqlite)에서 잰다.
 *
 * 사용: `node test/desktop/perf.mjs <DB 경로>` (Linux는 `xvfb-run -a -s "-screen 0 1400x900x24"`로 감싼다).
 * 경로에 파일이 없으면 만든다: `gen-fixture`의 wasm 엔진으로 30만 행 기반 DB(약 300 MB)를 만들고, 앱 안에서
 * `INSERT … SELECT`로 500만 행까지 늘려 저장한다. wasm 엔진은 DB 전체를 메모리에 두므로 5 GB를 직접 만들 수 없다.
 * 바이너리는 릴리스 프로필로 만든다(디버그는 번들 SQLite를 최적화 없이 컴파일해 저장·질의가 느리다).
 * `JDR_DESKTOP_BINARY`가 있으면 빌드를 건너뛴다. 디스크는 픽스처의 약 3배(원본·작업 사본·저장 임시 파일)가 필요하다.
 *
 * 로컬 판정용이다(CI에서 돌리지 않는다). 결과를 표로 찍고 예산을 하나라도 넘으면 1로 끝난다. 상주 메모리는
 * Linux의 `/proc`로만 잰다.
 */
import { spawnSync } from 'node:child_process';
import { copyFile, open, readdir, readFile, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { generateDb, longCell, makeRandom } from '../../scripts/gen-fixture.mjs';
import {
  binaryPath,
  buildTestApp,
  execute,
  hook,
  startApp,
  startDriver,
  step,
  stopApp,
} from './webdriver.js';

const TARGET_ROWS = 5_000_000;
const BASE_ROWS = 300_000;
const WINDOW_ROWS = 200;
const BATCH_ROWS = 1_000;
const MB = 1024 * 1024;

/** 8장 데스크톱 표의 예산. 복사·저장은 같은 크기 파일을 복사하고 fsync한 시간에 대한 배수다(아래 measure 참고). */
const BUDGET = Object.freeze({
  openMs: 2_000,
  copyRatio: 1.2,
  windowMs: 50,
  batchMs: 100,
  saveRatio: 1.5,
  rssBytes: 500 * MB,
});

/**
 * 페이지 안에서 식을 실행하고 걸린 시간(ms)을 함께 돌려준다. WebDriver 왕복은 시간에 들어가지 않는다.
 * @param {string} sessionId
 * @param {string} expression `hook`(window.__jdrTest)과 `a`(인자 배열)를 쓰는 식
 * @param {unknown[]} [args]
 * @returns {Promise<{ value: unknown, ms: number }>}
 */
async function timed(sessionId, expression, args = []) {
  const script = `const done = arguments[arguments.length - 1]; const hook = window.__jdrTest; const a = Array.from(arguments).slice(0, -1); const t0 = performance.now(); Promise.resolve().then(() => (${expression})).then((v) => done({ value: v === undefined ? null : v, ms: performance.now() - t0 }), (e) => done({ __error: String(e && e.code ? e.code + ': ' + e.message : e) }));`;
  const result = /** @type {{ value: unknown, ms: number } | { __error: string }} */ (
    await execute(sessionId, script, args, true)
  );
  if ('__error' in result) throw new Error(result.__error);
  return result;
}

/**
 * @typedef {object} Opened
 * @property {Array<{ id: string, columns: Array<{ id: string, type: string, deletedAt: string | null }> }>} tables
 * @property {{ copyMs: number, openMs: number, size: number, workcopyKey: string } | undefined} workcopy
 */

/**
 * 첫 사용자 테이블과 그 물리 열 이름(`id` 제외).
 * @param {string} sessionId
 * @param {Opened} opened
 */
async function tableShape(sessionId, opened) {
  const table = opened.tables[0];
  if (!table) throw new Error('fixture has no table');
  const info = /** @type {{ rows: unknown[][] }} */ (
    await hook(sessionId, 'hook.query(a[0])', [
      `SELECT name FROM pragma_table_info('${table.id}') WHERE name <> 'id' LIMIT 100`,
    ])
  );
  return { table, physical: info.rows.map((r) => String(r[0])) };
}

/**
 * 30만 행 기반 DB를 만들고 앱 안에서 500만 행까지 늘려 `target`에 둔다.
 * @param {string} binary
 * @param {string} target
 */
async function prepare(binary, target) {
  const base = `${target}.base.db`;
  step(`prepare: ${BASE_ROWS} rows with the wasm engine -> ${base}`);
  await generateDb({ rows: BASE_ROWS, cols: 20, long: 2, out: base });
  const sessionId = await startApp(binary);
  try {
    const opened = /** @type {Opened} */ (
      await hook(sessionId, "hook.call('db.open', { originalPath: a[0] })", [base])
    );
    const { table, physical } = await tableShape(sessionId, opened);
    const idents = physical.map((c) => `"${c}"`).join(', ');
    const grow = `INSERT INTO "${table.id}" (${idents}) SELECT ${idents} FROM "${table.id}" WHERE "id" <= ?`;
    for (let rows = BASE_ROWS; rows < TARGET_ROWS;) {
      const take = Math.min(BASE_ROWS, TARGET_ROWS - rows);
      await hook(sessionId, "hook.call('command.apply', { cmd: a[0] })", [
        {
          type: 'perf.grow',
          tableId: table.id,
          do: [{ sql: grow, params: [take] }],
          undo: [],
          summary: 'grow fixture',
        },
      ]);
      rows += take;
      step(`prepare: ${rows} rows`);
    }
    await hook(sessionId, "hook.call('db.save', { originalPath: a[0] })", [base]);
    await hook(sessionId, "hook.call('db.close', { discardWorkcopy: true })");
  } finally {
    await stopApp(sessionId);
  }
  await rename(base, target);
  await rm(`${base}.bak`, { force: true });
  step(`prepare: ${target} (${(await stat(target)).size} bytes)`);
}

/**
 * 이름에 `needle`이 든 프로세스의 pid(Linux). 없으면 빈 배열.
 * @param {string} needle
 * @returns {Promise<number[]>}
 */
async function pidsOf(needle) {
  if (process.platform !== 'linux') return [];
  /** @type {number[]} */
  const out = [];
  for (const entry of await readdir('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const cmd = await readFile(`/proc/${entry}/cmdline`, 'utf8');
      if (cmd.includes(needle)) out.push(Number(entry));
    } catch {
      // 사이에 끝난 프로세스는 건너뛴다.
    }
  }
  return out;
}

/**
 * `/proc/<pid>/status`의 킬로바이트 값(바이트로). 읽지 못하면 0.
 * @param {number} pid
 * @param {'VmRSS' | 'VmHWM'} key
 */
async function procBytes(pid, key) {
  try {
    const status = await readFile(`/proc/${pid}/status`, 'utf8');
    const m = new RegExp(`^${key}:\\s+(\\d+) kB`, 'm').exec(status);
    return m ? Number(m[1]) * 1024 : 0;
  } catch {
    return 0;
  }
}

/**
 * 앞 단계가 남긴 더티 페이지를 디스크로 내려 다음 측정에 섞이지 않게 한다(Linux·macOS의 `sync`).
 */
function settle() {
  if (process.platform !== 'win32') spawnSync('sync');
}

/**
 * @param {number[]} values
 */
function max(values) {
  return values.reduce((a, b) => Math.max(a, b), 0);
}

/**
 * @param {string} binary
 * @param {string} target
 */
async function measure(binary, target) {
  const size = (await stat(target)).size;
  const sessionId = await startApp(binary);
  const appPids = await pidsOf(path.basename(binary));
  const webPids = await pidsOf('WebKitWebProcess');
  /** @type {number[]} */
  const rssSamples = [];
  /** @type {number[]} */
  const webSamples = [];
  const sampler = setInterval(() => {
    void Promise.all(appPids.map((pid) => procBytes(pid, 'VmRSS'))).then((v) =>
      rssSamples.push(max(v)),
    );
    void Promise.all(webPids.map((pid) => procBytes(pid, 'VmRSS'))).then((v) =>
      webSamples.push(max(v)),
    );
  }, 200);
  /** @type {Record<string, unknown>} */
  const result = { sizeBytes: size };
  try {
    // 같은 크기 파일을 복사한 시간(작업 사본 복사·저장의 기준). 한 번 복사해 원본을 페이지 캐시에 올린 뒤 잰다
    // (식은 캐시의 기준은 실행마다 두 배 넘게 흔들렸고, 그 복사가 캐시를 데워 사본 복사만 빨라 보였다).
    // 사본 복사와 저장은 끝에 sync_all로 디스크에 내려쓰므로 판정 기준은 같은 일을 하는 "복사 + fsync"다.
    // fsync 없는 복사는 페이지 캐시에 쓰고 끝나 비교가 되지 않지만 참고로 함께 남긴다.
    const plain = `${target}.plain-copy`;
    await copyFile(target, plain);
    await rm(plain, { force: true });
    settle();
    let t0 = performance.now();
    await copyFile(target, plain);
    result.plainCopyMs = performance.now() - t0;
    await rm(plain, { force: true });
    settle();
    t0 = performance.now();
    await copyFile(target, plain);
    const copied = await open(plain, 'r+');
    await copied.sync();
    await copied.close();
    result.durableCopyMs = performance.now() - t0;
    await rm(plain, { force: true });
    settle();

    const openRun = await timed(sessionId, "hook.call('db.open', { originalPath: a[0] })", [
      target,
    ]);
    const opened = /** @type {Opened} */ (openRun.value);
    result.openWallMs = openRun.ms;
    result.copyMs = opened.workcopy?.copyMs ?? null;
    result.openMs = opened.workcopy?.openMs ?? null;
    const { table } = await tableShape(sessionId, opened);
    const count = /** @type {{ rows: unknown[][] }} */ (
      await hook(sessionId, 'hook.query(a[0])', [`SELECT count(*) FROM "${table.id}" LIMIT 1`])
    );
    result.rows = Number(count.rows[0]?.[0]);

    // 창 질의: 테이블 끝부분 200행. 첫 호출(캐시 없음)과 이어지는 네 번.
    /** @type {number[]} */
    const windowMs = [];
    /** @type {number[]} */
    const windowWallMs = [];
    for (let i = 0; i < 5; i += 1) {
      const w = await timed(sessionId, "hook.call('query.window', a[0])", [
        {
          tableId: table.id,
          viewSpec: {},
          offset: Math.max(0, TARGET_ROWS - WINDOW_ROWS),
          limit: WINDOW_ROWS,
          seq: i + 1,
        },
      ]);
      const value = /** @type {{ rows: unknown[], elapsedMs: number }} */ (w.value);
      if (value.rows.length !== WINDOW_ROWS) throw new Error(`window rows ${value.rows.length}`);
      windowMs.push(value.elapsedMs);
      windowWallMs.push(w.ms);
    }
    result.windowMs = windowMs;
    result.windowWallMs = windowWallMs;

    // run_batch 1,000행(장문 2열 포함). 커맨드의 batch 단계가 engine.runBatch로 간다(네이티브는 500행씩 IPC).
    // 장문은 픽스처와 같은 분포(gen-fixture의 longCell)로 만든다.
    const live = table.columns.filter((c) => c.deletedAt === null);
    const idents = ['"_created_at"', ...live.map((c) => `"${c.id}"`)].join(', ');
    const marks = ['?', ...live.map(() => '?')].join(', ');
    const insert = `INSERT INTO "${table.id}" (${idents}) VALUES (${marks})`;
    const rand = makeRandom(20260923);
    /** @param {string} type @param {number} r */
    const value = (type, r) => {
      switch (type) {
        case 'integer':
          return r;
        case 'real':
          return r / 7;
        case 'boolean':
          return r % 2;
        case 'date':
          return '2024-01-05';
        case 'longtext':
          return longCell(rand);
        default:
          return `짧은 글 ${r}`;
      }
    };
    /** @type {number[]} */
    const batchMs = [];
    for (let round = 0; round < 3; round += 1) {
      const paramsList = [];
      for (let r = 0; r < BATCH_ROWS; r += 1) {
        paramsList.push([
          '2026-09-23T00:00:00.000Z',
          ...live.map((c) => value(c.type, round * BATCH_ROWS + r)),
        ]);
      }
      const b = await timed(sessionId, "hook.call('command.apply', { cmd: a[0] })", [
        {
          type: 'perf.batch',
          tableId: table.id,
          do: [{ batch: { sql: insert, paramsList } }],
          undo: [],
          summary: 'batch',
        },
      ]);
      batchMs.push(b.ms);
    }
    result.batchMs = batchMs;

    // 저장: VACUUM INTO 임시 파일 → 원본을 .bak으로 → 임시 파일을 원본으로.
    settle();
    t0 = performance.now();
    const save = await timed(sessionId, "hook.call('db.save', { originalPath: a[0] })", [target]);
    result.saveMs = save.ms;
    result.saveWallMs = performance.now() - t0;
    await hook(sessionId, "hook.call('db.close', { discardWorkcopy: true })");
  } finally {
    clearInterval(sampler);
    result.appHwmBytes = max(await Promise.all(appPids.map((pid) => procBytes(pid, 'VmHWM'))));
    result.appRssMaxBytes = max(rssSamples);
    result.webRssMaxBytes = max(webSamples);
    await stopApp(sessionId);
  }
  // 저장이 원본을 .bak으로 돌렸다. 저장 전 파일을 원본 자리로 되돌려 다음 측정이 같은 픽스처를 쓰게 한다.
  await rename(`${target}.bak`, target);
  return result;
}

async function main() {
  const target = process.argv[2];
  if (!target) {
    console.error(
      'usage: node test/desktop/perf.mjs <path to a 5 GB fixture (created if missing)>',
    );
    process.exit(2);
  }
  const fixture = path.resolve(target);
  if (!process.env.JDR_DESKTOP_BINARY) await buildTestApp({ release: true });
  const binary = binaryPath({ release: true });
  const driver = await startDriver();
  let failed = false;
  try {
    const exists = await stat(fixture).then(
      () => true,
      () => false,
    );
    if (!exists) await prepare(binary, fixture);
    const r = await measure(binary, fixture);
    const plain = Number(r.durableCopyMs);
    const windowMax = max(/** @type {number[]} */ (r.windowMs));
    const batchMax = max(/** @type {number[]} */ (r.batchMs));
    const rss = process.platform === 'linux' ? Number(r.appHwmBytes) : null;
    const rows = [
      // 러스트의 open_ms는 열기 시작부터라 사본 복사를 포함한다(core db.rs). 복사를 빼고 판정한다.
      ['5 GB 파일 열기(사본 복사 제외)', Number(r.openMs) - Number(r.copyMs), BUDGET.openMs, 'ms'],
      ['작업 사본 복사(기준: 복사 + fsync)', Number(r.copyMs), plain * BUDGET.copyRatio, 'ms'],
      ['창 질의(끝부분 200행, 최대)', windowMax, BUDGET.windowMs, 'ms'],
      ['run_batch 1,000행(최대)', batchMax, BUDGET.batchMs, 'ms'],
      ['5 GB 저장(기준: 복사 + fsync)', Number(r.saveMs), plain * BUDGET.saveRatio, 'ms'],
      ['최대 상주 메모리(앱 프로세스)', rss, BUDGET.rssBytes, 'bytes'],
    ];
    console.log(`[perf:desktop] ${JSON.stringify(r)}`);
    for (const [label, got, limit, unit] of rows) {
      const ok = got === null ? null : Number(got) <= Number(limit);
      if (ok === false) failed = true;
      const show = (/** @type {unknown} */ v) =>
        v === null
          ? '미측정'
          : unit === 'bytes'
            ? `${(Number(v) / MB).toFixed(0)} MB`
            : `${Number(v).toFixed(1)} ms`;
      console.log(
        `[perf:budget] ${label}: ${show(got)} / 예산 ${show(limit)} ${ok === null ? '' : ok ? 'OK' : 'OVER'}`,
      );
    }
  } catch (err) {
    failed = true;
    console.error(err);
  } finally {
    driver.kill();
  }
  process.exit(failed ? 1 : 0);
}

await main();
