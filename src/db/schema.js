// @ts-check
/**
 * 메타 스키마(DESIGN.md 4.1): 메타 테이블 DDL, 마이그레이션, 헤더·무결성 검사, 외부 파일 등록, 식별자 인용.
 *
 * 메타 테이블 접두사 `_jdr_`는 이 파일과 util/ids.js에만 문자열로 존재한다(CLAUDE.md 5.2).
 * 이 모듈은 `Engine` 인터페이스만 호출한다.
 */
import { AppError } from '../util/errors.js';

/** @typedef {import('./engine.js').Engine} Engine */
/** @typedef {Record<string, string>} Meta `_jdr_meta`의 key → value */

/** SQLite 파일 매직 헤더(16바이트). */
export const SQLITE_HEADER = 'SQLite format 3\0';
/** SQLite 파일 헤더 길이. 이보다 짧은 파일은 SQLite 파일이 아니다. */
const SQLITE_HEADER_BYTES = 100;

/** 메타 테이블 접두사. 사용자 테이블 목록에서 제외한다. */
export const META_PREFIX = '_jdr_';
/** 사용자 테이블에 항상 있는 시스템 열(D-03). `_jdr_columns`에는 넣지 않는다. */
export const SYSTEM_COLUMNS = Object.freeze(['id', '_created_at', '_updated_at']);

/** `_jdr_columns.width`의 기본값(px). */
export const DEFAULT_COLUMN_WIDTH = 160;
/** SQLite 기본 열 상한(`SQLITE_MAX_COLUMN`). 이 수에 이르면 열 추가를 거부한다. */
export const MAX_COLUMNS = 2000;
/** 이 수부터 UI가 경고한다(Step 3 예외 처리). */
export const WARN_COLUMNS = 1000;

/** @typedef {import('./values.js').LogicalType} LogicalType */
/** @typedef {import('./tables.js').ColumnInfo} ColumnInfo */

/**
 * 논리 타입 → STRICT 물리 타입(4.2).
 * @param {LogicalType} logicalType
 * @returns {'TEXT' | 'INTEGER' | 'REAL'}
 */
export function physicalType(logicalType) {
  switch (logicalType) {
    case 'integer':
    case 'boolean':
      return 'INTEGER';
    case 'real':
      return 'REAL';
    case 'text':
    case 'longtext':
    case 'date':
    case 'datetime':
    case 'select':
      return 'TEXT';
    default:
      throw new AppError('E_DB_QUERY', `unknown logical type: ${String(logicalType)}`, {
        detail: { type: logicalType },
      });
  }
}

/**
 * @param {string} name
 * @returns {boolean}
 */
export function isSystemColumn(name) {
  return SYSTEM_COLUMNS.includes(name);
}

/**
 * 사용자 테이블의 DDL(D-03). 시스템 열 뒤에 `columns`를 주어진 순서로 선언한 STRICT 테이블이다.
 * 기본 열(D-16)을 한 문장에 함께 만든다. 열마다 `ALTER TABLE … ADD COLUMN`을 부르면 30열에서 30문장이 된다.
 * @param {string} tableId
 * @param {ReadonlyArray<{ id: string, type: LogicalType }>} [columns]
 * @returns {string}
 */
export function userTableDdl(tableId, columns = []) {
  const defs = columns.map((c) => `, ${quoteIdent(c.id)} ${physicalType(c.type)}`).join('');
  return `CREATE TABLE ${quoteIdent(tableId)} ("id" INTEGER PRIMARY KEY, "_created_at" TEXT, "_updated_at" TEXT${defs}) STRICT`;
}

/**
 * 검색 인덱스(D-07)의 FTS5 테이블 이름. 메타 접두사를 쓰므로 사용자 테이블 목록에서 자동으로 빠진다.
 * @param {string} tableId
 * @returns {string}
 */
export function ftsTableFor(tableId) {
  return `${META_PREFIX}fts_${tableId}`;
}

