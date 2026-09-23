// @ts-check
/**
 * CSV 파서(Step 7): 인코딩·구분자 감지, 상태 기계(따옴표·개행·조각 경계), 스트리밍 parse, 조기 종료.
 * 픽스처는 `test/fixtures/import/`의 바이트(`scripts/gen-import-fixtures.mjs`).
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  createParser,
  decodeHead,
  detectDelimiter,
  detectEncoding,
  parse,
  replacementRatio,
} from '../../../src/import/csv.js';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/import',
);

/**
 * @param {string} name
 * @returns {Promise<Uint8Array<ArrayBuffer>>}
 */
async function fixture(name) {
  const buf = await readFile(path.join(FIXTURES, name));
  const out = new Uint8Array(new ArrayBuffer(buf.byteLength));
  out.set(buf);
  return out;
}

/**
 * @param {AsyncIterable<import('../../../src/import/csv.js').CsvRecord>} records
 */
async function collect(records) {
  /** @type {string[][]} */
  const out = [];
  for await (const r of records) out.push(r.cells);
  return out;
}

/**
 * 조각 크기를 정해 텍스트를 잘라 넣는다. 조각 경계에 상관없이 같은 결과가 나와야 한다.
 * @param {string} text
 * @param {number} chunk
 * @param {string} [delimiter]
 */
function parseChunked(text, chunk, delimiter = ',') {
  const parser = createParser({ delimiter });
  /** @type {string[][]} */
  const out = [];
  for (let i = 0; i < text.length; i += chunk) {
    for (const r of parser.push(text.slice(i, i + chunk))) out.push(r.cells);
  }
  const tail = parser.end();
  for (const r of tail.records) out.push(r.cells);
  return { rows: out, unterminatedQuote: tail.unterminatedQuote };
}

test('detectEncoding: BOM, BOM 없는 UTF-16, UTF-8, EUC-KR', async () => {
  assert.equal(detectEncoding(await fixture('bom-utf8.csv')), 'utf-8');
  assert.equal(detectEncoding(await fixture('utf16le.csv')), 'utf-16le');
  assert.equal(detectEncoding(await fixture('utf16be.csv')), 'utf-16be');
  assert.equal(detectEncoding(await fixture('utf16le-nobom.csv')), 'utf-16le');
  assert.equal(detectEncoding(await fixture('euc-kr.csv')), 'euc-kr');
  assert.equal(detectEncoding(await fixture('quotes.csv')), 'utf-8');
  // 머리 끝에서 잘린 다중 바이트 문자는 UTF-8 판정을 깨지 않는다.
  const cut = new TextEncoder().encode('이름,값\n홍길동').slice(0, -1);
  assert.equal(detectEncoding(cut), 'utf-8');
  assert.equal(detectEncoding(new Uint8Array(0)), 'utf-8');
});

test('decodeHead·replacementRatio: EUC-KR 바이트를 UTF-8로 읽으면 깨진 문자 비율이 1%를 넘는다', async () => {
  const bytes = await fixture('euc-kr.csv');
  assert.equal(decodeHead(bytes, 'euc-kr'), '이름,주소\n홍길동,서울\n김영희,부산\n');
  const wrong = decodeHead(bytes, 'utf-8');
  assert.ok(replacementRatio(wrong) > 0.01, `ratio ${replacementRatio(wrong)}`);
  assert.equal(replacementRatio('abc'), 0);
});

test('detectDelimiter: 쉼표·세미콜론·탭·세로줄, 따옴표 안의 쉼표는 세지 않는다', async () => {
  assert.equal(detectDelimiter(decodeHead(await fixture('quotes.csv'), 'utf-8')), ',');
  assert.equal(detectDelimiter(decodeHead(await fixture('semicolon.csv'), 'utf-8')), ';');
  assert.equal(detectDelimiter(decodeHead(await fixture('tabs.tsv'), 'utf-8')), '\t');
  assert.equal(detectDelimiter('a|b|c\n1|2|3\n4|5|6\n'), '|');
  // 후보 어느 것도 필드를 나누지 못하면 쉼표.
  assert.equal(detectDelimiter('single\nline\n'), ',');
  assert.equal(detectDelimiter(''), ',');
});

test('createParser: 따옴표 안 개행·쉼표·이스케이프 따옴표, 빈 필드', async () => {
  const text = new TextDecoder().decode(await fixture('quotes.csv'));
  const { rows, unterminatedQuote } = parseChunked(text, text.length);
  assert.equal(unterminatedQuote, false);
  assert.deepEqual(rows, [
    ['id', 'text', 'note'],
    ['1', 'a, b', 'line 1\nline 2'],
    ['2', 'say "hi"', 'plain'],
    ['3', '', ''],
  ]);
});

test('createParser: 빈 줄은 레코드가 아니고 공백뿐인 줄은 레코드다', async () => {
  const text = new TextDecoder().decode(await fixture('blank-lines.csv'));
  const { rows } = parseChunked(text, text.length);
  assert.deepEqual(rows, [['a', 'b'], ['1', '2'], ['3', '4'], [' ']]);
  const parser = createParser({ delimiter: ',' });
  const records = [...parser.push('a,b\n\n1,2\n'), ...parser.end().records];
  assert.deepEqual(
    records.map((r) => r.rowIndex),
    [1, 2],
    '빈 줄은 레코드 순번을 쓰지 않는다',
  );
});

