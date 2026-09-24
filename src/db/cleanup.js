// @ts-check
/**
 * 데이터베이스 정리(D-17, Step 13): 소프트 삭제된 열을 물리적으로 없애고, 저장이 빈 페이지를 없애지 않는 엔진에서는
 * `VACUUM`으로 빈 공간을 줄인다.
 *
 * - 테이블마다 되돌릴 수 없는 `column.purge` 커맨드 하나로 다시 쓴다(임시 테이블 생성 → 복사 → 원래 테이블 삭제 →
 *   이름 바꾸기). `ALTER TABLE … DROP COLUMN`을 쓰지 않는 이유는 D-17: 열마다 테이블 전체를 다시 쓰고, 검색 인덱스의
 *   갱신 트리거가 참조하는 열은 지울 수 없다.
 * - 모든 테이블의 커맨드는 바깥 트랜잭션 하나 안에서 적용한다(커맨드마다 중첩 SAVEPOINT). 하나라도 실패하거나
 *   취소되면 전부 롤백되어 정리 전 상태 그대로다.
 * - `VACUUM`은 트랜잭션 밖에서만 돌므로 커맨드에 넣지 않고 저널에도 남기지 않는다(논리 상태를 바꾸지 않는다).
 * - 이 모듈은 `Engine` 인터페이스만 호출하고, 식별자는 `quoteIdent()`, 값은 파라미터 바인딩으로만 넣는다.
 */
import { AppError, serializeError } from '../util/errors.js';
import { applyCommand } from './command.js';
import { ftsTriggersFor, quoteIdent, SYSTEM_COLUMNS, tmpTableFor } from './schema.js';
import { indexStatements, searchableColumns } from './search.js';
import { dropSearchIndexStatements, list, requireStrict, requireTable } from './tables.js';

/** @typedef {import('./engine.js').Engine} Engine */
/** @typedef {import('./engine.js').SqlParams} SqlParams */
/** @typedef {import('./command.js').Command} Command */
/** @typedef {import('./command.js').Statement} Statement */
/** @typedef {import('./command.js').ApplyContext} ApplyContext */
/** @typedef {import('./tables.js').TableInfo} TableInfo */
/** @typedef {import('./values.js').LogicalType} LogicalType */
/** @typedef {import('../util/errors.js').SerializedError} SerializedError */

/**
 * 정리 계획의 테이블 하나: 소프트 삭제된 열이 있는 STRICT 테이블.
 * @typedef {object} CleanupTable
 * @property {string} tableId
 * @property {string} name
 * @property {Array<{ id: string, name: string, type: LogicalType, deletedAt: string }>} columns 소프트 삭제된 열
 * @property {boolean} ftsEnabled 정리하면 검색 인덱스를 다시 만든다
 * @property {SchemaBlocker | null} blocked 재작성이 스키마를 그대로 옮길 수 없어 정리할 수 없는 테이블이면 그 이유
 */

/**
 * 정리할 수 없는 이유(`schemaBlocker`). 이 앱이 만든 테이블에는 검색 인덱스 말고 다른 스키마 객체가 없으므로
 * 다른 도구가 더한 것이다.
 * @typedef {object} SchemaBlocker
 * @property {'foreign_key' | 'index' | 'trigger' | 'view' | 'columns'} reason
 * @property {string} object 그 객체의 이름(표시용, 80자까지). 열 제약이면 빈 문자열일 수 있다
 */

/**
 * @typedef {object} CleanupPlan
 * @property {CleanupTable[]} tables
 * @property {number} dbBytes 지금 DB 크기(`page_count × page_size`)
 * @property {number} freeBytes 빈 페이지가 차지하는 크기(`freelist_count × page_size`)
 * @property {boolean} compactsOnSave 저장이 빈 페이지를 없애는 엔진인가(그러면 `VACUUM`을 부르지 않는다)
 */

/**
 * @typedef {object} CleanupResult
 * @property {Command[]} cmds 적용한 `column.purge` 커맨드(테이블 순서). 메인이 저널에 기록한다
 * @property {number} removedColumns 물리적으로 지운 열 수
 * @property {number} rebuiltIndexes 다시 만든 검색 인덱스 수
 * @property {boolean} vacuumed `VACUUM`이 성공했는가
 * @property {SerializedError | null} vacuumError `VACUUM`이 실패한 원인. 재작성은 이미 커밋된 상태다
 * @property {number} bytesBefore
 * @property {number} bytesAfter
 */

