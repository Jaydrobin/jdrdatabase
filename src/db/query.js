// @ts-check
/**
 * 창 질의 빌더(D-06, Step 4)와 뷰 스펙(Step 6). 그리드가 보는 범위의 행만 `LIMIT/OFFSET`으로 읽고, 장문 열은
 * `substr(col, 1, 256)`과 `length(col)`을 함께 가져와 미리보기와 길이 배지를 만든다(D-05).
 *
 * Step 6: 뷰 스펙(숨김·정렬·필터·검색)을 정규화하고, 필터(`buildWhere`)·검색(`buildSearchWhere`)·정렬
 * (`buildOrderBy`)을 SQL 조각으로 만든다. 창 질의·행 수·행 읽기와 되돌릴 수 없는 범위 커맨드가 같은
 * `buildViewClauses`를 쓰므로 그리드의 행 순번과 편집이 읽는 행이 어긋나지 않는다.
 *
 * 이 모듈은 `Engine` 인터페이스만 호출하고, 식별자는 `quoteIdent()`, 값은 파라미터 바인딩으로만 넣는다.
 * 정렬은 항상 `id`를 보조 키로 붙인다.
 */
import { AppError } from '../util/errors.js';
import { MAX_RESULT_ROWS } from './engine.js';
import { physicalType, quoteIdent } from './schema.js';
import {
  fallbackLike,
  FTS_MIN_QUERY_CHARS,
  query as ftsQuery,
  searchableColumns,
} from './search.js';
import { validate } from './values.js';

/** @typedef {import('./engine.js').Engine} Engine */
/** @typedef {import('./engine.js').SqlParams} SqlParams */
/** @typedef {import('./engine.js').SqlValue} SqlValue */
/** @typedef {import('./tables.js').TableInfo} TableInfo */
/** @typedef {import('./tables.js').ColumnInfo} ColumnInfo */
/** @typedef {import('./values.js').LogicalType} LogicalType */

/** @typedef {'asc' | 'desc'} SortDir */

/**
 * 정렬 항목. 앞 항목이 우선한다.
 * @typedef {object} SortSpec
 * @property {string} colId
 * @property {SortDir} dir
 */

/** @typedef {'=' | '!=' | '<' | '>' | '<=' | '>=' | 'contains' | 'starts' | 'empty' | 'not_empty' | 'in'} FilterOp */

/**
 * 필터 조건 하나. 값은 UI에서 온 문자열이며 빌더가 열 타입으로 검증·변환한다.
 * @typedef {object} FilterCondition
 * @property {string} colId
 * @property {FilterOp} op
 * @property {string} [value] `in`·`empty`·`not_empty` 외의 연산자가 쓴다
 * @property {string[]} [values] `in`이 쓴다
 */

/**
 * @typedef {object} FilterSpec
 * @property {'and' | 'or'} logic 조건을 잇는 방식(1단계)
 * @property {FilterCondition[]} conditions
 */

/**
 * 뷰 사양. Step 4는 `hidden`만, Step 6이 `sort`·`filter`·`search`를 더했다. 모두 선택 사항이며
 * `normalizeViewSpec`이 빠진 값을 채운다.
 * @typedef {object} ViewSpec
 * @property {string[]} [hidden] 그리드에서 숨기는 열 id
 * @property {SortSpec[]} [sort]
 * @property {FilterSpec | null} [filter]
 * @property {string} [search] 전문 검색어. 비면 없음
 */

/** 빠진 값이 채워진 뷰 사양. */
/** @typedef {{ hidden: string[], sort: SortSpec[], filter: FilterSpec | null, search: string }} NormalizedViewSpec */

/**
 * 뷰 사양을 SQL 조각으로 만든 것. `where`는 `' WHERE ...'` 또는 빈 문자열이고 `params`는 그 바인딩 값이다.
 * @typedef {object} ViewClauses
 * @property {string} where
 * @property {SqlValue[]} params
 * @property {string} orderBy `ORDER BY` 뒤에 오는 조각. 언제나 `"id"`로 끝난다
 * @property {boolean} sorted 사용자 정렬이 있는가
 * @property {boolean} filtered 필터나 검색이 있는가
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

/** 필터 연산자 목록(Step 6). UI의 선택지와 빌더의 검증이 같은 목록을 쓴다. */
export const FILTER_OPS = Object.freeze(
  /** @type {const} */ ([
    '=',
    '!=',
    '<',
    '>',
    '<=',
    '>=',
    'contains',
    'starts',
    'empty',
    'not_empty',
    'in',
  ]),
);