/**
 * 검색 인덱스가 만들어진 뒤에 열 구성이 바뀌었는가(D-07). FTS 테이블은 만든 시점의 열 집합에
 * 고정되므로, 그 뒤 추가된 텍스트 열은 검색되지 않고 타입이 바뀌어 소프트 삭제된 열은 인덱스에
 * 남아 "결과에 행은 나오는데 화면에 일치하는 칸이 없는" 상태가 된다. 다시 만들면 맞춰지지만
 * 30만 행에서 수십 초가 걸리므로 자동으로 하지 않고 알리기만 한다.
 * @param {Engine} engine
 * @param {{ id: string, ftsEnabled: boolean, columns: ColumnInfo[] }} table
 * @returns {boolean}
 */
export function ftsIndexStale(engine, table) {
  if (!table.ftsEnabled) return false;
  /** @type {Set<string>} */
  let indexed;
  try {
    indexed = new Set(
      engine
        .exec('SELECT name FROM pragma_table_info(?)', [ftsTableFor(table.id)])
        .rows.map((row) => String(row[0])),
    );
  } catch {
    // 인덱스 테이블을 읽을 수 없으면 "오래되었다"고 단정하지 않는다(검색은 폴백으로 동작한다).
    return false;
  }
  const current = table.columns.filter(
    (c) => c.deletedAt === null && physicalType(c.type) === 'TEXT',
  );
  if (current.length !== indexed.size) return true;
  return current.some((c) => !indexed.has(c.id));
}

/**
 * 검색 인덱스를 원본 테이블과 동기화하는 트리거 이름 셋.
 * @param {string} tableId
 * @returns {{ insert: string, delete: string, update: string }}
 */
export function ftsTriggersFor(tableId) {
  const base = ftsTableFor(tableId);
  return { insert: `${base}_ai`, delete: `${base}_ad`, update: `${base}_au` };
}

/**
 * 식별자(테이블·열 이름)를 SQL에 넣을 때는 반드시 이 함수를 거친다(CLAUDE.md 5.3).
 * @param {string} name
 * @returns {string}
 */
export function quoteIdent(name) {
  if (typeof name !== 'string' || name.length === 0) {
    throw new AppError('E_DB_QUERY', 'identifier must be a non-empty string', {
      detail: { name: String(name).slice(0, 80) },
    });
  }
  if (name.includes('\0')) {
    throw new AppError('E_DB_QUERY', 'identifier must not contain NUL', {
      detail: { name: name.slice(0, 80) },
    });
  }
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * SQLite 매직 헤더를 확인한다. 실패하면 `E_FILE_NOT_SQLITE`.
 * @param {Uint8Array} bytes
 */
export function validateHeader(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < SQLITE_HEADER_BYTES) {
    throw new AppError('E_FILE_NOT_SQLITE', 'file is shorter than the SQLite header', {
      detail: { bytes: bytes instanceof Uint8Array ? bytes.byteLength : -1 },
    });
  }
  for (let i = 0; i < SQLITE_HEADER.length; i += 1) {
    if (bytes[i] !== SQLITE_HEADER.charCodeAt(i)) {
      throw new AppError('E_FILE_NOT_SQLITE', 'SQLite magic header mismatch', {
        detail: { offset: i },
      });
    }
  }
}

/**
 * 마이그레이션 목록. 인덱스 + 1이 그 마이그레이션 뒤의 `schema_version`이다.
 * 항목은 뒤에만 추가하고 기존 항목은 고치지 않는다.
 * @type {ReadonlyArray<(engine: Engine) => void>}
 */
