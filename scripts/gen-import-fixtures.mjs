// @ts-check
/**
 * `test/fixtures/import/`의 파서 픽스처를 다시 만든다. 바이트가 고정되어 있어 같은 출력이 나온다.
 *
 *   node scripts/gen-import-fixtures.mjs
 *
 * CSV(Step 7): 따옴표 안 개행·쉼표, BOM 있는 UTF-8, UTF-16LE, EUC-KR, 빈 줄, CRLF/LF 혼재, 필드 수 불일치,
 * 32 KB 조각 경계에 걸친 따옴표 필드. 모두 1 MB 아래(CLAUDE.md 4장).
 * XLSX(Step 8)는 세션 F의 Step 8 커밋에서 이 파일에 더한다.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const OUT_DIR = path.join(ROOT, 'test', 'fixtures', 'import');

/**
 * EUC-KR 인코딩. Node의 TextEncoder는 UTF-8만 지원하므로, KS X 1001 2바이트 영역(0xA1A1~0xFEFE)을
 * `TextDecoder('euc-kr')`로 한 번 풀어 역표를 만든다(외우거나 손으로 적은 코드에 기대지 않는다).
 * @returns {Map<string, [number, number]>}
 */
function eucKrTable() {
  const decoder = new TextDecoder('euc-kr');
  /** @type {Map<string, [number, number]>} */
  const table = new Map();
  for (let lead = 0xa1; lead <= 0xfe; lead += 1) {
    for (let trail = 0xa1; trail <= 0xfe; trail += 1) {
      const ch = decoder.decode(Uint8Array.from([lead, trail]));
      if (ch.length === 1 && ch !== '\uFFFD' && !table.has(ch)) table.set(ch, [lead, trail]);
    }
  }
  return table;
}

/** @type {Map<string, [number, number]> | null} */
let eucKr = null;

/**
 * @param {string} text ASCII와 KS X 1001 완성형 한글
 * @returns {Uint8Array}
 */
export function encodeEucKr(text) {
  if (!eucKr) eucKr = eucKrTable();
  /** @type {number[]} */
  const out = [];
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 0x80) {
      out.push(code);
      continue;
    }
    const mapped = eucKr.get(ch);
    if (!mapped) throw new Error(`EUC-KR로 적을 수 없는 글자: ${ch}`);
    out.push(mapped[0], mapped[1]);
  }
  return Uint8Array.from(out);
}

/**
 * @param {string} text
 * @param {'utf-16le' | 'utf-16be'} encoding
 * @param {boolean} bom
 * @returns {Uint8Array}
 */
export function encodeUtf16(text, encoding, bom) {
  const units = bom ? [0xfeff] : [];
  for (let i = 0; i < text.length; i += 1) units.push(text.charCodeAt(i));
  const out = new Uint8Array(units.length * 2);
  units.forEach((u, i) => {
    if (encoding === 'utf-16le') {
      out[i * 2] = u & 0xff;
      out[i * 2 + 1] = u >> 8;
    } else {
      out[i * 2] = u >> 8;
      out[i * 2 + 1] = u & 0xff;
    }
  });
  return out;
}

/**
 * 시드 고정 의사난수(mulberry32).
 * @param {number} seed
 * @returns {() => number}
 */
function makeRandom(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 32 KB 조각 경계에 따옴표 필드가 걸치는 CSV. 3열이고, 경계(32,768바이트) 앞 200바이트에서 시작하는
 * 따옴표 필드 안에 쉼표·개행·이스케이프 따옴표가 들어 있어 경계 뒤에서야 닫힌다.
 * @returns {string}
 */
export function boundaryCsv() {
  const rand = makeRandom(7);
  const lines = ['id,name,memo'];
  let bytes = lines[0].length + 1;
  let id = 1;
  const boundary = 32 * 1024;
  while (bytes < boundary - 200) {
    const memo = `memo ${Math.floor(rand() * 1e6)}`;
    const line = `${id},name${id},${memo}`;
    lines.push(line);
    bytes += line.length + 1;
    id += 1;
  }
  // 경계에 걸치는 레코드: 따옴표 필드가 32 KB 지점을 지나 닫힌다.
  const inner = `line one, with comma\nline two ""quoted""\n${'x'.repeat(600)}`;
  lines.push(`${id},boundary,"${inner}"`);
  id += 1;
  for (let i = 0; i < 5; i += 1) {
    lines.push(`${id},after${i},tail ${i}`);
    id += 1;
  }
  return `${lines.join('\n')}\n`;
}

export async function generate() {
  await mkdir(OUT_DIR, { recursive: true });
  /** @type {Record<string, Uint8Array | string>} */
  const files = {
    // 따옴표 안 개행·쉼표·이스케이프 따옴표, LF만
    'quotes.csv': 'id,text,note\n1,"a, b","line 1\nline 2"\n2,"say ""hi""",plain\n3,,""\n',
    // BOM 있는 UTF-8, 한글
    'bom-utf8.csv': `\uFEFF이름,나이,가입일\n홍길동,30,2024-01-05\n김영희,25,2024-02-10\n`,
    // UTF-16LE (BOM)
    'utf16le.csv': encodeUtf16('name,value\nalpha,1\n한글,2\n', 'utf-16le', true),
    // UTF-16BE (BOM)
    'utf16be.csv': encodeUtf16('name,value\nbeta,3\n', 'utf-16be', true),
    // UTF-16LE (BOM 없음): NUL 분포로 감지
    'utf16le-nobom.csv': encodeUtf16('name,value\ngamma,4\ndelta,5\n', 'utf-16le', false),
    // EUC-KR 바이트(BOM 없음)
    'euc-kr.csv': encodeEucKr('이름,주소\n홍길동,서울\n김영희,부산\n'),
    // 빈 줄(중간·끝), 공백만 있는 줄은 빈 줄이 아니다
    'blank-lines.csv': 'a,b\n\n1,2\n\n\n3,4\n \n',
    // CRLF/LF 혼재 + 마지막 줄바꿈 없음
    'mixed-newlines.csv': 'a,b\r\n1,2\n3,4\r\n5,6',
    // 필드 수 불일치: 부족(NULL)과 초과(버림)
    'ragged.csv': 'a,b,c\n1,2\n3,4,5,6\n7,8,9\n',
    // 세미콜론 구분자, 따옴표 안에 쉼표
    'semicolon.csv': 'a;b;c\n1;"x,y";3\n4;5;6\n',
    // 탭 구분자
    'tabs.tsv': 'a\tb\n1\t2\n3\t4\n',
    // 닫히지 않은 따옴표로 끝남
    'unterminated.csv': 'a,b\n1,"open quote\nstill inside\n',
    // 타입 추론용: 불리언·정수·실수·날짜·날짜시간·선행 0·장문 후보
    'types.csv': [
      'flag,int,real,date,datetime,zip,mixed,empty',
      'true,1,1.5,2024-01-01,2024-01-01 10:20:30,01234,1,',
      'false,"2,000",-2,2024-02-29,2024-02-29T00:00:00,00042,x,',
      '1,3,3e2,2023-12-31,2023-12-31 23:59:59,00001,,',
      '',
    ].join('\n'),
    // 32 KB 조각 경계에 걸친 따옴표 필드
    'boundary.csv': boundaryCsv(),
  };
  for (const [name, content] of Object.entries(files)) {
    await writeFile(
      path.join(OUT_DIR, name),
      typeof content === 'string' ? Buffer.from(content, 'utf8') : content,
    );
  }
  return Object.keys(files);
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const names = await generate();
  console.log(`generated ${names.length} fixtures in ${path.relative(ROOT, OUT_DIR)}`);
}
