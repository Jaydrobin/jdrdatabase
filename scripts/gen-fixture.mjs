// @ts-check
/**
 * 벤치마크용 대용량 CSV 생성. 산출물은 test/fixtures/generated/ 아래에 두고 커밋하지 않는다.
 *
 *   npm run fixture -- --rows 300000 [--cols 20] [--long 2] [--out test/fixtures/generated/bench.csv]
 *
 * 열 구성: id, 정수·실수·불리언·날짜·짧은 텍스트가 섞인 일반 열과 `--long` 개의 장문 열(2~8 KB).
 * 시드가 고정된 의사난수를 써서 같은 인자면 같은 파일이 나온다.
 */
import { createWriteStream } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';

/**
 * @param {string[]} argv
 * @returns {{ rows: number, cols: number, long: number, out: string }}
 */
export function parseArgs(argv) {
  const opts = { rows: 10_000, cols: 20, long: 2, out: 'test/fixtures/generated/bench.csv' };
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    const value = argv[i + 1];
    if (key === '--rows' && value) opts.rows = Number(value);
    else if (key === '--cols' && value) opts.cols = Number(value);
    else if (key === '--long' && value) opts.long = Number(value);
    else if (key === '--out' && value) opts.out = value;
    else continue;
    i += 1;
  }
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

const isCli =
  process.argv[1] && path.resolve(process.argv[1]) === new URL(import.meta.url).pathname;
if (isCli) {
  const opts = parseArgs(process.argv.slice(2));
  await generate(opts);
  console.log(`generated ${opts.rows} rows x ${opts.cols} cols -> ${opts.out}`);
}
