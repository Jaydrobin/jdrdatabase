// @ts-check
/**
 * 메타 스키마(Step 2): 헤더 검사, 마이그레이션, revision, 무결성, 외부 파일 등록.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  adoptExternal,
  bumpRevision,
  hasMeta,
  integrityCheck,
  listPhysicalTables,
  migrate,
  MIGRATIONS,
  newUuid,
  quoteIdent,
  readMeta,
  SCHEMA_VERSION,
  validateHeader,
  writeMeta,
} from '../../../src/db/schema.js';
import { AppError } from '../../../src/util/errors.js';
import { openWasmEngine } from './helpers.js';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../fixtures');

/** @param {string} name */
async function fixture(name) {
  return new Uint8Array(await readFile(path.join(FIXTURES, name)));
}

test('quoteIdent: 큰따옴표를 두 개로, 빈 이름·NUL은 거부', () => {
  assert.equal(quoteIdent('t_01234567'), '"t_01234567"');
  assert.equal(quoteIdent('a"b'), '"a""b"');
  assert.equal(quoteIdent('한글 열'), '"한글 열"');
  assert.throws(
    () => quoteIdent(''),
    (e) => e instanceof AppError && e.code === 'E_DB_QUERY',
  );
  assert.throws(
    () => quoteIdent('a\0b'),
    (e) => e instanceof AppError && e.code === 'E_DB_QUERY',
  );
});

test('validateHeader: 매직 헤더가 맞으면 통과, 짧거나 다르면 E_FILE_NOT_SQLITE', async () => {
  const engine = await openWasmEngine();
  const good = engine.snapshot();
  await engine.close();
  assert.doesNotThrow(() => validateHeader(good));

  const short = good.slice(0, 50);
  assert.throws(
    () => validateHeader(short),
    (e) => e instanceof AppError && e.code === 'E_FILE_NOT_SQLITE',
  );
  const junk = await fixture('not-sqlite.txt');
  assert.throws(
    () => validateHeader(junk),
    (e) => e instanceof AppError && e.code === 'E_FILE_NOT_SQLITE',
  );
  const flipped = good.slice();
  flipped[0] = 0x58;
  assert.throws(
    () => validateHeader(flipped),
    (e) =>
      e instanceof AppError &&
      e.code === 'E_FILE_NOT_SQLITE' &&
      /** @type {{ offset: number }} */ (e.detail).offset === 0,
  );
});

test('migrate: 빈 DB → 최신 스키마, db_id·revision 0·app_version 기록, 재실행은 무해', async () => {
  const engine = await openWasmEngine();
  assert.equal(hasMeta(engine), false);
  const first = await migrate(engine, { appVersion: '9.9.9', now: '2026-09-20T00:00:00.000Z' });
  assert.equal(first.readOnly, false);
  assert.equal(first.meta.schema_version, String(SCHEMA_VERSION));
  assert.equal(first.meta.revision, '0');
  assert.equal(first.meta.app_version, '9.9.9');
  assert.equal(first.meta.created_at, '2026-09-20T00:00:00.000Z');
  assert.match(first.meta.db_id ?? '', /^[0-9a-f-]{36}$/);
  assert.equal(hasMeta(engine), true);
  const tables = engine
    .exec("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name LIMIT 100")
    .rows.map((r) => r[0]);
  assert.deepEqual(tables, ['_jdr_columns', '_jdr_meta', '_jdr_tables', '_jdr_views']);

  const again = await migrate(engine, { appVersion: '9.9.10' });
  assert.deepEqual(again.meta, first.meta, '이미 최신이면 메타가 바뀌지 않는다');
  assert.equal(MIGRATIONS.length, SCHEMA_VERSION);
  await engine.close();
});

test('migrate: dbId를 주면 그 값으로 만든다(저널 복구용)', async () => {
  const engine = await openWasmEngine();
  const id = newUuid();
  const r = await migrate(engine, { appVersion: '0', dbId: id });
  assert.equal(r.meta.db_id, id);
  await engine.close();
});