export const MIGRATIONS = Object.freeze([
  (engine) => {
    engine.run(
      'CREATE TABLE IF NOT EXISTS _jdr_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT',
    );
    engine.run(
      `CREATE TABLE IF NOT EXISTS _jdr_tables (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        position INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        fts_enabled INTEGER NOT NULL DEFAULT 0,
        strict INTEGER NOT NULL DEFAULT 1
      ) STRICT`,
    );
    engine.run(
      `CREATE TABLE IF NOT EXISTS _jdr_columns (
        id TEXT NOT NULL,
        table_id TEXT NOT NULL REFERENCES _jdr_tables(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        position INTEGER NOT NULL,
        width INTEGER NOT NULL DEFAULT 160,
        options TEXT,
        deleted_at TEXT,
        PRIMARY KEY (table_id, id)
      ) STRICT`,
    );
    engine.run(
      `CREATE TABLE IF NOT EXISTS _jdr_views (
        id TEXT PRIMARY KEY,
        table_id TEXT NOT NULL REFERENCES _jdr_tables(id) ON DELETE CASCADE,
        name TEXT NOT NULL,
        spec TEXT NOT NULL
      ) STRICT`,
    );
  },
]);

/** 이 앱이 쓰는 `schema_version`. */
export const SCHEMA_VERSION = MIGRATIONS.length;

/**
 * `crypto.randomUUID`가 없는 환경(일부 WebView)을 위한 폴백을 포함한 UUID v4.
 * @returns {string}
 */
