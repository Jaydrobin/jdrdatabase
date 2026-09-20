// @ts-check
/**
 * 벤치마크용 대용량 픽스처 생성. 산출물은 test/fixtures/generated/ 아래에 두고 커밋하지 않는다.
 *
 *   npm run fixture -- --rows 300000 [--cols 20] [--long 2] [--out test/fixtures/generated/bench.csv]
 *   npm run fixture -- --rows 300000 --db [--out test/fixtures/generated/bench.db]
 *
 * CSV: 열 구성은 id, 정수·실수·불리언·날짜·짧은 텍스트가 섞인 일반 열과 `--long` 개의 장문 열(2~8 KB).
 * DB(`--db`): wasm 엔진으로 이 앱의 메타 스키마를 가진 표준 SQLite 파일을 만든다(Step 4 성능 측정용).
 *   `--cols`개의 사용자 열 중 `--long`개가 장문(`longtext`)이고, 장문 셀은 평균 약 200자, 0.1%는 100 KB
 *   이상이다(DESIGN.md Step 4 완료 기준, 8장의 약 300 MB 예산). 나머지 열은 정수·실수·불리언·날짜·텍스트.
 * 시드가 고정된 의사난수를 써서 같은 인자면 같은 파일이 나온다.
 */
import { createWriteStream } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { selectEngine } from '../src/db/engine.js';
import { migrate } from '../src/db/schema.js';
import * as tables from '../src/db/tables.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @param {string[]} argv
 * @returns {{ rows: number, cols: number, long: number, out: string, db: boolean }}
 */
export function parseArgs(argv) {
  const opts = { rows: 10_000, cols: 20, long: 2, out: '', db: false };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--db') {
      opts.db = true;
      continue;
    }
    if (key === '--rows' && value) opts.rows = Number(value);
    else if (key === '--cols' && value) opts.cols = Number(value);
    else if (key === '--long' && value) opts.long = Number(value);
    else if (key === '--out' && value) opts.out = value;
    else continue;
    i += 1;
  }
  if (!opts.out)
    opts.out = opts.db ? 'test/fixtures/generated/bench.db' : 'test/fixtures/generated/bench.csv';
  if (!Number.isInteger(opts.rows) || opts.rows <= 0) throw new Error('--rows는 양의 정수');
  if (!Number.isInteger(opts.cols) || opts.cols < 2) throw new Error('--cols는 2 이상');
  if (!Number.isInteger(opts.long) || opts.long < 0 || opts.long >= opts.cols) {
    throw new Error('--long은 0 이상 cols 미만');
  }
  return opts;
}

/**
 * 시드 고정 의사난수(mulberry32).
 * @param {number} seed
 * @returns {() => number}
 */
export function makeRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BOM = '\uFEFF';
const WORDS = [
  '사과',
  '바나나',
  '포도',
  '수박',
  '참외',
  '딸기',
  'apple',
  'grape',
  'melon',
  'berry',
];

/**
 * RFC 4180 규칙으로 필드를 감싼다.
 * @param {string} value
 * @returns {string}
 */
