// @ts-check
/**
 * 창 질의 빌더(D-06, Step 4). 그리드가 보는 범위의 행만 `LIMIT/OFFSET`으로 읽고, 장문 열은
 * `substr(col, 1, 256)`과 `length(col)`을 함께 가져와 미리보기와 길이 배지를 만든다(D-05).
 *
 * 이 모듈은 `Engine` 인터페이스만 호출하고, 식별자는 `quoteIdent()`, 값은 파라미터 바인딩으로만 넣는다.
 * 정렬은 항상 `id`를 보조 키로 붙인다. 사용자 정렬·필터(Step 6)는 같은 빌더에 더해진다.
 */
import { AppError } from '../util/errors.js';
import { MAX_RESULT_ROWS } from './engine.js';
import { quoteIdent } from './schema.js';

/** @typedef {import('./engine.js').Engine} Engine */
/** @typedef {import('./engine.js').SqlParams} SqlParams */
/** @typedef {import('./engine.js').SqlValue} SqlValue */
/** @typedef {import('./tables.js').TableInfo} TableInfo */
/** @typedef {import('./tables.js').ColumnInfo} ColumnInfo */

/**
 * 뷰 사양. Step 4는 `hidden`만 해석한다. Step 6이 `sort`·`filter`를 더한다.
 * @typedef {object} ViewSpec
 * @property {string[]} [hidden] 그리드에서 숨기는 열 id
 */

/**
 * 창 질의의 행 하나. `cells[j]`는 `columnIds[j]` 열의 값이고, `lengths[j]`는 미리보기가 잘렸을 때만
 * 전체 문자 수, 아니면 null이다.
 * @typedef {object} WindowRow
 * @property {number} id
 * @property {SqlValue[]} cells
 * @property {(number | null)[]} lengths
 */

/**
 * @typedef {object} WindowResult
 * @property {WindowRow[]} rows
 * @property {string[]} columnIds 살아 있고 숨기지 않은 열의 표시 순서
 * @property {number} elapsedMs Worker 측 질의 시간(8장 측정용)
 */

/**
 * 편집용 전문 행. `cells`는 열 id → 값. 시스템 열의 시각은 되돌리기가 원래대로 되돌려 놓는 데 쓴다.
 * @typedef {object} FullRow
 * @property {number} id
 * @property {Record<string, SqlValue>} cells
 * @property {string | null} createdAt `_created_at`
 * @property {string | null} updatedAt `_updated_at`
 */

/**
 * 행 통계(`query.stats`). 빈 테이블이면 `minId`·`maxId`는 null.
 * @typedef {object} RowStats
 * @property {number} count
 * @property {number | null} minId
 * @property {number | null} maxId
 */

/** 그리드가 받는 텍스트 미리보기 길이(문자 수, D-05). */
export const PREVIEW_CHARS = 256;

/**
 * 미리보기·길이를 함께 가져오는 논리 타입. 그 밖의 타입은 값을 그대로 가져온다.
 * @param {ColumnInfo} column
 * @returns {boolean}
 */
export function isPreviewColumn(column) {
  return column.type === 'text' || column.type === 'longtext';
}

/**
 * 뷰가 보여 주는 열: 소프트 삭제되지 않았고 `hidden`에 없는 열을 `position, id` 순으로.
 * @param {TableInfo} table
 * @param {ViewSpec} [viewSpec]
 * @returns {ColumnInfo[]}
 */
export function visibleColumns(table, viewSpec = {}) {
  const hidden = new Set(Array.isArray(viewSpec.hidden) ? viewSpec.hidden : []);
  return table.columns.filter((c) => c.deletedAt === null && !hidden.has(c.id));
}

/**
 * @param {unknown} n
 * @param {string} name
 * @param {number} max
 * @returns {number}
 */
function assertNonNegativeInt(n, name, max) {
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 0 || n > max) {
    throw new AppError('E_DB_QUERY', `${name} must be an integer in [0, ${max}]`, {
      detail: { [name]: n, max },
    });
  }
  return n;
}

/**
 * 창 범위. `fromId`가 있으면 `OFFSET` 대신 `id >= fromId`로 탐색한다(아래 `denseFromId`).
 * @typedef {object} WindowRange
 * @property {number} offset
 * @property {number} limit
 * @property {number} [fromId]
 */

/**
 * 테이블의 행 통계. `query.count`가 계산하고 Worker가 쓰기 사이에 캐시한다.
 * @typedef {object} TableStats
 * @property {number} count 뷰 조건을 포함한 행 수
 */

/**
 * 창 질의 SQL. `SELECT id, <열들> FROM t ORDER BY id LIMIT ? OFFSET ?`.
 * 미리보기 열은 `substr(col, 1, 256), length(col)` 두 결과 열을 차지한다.
 *
 * `range.fromId`가 있으면 `WHERE "id" >= ? ORDER BY "id" LIMIT ?`로 바꾼다. `OFFSET n`은 rowid
 * b-tree의 잎 셀을 n개 걸어야 해서 30만 행 끝에서 50~60 ms가 걸리지만(세션 C 실측), id 탐색은
 * O(log n)으로 10 ms 안이다.
 * @param {TableInfo} table
 * @param {ColumnInfo[]} columns 결과에 넣을 열(살아 있는 열만)
 * @param {ViewSpec} viewSpec Step 4에서는 정렬·필터가 없어 SQL에 영향을 주지 않는다
 * @param {WindowRange} range
 * @returns {{ sql: string, params: SqlParams }}
 */