export function newUuid() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  b[6] = ((b[6] ?? 0) & 0x0f) | 0x40;
  b[8] = ((b[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * ISO 8601(UTC) 시각. 메타의 `created_at`·`saved_at`에 쓴다.
 * @returns {string}
 */
export function nowIso() {
  return new Date().toISOString();
}

/**
 * `_jdr_meta` 테이블이 있는가.
 * @param {Engine} engine
 * @returns {boolean}
 */
export function hasMeta(engine) {
  const r = engine.exec(
    "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    ['_jdr_meta'],
  );
  return Number(r.rows[0]?.[0]) > 0;
}

/**
 * @param {Engine} engine
 * @returns {Meta}
 */
export function readMeta(engine) {
  /** @type {Meta} */
  const meta = {};
  for (const row of engine.exec('SELECT key, value FROM _jdr_meta LIMIT 1000').rows) {
    meta[String(row[0])] = String(row[1]);
  }
  return meta;
}

/**
 * 메타 키를 넣거나 갱신한다. 트랜잭션 안에서만 부른다.
 * @param {Engine} engine
 * @param {Record<string, string | number>} entries
 */
export function writeMeta(engine, entries) {
  const stmt = engine.prepareCached(
    'INSERT INTO _jdr_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  );
  for (const [key, value] of Object.entries(entries)) {
    engine.run(stmt, [key, String(value)]);
  }
}

/**
 * `PRAGMA integrity_check`. 첫 오류 한 줄만 받아 실패하면 `E_FILE_CORRUPT`.
 * @param {Engine} engine
 */
export function integrityCheck(engine) {
  const r = engine.exec('PRAGMA integrity_check(1)');
  const first = r.rows[0]?.[0];
  if (first !== 'ok') {
    throw new AppError('E_FILE_CORRUPT', 'integrity_check failed', {
      detail: { report: String(first).slice(0, 200) },
    });
  }
}

/**
 * @typedef {object} MigrateOptions
 * @property {string} appVersion `_jdr_meta.app_version`
 * @property {string} [dbId] 새 DB에 줄 `db_id`. 없으면 새로 만든다(저널 복구가 같은 id의 빈 DB를 만들 때 쓴다)
 * @property {string} [now] 테스트용 시각 주입
 */

/**
 * @typedef {object} MigrateResult
 * @property {Meta} meta
 * @property {boolean} readOnly 앱보다 새로운 `schema_version`이라 손대지 않고 읽기 전용으로 여는 경우
 */

/**
 * 메타를 최신 스키마로 올린다. 메타가 없으면 새로 만들고 `db_id`·`revision = 0`을 기록한다.
 * 앱보다 새로운 파일은 고치지 않고 `readOnly: true`를 돌려준다(`E_FILE_NEWER_SCHEMA`의 UI 행동).
 * @param {Engine} engine
 * @param {MigrateOptions} options
 * @returns {Promise<MigrateResult>}
 */
export async function migrate(engine, options) {
  const now = options.now ?? nowIso();
  return engine.transaction(() => {
    const fresh = !hasMeta(engine);
    let current = 0;
    if (!fresh) {
      const meta = readMeta(engine);
      current = Number.parseInt(meta.schema_version ?? '0', 10);
      if (!Number.isFinite(current) || current < 0) current = 0;
      if (current > SCHEMA_VERSION) return { meta, readOnly: true };
    }
    for (let v = current; v < SCHEMA_VERSION; v += 1) {
      const step = MIGRATIONS[v];
      if (step) step(engine);
    }
    if (fresh) {
      writeMeta(engine, {
        schema_version: SCHEMA_VERSION,
        db_id: options.dbId ?? newUuid(),
        revision: 0,
        created_at: now,
        app_version: options.appVersion,
      });
    } else if (current < SCHEMA_VERSION) {
      writeMeta(engine, { schema_version: SCHEMA_VERSION });
    }
    return { meta: readMeta(engine), readOnly: false };
  });
}

/**
 * 저장 직전에 `revision + 1`, `saved_at`, `saved_by`를 기록한다(D-10).
 * @param {Engine} engine
 * @param {{ savedBy: string, now?: string }} options
 * @returns {Promise<Meta>}
 */
export async function bumpRevision(engine, options) {
  return engine.transaction(() => {
    const meta = readMeta(engine);
    const revision = Number.parseInt(meta.revision ?? '0', 10);
    writeMeta(engine, {
      revision: (Number.isFinite(revision) ? revision : 0) + 1,
      saved_at: options.now ?? nowIso(),
      saved_by: options.savedBy,
    });
    return readMeta(engine);
  });
}

/**
 * 메타가 아닌 사용자 테이블의 물리 이름 목록(`sqlite_*`·`_jdr_*` 제외).
 * @param {Engine} engine
 * @returns {string[]}
 */
export function listPhysicalTables(engine) {
  const r = engine.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE ? ESCAPE '\\' ORDER BY rowid LIMIT 10000",
    [`${META_PREFIX.replace(/_/g, '\\_')}%`],
  );
  return r.rows.map((row) => String(row[0]));
}

/**
 * 다른 도구가 만든 SQLite 파일을 이 앱의 관리 대상으로 등록한다(Step 2 예외 처리).
 * 메타 테이블을 만들고 기존 테이블을 `strict = 0`으로, 열은 모두 `text`로 등록한다.
 * 기존 데이터는 바꾸지 않는다.
 * @param {Engine} engine
 * @param {MigrateOptions} options
 * @returns {Promise<Meta>}
 */
export async function adoptExternal(engine, options) {
  const now = options.now ?? nowIso();
  const physical = listPhysicalTables(engine);
  const migrated = await migrate(engine, { ...options, now });
  if (migrated.readOnly) return migrated.meta;
  await engine.transaction(() => {
    const insertTable = engine.prepareCached(
      'INSERT INTO _jdr_tables (id, name, position, created_at, fts_enabled, strict) VALUES (?, ?, ?, ?, 0, 0)',
    );
    const insertColumn = engine.prepareCached(
      'INSERT INTO _jdr_columns (id, table_id, name, type, position, width) VALUES (?, ?, ?, ?, ?, ?)',
    );
    physical.forEach((table, position) => {
      engine.run(insertTable, [table, table, position, now]);
      // table-valued pragma는 인자를 바인딩할 수 있다. 결과는 열 수(최대 2,000)만큼이다.
      const cols = engine.exec('SELECT name FROM pragma_table_info(?) ORDER BY cid LIMIT 2000', [
        table,
      ]);
      cols.rows.forEach((row, colPosition) => {
        const col = String(row[0]);
        engine.run(insertColumn, [col, table, col, 'text', colPosition, DEFAULT_COLUMN_WIDTH]);
      });
    });
  });
  return readMeta(engine);
}