/**
 * `pragma_table_info`의 열 하나(물리 순서).
 * @typedef {object} PhysicalColumn
 * @property {string} name
 * @property {string} type 선언된 물리 타입(대문자)
 * @property {boolean} pk
 * @property {boolean} notnull
 */

/** @typedef {TableInfo & { physical: PhysicalColumn[] }} PurgeTarget */

/** STRICT 테이블이 허용하는 열 타입 이름. 재작성 DDL에 그대로 들어가므로 이 목록 밖은 거부한다. */
const STRICT_TYPES = new Set(['INT', 'INTEGER', 'REAL', 'TEXT', 'BLOB', 'ANY']);

/**
 * @param {Engine} engine
 * @param {'PRAGMA page_count' | 'PRAGMA page_size' | 'PRAGMA freelist_count'} sql
 * @returns {number}
 */
function pragmaNumber(engine, sql) {
  return Number(engine.exec(sql).rows[0]?.[0] ?? 0);
}

/**
 * 지금 DB 크기. 직렬화하면 나올 바이트 수와 같다(`db.size`).
 * @param {Engine} engine
 * @returns {number}
 */
function dbBytes(engine) {
  return pragmaNumber(engine, 'PRAGMA page_count') * pragmaNumber(engine, 'PRAGMA page_size');
}

/**
 * `CREATE TABLE` 문에 이 앱이 쓰지 않는 열 제약이 있는가. 앱의 DDL은 따옴표 친 식별자, 타입, `PRIMARY KEY`,
 * `NOT NULL`, `STRICT`뿐이다(D-03, `purgeCommand`). 식별자와 문자열을 지운 뒤 남은 단어로 판정한다.
 */
const CONSTRAINT_WORDS =
  /\b(CHECK|COLLATE|DEFAULT|UNIQUE|REFERENCES|CONSTRAINT|AUTOINCREMENT|ASC|DESC|CONFLICT|AS|WITHOUT|GENERATED|FOREIGN)\b/i;

/**
 * @param {string} sql
 * @returns {boolean}
 */
function hasColumnConstraints(sql) {
  const stripped = sql.replace(/"(?:[^"]|"")*"|'(?:[^']|'')*'|`(?:[^`]|``)*`|\[[^\]]*\]/g, ' ');
  return CONSTRAINT_WORDS.test(stripped);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function objectName(value) {
  return String(value ?? '').slice(0, 80);
}

/**
 * 재작성(`CREATE` → `INSERT … SELECT` → `DROP` → `RENAME`)이 이 테이블의 스키마를 그대로 옮길 수 없는가(Step 13 예외 처리).
 * 다른 테이블의 외래 키가 이 테이블을 가리키면 `DROP TABLE`이 `ON DELETE CASCADE`·`SET NULL`을 실행해 그 테이블의
 * 행을 지우거나 바꾸고, 사용자 인덱스·트리거는 `DROP`과 함께 사라지며, 뷰는 `RENAME`을 실패시킨다. 읽기만 한다.
 * @param {Engine} engine
 * @param {string} tableId
 * @returns {SchemaBlocker | null}
 */