export function buildWindowSQL(table, columns, viewSpec, range) {
  void viewSpec;
  const offset = assertNonNegativeInt(range.offset, 'offset', Number.MAX_SAFE_INTEGER);
  const limit = assertNonNegativeInt(range.limit, 'limit', MAX_RESULT_ROWS);
  const select = ['"id"'];
  for (const column of columns) {
    const ident = quoteIdent(column.id);
    if (isPreviewColumn(column)) {
      select.push(`substr(${ident}, 1, ${PREVIEW_CHARS})`, `length(${ident})`);
    } else {
      select.push(ident);
    }
  }
  const head = `SELECT ${select.join(', ')} FROM ${quoteIdent(table.id)}`;
  if (range.fromId !== undefined) {
    const fromId = assertNonNegativeInt(range.fromId, 'fromId', Number.MAX_SAFE_INTEGER);
    return { sql: `${head} WHERE "id" >= ? ORDER BY "id" LIMIT ?`, params: [fromId, limit] };
  }
  return { sql: `${head} ORDER BY "id" LIMIT ? OFFSET ?`, params: [limit, offset] };
}

/**
 * id가 빈틈없이 연속인지(`max - min + 1 === count`) 보고, 그렇다면 `offset`번째 행의 id를 돌려준다.
 * 가져오기·추가만 겪은 테이블이 여기 해당하고, 행을 지운 뒤에는 연속이 깨져 `OFFSET`으로 돌아간다(R6).
 * `min`·`max`는 따로 물어야 rowid 탐색 한 번씩으로 끝난다(한 문장에 둘을 넣으면 전체 스캔이 된다).
 * @param {Engine} engine
 * @param {TableInfo} table
 * @param {TableStats} stats
 * @param {number} offset
 * @returns {number | undefined}
 */
export function denseFromId(engine, table, stats, offset) {
  if (stats.count <= 0 || offset >= stats.count) return undefined;
  const ident = quoteIdent(table.id);
  const lo = engine.exec(engine.prepareCached(`SELECT min("id") FROM ${ident} LIMIT 1`))
    .rows[0]?.[0];
  const hi = engine.exec(engine.prepareCached(`SELECT max("id") FROM ${ident} LIMIT 1`))
    .rows[0]?.[0];
  const min = typeof lo === 'number' ? lo : Number(lo);
  const max = typeof hi === 'number' ? hi : Number(hi);
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 0) return undefined;
  if (max - min + 1 !== stats.count) return undefined;
  return min + offset;
}

/**
 * 창 하나를 읽어 `WindowRow[]`로 만든다. `stats`가 있고 id가 연속이면 `OFFSET` 대신 id 탐색을 쓴다.
 * @param {Engine} engine
 * @param {TableInfo} table
 * @param {ViewSpec} viewSpec
 * @param {{ offset: number, limit: number }} range
 * @param {TableStats} [stats]
 * @returns {WindowResult}
 */
export function fetchWindow(engine, table, viewSpec, range, stats) {
  const columns = visibleColumns(table, viewSpec);
  const started = performance.now();
  const fromId = stats ? denseFromId(engine, table, stats, range.offset) : undefined;
  const { sql, params } = buildWindowSQL(table, columns, viewSpec, { ...range, fromId });
  const result = engine.exec(engine.prepareCached(sql), params);
  const elapsedMs = performance.now() - started;
  const preview = columns.map(isPreviewColumn);
  /** @type {WindowRow[]} */
  const rows = new Array(result.rows.length);
  for (let r = 0; r < result.rows.length; r += 1) {
    const raw = /** @type {SqlValue[]} */ (result.rows[r]);
    /** @type {SqlValue[]} */
    const cells = new Array(columns.length);
    /** @type {(number | null)[]} */
    const lengths = new Array(columns.length);
    let k = 1;
    for (let j = 0; j < columns.length; j += 1) {
      if (preview[j]) {
        cells[j] = raw[k] ?? null;
        const full = raw[k + 1];
        const n = typeof full === 'number' ? full : Number(full ?? 0);
        lengths[j] = n > PREVIEW_CHARS ? n : null;
        k += 2;
      } else {
        cells[j] = raw[k] ?? null;
        lengths[j] = null;
        k += 1;
      }
    }
    rows[r] = { id: Number(raw[0]), cells, lengths };
  }
  return { rows, columnIds: columns.map((c) => c.id), elapsedMs };
}

/**
 * 뷰 조건을 포함한 총 행 수(D-06: 필터 변경 시 1회). Step 4에는 필터가 없어 전체 행 수다.
 * @param {Engine} engine
 * @param {TableInfo} table
 * @param {ViewSpec} viewSpec
 * @returns {number}
 */
