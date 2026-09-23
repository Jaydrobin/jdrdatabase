// @ts-check
/**
 * 커맨드 생성 함수(D-08).
 *
 * - 스키마 커맨드(Step 3)는 Worker(`db/tables.js`)가 만들어 적용하므로 `schema.*` op를 부르고 그 결과의
 *   커맨드를 스토어(저널·dirty·히스토리)에 반영하는 얇은 래퍼만 둔다(`createSchemaCommands`).
 * - 데이터 커맨드(Step 5: 셀 편집, 행 추가·삭제, 다중 편집·붙여넣기)는 이 파일의 순수 함수가 만든다.
 *   물리 이름(테이블 `id`, 열 `id`)으로 SQL을 만들고 값은 모두 바인딩한다. 되돌리기에 필요한 옛 값은
 *   호출자가 `query.rows`·`query.row`로 읽어 넘기며, 커맨드는 DB를 다시 읽지 않고도 되돌릴 수 있다.
 * - 배치 문장의 목록은 `runBatch` 상한(1만 건·64 MB) 안이어야 하므로 여기서 나눈다.
 */
import { MAX_BATCH_BYTES, MAX_BATCH_PARAMS } from '../db/engine.js';
import { quoteIdent } from '../db/schema.js';
import { estimateCloneBytes } from '../util/bytes.js';
import { AppError } from '../util/errors.js';

/** @typedef {import('./store.js').Store} Store */
/** @typedef {import('../db/values.js').LogicalType} LogicalType */
/** @typedef {import('../db/tables.js').NewColumn} NewColumn */
/** @typedef {import('../db/values.js').ColumnOptions} ColumnOptions */
/** @typedef {import('../db/values.js').CoercePolicy} CoercePolicy */
/** @typedef {import('../db/client.js').CallOptions} CallOptions */
/** @typedef {import('../db/command.js').Command} Command */
/** @typedef {import('../db/command.js').Statement} Statement */
/** @typedef {import('../db/engine.js').SqlValue} SqlValue */
/** @typedef {import('../db/engine.js').SqlParams} SqlParams */
/** @typedef {import('../db/query.js').FullRow} FullRow */
/** @typedef {import('../db/query.js').ViewClauses} ViewClauses */

/** 되돌리기 스냅샷 상한(행, D-08). 넘는 삭제·붙여넣기는 확인 뒤 되돌릴 수 없는 커맨드로 적용한다. */
export const UNDO_SNAPSHOT_MAX_ROWS = 10_000;
/** 붙여넣기 셀 수 상한(Step 5 예외 처리). 넘으면 `E_PASTE_TOO_LARGE`. */
export const PASTE_MAX_CELLS = 1_000_000;
/** 배치 하나의 직렬화 예산. `runBatch` 상한의 절반에서 나눠 추정 오차를 흡수한다. */
const BATCH_BYTES_BUDGET = MAX_BATCH_BYTES / 2;

/**
 * @typedef {object} SchemaCommands
 * @property {(input: { name: string, columns?: NewColumn[] }) => Promise<string | null>} createTable 만든 테이블 id. `columns`는 함께 만들 열(D-16)
 * @property {(tableId: string, name: string) => Promise<boolean>} renameTable
 * @property {(tableId: string) => Promise<boolean>} dropTable 되돌릴 수 없음. 확인은 UI가 먼저 받는다
 * @property {(tableId: string, input: { name: string, type: LogicalType, options?: ColumnOptions | null }) => Promise<{ columnId: string, columnCount: number } | null>} addColumn
 * @property {(tableId: string, columnId: string, name: string) => Promise<boolean>} renameColumn
 * @property {(tableId: string, orderedIds: string[]) => Promise<boolean>} reorderColumns
 * @property {(tableId: string, columnId: string) => Promise<boolean>} softDeleteColumn
 * @property {(tableId: string, columnId: string) => Promise<boolean>} restoreColumn
 * @property {(tableId: string, columnId: string, input: { type: LogicalType, policy: CoercePolicy, options?: ColumnOptions | null }, options?: CallOptions) => Promise<{ columnId: string, nulled: number } | null>} changeColumnType
 */

