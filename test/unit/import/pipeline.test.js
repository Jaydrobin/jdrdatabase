// @ts-check
/**
 * 가져오기 파이프라인(Step 7): 미리보기(헤더 정리·추론·경고), 실행(새 테이블·기존 테이블·정책·select 자동 추가·
 * 필드 수 불일치·셀 크기 상한·진행률), 취소·오류 뒤 DB 덤프 동일(잔여물 없음). 실제 wasm DB로 검사한다.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { migrate } from '../../../src/db/schema.js';
import * as tables from '../../../src/db/tables.js';
import {
  BATCH_ROWS,
  MAX_CELL_BYTES,
  MAX_REPORT_ERRORS,
  normalizeOptions,
  openSource,
  preview,
  requireTarget,
  run,
} from '../../../src/import/pipeline.js';
import { AppError } from '../../../src/util/errors.js';
import { dumpDb } from '../db/command.test.js';
import { openWasmEngine } from '../db/helpers.js';

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../../fixtures/import',
);

/** @param {string} name */
async function fixtureBlob(name) {
  const buf = await readFile(path.join(FIXTURES, name));
  const bytes = new Uint8Array(new ArrayBuffer(buf.byteLength));
  bytes.set(buf);
  return new Blob([bytes]);
}

/** @param {string} text */
function csv(text) {
  return new Blob([text]);
}

async function setup() {
  const engine = await openWasmEngine();
  await migrate(engine, { appVersion: 'test' });
  return engine;
}

/**
 * @param {import('../../../src/db/engine.js').Engine} engine
 * @param {string} tableId
 * @param {string[]} colIds
 */
function rowsOf(engine, tableId, colIds) {
  const cols = colIds.map((c) => `"${c}"`).join(', ');
  return engine.exec(`SELECT ${cols} FROM "${tableId}" ORDER BY "id" LIMIT 10000`).rows;
}

/** @param {import('../../../src/db/engine.js').Engine} engine */
function onlyTable(engine) {
  const list = tables.list(engine);
  assert.equal(list.length, 1);
  return /** @type {import('../../../src/db/tables.js').TableInfo} */ (list[0]);
}

test('preview: 헤더 정리, 추론, 미리보기 20행, 인코딩·구분자 감지 결과', async () => {
  const p = await preview(await fixtureBlob('types.csv'), { format: 'csv' });
  assert.equal(p.format, 'csv');
  assert.equal(p.encoding, 'utf-8');
  assert.equal(p.delimiter, ',');
  assert.equal(p.hasHeader, true);
  assert.deepEqual(p.headers, ['flag', 'int', 'real', 'date', 'datetime', 'zip', 'mixed', 'empty']);
  assert.deepEqual(
    p.inferred.map((i) => i.type),
    ['boolean', 'integer', 'real', 'date', 'datetime', 'text', 'text', 'text'],
  );
  assert.equal(p.sampleRows, 3);
  assert.equal(p.exhausted, true);
  assert.equal(p.sample.length, 3);
  assert.deepEqual(p.sample[0], [
    'true',
    '1',
    '1.5',
    '2024-01-01',
    '2024-01-01 10:20:30',
    '01234',
    '1',
    '',
  ]);
  assert.deepEqual(p.warnings, []);
});

test('preview: EUC-KR 감지와 UTF-8 강제 시 인코딩 경고, 세미콜론·탭 감지', async () => {
  const eucKr = await preview(await fixtureBlob('euc-kr.csv'), { format: 'csv' });
  assert.equal(eucKr.encoding, 'euc-kr');
  assert.deepEqual(eucKr.headers, ['이름', '주소']);
  const wrong = await preview(await fixtureBlob('euc-kr.csv'), {
    format: 'csv',
    encoding: 'utf-8',
  });
  assert.equal(wrong.warnings[0]?.kind, 'encoding');
  assert.equal(
    (await preview(await fixtureBlob('semicolon.csv'), { format: 'csv' })).delimiter,
    ';',
  );
  const tsv = await preview(await fixtureBlob('tabs.tsv'), { format: 'csv' });
  assert.equal(tsv.delimiter, '\t');
  assert.deepEqual(tsv.headers, ['a', 'b']);
});