/**
 * @param {unknown} value
 * @returns {value is FilterOp}
 */
export function isFilterOp(value) {
  return typeof value === 'string' && /** @type {readonly string[]} */ (FILTER_OPS).includes(value);
}

/**
 * 값이 필요 없는 연산자.
 * @param {FilterOp} op
 * @returns {boolean}
 */
export function isUnaryOp(op) {
  return op === 'empty' || op === 'not_empty';
}

/**
 * 미리보기·길이를 함께 가져오는 논리 타입. 그 밖의 타입은 값을 그대로 가져온다.
 * @param {ColumnInfo} column
 * @returns {boolean}
 */
export function isPreviewColumn(column) {
  return column.type === 'text' || column.type === 'longtext';
}

/**
 * 대소문자 무시 비교·정렬을 쓰는 텍스트 계열 타입(4.2: `COLLATE NOCASE`).
 * @param {LogicalType} type
 * @returns {boolean}
 */
export function isTextType(type) {
  return type === 'text' || type === 'longtext' || type === 'select';
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

// ---- 뷰 스펙 (Step 6) ----

/**
 * @param {unknown} raw
 * @returns {SortSpec[]}
 */
function normalizeSort(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {SortSpec[]} */
  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const o = /** @type {Record<string, unknown>} */ (item);
    if (typeof o.colId !== 'string' || !o.colId || seen.has(o.colId)) continue;
    seen.add(o.colId);
    out.push({ colId: o.colId, dir: o.dir === 'desc' ? 'desc' : 'asc' });
  }
  return out;
}

/**
 * @param {unknown} raw
 * @returns {FilterSpec | null}
 */
function normalizeFilter(raw) {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = /** @type {Record<string, unknown>} */ (raw);
  const conditions = Array.isArray(o.conditions) ? o.conditions : [];
  /** @type {FilterCondition[]} */
  const out = [];
  for (const item of conditions) {
    if (typeof item !== 'object' || item === null) continue;
    const c = /** @type {Record<string, unknown>} */ (item);
    if (typeof c.colId !== 'string' || !c.colId || !isFilterOp(c.op)) continue;
    /** @type {FilterCondition} */
    const cond = { colId: c.colId, op: c.op };
    if (c.op === 'in') {
      cond.values = Array.isArray(c.values) ? c.values.map((v) => String(v)) : [];
    } else if (!isUnaryOp(c.op)) {
      cond.value = c.value === undefined || c.value === null ? '' : String(c.value);
    }
    out.push(cond);
  }
  if (out.length === 0) return null;
  return { logic: o.logic === 'or' ? 'or' : 'and', conditions: out };
}

/**
 * Worker 경계를 넘어온 뷰 사양의 형태를 정리한다. 모르는 키는 버리고 빠진 값은 채운다.
 * @param {unknown} raw
 * @returns {NormalizedViewSpec}
 */
export function normalizeViewSpec(raw) {
  const o =
    typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {};
  const hidden = Array.isArray(o.hidden)
    ? [...new Set(o.hidden.filter((id) => typeof id === 'string' && id))]
    : [];
  return {
    hidden: /** @type {string[]} */ (hidden),
    sort: normalizeSort(o.sort),
    filter: normalizeFilter(o.filter),
    search: typeof o.search === 'string' ? o.search.trim() : '',
  };
}

/**
 * 정렬·필터·검색이 하나도 없는가(D-06의 id 탐색 빠른 경로를 쓸 수 있는 뷰).
 * @param {ViewSpec} viewSpec
 * @returns {boolean}
 */
export function isPlainView(viewSpec) {
  const spec = normalizeViewSpec(viewSpec);
  return spec.sort.length === 0 && spec.filter === null && spec.search === '';
}

/**
 * 머리글 클릭에 따른 다음 정렬. 없음 → 오름차순 → 내림차순 → 없음. `append`(Shift+클릭)면 다른 항목을
 * 유지한 채 이 열만 바꾸고, 아니면 이 열 하나만 남긴다.
 * @param {SortSpec[]} sort
 * @param {string} colId
 * @param {boolean} [append]
 * @returns {SortSpec[]}
 */
export function toggleSort(sort, colId, append = false) {
  const current = sort.find((s) => s.colId === colId);
  /** @type {SortSpec | null} */
  const next =
    current === undefined
      ? { colId, dir: 'asc' }
      : current.dir === 'asc'
        ? { colId, dir: 'desc' }
        : null;
  if (!append) return next ? [next] : [];
  const others = sort.filter((s) => s.colId !== colId);
  if (!next) return others;
  if (current === undefined) return [...others, next];
  return sort.map((s) => (s.colId === colId ? next : s));
}