export function csvField(value) {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/**
 * @param {{ rows: number, cols: number, long: number, out: string }} opts
 * @returns {Promise<void>}
 */
export async function generate(opts) {
  const rand = makeRandom(20260920);
  await mkdir(path.dirname(opts.out), { recursive: true });
  const stream = createWriteStream(opts.out, { encoding: 'utf8' });

  /** @type {string[]} */
  const header = ['id'];
  const kinds = ['int', 'real', 'bool', 'date', 'text'];
  for (let c = 1; c < opts.cols - opts.long; c += 1) header.push(`${kinds[c % kinds.length]}_${c}`);
  for (let l = 0; l < opts.long; l += 1) header.push(`long_${l}`);
  stream.write(`${BOM}${header.map(csvField).join(',')}\r\n`);

  for (let r = 1; r <= opts.rows; r += 1) {
    /** @type {string[]} */
    const cells = [String(r)];
    for (let c = 1; c < opts.cols - opts.long; c += 1) {
      switch (kinds[c % kinds.length]) {
        case 'int':
          cells.push(String(Math.floor(rand() * 1_000_000)));
          break;
        case 'real':
          cells.push((rand() * 10_000).toFixed(3));
          break;
        case 'bool':
          cells.push(rand() < 0.5 ? 'true' : 'false');
          break;
        case 'date': {
          const d = new Date(Date.UTC(2020, 0, 1) + Math.floor(rand() * 2_000) * 86_400_000);
          cells.push(d.toISOString().slice(0, 10));
          break;
        }
        default:
          cells.push(`${WORDS[Math.floor(rand() * WORDS.length)]} ${Math.floor(rand() * 100)}`);
      }
    }
    for (let l = 0; l < opts.long; l += 1) {
      const words = 300 + Math.floor(rand() * 1_000);
      /** @type {string[]} */
      const parts = [];
      for (let w = 0; w < words; w += 1) {
        parts.push(WORDS[Math.floor(rand() * WORDS.length)] ?? '');
        if (w % 40 === 39) parts.push('\n');
      }
      cells.push(parts.join(' '));
    }
    if (!stream.write(`${cells.map(csvField).join(',')}\r\n`)) await once(stream, 'drain');
  }
  stream.end();
  await once(stream, 'finish');
}

const ASCII_WORDS = WORDS.filter((w) => /^[a-z]+$/.test(w));

/** 장문 셀 중 100 KB 이상인 비율(DESIGN.md Step 4 완료 기준). */
export const DB_HUGE_CELL_RATIO = 0.001;
/** 100 KB 이상 셀의 최소 문자 수. 한글은 UTF-8 3바이트이므로 문자 수는 바이트의 1/3 이상이면 된다. */
export const DB_HUGE_CELL_CHARS = 102_400;
/** `runBatch` 한 번에 넣는 행 수. 파라미터 상한(1만)·64 MB 상한 안에서 왕복 수를 줄인다. */
const DB_BATCH_ROWS = 2_000;

/**
 * 장문 셀 하나. 평균 약 300자, `DB_HUGE_CELL_RATIO` 비율로 100 KB 이상.
 * @param {() => number} rand
 * @returns {string}
 */
function longCell(rand) {
  const huge = rand() < DB_HUGE_CELL_RATIO;
  const target = huge
    ? DB_HUGE_CELL_CHARS + Math.floor(rand() * 20_000)
    : 60 + Math.floor(rand() * 280);
  // 100 KB 셀은 영어 단어로 채워 바이트 수를 문자 수 근처로 둔다(한글은 3바이트라 파일이 8장 예산을 넘는다).
  const words = huge ? ASCII_WORDS : WORDS;
  /** @type {string[]} */
  const parts = [];
  let length = 0;
  while (length < target) {
    const word = words[Math.floor(rand() * words.length)] ?? '';
    parts.push(word);
    length += word.length + 1;
    if (parts.length % 40 === 39) parts.push('\n');
  }
  return parts.join(' ');
}

/**
 * 이 앱의 메타 스키마를 가진 SQLite DB 픽스처를 만든다. Node에서 wasm 엔진을 돌려 표준 SQLite 파일을 쓴다.
 * @param {{ rows: number, cols: number, long: number, out: string }} opts
 * @returns {Promise<{ bytes: number }>}
 */
export async function generateDb(opts) {
  const g = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis));
  if (!g.sqlite3ApiConfig) g.sqlite3ApiConfig = { warn: () => {} };
  const { readFile } = await import('node:fs/promises');
  const wasmBuf = await readFile(path.join(ROOT, 'vendor', 'sqlite3.wasm'));
  const wasmBinary = new ArrayBuffer(wasmBuf.byteLength);
  new Uint8Array(wasmBinary).set(wasmBuf);
  const engine = selectEngine('wasm');
  await engine.init({ wasmBinary });
  await engine.open();
  await migrate(engine, { appVersion: 'fixture' });
  const { tableId } = await tables.create(engine, { name: 'bench' });
  const kinds = ['integer', 'real', 'boolean', 'date', 'text'];
  /** @type {{ id: string, kind: string }[]} */
  const columns = [];
  for (let c = 0; c < opts.cols - opts.long; c += 1) {
    const kind = /** @type {string} */ (kinds[c % kinds.length]);
    const type = /** @type {import('../src/db/values.js').LogicalType} */ (kind);
    const { columnId } = await tables.addColumn(engine, tableId, { name: `${kind}_${c}`, type });
    columns.push({ id: columnId, kind });
  }
  for (let l = 0; l < opts.long; l += 1) {
    const { columnId } = await tables.addColumn(engine, tableId, {
      name: `long_${l}`,
      type: 'longtext',
    });
    columns.push({ id: columnId, kind: 'longtext' });
  }
  const idents = columns.map((c) => `"${c.id}"`).join(', ');
  const marks = columns.map(() => '?').join(', ');
  const sql = `INSERT INTO "${tableId}" (${idents}) VALUES (${marks})`;
  const rand = makeRandom(20260920);
  for (let start = 0; start < opts.rows; start += DB_BATCH_ROWS) {
    const n = Math.min(DB_BATCH_ROWS, opts.rows - start);
    /** @type {Array<Array<string | number | null>>} */
    const batch = new Array(n);
    for (let r = 0; r < n; r += 1) {
      const rowIndex = start + r + 1;
      /** @type {Array<string | number | null>} */
      const values = [];
      for (const column of columns) {
        switch (column.kind) {
          case 'integer':
            values.push(Math.floor(rand() * 1_000_000));
            break;
          case 'real':
            values.push(Number((rand() * 10_000).toFixed(3)));
            break;
          case 'boolean':
            values.push(rand() < 0.5 ? 1 : 0);
            break;
          case 'date': {
            const d = new Date(Date.UTC(2020, 0, 1) + Math.floor(rand() * 2_000) * 86_400_000);
            values.push(d.toISOString().slice(0, 10));
            break;
          }
          case 'longtext':
            values.push(rowIndex % 50 === 0 ? null : longCell(rand));
            break;
          default:
            values.push(`${WORDS[Math.floor(rand() * WORDS.length)]} ${Math.floor(rand() * 100)}`);
        }
      }
      batch[r] = values;
    }
    await engine.runBatch(sql, batch);
    if ((start / DB_BATCH_ROWS) % 25 === 0) console.log(`  ${start + n}/${opts.rows} rows`);
  }
  const bytes = engine.snapshot();
  await mkdir(path.dirname(opts.out), { recursive: true });
  await writeFile(opts.out, bytes);
  await engine.close();
  return { bytes: bytes.byteLength };
}

const isCli =
  process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isCli) {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.db) {
    const { bytes } = await generateDb(opts);
    console.log(`generated ${opts.rows} rows x ${opts.cols} cols -> ${opts.out} (${bytes} bytes)`);
  } else {
    await generate(opts);
    console.log(`generated ${opts.rows} rows x ${opts.cols} cols -> ${opts.out}`);
  }
}