test('preview: 헤더 없음은 자동 이름, 빈·중복 헤더는 접미사와 경고, 필드 초과 10%는 ragged 경고', async () => {
  const noHeader = await preview(csv('1,2,3\n4,5,6\n'), { format: 'csv', hasHeader: false });
  assert.deepEqual(noHeader.headers, ['열1', '열2', '열3']);
  assert.deepEqual(noHeader.sample, [
    ['1', '2', '3'],
    ['4', '5', '6'],
  ]);
  const dup = await preview(csv('a,,a\n1,2,3\n'), { format: 'csv' });
  assert.deepEqual(dup.headers, ['a', '열2', 'a (2)']);
  assert.deepEqual(dup.warnings, [{ kind: 'empty_headers', count: 2 }]);
  const ragged = await preview(await fixtureBlob('ragged.csv'), { format: 'csv' });
  assert.deepEqual(ragged.warnings, [{ kind: 'ragged', count: 1 }]);
  assert.deepEqual(ragged.sample[0], ['1', '2', null], '부족한 필드는 null');
  assert.deepEqual(ragged.sample[1], ['3', '4', '5'], '넘치는 필드는 미리보기에서 잘린다');
  const unterminated = await preview(await fixtureBlob('unterminated.csv'), { format: 'csv' });
  assert.deepEqual(unterminated.warnings, [{ kind: 'unterminated_quote' }]);
});

test('preview: 빈 파일과 헤더만 있는 파일', async () => {
  const empty = await preview(csv(''), { format: 'csv' });
  assert.deepEqual(empty.headers, []);
  assert.equal(empty.sampleRows, 0);
  const headerOnly = await preview(csv('a,b\n'), { format: 'csv' });
  assert.deepEqual(headerOnly.headers, ['a', 'b']);
  assert.deepEqual(
    headerOnly.inferred.map((i) => i.type),
    ['text', 'text'],
  );
});

test('normalizeOptions·requireTarget: 형태가 틀리면 거부한다', () => {
  assert.throws(
    () => normalizeOptions({}),
    (err) => err instanceof AppError && err.code === 'E_DB_QUERY',
  );
  assert.deepEqual(
    normalizeOptions({ format: 'csv', delimiter: ';;', encoding: 'x', headerRow: -1 }),
    {
      format: 'csv',
    },
  );
  assert.deepEqual(normalizeOptions({ format: 'xlsx', sheet: 'S', headerRow: 2 }), {
    format: 'xlsx',
    sheet: 'S',
    headerRow: 2,
  });
  assert.deepEqual(requireTarget({ kind: 'new', name: 't' }), { kind: 'new', name: 't' });
  assert.throws(() => requireTarget({ kind: 'nope' }), /import target/);
});

test('openSource: xlsx는 Step 8 전까지 E_UNSUPPORTED', async () => {
  await assert.rejects(
    openSource(csv(''), { format: 'xlsx' }),
    (err) => err instanceof AppError && err.code === 'E_UNSUPPORTED',
  );
});

test('run: 새 테이블로 가져오기 — 열 생성, 타입 변환, _created_at 일괄, 보고서', async () => {
  const engine = await setup();
  const p = await preview(await fixtureBlob('types.csv'), { format: 'csv' });
  const mapping = {
    columns: p.headers.map((name, i) => ({ source: i, name, type: p.inferred[i]?.type })),
  };
  const { report } = await run({
    engine,
    file: await fixtureBlob('types.csv'),
    options: { format: 'csv' },
    mapping,
    target: { kind: 'new', name: '타입' },
  });
  assert.equal(report.inserted, 3);
  assert.equal(report.skipped, 0);
  assert.equal(report.nulled, 0);
  assert.deepEqual(report.errors, []);
  const table = onlyTable(engine);
  assert.equal(table.id, report.tableId);
  assert.equal(table.name, '타입');
  assert.deepEqual(
    table.columns.map((c) => [c.name, c.type]),
    [
      ['flag', 'boolean'],
      ['int', 'integer'],
      ['real', 'real'],
      ['date', 'date'],
      ['datetime', 'datetime'],
      ['zip', 'text'],
      ['mixed', 'text'],
      ['empty', 'text'],
    ],
  );
  const ids = table.columns.map((c) => c.id);
  assert.deepEqual(rowsOf(engine, table.id, ids), [
    [1, 1, 1.5, '2024-01-01', '2024-01-01T10:20:30', '01234', '1', null],
    [0, 2000, -2, '2024-02-29', '2024-02-29T00:00:00', '00042', 'x', null],
    [1, 3, 300, '2023-12-31', '2023-12-31T23:59:59', '00001', null, null],
  ]);
  const created = engine.exec(`SELECT DISTINCT "_created_at" FROM "${table.id}" LIMIT 10`).rows;
  assert.equal(created.length, 1, '_created_at은 하나의 시각');
  assert.match(String(created[0]?.[0]), /^\d{4}-\d{2}-\d{2}T/);
});