export function schemaBlocker(engine, tableId) {
  const outgoing = engine.exec('SELECT "table" FROM pragma_foreign_key_list(?) LIMIT 1', [tableId]);
  if (outgoing.rows.length > 0) {
    return { reason: 'foreign_key', object: objectName(outgoing.rows[0]?.[0]) };
  }
  const incoming = engine.exec(
    `SELECT m.name FROM sqlite_master AS m, pragma_foreign_key_list(m.name) AS f
      WHERE m.type = 'table' AND m.name <> ? AND f."table" = ? COLLATE NOCASE LIMIT 1`,
    [tableId, tableId],
  );
  if (incoming.rows.length > 0) {
    return { reason: 'foreign_key', object: objectName(incoming.rows[0]?.[0]) };
  }
  const indexes = engine.exec('SELECT name FROM pragma_index_list(?) LIMIT 1', [tableId]);
  if (indexes.rows.length > 0) return { reason: 'index', object: objectName(indexes.rows[0]?.[0]) };
  const own = ftsTriggersFor(tableId);
  const triggers = engine.exec(
    `SELECT name FROM sqlite_master
      WHERE type = 'trigger' AND (tbl_name = ? COLLATE NOCASE OR instr(sql, ?) > 0)
        AND name NOT IN (?, ?, ?) LIMIT 1`,
    [tableId, tableId, own.insert, own.delete, own.update],
  );
  if (triggers.rows.length > 0) {
    return { reason: 'trigger', object: objectName(triggers.rows[0]?.[0]) };
  }
  const views = engine.exec(
    "SELECT name FROM sqlite_master WHERE type = 'view' AND instr(sql, ?) > 0 LIMIT 1",
    [tableId],
  );
  if (views.rows.length > 0) return { reason: 'view', object: objectName(views.rows[0]?.[0]) };
  const hidden = engine.exec('SELECT name FROM pragma_table_xinfo(?) WHERE hidden <> 0 LIMIT 1', [
    tableId,
  ]);
  if (hidden.rows.length > 0) return { reason: 'columns', object: objectName(hidden.rows[0]?.[0]) };
  const ddl = engine.exec(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ? LIMIT 1",
    [tableId],
  );
  if (hasColumnConstraints(String(ddl.rows[0]?.[0] ?? '')))
    return { reason: 'columns', object: '' };
  try {
    physicalColumns(engine, tableId);
  } catch (err) {
    if (err instanceof AppError && err.code === 'E_DB_QUERY') {
      const detail = /** @type {Record<string, unknown>} */ (
        typeof err.detail === 'object' && err.detail !== null ? err.detail : {}
      );
      return { reason: 'columns', object: objectName(detail.column) };
    }
    throw err;
  }
  return null;
}

/**
 * 정리 계획. 소프트 삭제된 열이 있는 STRICT 테이블과 DB 크기·빈 공간을 돌려준다. 읽기만 한다.
 * @param {Engine} engine
 * @returns {CleanupPlan}
 */
export function plan(engine) {
  /** @type {CleanupTable[]} */
  const tables = [];
  for (const table of list(engine)) {
    // 외부(비STRICT) 테이블은 읽기 전용이다(R7). 소프트 삭제된 열이 있을 수 없지만 계획에서도 뺀다.
    if (!table.strict) continue;
    const deleted = table.columns.filter((c) => c.deletedAt !== null);
    if (deleted.length === 0) continue;
    tables.push({
      tableId: table.id,
      name: table.name,
      columns: deleted.map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        deletedAt: /** @type {string} */ (c.deletedAt),
      })),
      ftsEnabled: table.ftsEnabled,
      blocked: schemaBlocker(engine, table.id),
    });
  }
  const pageSize = pragmaNumber(engine, 'PRAGMA page_size');
  return {
    tables,
    dbBytes: pragmaNumber(engine, 'PRAGMA page_count') * pageSize,
    freeBytes: pragmaNumber(engine, 'PRAGMA freelist_count') * pageSize,
    compactsOnSave: engine.capabilities().compactsOnSave,
  };
}

/**
 * 테이블의 물리 열(cid 순서). 재작성은 이 순서를 지킨다. `_jdr_columns.position`은 표시 순서라 타입 변경이나
 * 순서 바꾸기 뒤에는 물리 순서와 다르다.
 * @param {Engine} engine
 * @param {string} tableId
 * @returns {PhysicalColumn[]}
 */
export function physicalColumns(engine, tableId) {
  const r = engine.exec(
    'SELECT name, type, pk, "notnull", dflt_value FROM pragma_table_info(?) ORDER BY cid LIMIT 2001',
    [tableId],
  );
  /** @type {PhysicalColumn[]} */
  const columns = [];
  for (const row of r.rows) {
    const name = String(row[0]);
    const type = String(row[1]).toUpperCase();
    // 이 앱이 만든 STRICT 테이블(D-03)에는 기본값이 없고 기본 키는 `id` 하나다. 그 밖의 형태는 재작성 DDL로
    // 옮길 수 없으므로(기본값은 SQL 조각이다) 손대지 않고 거부한다.
    if (!STRICT_TYPES.has(type) || row[4] !== null) {
      throw new AppError('E_DB_QUERY', 'table has a column this app did not create', {
        detail: { reason: 'unexpected_schema', tableId, column: name.slice(0, 80) },
      });
    }
    columns.push({ name, type, pk: Number(row[2]) > 0, notnull: Number(row[3]) === 1 });
  }
  if (columns.filter((c) => c.pk).length > 1) {
    throw new AppError('E_DB_QUERY', 'table has a composite primary key', {
      detail: { reason: 'unexpected_schema', tableId },
    });
  }
  return columns;
}