/**
 * @param {Store} store
 * @returns {SchemaCommands}
 */
export function createSchemaCommands(store) {
  return {
    async createTable(input) {
      return store.createTable(input.name, input.columns ? { columns: input.columns } : {});
    },
    async renameTable(tableId, name) {
      return (await store.runSchemaOp('schema.rename', { tableId, name })) !== null;
    },
    async dropTable(tableId) {
      return (await store.runSchemaOp('schema.drop', { tableId })) !== null;
    },
    async addColumn(tableId, input) {
      const result = await store.runSchemaOp('schema.addColumn', {
        tableId,
        name: input.name,
        type: input.type,
        options: input.options ?? null,
      });
      return result ? { columnId: result.columnId, columnCount: result.columnCount } : null;
    },
    async renameColumn(tableId, columnId, name) {
      return (await store.runSchemaOp('schema.renameColumn', { tableId, columnId, name })) !== null;
    },
    async reorderColumns(tableId, orderedIds) {
      return (await store.runSchemaOp('schema.reorderColumns', { tableId, orderedIds })) !== null;
    },
    async softDeleteColumn(tableId, columnId) {
      return (await store.runSchemaOp('schema.softDeleteColumn', { tableId, columnId })) !== null;
    },
    async restoreColumn(tableId, columnId) {
      return (await store.runSchemaOp('schema.restoreColumn', { tableId, columnId })) !== null;
    },
    async changeColumnType(tableId, columnId, input, options) {
      const result = await store.runSchemaOp(
        'schema.changeColumnType',
        {
          tableId,
          columnId,
          type: input.type,
          policy: input.policy,
          options: input.options ?? null,
        },
        options,
      );
      return result ? { columnId: result.columnId, nulled: result.result.nulled ?? 0 } : null;
    },
  };
}

// ---- 데이터 커맨드 (Step 5) ----

/**
 * 파라미터 목록을 `runBatch` 상한 안의 조각으로 나눈다. 건수와 직렬화 크기를 함께 본다.
 * @param {SqlParams[]} paramsList
 * @returns {SqlParams[][]}
 */