test('run: 정책 null은 NULL로 넣고 보고, abort는 E_VALUE_INVALID로 롤백(덤프 동일), text는 강등 후 재시도', async () => {
  const engine = await setup();
  const before = dumpDb(engine);
  const file = () => csv('n\n1\nx\n3\n');
  const mapping = (/** @type {'null' | 'text' | 'abort'} */ policy) => ({
    columns: [{ source: 0, name: 'n', type: /** @type {const} */ ('integer'), policy }],
  });

  await assert.rejects(
    run({
      engine,
      file: file(),
      options: { format: 'csv' },
      mapping: mapping('abort'),
      target: { kind: 'new', name: 'A' },
    }),
    (err) =>
      err instanceof AppError &&
      err.code === 'E_VALUE_INVALID' &&
      /** @type {{ rowIndex: number, column: string }} */ (err.detail).rowIndex === 3 &&
      /** @type {{ rowIndex: number, column: string }} */ (err.detail).column === 'n',
  );
  assert.deepEqual(dumpDb(engine), before, 'abort 뒤 새 테이블·메타가 남지 않는다');

  const nulled = await run({
    engine,
    file: file(),
    options: { format: 'csv' },
    mapping: mapping('null'),
    target: { kind: 'new', name: 'N' },
  });
  assert.equal(nulled.report.nulled, 1);
  assert.deepEqual(nulled.report.errors, [{ rowIndex: 3, column: 'n', reason: 'invalid' }]);
  const nTable = tables.requireTable(engine, nulled.report.tableId);
  assert.deepEqual(rowsOf(engine, nTable.id, [nTable.columns[0]?.id ?? '']), [[1], [null], [3]]);

  const demoted = await run({
    engine,
    file: file(),
    options: { format: 'csv' },
    mapping: mapping('text'),
    target: { kind: 'new', name: 'T' },
  });
  assert.deepEqual(demoted.report.demoted, ['n']);
  assert.equal(demoted.report.nulled, 0);
  const tTable = tables.requireTable(engine, demoted.report.tableId);
  assert.equal(tTable.columns[0]?.type, 'text');
  assert.deepEqual(rowsOf(engine, tTable.id, [tTable.columns[0]?.id ?? '']), [['1'], ['x'], ['3']]);
  assert.equal(tables.list(engine).length, 2, '강등 재시도가 테이블을 두 번 만들지 않는다');
});

test('run: 기존 테이블에 추가 — 이름 자동 대응은 UI 몫이고 Worker는 columnId로 넣는다, select 항목 자동 추가', async () => {
  const engine = await setup();
  const { tableId } = await tables.create(engine, { name: '고객' });
  const name = (await tables.addColumn(engine, tableId, { name: '이름', type: 'text' })).columnId;
  const grade = (
    await tables.addColumn(engine, tableId, {
      name: '등급',
      type: 'select',
      options: { choices: ['일반'] },
    })
  ).columnId;
  await engine.transaction(() => {
    engine.run(`INSERT INTO "${tableId}" ("${name}", "${grade}") VALUES (?, ?)`, ['기존', '일반']);
  });
  const { report } = await run({
    engine,
    file: csv('이름,등급,무시\n새1,VIP,x\n새2,,y\n'),
    options: { format: 'csv' },
    mapping: {
      columns: [
        { source: 0, columnId: name },
        { source: 1, columnId: grade },
      ],
    },
    target: { kind: 'existing', tableId },
  });
  assert.equal(report.tableId, tableId);
  assert.equal(report.inserted, 2);
  assert.deepEqual(rowsOf(engine, tableId, [name, grade]), [
    ['기존', '일반'],
    ['새1', 'VIP'],
    ['새2', null],
  ]);
  const column = tables.requireTable(engine, tableId).columns.find((c) => c.id === grade);
  assert.deepEqual(column?.options, { choices: ['일반', 'VIP'] }, '없는 값은 선택 항목에 더한다');
});