test('migrate: 앱보다 새로운 schema_version은 손대지 않고 readOnly', async () => {
  const engine = await openWasmEngine();
  await migrate(engine, { appVersion: '0' });
  await engine.transaction(() => {
    writeMeta(engine, { schema_version: SCHEMA_VERSION + 5, future_key: 'x' });
  });
  const r = await migrate(engine, { appVersion: '0' });
  assert.equal(r.readOnly, true);
  assert.equal(r.meta.schema_version, String(SCHEMA_VERSION + 5));
  assert.equal(r.meta.future_key, 'x');
  await engine.close();
});

test('bumpRevision: revision + 1, saved_at, saved_by', async () => {
  const engine = await openWasmEngine();
  await migrate(engine, { appVersion: '0' });
  const a = await bumpRevision(engine, { savedBy: '기기-A', now: '2026-09-20T01:00:00.000Z' });
  assert.equal(a.revision, '1');
  assert.equal(a.saved_by, '기기-A');
  assert.equal(a.saved_at, '2026-09-20T01:00:00.000Z');
  const b = await bumpRevision(engine, { savedBy: '기기-B' });
  assert.equal(b.revision, '2');
  assert.equal(readMeta(engine).saved_by, '기기-B');
  await engine.close();
});

test('integrityCheck: 정상 DB는 통과, 손상 픽스처는 E_FILE_CORRUPT', async () => {
  const ok = await openWasmEngine();
  assert.doesNotThrow(() => integrityCheck(ok));
  await ok.close();

  const corrupt = await openWasmEngine(await fixture('corrupt.db'));
  assert.throws(
    () => integrityCheck(corrupt),
    (e) =>
      e instanceof AppError &&
      e.code === 'E_FILE_CORRUPT' &&
      /page/.test(String(/** @type {{ report: string }} */ (e.detail).report)),
  );
  await corrupt.close();
});

test('adoptExternal: 외부 파일의 테이블을 strict = 0, 열은 text로 등록하고 데이터는 그대로', async () => {
  const engine = await openWasmEngine(await fixture('external.db'));
  assert.equal(hasMeta(engine), false);
  assert.deepEqual(listPhysicalTables(engine), ['users', 'posts']);
  const meta = await adoptExternal(engine, { appVersion: '0', now: '2026-09-20T00:00:00.000Z' });
  assert.equal(meta.revision, '0');
  assert.ok(meta.db_id);

  const tables = engine.exec(
    'SELECT id, name, position, strict FROM _jdr_tables ORDER BY position LIMIT 100',
  ).rows;
  assert.deepEqual(tables, [
    ['users', 'users', 0, 0],
    ['posts', 'posts', 1, 0],
  ]);
  const columns = engine.exec(
    'SELECT table_id, id, name, type, position FROM _jdr_columns ORDER BY table_id, position LIMIT 100',
  ).rows;
  assert.deepEqual(columns, [
    ['posts', 'id', 'id', 'text', 0],
    ['posts', 'name', 'name', 'text', 1],
    ['posts', 'body', 'body', 'text', 2],
    ['users', 'id', 'id', 'text', 0],
    ['users', 'name', 'name', 'text', 1],
    ['users', 'age', 'age', 'text', 2],
  ]);
  // 같은 열 이름(name)이 두 테이블에 있어도 (table_id, id) 기본 키로 공존한다.
  assert.deepEqual(engine.exec('SELECT count(*) FROM users').rows, [[2]]);
  assert.deepEqual(engine.exec('SELECT name FROM posts LIMIT 10').rows, [['첫 글']]);
  // 등록 뒤에는 메타가 있으므로 다시 등록하지 않아도 되고, 물리 테이블 목록에서 메타는 빠진다.
  assert.deepEqual(listPhysicalTables(engine), ['users', 'posts']);
  await engine.close();
});