/**
 * 열 메뉴의 "오름차순·내림차순 정렬"(D-16). 다른 열의 정렬은 그대로 두고, 이 열이 목록에 있으면 그 자리에서
 * 방향만 바꾸고 없으면 보조 정렬로 끝에 붙인다. 한 열에는 정렬 항목이 하나뿐이다.
 * @param {SortSpec[]} sort
 * @param {string} colId
 * @param {'asc' | 'desc'} dir
 * @returns {SortSpec[]}
 */
export function setSortDirection(sort, colId, dir) {
  if (!sort.some((s) => s.colId === colId)) return [...sort, { colId, dir }];
  return sort.map((s) => (s.colId === colId ? { colId, dir } : s));
}

/**
 * 살아 있지 않은 열을 가리키는 정렬·필터·숨김 항목을 뷰에서 뺀다(Step 6 예외 처리: 정렬 대상 열의 소프트 삭제).
 * @param {ViewSpec} viewSpec
 * @param {TableInfo} table
 * @returns {{ spec: NormalizedViewSpec, changed: boolean }}
 */
export function pruneViewSpec(viewSpec, table) {
  const spec = normalizeViewSpec(viewSpec);
  const live = new Set(table.columns.filter((c) => c.deletedAt === null).map((c) => c.id));
  const sort = spec.sort.filter((s) => live.has(s.colId));
  const hidden = spec.hidden.filter((id) => live.has(id));
  const conditions = spec.filter ? spec.filter.conditions.filter((c) => live.has(c.colId)) : [];
  const filter = spec.filter && conditions.length > 0 ? { ...spec.filter, conditions } : null;
  const changed =
    sort.length !== spec.sort.length ||
    hidden.length !== spec.hidden.length ||
    (spec.filter ? conditions.length !== spec.filter.conditions.length : false);
  return { spec: { hidden, sort, filter, search: spec.search }, changed };
}

// ---- 필터·정렬·검색 빌더 (Step 6) ----

/**
 * 필터 값을 열 타입의 저장값으로 바꾼다. 맞지 않으면 `E_VALUE_INVALID`(UI도 같은 검증으로 먼저 거른다).
 * @param {ColumnInfo} column
 * @param {string} raw
 * @returns {SqlValue}
 */
function filterValue(column, raw) {
  const result = validate(column.type, raw, column.options ?? undefined);
  if (result.ok) return result.value;
  throw new AppError('E_VALUE_INVALID', `filter value does not fit ${column.type}`, {
    detail: {
      reason: result.reason,
      colId: column.id,
      columnName: column.name,
      preview: raw.slice(0, 80),
    },
  });
}

/**
 * 필터 사양 → `WHERE` 조각. 값은 항상 파라미터 바인딩이고 식별자는 `quoteIdent()`를 거친다.
 * 살아 있지 않은 열을 가리키는 조건은 무시한다(스토어가 곧 뷰에서 지운다). 조건이 없으면 `sql`은 빈 문자열.
 * @param {FilterSpec | null | undefined} filterSpec
 * @param {ColumnInfo[]} columns 살아 있는 열
 * @returns {{ sql: string, params: SqlValue[] }}
 */