test('run: 기존 테이블 매핑 검증 — 외부 테이블, 없는·지운·중복 열, text 정책 거부', async () => {
  const engine = await setup();
  const { tableId } = await tables.create(engine, { name: 't' });
  const a = (await tables.addColumn(engine, tableId, { name: 'a', type: 'text' })).columnId;
  const b = (await tables.addColumn(engine, tableId, { name: 'b', type: 'text' })).columnId;
  await tables.softDeleteColumn(engine, tableId, b);
  const before = dumpDb(engine);
  /** @param {import('../../../src/import/pipeline.js').ImportMapping} mapping */
  const attempt = (mapping) =>
    run({
      engine,
      file: csv('x,y\n1,2\n'),
      options: { format: 'csv' },
      mapping,
      target: { kind: 'existing', tableId },
    });
  /** @param {Promise<unknown>} p @param {RegExp} re */
  const rejects = (p, re) =>
    assert.rejects(p, (err) => err instanceof AppError && re.test(err.message));
  await rejects(attempt({ columns: [{ source: 0, columnId: 'nope' }] }), /target column not found/);
  await rejects(attempt({ columns: [{ source: 0, columnId: b }] }), /target column not found/);
  await rejects(
    attempt({
      columns: [
        { source: 0, columnId: a },
        { source: 1, columnId: a },
      ],
    }),
    /mapped twice/,
  );
  await rejects(
    attempt({ columns: [{ source: 0, columnId: a, policy: 'text' }] }),
    /only for new tables/,
  );
  await rejects(attempt({ columns: [] }), /no columns/);
  await rejects(
    run({
      engine,
      file: csv('x\n1\n'),
      options: { format: 'csv' },
      mapping: { columns: [{ source: 0, columnId: a }] },
      target: { kind: 'existing', tableId: 'missing' },
    }),
    /table not found/,
  );
  await engine.transaction(() => {
    engine.run('UPDATE _jdr_tables SET strict = 0 WHERE id = ?', [tableId]);
  });
  await rejects(attempt({ columns: [{ source: 0, columnId: a }] }), /read-only/);
  await engine.transaction(() => {
    engine.run('UPDATE _jdr_tables SET strict = 1 WHERE id = ?', [tableId]);
  });
  assert.deepEqual(dumpDb(engine), before);
});

test('run: 필드 수 불일치(부족 NULL·초과 버림), 빈 행 건너뜀, 셀 크기 상한, 헤더 없음', async () => {
  const engine = await setup();
  const huge = 'h'.repeat(MAX_CELL_BYTES / 2 + 1);
  const { report } = await run({
    engine,
    file: csv(`a,b,c\n1,2\n3,4,5,6\n,,\n${huge},8,9\n`),
    options: { format: 'csv' },
    mapping: {
      columns: [
        { source: 0, name: 'a', type: 'text' },
        { source: 1, name: 'b', type: 'text' },
        { source: 2, name: 'c', type: 'text' },
      ],
    },
    target: { kind: 'new', name: 'R' },
  });
  assert.equal(report.inserted, 3);
  assert.equal(report.skipped, 1, '모든 값이 빈 행');
  assert.equal(report.nulled, 1);
  assert.deepEqual(report.errors, [
    { rowIndex: 3, reason: 'extra_fields' },
    { rowIndex: 5, column: 'a', reason: 'too_long' },
  ]);
  const table = tables.requireTable(engine, report.tableId);
  assert.deepEqual(
    rowsOf(
      engine,
      table.id,
      table.columns.map((c) => c.id),
    ),
    [
      ['1', '2', null],
      ['3', '4', '5'],
      [null, '8', '9'],
    ],
  );

  const noHeader = await run({
    engine,
    file: csv('1,2\n3,4\n'),
    options: { format: 'csv', hasHeader: false },
    mapping: { columns: [{ source: 1, name: '둘째', type: 'integer' }] },
    target: { kind: 'new', name: 'H' },
  });
  assert.equal(noHeader.report.inserted, 2);
  const h = tables.requireTable(engine, noHeader.report.tableId);
  assert.deepEqual(rowsOf(engine, h.id, [h.columns[0]?.id ?? '']), [[2], [4]]);
});