/**
 * 한 테이블의 재작성 커맨드. 되돌릴 수 없다(`undo`가 비고 `irreversible`). 저널 재생은 `do` 방향이라 같은 재작성이
 * 다시 일어난다. 순수 함수이며 `target.physical`은 `physicalColumns`로 읽어 둔다.
 * @param {PurgeTarget} target
 * @param {string[]} columnIds 지울 물리 열(모두 소프트 삭제된 열)
 * @returns {Command}
 */
export function purgeCommand(target, columnIds) {
  const remove = new Set(columnIds);
  for (const id of remove) {
    if (SYSTEM_COLUMNS.includes(id)) {
      throw new AppError('E_SYSTEM_COLUMN', `system column ${id} cannot be removed`, {
        detail: { columnId: id },
      });
    }
  }
  const keep = target.physical.filter((c) => !remove.has(c.name));
  const tmp = quoteIdent(tmpTableFor(target.id));
  const table = quoteIdent(target.id);
  const defs = keep
    .map(
      (c) =>
        `${quoteIdent(c.name)} ${c.type}${c.pk ? ' PRIMARY KEY' : ''}${c.notnull ? ' NOT NULL' : ''}`,
    )
    .join(', ');
  const cols = keep.map((c) => quoteIdent(c.name)).join(', ');
  /** @type {Statement[]} */
  const doList = [];
  if (target.ftsEnabled) doList.push(...dropSearchIndexStatements(target.id));
  doList.push(
    { sql: `CREATE TABLE ${tmp} (${defs}) STRICT` },
    { sql: `INSERT INTO ${tmp} (${cols}) SELECT ${cols} FROM ${table}` },
    { sql: `DROP TABLE ${table}` },
    { sql: `ALTER TABLE ${tmp} RENAME TO ${table}` },
    {
      batch: {
        sql: 'DELETE FROM _jdr_columns WHERE table_id = ? AND id = ?',
        paramsList: [...remove].map((id) => /** @type {SqlParams} */ ([target.id, id])),
      },
    },
  );
  if (target.ftsEnabled) {
    // 지금의 검색 대상 열로 다시 만든다. 만든 뒤 열 구성이 바뀌어 낡았던 인덱스(D-07의 `ftsStale`)도 이때 맞춰진다.
    // 검색 대상 열이 없으면 FTS5 테이블을 만들 수 없다(열이 하나 이상이어야 한다). 인덱스 없음으로 둔다.
    const searchable = searchableColumns(target)
      .map((c) => c.id)
      .filter((id) => !remove.has(id));
    if (searchable.length > 0) {
      doList.push(...indexStatements(target.id, searchable).create);
    } else {
      doList.push({
        sql: 'UPDATE _jdr_tables SET fts_enabled = 0 WHERE id = ?',
        params: [target.id],
      });
    }
  }
  const names = target.columns.filter((c) => remove.has(c.id)).map((c) => c.name);
  return {
    type: 'column.purge',
    tableId: target.id,
    do: doList,
    undo: [],
    summary: `column.purge ${target.name}: ${names.join(', ')}`,
    irreversible: true,
  };
}

/**
 * 요청을 테이블별로 묶고 검사한다. 요청한 열이 모두 지금 소프트 삭제 상태여야 한다(이미 복원되었거나 없으면 거부).
 * @param {Engine} engine
 * @param {Array<{ tableId: string, columnId: string }>} columns
 * @returns {Array<{ target: PurgeTarget, columnIds: string[] }>}
 */
