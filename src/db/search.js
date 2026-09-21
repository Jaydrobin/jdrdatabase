// @ts-check
/**
 * 전문 검색(D-07, Step 6): FTS5 trigram 인덱스의 생성·삭제와 질의 조각, 인덱스가 없을 때의 LIKE 폴백.
 *
 * - 인덱스는 external-content FTS5 테이블 + 동기화 트리거 3개이며, 생성·삭제는 D-08 커맨드다(저널·되돌리기).
 *   생성 커맨드의 초기 인덱싱은 `{ index }` 단계로, Worker가 청크마다 진행률을 보내고 취소를 확인한다.
 * - 검색 대상 열은 물리 타입이 TEXT인 살아 있는 열이다. 인덱스와 LIKE 폴백이 같은 열 집합을 본다.
 * - 이 모듈은 `Engine` 인터페이스만 호출하고, 식별자는 `quoteIdent()`, 값은 파라미터 바인딩으로만 넣는다.
 */
import { AppError } from '../util/errors.js';
import { applyCommand } from './command.js';
import { ftsTableFor, ftsTriggersFor, physicalType, quoteIdent } from './schema.js';
import { requireTable } from './tables.js';

/** @typedef {import('./engine.js').Engine} Engine */
/** @typedef {import('./engine.js').SqlValue} SqlValue */
/** @typedef {import('./command.js').Command} Command */
/** @typedef {import('./command.js').Statement} Statement */
/** @typedef {import('./command.js').ApplyContext} ApplyContext */
/** @typedef {import('./tables.js').TableInfo} TableInfo */
/** @typedef {import('./tables.js').ColumnInfo} ColumnInfo */

/** @typedef {{ sql: string, params: SqlValue[] }} SqlFragment */

/** trigram 토크나이저가 처리할 수 있는 최소 검색어 길이(문자 수). 그보다 짧으면 LIKE 폴백. */
export const FTS_MIN_QUERY_CHARS = 3;

/**
 * 검색 대상 열: 살아 있고 물리 타입이 TEXT인 열(`text`·`longtext`·`date`·`datetime`·`select`).
 * @param {TableInfo} table
 * @returns {ColumnInfo[]}
 */
export function searchableColumns(table) {
  return table.columns.filter((c) => c.deletedAt === null && physicalType(c.type) === 'TEXT');
}

/**
 * 사용자 입력을 FTS5 구절 하나로 감싼다. 안의 `"`는 `""`로 이스케이프하므로 구문 오류가 나지 않는다.
 * @param {string} q
 * @returns {string}
 */
export function ftsMatchQuery(q) {
  return `"${q.replace(/"/g, '""')}"`;
}

/**
 * LIKE 패턴. `%`, `_`, `\`를 `\`로 이스케이프한다(`ESCAPE '\'`와 함께 쓴다).
 * @param {string} q
 * @returns {string}
 */