export function chunkParams(paramsList) {
  /** @type {SqlParams[][]} */
  const chunks = [];
  /** @type {SqlParams[]} */
  let current = [];
  let bytes = 0;
  for (const params of paramsList) {
    const size = estimateCloneBytes(params);
    if (
      current.length > 0 &&
      (current.length >= MAX_BATCH_PARAMS || bytes + size > BATCH_BYTES_BUDGET)
    ) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(params);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

/**
 * 같은 문장을 조각마다 하나의 배치 문장으로 만든다. 목록이 비면 문장을 만들지 않는다.
 * @param {string} sql
 * @param {SqlParams[]} paramsList
 * @returns {Statement[]}
 */
function batchStatements(sql, paramsList) {
  return chunkParams(paramsList).map((chunk) => ({ batch: { sql, paramsList: chunk } }));
}

/**
 * `do`와 `undo`를 맞바꾼 역커맨드. 되돌리기를 저널에 기록할 때 쓴다(D-08).
 * @param {Command} cmd
 * @returns {Command}
 */
export function invert(cmd) {
  if (cmd.irreversible || cmd.undo.length === 0) {
    throw new AppError('E_UNDO_LIMIT', `command ${cmd.type} cannot be inverted`, {
      detail: { type: cmd.type },
    });
  }
  const { irreversible, ...rest } = cmd;
  void irreversible;
  return { ...rest, do: cmd.undo, undo: cmd.do, summary: `undo ${cmd.summary}` };
}

/**
 * 셀 하나를 바꾼다. `_updated_at`은 커맨드가 명시적으로 갱신하고 되돌리기가 원래 값으로 되돌린다.
 * @param {{ tableId: string, rowId: number, colId: string, oldValue: SqlValue, newValue: SqlValue, oldUpdatedAt: string | null, now: string }} input
 * @returns {Command}
 */
export function editCell(input) {
  const sql = `UPDATE ${quoteIdent(input.tableId)} SET ${quoteIdent(input.colId)} = ?, "_updated_at" = ? WHERE "id" = ?`;
  return {
    type: 'cell.edit',
    tableId: input.tableId,
    do: [{ sql, params: [input.newValue, input.now, input.rowId] }],
    undo: [{ sql, params: [input.oldValue, input.oldUpdatedAt, input.rowId] }],
    summary: `cell.edit ${input.tableId}.${input.colId}#${input.rowId}`,
  };
}

/**
 * 빈 행을 `count`개 붙인다. id는 `firstId`부터 연속이며(`query.stats`의 `maxId + 1`), 되돌리기는 그 id를 지운다.
 * @param {{ tableId: string, count: number, firstId: number, now: string }} input
 * @returns {Command}
 */
export function insertRows(input) {
  if (!Number.isInteger(input.count) || input.count <= 0 || !Number.isSafeInteger(input.firstId)) {
    throw new AppError('E_DB_QUERY', 'insertRows needs a positive count and a safe firstId', {
      detail: { count: input.count, firstId: input.firstId },
    });
  }
  const table = quoteIdent(input.tableId);
  /** @type {SqlParams[]} */
  const inserts = [];
  /** @type {SqlParams[]} */
  const deletes = [];
  for (let i = 0; i < input.count; i += 1) {
    inserts.push([input.firstId + i, input.now, input.now]);
    deletes.push([input.firstId + i]);
  }
  return {
    type: 'row.insert',
    tableId: input.tableId,
    do: batchStatements(
      `INSERT INTO ${table} ("id", "_created_at", "_updated_at") VALUES (?, ?, ?)`,
      inserts,
    ),
    undo: batchStatements(`DELETE FROM ${table} WHERE "id" = ?`, deletes),
    summary: `row.insert ${input.tableId} ×${input.count}`,
  };
}

/**
 * 스냅샷 행들을 다시 넣는 INSERT 문장. 열 목록은 첫 행의 키(모든 행이 같은 열 집합으로 읽혔다)다.
 * @param {string} tableId
 * @param {FullRow[]} rows
 * @returns {Statement[]}
 */
function reinsertStatements(tableId, rows) {
  const first = rows[0];
  if (!first) return [];
  const colIds = Object.keys(first.cells).sort();
  const columns = ['"id"', '"_created_at"', '"_updated_at"', ...colIds.map(quoteIdent)];
  const marks = columns.map(() => '?').join(', ');
  const sql = `INSERT INTO ${quoteIdent(tableId)} (${columns.join(', ')}) VALUES (${marks})`;
  const paramsList = rows.map((row) => [
    row.id,
    row.createdAt,
    row.updatedAt,
    ...colIds.map((colId) => row.cells[colId] ?? null),
  ]);
  return batchStatements(sql, paramsList);
}

/**
 * 행을 지운다. `rows`는 `query.rows`가 열 목록 없이(소프트 삭제된 열까지) 읽은 스냅샷이며 되돌리기가 그대로 되살린다.
 * @param {{ tableId: string, rows: FullRow[] }} input
 * @returns {Command}
 */
export function deleteRows(input) {
  if (input.rows.length > UNDO_SNAPSHOT_MAX_ROWS) {
    throw new AppError(
      'E_UNDO_LIMIT',
      `snapshot of ${input.rows.length} rows exceeds the undo limit`,
      {
        detail: { rows: input.rows.length, limit: UNDO_SNAPSHOT_MAX_ROWS },
      },
    );
  }
  const table = quoteIdent(input.tableId);
  return {
    type: 'row.delete',
    tableId: input.tableId,
    do: batchStatements(
      `DELETE FROM ${table} WHERE "id" = ?`,
      input.rows.map((row) => [row.id]),
    ),
    undo: reinsertStatements(input.tableId, input.rows),
    summary: `row.delete ${input.tableId} ×${input.rows.length}`,
  };
}

/**
 * 뷰 순서로 `offset`부터 `count`개 행의 id를 고르는 부분 질의. `clauses`(`query.buildViewClauses`)가 있으면
 * 뷰의 필터·검색·정렬을 그대로 붙여 그리드의 행 순번과 같은 행을 가리킨다(Step 6). 없으면 `id` 순서다.
 * @param {string} table 인용된 테이블 식별자
 * @param {ViewClauses | undefined} clauses
 * @returns {{ sql: string, params: SqlValue[] }}
 */
function rangeSubquery(table, clauses) {
  return {
    sql: `SELECT "id" FROM ${table}${clauses?.where ?? ''} ORDER BY ${clauses?.orderBy ?? '"id"'} LIMIT ? OFFSET ?`,
    params: clauses ? [...clauses.params] : [],
  };
}

/**
 * 스냅샷 상한을 넘는 행 범위를 되돌릴 수 없이 지운다(D-08). 뷰 순서로 `offset`부터 `count`개.
 * UI가 "되돌릴 수 없는 작업"임을 확인받은 뒤에만 만든다.
 * @param {{ tableId: string, offset: number, count: number, clauses?: ViewClauses }} input
 * @returns {Command}
 */
export function deleteRowRange(input) {
  const table = quoteIdent(input.tableId);
  const range = rangeSubquery(table, input.clauses);
  return {
    type: 'row.deleteRange',
    tableId: input.tableId,
    do: [
      {
        sql: `DELETE FROM ${table} WHERE "id" IN (${range.sql})`,
        params: [...range.params, input.count, input.offset],
      },
    ],
    undo: [],
    summary: `row.deleteRange ${input.tableId} ×${input.count}`,
    irreversible: true,
  };
}

/**
 * 스냅샷 상한을 넘는 범위를 되돌릴 수 없이 비운다(D-08). 뷰 순서(`id`)로 `offset`부터 `count`개 행의
 * `colIds` 열을 NULL로 만든다. `deleteRowRange`와 같은 이유로 문장 하나다: 되돌릴 수 없으므로 옛 값이
 * 필요 없고, 옛 값을 읽으려면 범위 전체를 메인 스레드로 가져와야 한다(30만 행이면 수 GB).
 * 이미 모두 NULL인 행은 건드리지 않아 `_updated_at`이 헛돌지 않는다(되돌릴 수 있는 경로와 같다).
 * UI가 "되돌릴 수 없는 작업"임을 확인받은 뒤에만 만든다.
 * @param {{ tableId: string, colIds: string[], offset: number, count: number, now: string, clauses?: ViewClauses }} input
 * @returns {Command}
 */
export function clearRowRange(input) {
  if (input.colIds.length === 0) {
    throw new AppError('E_DB_QUERY', 'clearRowRange needs at least one column', {
      detail: { tableId: input.tableId },
    });
  }
  const table = quoteIdent(input.tableId);
  const sets = input.colIds.map((colId) => `${quoteIdent(colId)} = NULL`).join(', ');
  const anyFilled = input.colIds.map((colId) => `${quoteIdent(colId)} IS NOT NULL`).join(' OR ');
  const range = rangeSubquery(table, input.clauses);
  return {
    type: 'cell.clearRange',
    tableId: input.tableId,
    do: [
      {
        sql:
          `UPDATE ${table} SET ${sets}, "_updated_at" = ? ` +
          `WHERE "id" IN (${range.sql}) AND (${anyFilled})`,
        params: [input.now, ...range.params, input.count, input.offset],
      },
    ],
    undo: [],
    summary: `cell.clearRange ${input.tableId} ×${input.count}`,
    irreversible: true,
  };
}

/**
 * 다중 편집의 행 하나. `cells`는 바꿀 열과 옛·새 값.
 * @typedef {object} RowEdit
 * @property {number} rowId
 * @property {string | null} oldUpdatedAt
 * @property {Array<{ colId: string, oldValue: SqlValue, newValue: SqlValue }>} cells
 */

/**
 * 붙여넣기가 만드는 새 행. `cells`는 열 id → 값.
 * @typedef {object} RowInsert
 * @property {number} id
 * @property {Record<string, SqlValue>} cells
 */

/**
 * 빈 행 확정(D-16)의 새 행 목록. k번째 빈 행에 값을 쓰면 그 줄까지 k행을 만들고 마지막 행에만 값을 넣는다.
 * 앞의 k−1행은 모든 열이 비어 있다. `bulkEdit`의 `inserts`로 넘겨 커맨드 하나로 적용한다.
 * @param {{ firstId: number, count: number, cells: Record<string, SqlValue> }} input
 * @returns {RowInsert[]}
 */
export function ghostRowInserts(input) {
  /** @type {RowInsert[]} */
  const out = [];
  for (let i = 0; i < input.count; i += 1) {
    out.push({ id: input.firstId + i, cells: i === input.count - 1 ? { ...input.cells } : {} });
  }
  return out;
}

/**
 * 여러 행의 셀을 한 번에 바꾸고(`edits`), 필요하면 값이 든 새 행을 붙인다(`inserts`, 붙여넣기가 경계를 넘을 때).
 * 같은 열 집합을 바꾸는 행끼리 배치 하나로 묶고, 새 행은 모든 새 행의 열 합집합으로 INSERT 한 문장을 쓴다.
 * `irreversible`이면 스냅샷 상한을 적용하지 않고 `undo`가 빈 커맨드를 만든다(옛 값은 무시된다. UI가 확인받은 뒤에만).
 * @param {{ tableId: string, edits: RowEdit[], inserts?: RowInsert[], now: string, irreversible?: boolean }} input
 * @returns {Command}
 */
export function bulkEdit(input) {
  const inserts = input.inserts ?? [];
  if (!input.irreversible && input.edits.length + inserts.length > UNDO_SNAPSHOT_MAX_ROWS) {
    throw new AppError(
      'E_UNDO_LIMIT',
      `bulk edit of ${input.edits.length + inserts.length} rows exceeds the undo limit`,
      {
        detail: { rows: input.edits.length + inserts.length, limit: UNDO_SNAPSHOT_MAX_ROWS },
      },
    );
  }
  const table = quoteIdent(input.tableId);
  /** @type {Statement[]} */
  const doList = [];
  /** @type {Statement[]} */
  const undoList = [];

  /** @type {Map<string, { colIds: string[], doParams: SqlParams[], undoParams: SqlParams[] }>} */
  const groups = new Map();
  for (const edit of input.edits) {
    if (edit.cells.length === 0) continue;
    const colIds = edit.cells.map((c) => c.colId);
    const key = colIds.join('\u0000');
    let group = groups.get(key);
    if (!group) {
      group = { colIds, doParams: [], undoParams: [] };
      groups.set(key, group);
    }
    group.doParams.push([...edit.cells.map((c) => c.newValue), input.now, edit.rowId]);
    group.undoParams.push([...edit.cells.map((c) => c.oldValue), edit.oldUpdatedAt, edit.rowId]);
  }
  for (const group of groups.values()) {
    const sets = group.colIds.map((colId) => `${quoteIdent(colId)} = ?`).join(', ');
    const sql = `UPDATE ${table} SET ${sets}, "_updated_at" = ? WHERE "id" = ?`;
    doList.push(...batchStatements(sql, group.doParams));
    undoList.unshift(...batchStatements(sql, group.undoParams));
  }

  if (inserts.length > 0) {
    const colIds = [...new Set(inserts.flatMap((row) => Object.keys(row.cells)))].sort();
    const columns = ['"id"', '"_created_at"', '"_updated_at"', ...colIds.map(quoteIdent)];
    const marks = columns.map(() => '?').join(', ');
    const sql = `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${marks})`;
    doList.push(
      ...batchStatements(
        sql,
        inserts.map((row) => [
          row.id,
          input.now,
          input.now,
          ...colIds.map((colId) => row.cells[colId] ?? null),
        ]),
      ),
    );
    undoList.unshift(
      ...batchStatements(
        `DELETE FROM ${table} WHERE "id" = ?`,
        inserts.map((row) => [row.id]),
      ),
    );
  }

  /** @type {Command} */
  const cmd = {
    type: 'cell.bulkEdit',
    tableId: input.tableId,
    do: doList,
    undo: input.irreversible ? [] : undoList,
    summary: `cell.bulkEdit ${input.tableId} ×${input.edits.length}+${inserts.length}`,
  };
  if (input.irreversible) cmd.irreversible = true;
  return cmd;
}