test('createParser: CRLF/LF 혼재, 마지막 줄바꿈 없음, 조각 경계에서 갈라진 CRLF', async () => {
  const text = new TextDecoder().decode(await fixture('mixed-newlines.csv'));
  const expected = [
    ['a', 'b'],
    ['1', '2'],
    ['3', '4'],
    ['5', '6'],
  ];
  for (const chunk of [1, 2, 3, 5, 7, text.length]) {
    assert.deepEqual(parseChunked(text, chunk).rows, expected, `chunk ${chunk}`);
  }
  // `\r`로 끝난 조각 뒤에 `\n`만 든 조각이 와도 빈 레코드가 생기지 않는다.
  const parser = createParser({ delimiter: ',' });
  const out = [...parser.push('a,b\r'), ...parser.push('\n1,2'), ...parser.end().records];
  assert.deepEqual(
    out.map((r) => r.cells),
    [
      ['a', 'b'],
      ['1', '2'],
    ],
  );
});

test('createParser: 필드 수 불일치는 그대로 돌려준다(부족·초과 처리는 파이프라인 몫)', async () => {
  const text = new TextDecoder().decode(await fixture('ragged.csv'));
  assert.deepEqual(parseChunked(text, text.length).rows, [
    ['a', 'b', 'c'],
    ['1', '2'],
    ['3', '4', '5', '6'],
    ['7', '8', '9'],
  ]);
});

test('createParser: 닫히지 않은 따옴표는 남은 텍스트를 마지막 필드로 읽고 표시한다', async () => {
  const text = new TextDecoder().decode(await fixture('unterminated.csv'));
  const { rows, unterminatedQuote } = parseChunked(text, text.length);
  assert.equal(unterminatedQuote, true);
  assert.deepEqual(rows, [
    ['a', 'b'],
    ['1', 'open quote\nstill inside\n'],
  ]);
});

test('createParser: 32 KB 조각 경계에 걸친 따옴표 필드가 조각 크기와 무관하게 같게 읽힌다', async () => {
  const text = new TextDecoder().decode(await fixture('boundary.csv'));
  const whole = parseChunked(text, text.length).rows;
  const boundaryRow = whole.find((r) => r[1] === 'boundary');
  assert.ok(boundaryRow);
  assert.equal(
    boundaryRow[2],
    `line one, with comma\nline two "quoted"\n${'x'.repeat(600)}`,
    '따옴표 필드 안의 쉼표·개행·이스케이프 따옴표',
  );
  // 32 KB 경계가 필드 안에 놓인다.
  const at = text.indexOf('boundary,"');
  assert.ok(at < 32 * 1024 && at + 700 > 32 * 1024, `field spans the boundary (starts at ${at})`);
  for (const chunk of [32 * 1024, 1024, 13, 1]) {
    assert.deepEqual(parseChunked(text, chunk).rows, whole, `chunk ${chunk}`);
  }
  assert.deepEqual(whole.at(-1), [String(whole.length - 1), 'after4', 'tail 4']);
});

test('createParser: 구분자는 한 글자여야 한다', () => {
  assert.throws(() => createParser({ delimiter: ',,' }), /single character/);
});

test('parse: Blob을 스트리밍으로 읽고 BOM·인코딩을 처리한다', async () => {
  for (const [name, encoding, expected] of /** @type {const} */ ([
    ['bom-utf8.csv', 'utf-8', ['이름', '나이', '가입일']],
    ['utf16le.csv', 'utf-16le', ['name', 'value']],
    ['utf16be.csv', 'utf-16be', ['name', 'value']],
    ['euc-kr.csv', 'euc-kr', ['이름', '주소']],
  ])) {
    const rows = await collect(
      parse(new Blob([await fixture(name)]), { encoding, delimiter: ',' }),
    );
    assert.deepEqual(rows[0], expected, name);
  }
  const eucKr = await collect(
    parse(new Blob([await fixture('euc-kr.csv')]), { encoding: 'euc-kr', delimiter: ',' }),
  );
  assert.deepEqual(eucKr, [
    ['이름', '주소'],
    ['홍길동', '서울'],
    ['김영희', '부산'],
  ]);
});

test('parse: 파일 끝에서 onEnd가 불리고, 일찍 멈추면 불리지 않는다', async () => {
  const bytes = await fixture('unterminated.csv');
  /** @type {unknown[]} */
  const ended = [];
  await collect(
    parse(new Blob([bytes]), { encoding: 'utf-8', delimiter: ',', onEnd: (i) => ended.push(i) }),
  );
  assert.deepEqual(ended, [{ unterminatedQuote: true }]);

  const big = new Blob([new TextDecoder().decode(await fixture('boundary.csv'))]);
  ended.length = 0;
  const it = parse(big, { encoding: 'utf-8', delimiter: ',', onEnd: (i) => ended.push(i) });
  const first = await it.next();
  assert.equal(first.done, false);
  await it.return();
  assert.deepEqual(ended, [], '미리보기처럼 일찍 멈추면 파일 끝에 닿지 않는다');
});

test('parse: 32 KB 경계 픽스처를 스트림으로 읽어도 조각 단위 결과와 같다', async () => {
  const text = new TextDecoder().decode(await fixture('boundary.csv'));
  const rows = await collect(parse(new Blob([text]), { encoding: 'utf-8', delimiter: ',' }));
  assert.deepEqual(rows, parseChunked(text, 32 * 1024).rows);
});