export function likePattern(q) {
  return `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

/**
 * 인덱스가 있는 테이블의 검색 조각: `"id" IN (SELECT rowid FROM fts WHERE fts MATCH ?)`.
 * @param {string} tableId
 * @param {string} q
 * @returns {SqlFragment}
 */
export function query(tableId, q) {
  const fts = quoteIdent(ftsTableFor(tableId));
  return {
    sql: `"id" IN (SELECT rowid FROM ${fts} WHERE ${fts} MATCH ?)`,
    params: [ftsMatchQuery(q)],
  };
}

/**
 * 인덱스가 없거나 검색어가 짧을 때의 폴백: 검색 대상 열 각각에 `LIKE ... ESCAPE '\'`를 OR로 잇는다.
 * 열이 없으면 아무 행도 맞지 않는 조각(`0`)을 돌려준다.
 * @param {ColumnInfo[]} columns
 * @param {string} q
 * @returns {SqlFragment}
 */
export function fallbackLike(columns, q) {
  if (columns.length === 0) return { sql: '0', params: [] };
  const pattern = likePattern(q);
  return {
    sql: `(${columns.map((c) => `${quoteIdent(c.id)} LIKE ? ESCAPE '\\'`).join(' OR ')})`,
    params: columns.map(() => pattern),
  };
}

/**
 * 인덱스를 만드는 문장(`create`)과 지우는 문장(`drop`). 생성 커맨드는 `do = create, undo = drop`,
 * 삭제 커맨드는 그 반대다. `columnIds`는 인덱스에 담는 열이며 만드는 시점에 고정된다(D-07).
 * @param {string} tableId
 * @param {string[]} columnIds
 * @returns {{ create: Statement[], drop: Statement[] }}
 */
export function indexStatements(tableId, columnIds) {
  const ftsName = ftsTableFor(tableId);
  const triggers = ftsTriggersFor(tableId);
  const t = quoteIdent(tableId);
  const f = quoteIdent(ftsName);
  const cols = columnIds.map(quoteIdent).join(', ');
  const newVals = columnIds.map((id) => `new.${quoteIdent(id)}`).join(', ');
  const oldVals = columnIds.map((id) => `old.${quoteIdent(id)}`).join(', ');
  // external-content 테이블: 본문은 원본 테이블에 있고 FTS는 rowid(= id)와 토큰만 갖는다.
  // 'delete' 명령은 인덱스에 들어 있던 값 그대로를 받아야 하므로 트리거가 old.* 를 넘긴다.
  const create = [
    {
      sql: `CREATE VIRTUAL TABLE ${f} USING fts5(${cols}, content=${quoteIdent(tableId)}, content_rowid='id', tokenize='trigram')`,
    },
    {
      sql: `CREATE TRIGGER ${quoteIdent(triggers.insert)} AFTER INSERT ON ${t} BEGIN INSERT INTO ${f}(rowid, ${cols}) VALUES (new."id", ${newVals}); END`,
    },
    {
      sql: `CREATE TRIGGER ${quoteIdent(triggers.delete)} AFTER DELETE ON ${t} BEGIN INSERT INTO ${f}(${f}, rowid, ${cols}) VALUES ('delete', old."id", ${oldVals}); END`,
    },
    {
      sql: `CREATE TRIGGER ${quoteIdent(triggers.update)} AFTER UPDATE OF ${cols} ON ${t} BEGIN INSERT INTO ${f}(${f}, rowid, ${cols}) VALUES ('delete', old."id", ${oldVals}); INSERT INTO ${f}(rowid, ${cols}) VALUES (new."id", ${newVals}); END`,
    },
    { index: { table: tableId, fts: ftsName, columns: [...columnIds] } },
    { sql: 'UPDATE _jdr_tables SET fts_enabled = 1 WHERE id = ?', params: [tableId] },
  ];
  const drop = [
    { sql: 'UPDATE _jdr_tables SET fts_enabled = 0 WHERE id = ?', params: [tableId] },
    { sql: `DROP TRIGGER ${quoteIdent(triggers.insert)}` },
    { sql: `DROP TRIGGER ${quoteIdent(triggers.delete)}` },
    { sql: `DROP TRIGGER ${quoteIdent(triggers.update)}` },
    { sql: `DROP TABLE ${f}` },
  ];
  return { create, drop };
}

/**
 * 인덱스가 실제로 담고 있는 열 id(만든 뒤 열이 늘거나 지워졌을 수 있으므로 메타가 아니라 FTS 테이블에서 읽는다).
 * @param {Engine} engine
 * @param {string} tableId
 * @returns {string[]}
 */
export function indexedColumnIds(engine, tableId) {
  const r = engine.exec('SELECT name FROM pragma_table_info(?) ORDER BY cid LIMIT 2000', [
    ftsTableFor(tableId),
  ]);
  return r.rows.map((row) => String(row[0]));
}

/**
 * 검색 인덱스를 만든다. FTS5 테이블·트리거 생성과 초기 인덱싱(진행률·취소)이 커맨드 하나다.
 * 취소하면 트랜잭션이 롤백되어 테이블·트리거·`fts_enabled`가 모두 원래대로 돌아간다.
 * @param {Engine} engine
 * @param {string} tableId
 * @param {ApplyContext} [ctx]
 * @returns {Promise<{ cmd: Command }>}
 */
export async function enable(engine, tableId, ctx = {}) {
  const table = requireTable(engine, tableId);
  if (!table.strict) {
    throw new AppError('E_DB_QUERY', 'external (non-STRICT) tables cannot have a search index', {
      detail: { reason: 'external_table', tableId },
    });
  }
  if (table.ftsEnabled) {
    throw new AppError('E_DB_QUERY', 'search index already exists', {
      detail: { reason: 'fts_enabled', tableId },
    });
  }
  const columns = searchableColumns(table);
  if (columns.length === 0) {
    throw new AppError('E_DB_QUERY', 'table has no searchable (text) columns', {
      detail: { reason: 'no_searchable_columns', tableId },
    });
  }
  const statements = indexStatements(
    tableId,
    columns.map((c) => c.id),
  );
  /** @type {Command} */
  const cmd = {
    type: 'search.enable',
    tableId,
    do: statements.create,
    undo: statements.drop,
    summary: `search.enable ${table.name}`,
  };
  await applyCommand(engine, cmd, 'do', ctx);
  return { cmd };
}

/**
 * 검색 인덱스를 지운다. 되돌리기는 같은 열로 인덱스를 다시 만든다(진행률 없음).
 * @param {Engine} engine
 * @param {string} tableId
 * @returns {Promise<{ cmd: Command }>}
 */
export async function disable(engine, tableId) {
  const table = requireTable(engine, tableId);
  if (!table.ftsEnabled) {
    throw new AppError('E_DB_QUERY', 'table has no search index', {
      detail: { reason: 'fts_disabled', tableId },
    });
  }
  const statements = indexStatements(tableId, indexedColumnIds(engine, tableId));
  /** @type {Command} */
  const cmd = {
    type: 'search.disable',
    tableId,
    do: statements.drop,
    undo: statements.create,
    summary: `search.disable ${table.name}`,
  };
  await applyCommand(engine, cmd);
  return { cmd };
}
