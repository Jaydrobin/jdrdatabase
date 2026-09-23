// @ts-check
/**
 * 저장된 뷰(`_jdr_views`, Step 6). 저장·삭제는 D-08 커맨드로 만들어 즉시 적용하고 `{ cmd }`를 돌려준다
 * (스키마 op와 같은 방식). 목록·불러오기는 읽기다. 뷰를 "적용"하는 것은 메인의 뷰 상태 일이며 DB를 바꾸지 않는다.
 *
 * 이 모듈은 `Engine` 인터페이스만 호출하고 값은 파라미터 바인딩으로만 넣는다.
 */
import { AppError } from '../util/errors.js';
import { newViewId } from '../util/ids.js';
import { applyCommand } from './command.js';
import { normalizeViewSpec } from './query.js';
import { normalizeName, requireTable } from './tables.js';

/** @typedef {import('./engine.js').Engine} Engine */
/** @typedef {import('./command.js').Command} Command */
/** @typedef {import('./query.js').ViewSpec} ViewSpec */
/** @typedef {import('./query.js').SortSpec} SortSpec */
/** @typedef {import('./query.js').FilterSpec} FilterSpec */

/**
 * `_jdr_views.spec`의 JSON. 그리드 뷰 스펙(정렬·필터·숨김·검색)에 열 너비·고정 열을 더한 것.
 * @typedef {object} SavedViewSpec
 * @property {SortSpec[]} sort
 * @property {FilterSpec | null} filter
 * @property {string[]} hidden
 * @property {string} search
 * @property {Record<string, number>} widths 열 id → 너비(px)
 * @property {number} frozen 고정 열 수
 */

/**
 * @typedef {object} View
 * @property {string} id
 * @property {string} tableId
 * @property {string} name
 * @property {SavedViewSpec} spec
 */

/** 테이블당 뷰 수 상한(목록 질의의 LIMIT). */
export const MAX_VIEWS_PER_TABLE = 1000;

/**
 * 저장할 스펙의 형태를 정리한다. 알 수 없는 키는 버리고 너비는 양의 정수만 남긴다.
 * @param {unknown} raw
 * @returns {SavedViewSpec}
 */
export function normalizeSavedSpec(raw) {
  const o =
    typeof raw === 'object' && raw !== null ? /** @type {Record<string, unknown>} */ (raw) : {};
  const base = normalizeViewSpec(o);
  /** @type {Record<string, number>} */
  const widths = {};
  if (typeof o.widths === 'object' && o.widths !== null) {
    for (const [colId, width] of Object.entries(o.widths)) {
      if (typeof width === 'number' && Number.isFinite(width) && width > 0) {
        widths[colId] = Math.round(width);
      }
    }
  }
  const frozen =
    typeof o.frozen === 'number' && Number.isFinite(o.frozen)
      ? Math.max(0, Math.trunc(o.frozen))
      : 0;
  return {
    sort: base.sort,
    filter: base.filter,
    hidden: base.hidden,
    search: base.search,
    widths,
    frozen,
  };
}

/**
 * @param {unknown} raw `_jdr_views.spec`
 * @returns {SavedViewSpec}
 */
function parseSpec(raw) {
  if (typeof raw !== 'string' || !raw) return normalizeSavedSpec({});
  try {
    return normalizeSavedSpec(JSON.parse(raw));
  } catch {
    // 손상된 스펙은 빈 뷰로 본다. 뷰 자체는 목록에 남아 지우거나 덮어쓸 수 있다.
    return normalizeSavedSpec({});
  }
}

/**
 * @param {import('./engine.js').SqlValue[]} row `id, table_id, name, spec`
 * @returns {View}
 */
function toView(row) {
  return {
    id: String(row[0]),
    tableId: String(row[1]),
    name: String(row[2]),
    spec: parseSpec(row[3]),
  };
}

/**
 * 테이블의 뷰 목록(이름 순).
 * @param {Engine} engine
 * @param {string} tableId
 * @returns {View[]}
 */