export function buildWhere(filterSpec, columns) {
  const spec = normalizeFilter(filterSpec);
  if (!spec) return { sql: '', params: [] };
  const byId = new Map(columns.filter((c) => c.deletedAt === null).map((c) => [c.id, c]));
  /** @type {string[]} */
  const parts = [];
  /** @type {SqlValue[]} */
  const params = [];
  for (const cond of spec.conditions) {
    const column = byId.get(cond.colId);
    if (!column) continue;
    const ident = quoteIdent(column.id);
    const textual = physicalType(column.type) === 'TEXT';
    const collate = isTextType(column.type) ? ' COLLATE NOCASE' : '';
    switch (cond.op) {
      case '=':
      case '!=': {
        const value = filterValue(column, cond.value ?? '');
        if (value === null) {
          parts.push(cond.op === '=' ? `${ident} IS NULL` : `${ident} IS NOT NULL`);
        } else {
          parts.push(`${ident}${collate} ${cond.op === '=' ? '=' : 'IS NOT'} ?`);
          params.push(value);
        }
        break;
      }
      case '<':
      case '>':
      case '<=':
      case '>=': {
        const value = filterValue(column, cond.value ?? '');
        if (value === null) {
          // 빈 값과의 대소 비교는 어떤 행도 맞지 않는다(SQL의 NULL 비교와 같다).
          parts.push('0');
        } else {
          parts.push(`${ident}${collate} ${cond.op} ?`);
          params.push(value);
        }
        break;
      }
      case 'contains':
      case 'starts': {
        const expr = textual ? ident : `CAST(${ident} AS TEXT)`;
        const escaped = (cond.value ?? '').replace(/[\\%_]/g, (m) => `\\${m}`);
        parts.push(`${expr} LIKE ? ESCAPE '\\'`);
        params.push(cond.op === 'contains' ? `%${escaped}%` : `${escaped}%`);
        break;
      }
      case 'empty':
        parts.push(textual ? `(${ident} IS NULL OR ${ident} = '')` : `${ident} IS NULL`);
        break;
      case 'not_empty':
        parts.push(textual ? `(${ident} IS NOT NULL AND ${ident} != '')` : `${ident} IS NOT NULL`);
        break;
      case 'in': {
        const values = (cond.values ?? []).map((v) => filterValue(column, v));
        const present = values.filter((v) => v !== null);
        if (values.length === 0) {
          throw new AppError('E_VALUE_INVALID', 'in-list is empty', {
            detail: { reason: 'empty_list', colId: column.id, columnName: column.name },
          });
        }
        /** @type {string[]} */
        const alternatives = [];
        if (present.length > 0) {
          alternatives.push(`${ident}${collate} IN (${present.map(() => '?').join(', ')})`);
          params.push(...present);
        }
        if (present.length !== values.length) alternatives.push(`${ident} IS NULL`);
        parts.push(
          alternatives.length === 1 ? (alternatives[0] ?? '') : `(${alternatives.join(' OR ')})`,
        );
        break;
      }
      default:
        throw new AppError('E_DB_QUERY', `unknown filter operator ${String(cond.op)}`, {
          detail: { op: cond.op },
        });
    }
  }
  if (parts.length === 0) return { sql: '', params: [] };
  return { sql: `(${parts.join(spec.logic === 'or' ? ' OR ' : ' AND ')})`, params };
}

/**
 * 정렬 사양 → `ORDER BY` 뒤의 조각. 타입에 맞는 정렬(숫자·불리언은 수치, 텍스트 계열은 `COLLATE NOCASE`,
 * 날짜는 그대로), 빈 값은 항상 뒤(`NULLS LAST`), 마지막에 언제나 `"id"`. 살아 있지 않은 열은 무시한다.
 * @param {SortSpec[] | undefined} sortSpec
 * @param {ColumnInfo[]} columns 살아 있는 열
 * @returns {string}
 */
export function buildOrderBy(sortSpec, columns) {
  const byId = new Map(columns.filter((c) => c.deletedAt === null).map((c) => [c.id, c]));
  /** @type {string[]} */
  const terms = [];
  for (const item of normalizeSort(sortSpec)) {
    const column = byId.get(item.colId);
    if (!column) continue;
    const collate = isTextType(column.type) ? ' COLLATE NOCASE' : '';
    terms.push(
      `${quoteIdent(column.id)}${collate} ${item.dir === 'desc' ? 'DESC' : 'ASC'} NULLS LAST`,
    );
  }
  terms.push('"id"');
  return terms.join(', ');
}

/**
 * 검색어 → `WHERE` 조각. 인덱스가 있고(STRICT 테이블) 검색어가 3자 이상이면 FTS5, 아니면 LIKE 폴백(D-07).
 * @param {TableInfo} table
 * @param {string | undefined} q
 * @returns {{ sql: string, params: SqlValue[] }}
 */
export function buildSearchWhere(table, q) {
  const text = typeof q === 'string' ? q.trim() : '';
  if (!text) return { sql: '', params: [] };
  if (table.ftsEnabled && table.strict && [...text].length >= FTS_MIN_QUERY_CHARS) {
    return ftsQuery(table.id, text);
  }
  return fallbackLike(searchableColumns(table), text);
}

/**
 * 뷰 사양 전체를 SQL 조각으로 합친다. 창 질의·행 수·행 읽기·되돌릴 수 없는 범위 커맨드가 모두 이것을 쓴다.
 * @param {TableInfo} table
 * @param {ViewSpec} viewSpec
 * @returns {ViewClauses}
 */
export function buildViewClauses(table, viewSpec) {
  const spec = normalizeViewSpec(viewSpec);
  const live = table.columns.filter((c) => c.deletedAt === null);
  const filter = buildWhere(spec.filter, live);
  const search = buildSearchWhere(table, spec.search);
  const parts = [filter.sql, search.sql].filter((sql) => sql !== '');
  const orderBy = buildOrderBy(spec.sort, live);
  return {
    where: parts.length > 0 ? ` WHERE ${parts.join(' AND ')}` : '',
    params: [...filter.params, ...search.params],
    orderBy,
    sorted: orderBy !== '"id"',
    filtered: parts.length > 0,
  };
}