function resolveRequest(engine, columns) {
  if (!Array.isArray(columns)) {
    throw new AppError('E_DB_QUERY', 'cleanup.run requires columns', {
      detail: { reason: 'bad_request' },
    });
  }
  /** @type {Map<string, Set<string>>} */
  const byTable = new Map();
  for (const item of columns) {
    if (typeof item?.tableId !== 'string' || typeof item?.columnId !== 'string') {
      throw new AppError('E_DB_QUERY', 'cleanup column must be { tableId, columnId }', {
        detail: { reason: 'bad_request' },
      });
    }
    let set = byTable.get(item.tableId);
    if (!set) {
      set = new Set();
      byTable.set(item.tableId, set);
    }
    set.add(item.columnId);
  }
  /** @type {Array<{ target: PurgeTarget, columnIds: string[] }>} */
  const out = [];
  for (const [tableId, ids] of byTable) {
    const table = requireTable(engine, tableId);
    requireStrict(table);
    // 계획 뒤에 다른 도구가 스키마를 더했을 수 있다. 쓰기 전에(바깥 트랜잭션 안에서) 다시 본다.
    const blocked = schemaBlocker(engine, tableId);
    if (blocked) {
      throw new AppError('E_DB_QUERY', `table schema cannot be rewritten (${blocked.reason})`, {
        detail: { reason: 'unexpected_schema', tableId, blocked },
      });
    }
    const physical = physicalColumns(engine, tableId);
    for (const id of ids) {
      const column = table.columns.find((c) => c.id === id);
      if (!column || column.deletedAt === null || !physical.some((c) => c.name === id)) {
        throw new AppError('E_DB_QUERY', 'column is not a soft-deleted column', {
          detail: {
            reason: column ? 'not_deleted' : 'column_not_found',
            tableId,
            columnId: id,
          },
        });
      }
    }
    out.push({ target: { ...table, physical }, columnIds: [...ids] });
  }
  // 테이블 순서(사이드바 순서)로 다시 쓴다. 저널에 남는 순서가 요청 순서에 흔들리지 않게 한다.
  out.sort((a, b) => a.target.position - b.target.position || (a.target.id < b.target.id ? -1 : 1));
  return out;
}

/**
 * 정리를 실행한다. 요청 검사(소프트 삭제 상태, `schemaBlocker`)와 재작성은 트랜잭션 하나이고, 그 뒤
 * `compactsOnSave`가 거짓이면 `VACUUM`을 부른다.
 * 취소는 테이블 사이와(커맨드 안의 문장 사이) 인덱싱 청크 사이에서 받으며 전체를 롤백한다. `VACUUM`은 취소할 수 없다.
 * @param {Engine} engine
 * @param {{ columns: Array<{ tableId: string, columnId: string }> }} input
 * @param {ApplyContext} [ctx]
 * @returns {Promise<CleanupResult>}
 */
export async function run(engine, input, ctx = {}) {
  const bytesBefore = dbBytes(engine);
  /** @type {Command[]} */
  const cmds = [];
  let removedColumns = 0;
  let rebuiltIndexes = 0;
  await engine.transaction(async () => {
    // 검사도 트랜잭션 안에서 한다. 검사와 첫 쓰기 사이에 스키마가 바뀔 틈을 두지 않는다.
    const groups = resolveRequest(engine, input?.columns);
    if (groups.length === 0) return;
    for (let i = 0; i < groups.length; i += 1) {
      if (ctx.signal?.aborted) {
        throw new AppError('E_IMPORT_CANCELLED', 'cleanup cancelled', {
          detail: { done: i, total: groups.length },
        });
      }
      ctx.progress?.({ phase: 'purge', done: i, total: groups.length });
      const group = /** @type {{ target: PurgeTarget, columnIds: string[] }} */ (groups[i]);
      const cmd = purgeCommand(group.target, group.columnIds);
      await applyCommand(engine, cmd, 'do', ctx);
      cmds.push(cmd);
      removedColumns += group.columnIds.length;
      if (cmd.do.some((s) => 'index' in s)) rebuiltIndexes += 1;
    }
    ctx.progress?.({ phase: 'purge', done: groups.length, total: groups.length });
  });
  let vacuumed = false;
  /** @type {SerializedError | null} */
  let vacuumError = null;
  if (!engine.capabilities().compactsOnSave) {
    ctx.progress?.({ phase: 'vacuum', done: 0, total: 0 });
    try {
      engine.vacuum();
      vacuumed = true;
    } catch (err) {
      // 재작성은 이미 커밋되었고 DB는 그대로 쓰고 저장할 수 있다. 던지면 메인이 커맨드를 저널에 넣지 못하므로
      // 결과에 실어 알린다(D-17).
      vacuumError = serializeError(err);
    }
  }
  return {
    cmds,
    removedColumns,
    rebuiltIndexes,
    vacuumed,
    vacuumError,
    bytesBefore,
    bytesAfter: dbBytes(engine),
  };
}