export function count(engine, table, viewSpec) {
  void viewSpec;
  const r = engine.exec(
    engine.prepareCached(`SELECT count(*) FROM ${quoteIdent(table.id)} LIMIT 1`),
  );
  return Number(r.rows[0]?.[0] ?? 0);
}

/**
 * 전문 행 읽기가 돌려줄 열. `colIds`가 비면 살아 있는 열(`includeDeleted`면 소프트 삭제된 열까지) 전부.
 * @param {TableInfo} table
 * @param {string[]} colIds
 * @param {boolean} includeDeleted
 * @returns {ColumnInfo[]}
 */
function wantedColumns(table, colIds, includeDeleted) {
  const pool = includeDeleted ? table.columns : table.columns.filter((c) => c.deletedAt === null);
  if (colIds.length === 0) return pool;
  const missing = colIds.filter((id) => !pool.some((c) => c.id === id));
  if (missing.length > 0) {
    throw new AppError('E_DB_QUERY', 'column not found', {
      detail: { tableId: table.id, columnIds: missing },
    });
  }
  return pool.filter((c) => colIds.includes(c.id));
}

/**
 * `SELECT id, _created_at, _updated_at, <열들>` 결과 행 하나를 `FullRow`로 만든다.
 * @param {SqlValue[]} raw
 * @param {ColumnInfo[]} wanted
 * @returns {FullRow}
 */
function toFullRow(raw, wanted) {
  /** @type {Record<string, SqlValue>} */
  const cells = {};
  wanted.forEach((c, i) => {
    cells[c.id] = raw[i + 3] ?? null;
  });
  const createdAt = raw[1];
  const updatedAt = raw[2];
  return {
    id: Number(raw[0]),
    cells,
    createdAt: typeof createdAt === 'string' ? createdAt : null,
    updatedAt: typeof updatedAt === 'string' ? updatedAt : null,
  };
}

/**
 * 편집용 전문 로드. 미리보기 없이 값 전체를 읽는다.
 * @param {Engine} engine
 * @param {TableInfo} table
 * @param {number} rowId
 * @param {string[]} [colIds] 비우면 살아 있는 열 전부
 * @returns {FullRow | null}
 */
export function fetchRow(engine, table, rowId, colIds = []) {
  const wanted = wantedColumns(table, colIds, false);
  const select = ['"id"', '"_created_at"', '"_updated_at"', ...wanted.map((c) => quoteIdent(c.id))];
  const r = engine.exec(
    engine.prepareCached(
      `SELECT ${select.join(', ')} FROM ${quoteIdent(table.id)} WHERE "id" = ? LIMIT 1`,
    ),
    [rowId],
  );
  const raw = r.rows[0];
  if (!raw) return null;
  return toFullRow(raw, wanted);
}

/**
 * 뷰 순서로 `offset`부터 `limit`개의 전문 행을 읽는다(`query.rows`). 붙여넣기·다중 편집·행 삭제가
 * 커맨드를 만들기 전에 옛 값을 읽는 경로다. `colIds`가 비면 소프트 삭제된 열까지 물리 열 전부를
 * 돌려주어 행 삭제의 되돌리기가 행을 원래대로 되살릴 수 있게 한다.
 * @param {Engine} engine
 * @param {TableInfo} table
 * @param {ViewSpec} viewSpec
 * @param {{ offset: number, limit: number }} range
 * @param {string[]} [colIds]
 * @returns {FullRow[]}
 */
export function fetchRows(engine, table, viewSpec, range, colIds = []) {
  void viewSpec;
  const offset = assertNonNegativeInt(range.offset, 'offset', Number.MAX_SAFE_INTEGER);
  const limit = assertNonNegativeInt(range.limit, 'limit', MAX_RESULT_ROWS);
  const wanted = wantedColumns(table, colIds, colIds.length === 0);
  const select = ['"id"', '"_created_at"', '"_updated_at"', ...wanted.map((c) => quoteIdent(c.id))];
  const r = engine.exec(
    engine.prepareCached(
      `SELECT ${select.join(', ')} FROM ${quoteIdent(table.id)} ORDER BY "id" LIMIT ? OFFSET ?`,
    ),
    [limit, offset],
  );
  return r.rows.map((raw) => toFullRow(/** @type {SqlValue[]} */ (raw), wanted));
}

/**
 * 행 수와 id 범위(`query.stats`). 행 추가 커맨드가 새 id를 `maxId + 1`부터 정하는 데 쓴다.
 * `min`·`max`는 따로 묻는다(D-06).
 * @param {Engine} engine
 * @param {TableInfo} table
 * @returns {RowStats}
 */
export function stats(engine, table) {
  const ident = quoteIdent(table.id);
  const total = count(engine, table, {});
  if (total === 0) return { count: 0, minId: null, maxId: null };
  const lo = engine.exec(engine.prepareCached(`SELECT min("id") FROM ${ident} LIMIT 1`))
    .rows[0]?.[0];
  const hi = engine.exec(engine.prepareCached(`SELECT max("id") FROM ${ident} LIMIT 1`))
    .rows[0]?.[0];
  return { count: total, minId: Number(lo), maxId: Number(hi) };
}
