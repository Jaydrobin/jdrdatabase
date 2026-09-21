// @ts-check
/**
 * 테이블·열 CRUD(Step 3). 각 함수는 현재 메타를 읽어 D-08 커맨드를 만들고 `applyCommand`로 즉시 적용한 뒤
 * `{ cmd, ... }`를 돌려준다. 메인은 그 커맨드를 히스토리·저널에 넣는다. RPC op `schema.*`와 1:1이다.
 *
 * 이 모듈은 `Engine` 인터페이스만 호출하고, 식별자는 `quoteIdent()`, 값은 파라미터 바인딩으로만 넣는다.
 */
import { AppError } from '../util/errors.js';
import { newColumnId, newTableId } from '../util/ids.js';
import { applyCommand } from './command.js';
import {
  DEFAULT_COLUMN_WIDTH,
  ftsTableFor,
  ftsTriggersFor,
  isSystemColumn,
  MAX_COLUMNS,
  nowIso,
  physicalType,
  quoteIdent,
  SYSTEM_COLUMNS,
  userTableDdl,
} from './schema.js';
import { isLogicalType } from './values.js';

/** @typedef {import('./engine.js').Engine} Engine */
/** @typedef {import('./command.js').Command} Command */
/** @typedef {import('./command.js').Statement} Statement */
/** @typedef {import('./command.js').ApplyContext} ApplyContext */
/** @typedef {import('./command.js').ApplyResult} ApplyResult */
/** @typedef {import('./values.js').LogicalType} LogicalType */
/** @typedef {import('./values.js').ColumnOptions} ColumnOptions */
/** @typedef {import('./values.js').CoercePolicy} CoercePolicy */

/**
 * @typedef {object} ColumnInfo
 * @property {string} id 물리 열 이름
 * @property {string} name 표시 이름
 * @property {LogicalType} type
 * @property {number} position
 * @property {number} width
 * @property {ColumnOptions | null} options
 * @property {string | null} deletedAt 소프트 삭제 시각. 살아 있으면 null
 */

/**
 * @typedef {object} TableInfo
 * @property {string} id 물리 테이블 이름
 * @property {string} name 표시 이름
 * @property {number} position
 * @property {string} createdAt
 * @property {boolean} ftsEnabled
 * @property {boolean} strict false면 다른 도구가 만든 테이블(읽기 전용)
 * @property {ColumnInfo[]} columns 소프트 삭제된 열도 포함(`deletedAt`으로 구분)
 */

/** 표시 이름 길이 상한. */
export const MAX_NAME_LENGTH = 200;

/**
 * 표시 이름 규칙: 앞뒤 공백 제거 후 비어 있지 않고, 상한 이내, 같은 범위의 살아 있는 이름과 중복되지 않음.
 * @param {string} raw
 * @param {Iterable<string>} taken 이미 쓰는 이름
 * @returns {string} 정리된 이름
 */
export function normalizeName(raw, taken) {
  const name = typeof raw === 'string' ? raw.trim() : '';
  if (!name) throw new AppError('E_NAME_INVALID', 'name is empty', { detail: { reason: 'empty' } });
  if (name.length > MAX_NAME_LENGTH) {
    throw new AppError('E_NAME_INVALID', 'name is too long', {
      detail: { reason: 'too_long', limit: MAX_NAME_LENGTH },
    });
  }
  for (const existing of taken) {
    if (existing === name) {
      throw new AppError('E_NAME_INVALID', 'name is already in use', {
        detail: { reason: 'duplicate', name },
      });
    }
  }
  return name;
}

/**
 * @param {unknown} options
 * @param {LogicalType} type
 * @returns {ColumnOptions | null}
 */