test('run: 배치 경계를 넘는 행 수에서 진행률이 오르고 보고서 오류는 상한까지만 담는다', async () => {
  const engine = await setup();
  const lines = ['n'];
  for (let i = 1; i <= BATCH_ROWS * 2 + 5; i += 1) lines.push(i % 20 === 0 ? 'bad' : String(i));
  /** @type {Array<{ done: number, total: number }>} */
  const progress = [];
  const { report } = await run({
    engine,
    file: csv(`${lines.join('\n')}\n`),
    options: { format: 'csv' },
    mapping: { columns: [{ source: 0, name: 'n', type: 'integer' }] },
    target: { kind: 'new', name: 'P' },
    progress: (p) => progress.push({ done: p.done, total: p.total }),
  });
  assert.equal(report.inserted, BATCH_ROWS * 2 + 5);
  assert.equal(report.nulled, Math.floor((BATCH_ROWS * 2 + 5) / 20));
  assert.equal(report.errorCount, report.nulled);
  assert.equal(report.errors.length, Math.min(MAX_REPORT_ERRORS, report.nulled));
  assert.deepEqual(
    progress.map((p) => p.done),
    [0, BATCH_ROWS, BATCH_ROWS * 2, BATCH_ROWS * 2 + 5, BATCH_ROWS * 2 + 5],
  );
  assert.equal(progress[0]?.total, 0, 'CSV는 행 수를 미리 모른다');
  assert.equal(progress.at(-1)?.total, BATCH_ROWS * 2 + 5, '끝에서는 total을 채워 완료를 알린다');
});

test('run: 취소하면 전체가 롤백되어 새 테이블도 기존 테이블의 행도 남지 않는다', async () => {
  const engine = await setup();
  const { tableId } = await tables.create(engine, { name: '기존' });
  const col = (await tables.addColumn(engine, tableId, { name: 'n', type: 'integer' })).columnId;
  const before = dumpDb(engine);
  const lines = ['n'];
  for (let i = 1; i <= BATCH_ROWS * 3; i += 1) lines.push(String(i));
  const text = `${lines.join('\n')}\n`;

  for (const target of /** @type {const} */ ([
    { kind: 'new', name: '새것' },
    { kind: 'existing', tableId },
  ])) {
    const controller = new AbortController();
    const mapping =
      target.kind === 'new'
        ? { columns: [{ source: 0, name: 'n', type: /** @type {const} */ ('integer') }] }
        : { columns: [{ source: 0, columnId: col }] };
    await assert.rejects(
      run({
        engine,
        file: csv(text),
        options: { format: 'csv' },
        mapping,
        target,
        signal: controller.signal,
        progress: (p) => {
          // 첫 배치가 들어간 뒤 취소한다. 다음 배치 전에 확인되어 롤백된다.
          if (p.done >= BATCH_ROWS) controller.abort();
        },
      }),
      (err) => err instanceof AppError && err.code === 'E_IMPORT_CANCELLED',
      String(target.kind),
    );
    assert.deepEqual(dumpDb(engine), before, `${target.kind}: 취소 뒤 덤프 동일`);
  }
  assert.equal(engine.exec(`SELECT count(*) FROM "${tableId}"`).rows[0]?.[0], 0);
});

test('run: 이미 취소된 신호로 시작하면 아무것도 넣지 않는다', async () => {
  const engine = await setup();
  const before = dumpDb(engine);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    run({
      engine,
      file: csv('n\n1\n'),
      options: { format: 'csv' },
      mapping: { columns: [{ source: 0, name: 'n', type: 'integer' }] },
      target: { kind: 'new', name: 'X' },
      signal: controller.signal,
    }),
    (err) => err instanceof AppError && err.code === 'E_IMPORT_CANCELLED',
  );
  assert.deepEqual(dumpDb(engine), before);
});