export function list(engine, tableId) {
  const r = engine.exec(
    engine.prepareCached(
      `SELECT id, table_id, name, spec FROM _jdr_views WHERE table_id = ? ORDER BY name COLLATE NOCASE, id LIMIT ${MAX_VIEWS_PER_TABLE}`,
    ),
    [tableId],
  );
  return r.rows.map(toView);
}

/**
 * 뷰 하나. 없으면 null.
 * @param {Engine} engine
 * @param {string} viewId
 * @returns {View | null}
 */
export function load(engine, viewId) {
  const r = engine.exec(
    engine.prepareCached('SELECT id, table_id, name, spec FROM _jdr_views WHERE id = ? LIMIT 1'),
    [viewId],
  );
  const row = r.rows[0];
  return row ? toView(row) : null;
}

/**
 * 뷰를 저장한다. `viewId`가 있으면 그 뷰를 덮어쓰고(되돌리면 옛 이름·스펙), 없으면 새 뷰를 만든다.
 * 이름은 같은 테이블의 다른 뷰와 겹칠 수 없다.
 * @param {Engine} engine
 * @param {string} tableId
 * @param {{ name: string, spec: unknown, viewId?: string }} input
 * @returns {Promise<{ viewId: string, cmd: Command }>}
 */
export async function save(engine, tableId, input) {
  const table = requireTable(engine, tableId);
  const views = list(engine, tableId);
  const existing = input.viewId ? views.find((v) => v.id === input.viewId) : undefined;
  if (input.viewId && !existing) {
    throw new AppError('E_DB_QUERY', 'view not found', {
      detail: { viewId: input.viewId, tableId },
    });
  }
  const name = normalizeName(
    input.name,
    views.filter((v) => v.id !== existing?.id).map((v) => v.name),
  );
  const spec = JSON.stringify(normalizeSavedSpec(input.spec));
  if (existing) {
    const sql = 'UPDATE _jdr_views SET name = ?, spec = ? WHERE id = ?';
    /** @type {Command} */
    const cmd = {
      type: 'view.update',
      tableId,
      do: [{ sql, params: [name, spec, existing.id] }],
      undo: [{ sql, params: [existing.name, JSON.stringify(existing.spec), existing.id] }],
      summary: `view.update ${table.name}.${name}`,
    };
    await applyCommand(engine, cmd);
    return { viewId: existing.id, cmd };
  }
  const viewId = newViewId(views.map((v) => v.id));
  /** @type {Command} */
  const cmd = {
    type: 'view.create',
    tableId,
    do: [
      {
        sql: 'INSERT INTO _jdr_views (id, table_id, name, spec) VALUES (?, ?, ?, ?)',
        params: [viewId, tableId, name, spec],
      },
    ],
    undo: [{ sql: 'DELETE FROM _jdr_views WHERE id = ?', params: [viewId] }],
    summary: `view.create ${table.name}.${name}`,
  };
  await applyCommand(engine, cmd);
  return { viewId, cmd };
}

/**
 * 뷰를 지운다. 되돌리면 같은 id·이름·스펙으로 되살아난다.
 * @param {Engine} engine
 * @param {string} viewId
 * @returns {Promise<{ cmd: Command }>}
 */
export async function remove(engine, viewId) {
  const view = load(engine, viewId);
  if (!view) throw new AppError('E_DB_QUERY', 'view not found', { detail: { viewId } });
  /** @type {Command} */
  const cmd = {
    type: 'view.delete',
    tableId: view.tableId,
    do: [{ sql: 'DELETE FROM _jdr_views WHERE id = ?', params: [viewId] }],
    undo: [
      {
        sql: 'INSERT INTO _jdr_views (id, table_id, name, spec) VALUES (?, ?, ?, ?)',
        params: [view.id, view.tableId, view.name, JSON.stringify(view.spec)],
      },
    ],
    summary: `view.delete ${view.name}`,
  };
  await applyCommand(engine, cmd);
  return { cmd };
}