// ---- 창 질의 (Step 4) ----

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
 * 창 질의 SQL. `SELECT id, <열들> FROM t [WHERE 필터·검색] ORDER BY <정렬>, id LIMIT ? OFFSET ?`.
 * 미리보기 열은 `substr(col, 1, 256), length(col)` 두 결과 열을 차지한다.
 *
 * `range.fromId`가 있으면 `WHERE "id" >= ? ORDER BY "id" LIMIT ?`로 바꾼다(정렬·필터·검색이 없는 뷰에서만).
 * `OFFSET n`은 rowid b-tree의 잎 셀을 n개 걸어야 해서 30만 행 끝에서 50~60 ms가 걸리지만(세션 C 실측),
 * id 탐색은 O(log n)으로 10 ms 안이다.
 * @param {TableInfo} table
 * @param {ColumnInfo[]} columns 결과에 넣을 열(살아 있는 열만)
 * @param {ViewSpec} viewSpec
 * @param {WindowRange} range
 * @returns {{ sql: string, params: SqlParams }}
 */
export function buildWindowSQL(table, columns, viewSpec, range) {
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
  const clauses = buildViewClauses(table, viewSpec);
  if (range.fromId !== undefined) {
    if (clauses.sorted || clauses.filtered) {
      throw new AppError('E_DB_QUERY', 'fromId requires a plain view (no sort/filter/search)', {
        detail: { tableId: table.id },
      });
    }
    const fromId = assertNonNegativeInt(range.fromId, 'fromId', Number.MAX_SAFE_INTEGER);
    return { sql: `${head} WHERE "id" >= ? ORDER BY "id" LIMIT ?`, params: [fromId, limit] };
  }
  return {
    sql: `${head}${clauses.where} ORDER BY ${clauses.orderBy} LIMIT ? OFFSET ?`,
    params: [...clauses.params, limit, offset],
  };
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
 * 창 하나를 읽어 `WindowRow[]`로 만든다. `stats`가 있고 정렬·필터·검색이 없으며 id가 연속이면 `OFFSET` 대신
 * id 탐색을 쓴다.
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
  const fromId =
    stats && isPlainView(viewSpec) ? denseFromId(engine, table, stats, range.offset) : undefined;
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
 * 뷰 조건(필터·검색)을 포함한 총 행 수(D-06: 필터 변경 시 1회).
 * @param {Engine} engine
 * @param {TableInfo} table
 * @param {ViewSpec} viewSpec
 * @returns {number}
 */
export function count(engine, table, viewSpec) {
  const clauses = buildViewClauses(table, viewSpec);
  const r = engine.exec(
    engine.prepareCached(`SELECT count(*) FROM ${quoteIdent(table.id)}${clauses.where} LIMIT 1`),
    clauses.params,
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
 * 커맨드를 만들기 전에 옛 값을 읽는 경로다. 뷰의 정렬·필터·검색을 창 질의와 똑같이 적용하므로 그리드의
 * 행 순번이 그대로 `offset`이다. `colIds`가 비면 소프트 삭제된 열까지 물리 열 전부를 돌려주어 행 삭제의
 * 되돌리기가 행을 원래대로 되살릴 수 있게 한다.
 * @param {Engine} engine
 * @param {TableInfo} table
 * @param {ViewSpec} viewSpec
 * @param {{ offset: number, limit: number }} range
 * @param {string[]} [colIds]
 * @returns {FullRow[]}
 */
export function fetchRows(engine, table, viewSpec, range, colIds = []) {
  const offset = assertNonNegativeInt(range.offset, 'offset', Number.MAX_SAFE_INTEGER);
  const limit = assertNonNegativeInt(range.limit, 'limit', MAX_RESULT_ROWS);
  const wanted = wantedColumns(table, colIds, colIds.length === 0);
  const select = ['"id"', '"_created_at"', '"_updated_at"', ...wanted.map((c) => quoteIdent(c.id))];
  const clauses = buildViewClauses(table, viewSpec);
  const r = engine.exec(
    engine.prepareCached(
      `SELECT ${select.join(', ')} FROM ${quoteIdent(table.id)}${clauses.where} ORDER BY ${clauses.orderBy} LIMIT ? OFFSET ?`,
    ),
    [...clauses.params, limit, offset],
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
