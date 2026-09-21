// @ts-check
/**
 * `test/fixtures/import/`의 파서 픽스처를 다시 만든다. 바이트가 고정되어 있어 같은 출력이 나온다.
 *
 *   node scripts/gen-import-fixtures.mjs
 *
 * CSV(Step 7): 따옴표 안 개행·쉼표, BOM 있는 UTF-8, UTF-16LE, EUC-KR, 빈 줄, CRLF/LF 혼재, 필드 수 불일치,
 * 32 KB 조각 경계에 걸친 따옴표 필드. 바이트가 고정된다.
 * XLSX(Step 8): 날짜·시각·불리언·수식·병합·오류 셀·빈/중복 헤더·선행 0 텍스트, 헤더가 3행에 있는 둘째 시트,
 * 1904 날짜 체계, 암호화 컨테이너. SheetJS로 쓰므로 zip 메타데이터(시각)는 실행마다 다를 수 있고 내용은 같다.
 * 모두 1 MB 아래(CLAUDE.md 4장).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from '../vendor/xlsx.full.min.js';

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

/**
 * 날짜·시각·불리언·수식·병합·오류 셀·빈/중복 헤더·선행 0 텍스트가 든 통합 문서. 둘째 시트는 헤더가 3행에 있다.
 * 날짜는 Date 객체로 넣어 SheetJS가 일련번호(+ 날짜 서식)로 쓰게 한다(엑셀이 저장하는 형태).
 * @returns {Uint8Array}
 */
export function basicXlsx() {
  const wb = XLSX.utils.book_new();
  const rows = [
    [
      '이름',
      '',
      '나이',
      '이름',
      '가입일',
      '시각',
      '활성',
      '수식',
      '우편번호',
      '오류',
      '실수',
      '윤년',
    ],
    [
      '홍길동',
      'x',
      30,
      'dup',
      new Date(2024, 0, 5),
      new Date(2024, 0, 5, 10, 20, 30),
      true,
      null,
      '01234',
      null,
      1.5,
    ],
    [
      '김영희',
      'y',
      25,
      'dup2',
      new Date(2024, 1, 29),
      new Date(2024, 1, 29, 0, 0, 0),
      false,
      null,
      '00042',
      null,
      -2,
    ],
    ['병합', 'b', 40, 'dup3', new Date(1900, 1, 27), null, true, null, '99999', null, 3e2],
    ['', '', null, '', null, null, null, null, '', null, null],
  ];
  const ws = XLSX.utils.aoa_to_sheet(rows);
  // 수식 셀: 계산값(v)과 수식(f)을 함께 둔다. 가져오기는 v만 쓴다.
  ws['H2'] = { t: 'n', f: 'C2*2', v: 60 };
  ws['H3'] = { t: 'n', f: 'C3*2', v: 50 };
  ws['H4'] = { t: 'n', f: 'C4*2', v: 80 };
  // 오류 셀: #N/A, #REF!
  ws['J2'] = { t: 'e', v: 0x2a, w: '#N/A' };
  ws['J3'] = { t: 'e', v: 0x17, w: '#REF!' };
  // 1900 윤년 버그: 엑셀의 일련번호 60은 존재하지 않는 1900-02-29, 61은 1900-03-01이다.
  ws['L2'] = { t: 'n', v: 60, z: 'yyyy-mm-dd' };
  ws['L3'] = { t: 'n', v: 61, z: 'yyyy-mm-dd' };
  // 병합: A4:B5 (왼쪽 위 A4에만 값)
  ws['!merges'] = [{ s: { r: 3, c: 0 }, e: { r: 4, c: 1 } }];
  XLSX.utils.book_append_sheet(wb, ws, '데이터');
  const second = XLSX.utils.aoa_to_sheet([['제목 줄'], [], ['a', 'b'], [1, 2], [3, 4]]);
  XLSX.utils.book_append_sheet(wb, second, '둘째');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

/**
 * 1904 날짜 체계 통합 문서. 같은 날짜가 1900 체계와 다른 일련번호로 저장되지만 읽으면 같은 날짜여야 한다.
 * @returns {Uint8Array}
 */
export function date1904Xlsx() {
  const wb = XLSX.utils.book_new();
  wb.Workbook = { WBProps: { date1904: true } };
  const ws = XLSX.utils.aoa_to_sheet(
    [
      ['날짜', '시각'],
      [new Date(2024, 0, 5), new Date(2024, 0, 5, 10, 20, 30)],
    ],
    // 셀은 날짜 타입으로 두고, 일련번호 변환은 통합 문서의 date1904를 아는 쓰기 단계에 맡긴다.
    { cellDates: true },
  );
  XLSX.utils.book_append_sheet(wb, ws, 'S');
  return new Uint8Array(XLSX.write(wb, { type: 'array', bookType: 'xlsx' }));
}

/**
 * 암호화된 통합 문서의 컨테이너(CFB에 EncryptedPackage·EncryptionInfo 스트림). 내용은 임의 바이트지만
 * SheetJS는 스트림 이름만 보고 암호 보호로 판정한다.
 * @returns {Uint8Array}
 */
export function encryptedXlsx() {
  const cfb = XLSX.CFB.utils.cfb_new();
  XLSX.CFB.utils.cfb_add(cfb, '/EncryptionInfo', new Uint8Array([4, 0, 4, 0, 0x40, 0, 0, 0]));
  XLSX.CFB.utils.cfb_add(cfb, '/EncryptedPackage', new Uint8Array(64));
  return new Uint8Array(XLSX.CFB.write(cfb, { type: 'array' }));
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
    // XLSX (Step 8)
    'basic.xlsx': basicXlsx(),
    'date1904.xlsx': date1904Xlsx(),
    'encrypted.xlsx': encryptedXlsx(),
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