function normalizeOptions(options, type) {
  /** @type {ColumnOptions} */
  const out = {};
  if (typeof options === 'object' && options !== null) {
    const o = /** @type {Record<string, unknown>} */ (options);
    if (Array.isArray(o.choices)) {
      const choices = [...new Set(o.choices.map((c) => String(c).trim()).filter((c) => c))];
      if (choices.length > 0) out.choices = choices;
    }
    if (typeof o.decimals === 'number' && Number.isInteger(o.decimals) && o.decimals >= 0) {
      out.decimals = Math.min(o.decimals, 20);
    }
  }
  if (type === 'select' && !out.choices) {
    throw new AppError('E_VALUE_INVALID', 'select column needs at least one choice', {
      detail: { reason: 'no_choices' },
    });
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * @param {unknown} raw `_jdr_columns.options`
 * @returns {ColumnOptions | null}
 */
function parseOptions(raw) {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    // 손상된 옵션은 옵션 없음으로 본다. 열 자체는 계속 보인다.
    return null;
  }
}

/**
 * @param {Engine} engine
 * @param {string} tableId
 * @returns {ColumnInfo[]}
 */
function listColumns(engine, tableId) {
  const r = engine.exec(
    engine.prepareCached(
      'SELECT id, name, type, position, width, options, deleted_at FROM _jdr_columns WHERE table_id = ? ORDER BY position, id LIMIT 2000',
    ),
    [tableId],
  );
  return r.rows.map((row) => ({
    id: String(row[0]),
    name: String(row[1]),
    type: /** @type {LogicalType} */ (isLogicalType(row[2]) ? row[2] : 'text'),
    position: Number(row[3]),
    width: Number(row[4]),
    options: parseOptions(row[5]),
    deletedAt: row[6] === null ? null : String(row[6]),
  }));
}

/**
 * 테이블 목록(열 포함).
 * @param {Engine} engine
 * @returns {TableInfo[]}
 */
export function list(engine) {
  const r = engine.exec(
    'SELECT id, name, position, created_at, fts_enabled, strict FROM _jdr_tables ORDER BY position, id LIMIT 10000',
  );
  return r.rows.map((row) => {
    const id = String(row[0]);
    return {
      id,
      name: String(row[1]),
      position: Number(row[2]),
      createdAt: String(row[3]),
      ftsEnabled: Number(row[4]) === 1,
      strict: Number(row[5]) === 1,
      columns: listColumns(engine, id),
    };
  });
}

/**
 * 테이블 하나(열 포함). 없으면 null. 창 질의처럼 자주 부르는 경로가 목록 전체를 읽지 않게 한다.
 * @param {Engine} engine
 * @param {string} tableId
 * @returns {TableInfo | null}
 */
export function get(engine, tableId) {
  const r = engine.exec(
    engine.prepareCached(
      'SELECT id, name, position, created_at, fts_enabled, strict FROM _jdr_tables WHERE id = ? LIMIT 1',
    ),
    [tableId],
  );
  const row = r.rows[0];
  if (!row) return null;
  const id = String(row[0]);
  return {
    id,
    name: String(row[1]),
    position: Number(row[2]),
    createdAt: String(row[3]),
    ftsEnabled: Number(row[4]) === 1,
    strict: Number(row[5]) === 1,
    columns: listColumns(engine, id),
  };
}

/**
 * @param {Engine} engine
 * @param {string} tableId
 * @returns {TableInfo}
 */
export function requireTable(engine, tableId) {
  const found = get(engine, tableId);
  if (!found) {
    throw new AppError('E_DB_QUERY', 'table not found', { detail: { tableId } });
  }
  return found;
}

/**
 * 스키마·데이터를 바꿀 수 있는 테이블인지. 외부 파일에서 등록한 비STRICT 테이블은 v1에서 읽기 전용이다(R7).
 * 가져오기(`import/pipeline.js`)도 대상 테이블에 같은 검사를 한다.
 * @param {TableInfo} table
 */
export function requireStrict(table) {
  if (!table.strict) {
    throw new AppError('E_DB_QUERY', 'external (non-STRICT) tables are read-only', {
      detail: { reason: 'external_table', tableId: table.id },
    });
  }
}

/**
 * @param {TableInfo} table
 * @param {string} columnId
 * @returns {ColumnInfo}
 */
function requireColumn(table, columnId) {
  if (isSystemColumn(columnId)) {
    throw new AppError('E_SYSTEM_COLUMN', `system column ${columnId} cannot be changed`, {
      detail: { columnId },
    });
  }
  const column = table.columns.find((c) => c.id === columnId);
  if (!column) {
    throw new AppError('E_DB_QUERY', 'column not found', {
      detail: { tableId: table.id, columnId },
    });
  }
  return column;
}

/**
 * @param {TableInfo} table
 * @returns {string[]} 살아 있는 열의 표시 이름
 */
function liveColumnNames(table) {
  return table.columns.filter((c) => c.deletedAt === null).map((c) => c.name);
}

/**
 * 검색 인덱스(D-07)를 지우는 문장. 원본 테이블을 지우면 트리거는 함께 사라지지만 FTS5 가상 테이블과
 * 그림자 테이블은 남는다. 메타 행이 사라진 뒤에는 UI가 손잡이를 잃어 영영 지울 수 없으므로 여기서 지운다.
 * 인덱스가 없는 테이블에서도 안전하도록 `IF EXISTS`를 쓴다(`search.js`의 삭제는 인덱스가 있음을 확인한 뒤다).
 * @param {string} tableId
 * @returns {Statement[]}
 */
function dropSearchIndexStatements(tableId) {
  const triggers = ftsTriggersFor(tableId);
  return [
    { sql: `DROP TRIGGER IF EXISTS ${quoteIdent(triggers.insert)}` },
    { sql: `DROP TRIGGER IF EXISTS ${quoteIdent(triggers.delete)}` },
    { sql: `DROP TRIGGER IF EXISTS ${quoteIdent(triggers.update)}` },
    { sql: `DROP TABLE IF EXISTS ${quoteIdent(ftsTableFor(tableId))}` },
  ];
}

/**
 * 테이블 삭제에 쓰는 메타 정리 문장.
 * @param {string} tableId
 * @returns {Statement[]}
 */
function deleteMetaStatements(tableId) {
  return [
    { sql: 'DELETE FROM _jdr_columns WHERE table_id = ?', params: [tableId] },
    { sql: 'DELETE FROM _jdr_views WHERE table_id = ?', params: [tableId] },
    { sql: 'DELETE FROM _jdr_tables WHERE id = ?', params: [tableId] },
  ];
}

/**
 * 테이블을 만든다.
 * @param {Engine} engine
 * @param {{ name: string, now?: string }} input
 * @returns {Promise<{ tableId: string, cmd: Command }>}
 */
export async function create(engine, input) {
  const tables = list(engine);
  const name = normalizeName(
    input.name,
    tables.map((t) => t.name),
  );
  const tableId = newTableId(tables.map((t) => t.id));
  const position = tables.reduce((max, t) => Math.max(max, t.position), -1) + 1;
  const now = input.now ?? nowIso();
  /** @type {Command} */
  const cmd = {
    type: 'table.create',
    tableId,
    do: [
      { sql: userTableDdl(tableId) },
      {
        sql: 'INSERT INTO _jdr_tables (id, name, position, created_at, fts_enabled, strict) VALUES (?, ?, ?, ?, 0, 1)',
        params: [tableId, name, position, now],
      },
    ],
    undo: [...deleteMetaStatements(tableId), { sql: `DROP TABLE ${quoteIdent(tableId)}` }],
    summary: `table.create ${name}`,
  };
  await applyCommand(engine, cmd);
  return { tableId, cmd };
}

/**
 * 테이블 표시 이름을 바꾼다(메타만).
 * @param {Engine} engine
 * @param {string} tableId
 * @param {{ name: string }} input
 * @returns {Promise<{ cmd: Command }>}
 */
export async function rename(engine, tableId, input) {
  const tables = list(engine);
  const table = tables.find((t) => t.id === tableId);
  if (!table) throw new AppError('E_DB_QUERY', 'table not found', { detail: { tableId } });
  const name = normalizeName(
    input.name,
    tables.filter((t) => t.id !== tableId).map((t) => t.name),
  );
  /** @type {Command} */
  const cmd = {
    type: 'table.rename',
    tableId,
    do: [{ sql: 'UPDATE _jdr_tables SET name = ? WHERE id = ?', params: [name, tableId] }],
    undo: [{ sql: 'UPDATE _jdr_tables SET name = ? WHERE id = ?', params: [table.name, tableId] }],
    summary: `table.rename ${table.name} → ${name}`,
  };
  await applyCommand(engine, cmd);
  return { cmd };
}

/**
 * 테이블을 물리 삭제한다. 되돌릴 수 없다(UI가 미리 확인받는다).
 * @param {Engine} engine
 * @param {string} tableId
 * @returns {Promise<{ cmd: Command }>}
 */
export async function drop(engine, tableId) {
  const table = requireTable(engine, tableId);
  // 되돌릴 수 없는 유일한 커맨드다. 읽기 전용으로 등록한 외부 파일의 테이블에는 쓰지 않는다.
  requireStrict(table);
  /** @type {Command} */
  const cmd = {
    type: 'table.drop',
    tableId,
    do: [
      ...dropSearchIndexStatements(tableId),
      ...deleteMetaStatements(tableId),
      { sql: `DROP TABLE ${quoteIdent(tableId)}` },
    ],
    undo: [],
    summary: `table.drop ${table.name}`,
    irreversible: true,
  };
  await applyCommand(engine, cmd);
  return { cmd };
}

/**
 * 열을 추가한다. 물리 열 수(시스템 열 + 소프트 삭제 포함)가 SQLite 상한에 이르면 거부한다.
 * @param {Engine} engine
 * @param {string} tableId
 * @param {{ name: string, type: LogicalType, options?: ColumnOptions | null }} input
 * @returns {Promise<{ columnId: string, columnCount: number, cmd: Command }>}
 */
export async function addColumn(engine, tableId, input) {
  const table = requireTable(engine, tableId);
  requireStrict(table);
  if (!isLogicalType(input.type)) {
    throw new AppError('E_VALUE_INVALID', `unknown column type ${String(input.type)}`, {
      detail: { type: input.type },
    });
  }
  const name = normalizeName(input.name, liveColumnNames(table));
  const options = normalizeOptions(input.options, input.type);
  const physicalCount = table.columns.length + SYSTEM_COLUMNS.length;
  if (physicalCount >= MAX_COLUMNS) {
    throw new AppError('E_DB_QUERY', `column limit ${MAX_COLUMNS} reached`, {
      detail: { reason: 'column_limit', limit: MAX_COLUMNS, count: physicalCount },
    });
  }
  const columnId = newColumnId(table.columns.map((c) => c.id));
  const position = table.columns.reduce((max, c) => Math.max(max, c.position), -1) + 1;
  /** @type {Command} */
  const cmd = {
    type: 'column.add',
    tableId,
    do: [
      {
        sql: `ALTER TABLE ${quoteIdent(tableId)} ADD COLUMN ${quoteIdent(columnId)} ${physicalType(input.type)}`,
      },
      {
        sql: 'INSERT INTO _jdr_columns (id, table_id, name, type, position, width, options) VALUES (?, ?, ?, ?, ?, ?, ?)',
        params: [
          columnId,
          tableId,
          name,
          input.type,
          position,
          DEFAULT_COLUMN_WIDTH,
          options ? JSON.stringify(options) : null,
        ],
      },
    ],
    undo: [
      {
        sql: 'DELETE FROM _jdr_columns WHERE table_id = ? AND id = ?',
        params: [tableId, columnId],
      },
      { sql: `ALTER TABLE ${quoteIdent(tableId)} DROP COLUMN ${quoteIdent(columnId)}` },
    ],
    summary: `column.add ${table.name}.${name}`,
  };
  await applyCommand(engine, cmd);
  return { columnId, columnCount: physicalCount + 1, cmd };
}

/**
 * 열 표시 이름을 바꾼다(메타만).
 * @param {Engine} engine
 * @param {string} tableId
 * @param {string} columnId
 * @param {{ name: string }} input
 * @returns {Promise<{ cmd: Command }>}
 */
export async function renameColumn(engine, tableId, columnId, input) {
  const table = requireTable(engine, tableId);
  requireStrict(table);
  const column = requireColumn(table, columnId);
  const name = normalizeName(
    input.name,
    liveColumnNames(table).filter((n) => n !== column.name),
  );
  /** @type {Command} */
  const cmd = {
    type: 'column.rename',
    tableId,
    do: [
      {
        sql: 'UPDATE _jdr_columns SET name = ? WHERE table_id = ? AND id = ?',
        params: [name, tableId, columnId],
      },
    ],
    undo: [
      {
        sql: 'UPDATE _jdr_columns SET name = ? WHERE table_id = ? AND id = ?',
        params: [column.name, tableId, columnId],
      },
    ],
    summary: `column.rename ${table.name}.${column.name} → ${name}`,
  };
  await applyCommand(engine, cmd);
  return { cmd };
}

/**
 * 살아 있는 열의 순서를 바꾼다. `orderedIds`는 살아 있는 열 id의 순열이어야 한다.
 * @param {Engine} engine
 * @param {string} tableId
 * @param {{ orderedIds: string[] }} input
 * @returns {Promise<{ cmd: Command }>}
 */
export async function reorderColumns(engine, tableId, input) {
  const table = requireTable(engine, tableId);
  requireStrict(table);
  const live = table.columns.filter((c) => c.deletedAt === null);
  const ids = Array.isArray(input.orderedIds) ? input.orderedIds : [];
  const sameSet =
    ids.length === live.length &&
    new Set(ids).size === ids.length &&
    ids.every((id) => live.some((c) => c.id === id));
  if (!sameSet) {
    throw new AppError('E_DB_QUERY', 'orderedIds must be a permutation of live column ids', {
      detail: { tableId, expected: live.length, received: ids.length },
    });
  }
  for (const id of ids) {
    if (isSystemColumn(id)) {
      throw new AppError('E_SYSTEM_COLUMN', 'system columns cannot be reordered', {
        detail: { columnId: id },
      });
    }
  }
  const sql = 'UPDATE _jdr_columns SET position = ? WHERE table_id = ? AND id = ?';
  /** @type {Command} */
  const cmd = {
    type: 'column.reorder',
    tableId,
    do: ids.map((id, index) => ({ sql, params: [index, tableId, id] })),
    undo: live.map((c) => ({ sql, params: [c.position, tableId, c.id] })),
    summary: `column.reorder ${table.name}`,
  };
  await applyCommand(engine, cmd);
  return { cmd };
}

/**
 * 열을 소프트 삭제한다(D-08). 물리 열은 남는다.
 * @param {Engine} engine
 * @param {string} tableId
 * @param {string} columnId
 * @param {{ now?: string }} [input]
 * @returns {Promise<{ cmd: Command }>}
 */
export async function softDeleteColumn(engine, tableId, columnId, input = {}) {
  const table = requireTable(engine, tableId);
  requireStrict(table);
  const column = requireColumn(table, columnId);
  if (column.deletedAt !== null) {
    throw new AppError('E_DB_QUERY', 'column is already deleted', { detail: { columnId } });
  }
  const now = input.now ?? nowIso();
  /** @type {Command} */
  const cmd = {
    type: 'column.softDelete',
    tableId,
    do: [
      {
        sql: 'UPDATE _jdr_columns SET deleted_at = ? WHERE table_id = ? AND id = ?',
        params: [now, tableId, columnId],
      },
    ],
    undo: [
      {
        sql: 'UPDATE _jdr_columns SET deleted_at = NULL WHERE table_id = ? AND id = ?',
        params: [tableId, columnId],
      },
    ],
    summary: `column.softDelete ${table.name}.${column.name}`,
  };
  await applyCommand(engine, cmd);
  return { cmd };
}

/**
 * 소프트 삭제된 열을 되살린다. 같은 이름의 살아 있는 열이 있으면 거부한다.
 * @param {Engine} engine
 * @param {string} tableId
 * @param {string} columnId
 * @returns {Promise<{ cmd: Command }>}
 */
export async function restoreColumn(engine, tableId, columnId) {
  const table = requireTable(engine, tableId);
  requireStrict(table);
  const column = requireColumn(table, columnId);
  if (column.deletedAt === null) {
    throw new AppError('E_DB_QUERY', 'column is not deleted', { detail: { columnId } });
  }
  normalizeName(column.name, liveColumnNames(table));
  /** @type {Command} */
  const cmd = {
    type: 'column.restore',
    tableId,
    do: [
      {
        sql: 'UPDATE _jdr_columns SET deleted_at = NULL WHERE table_id = ? AND id = ?',
        params: [tableId, columnId],
      },
    ],
    undo: [
      {
        sql: 'UPDATE _jdr_columns SET deleted_at = ? WHERE table_id = ? AND id = ?',
        params: [column.deletedAt, tableId, columnId],
      },
    ],
    summary: `column.restore ${table.name}.${column.name}`,
  };
  await applyCommand(engine, cmd);
  return { cmd };
}

/**
 * 열 타입을 바꾼다: 새 물리 열 추가 → 변환 복사(청크·진행률·취소) → 옛 열 소프트 삭제(4.2).
 * 하나의 커맨드이므로 되돌리면 옛 열이 그대로 되살아나고 새 열은 지워진다.
 * @param {Engine} engine
 * @param {string} tableId
 * @param {string} columnId
 * @param {{ type: LogicalType, policy?: CoercePolicy, options?: ColumnOptions | null, now?: string }} input
 * @param {ApplyContext} [ctx]
 * @returns {Promise<{ columnId: string, cmd: Command, result: ApplyResult }>}
 */
export async function changeColumnType(engine, tableId, columnId, input, ctx = {}) {
  const table = requireTable(engine, tableId);
  requireStrict(table);
  const column = requireColumn(table, columnId);
  if (column.deletedAt !== null) {
    throw new AppError('E_DB_QUERY', 'column is deleted', { detail: { columnId } });
  }
  if (!isLogicalType(input.type)) {
    throw new AppError('E_VALUE_INVALID', `unknown column type ${String(input.type)}`, {
      detail: { type: input.type },
    });
  }
  const policy = input.policy === 'abort' ? 'abort' : 'null';
  const options = normalizeOptions(input.options ?? column.options, input.type);
  const physicalCount = table.columns.length + SYSTEM_COLUMNS.length;
  if (physicalCount >= MAX_COLUMNS) {
    throw new AppError('E_DB_QUERY', `column limit ${MAX_COLUMNS} reached`, {
      detail: { reason: 'column_limit', limit: MAX_COLUMNS, count: physicalCount },
    });
  }
  const newId = newColumnId(table.columns.map((c) => c.id));
  const now = input.now ?? nowIso();
  /** @type {Command} */
  const cmd = {
    type: 'column.changeType',
    tableId,
    do: [
      {
        sql: `ALTER TABLE ${quoteIdent(tableId)} ADD COLUMN ${quoteIdent(newId)} ${physicalType(input.type)}`,
      },
      {
        sql: 'UPDATE _jdr_columns SET deleted_at = ? WHERE table_id = ? AND id = ?',
        params: [now, tableId, columnId],
      },
      {
        sql: 'INSERT INTO _jdr_columns (id, table_id, name, type, position, width, options) VALUES (?, ?, ?, ?, ?, ?, ?)',
        params: [
          newId,
          tableId,
          column.name,
          input.type,
          column.position,
          column.width,
          options ? JSON.stringify(options) : null,
        ],
      },
      {
        convert: {
          table: tableId,
          from: columnId,
          to: newId,
          type: input.type,
          policy,
          ...(options ? { options } : {}),
        },
      },
    ],
    undo: [
      { sql: 'DELETE FROM _jdr_columns WHERE table_id = ? AND id = ?', params: [tableId, newId] },
      {
        sql: 'UPDATE _jdr_columns SET deleted_at = NULL WHERE table_id = ? AND id = ?',
        params: [tableId, columnId],
      },
      { sql: `ALTER TABLE ${quoteIdent(tableId)} DROP COLUMN ${quoteIdent(newId)}` },
    ],
    summary: `column.changeType ${table.name}.${column.name} ${column.type} → ${input.type}`,
  };
  const result = await applyCommand(engine, cmd, 'do', ctx);
  return { columnId: newId, cmd, result };
}
