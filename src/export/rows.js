// @ts-check
/**
 * 내보내기용 행 읽기(Step 9). 뷰 순서로 5,000행씩 읽는 페이지 이터레이터와 내보낼 열 목록. Worker에서 실행된다.
 *
 * - 정렬·필터·검색을 창 질의와 같은 `buildViewClauses`로 적용하므로 그리드에서 보는 순서가 파일의 순서다.
 * - 정렬·필터·검색이 없는 뷰는 `WHERE "id" > ? ORDER BY "id"` 키셋으로 읽어 OFFSET 비용(D-06)을 피한다.
 * - 값은 `substr` 미리보기가 아니라 전문이다.
 * - 페이지 사이에서 `yieldToEventLoop()`로 돌아와 취소 메시지를 받는다.
 * - 이 모듈은 `Engine` 인터페이스만 호출하고, 식별자는 `quoteIdent()`, 값은 파라미터 바인딩으로만 넣는다.
 */
import { yieldToEventLoop } from '../db/command.js';
import { buildViewClauses, visibleColumns } from '../db/query.js';
import { quoteIdent } from '../db/schema.js';
import { AppError } from '../util/errors.js';

/** @typedef {import('../db/engine.js').Engine} Engine */
/** @typedef {import('../db/engine.js').SqlValue} SqlValue */
/** @typedef {import('../db/tables.js').TableInfo} TableInfo */
/** @typedef {import('../db/tables.js').ColumnInfo} ColumnInfo */
/** @typedef {import('../db/query.js').ViewSpec} ViewSpec */

/** 한 페이지의 행 수. `MAX_RESULT_ROWS`(1만) 아래. */
export const PAGE_ROWS = 5_000;

/**
 * 내보낼 열: 살아 있고 숨기지 않은 열의 표시 순서(`query.visibleColumns`). 시스템 열은 내보내지 않는다.
 * @param {TableInfo} table
 * @param {ViewSpec} viewSpec
 * @returns {ColumnInfo[]}
 */
export function exportColumns(table, viewSpec) {
  return visibleColumns(table, viewSpec);
}

/**
 * @typedef {object} PageOptions
 * @property {number} [pageSize] 기본 `PAGE_ROWS`
 * @property {AbortSignal} [signal] 페이지 사이에서 확인한다
 */

/**
 * 뷰 순서로 페이지(행 배열)를 차례로 돌려준다. 각 행은 `columns` 순서의 값 배열이다(`id`는 넣지 않는다).
 * @param {Engine} engine
 * @param {TableInfo} table
 * @param {ViewSpec} viewSpec
 * @param {ColumnInfo[]} columns
 * @param {PageOptions} [options]
 * @returns {AsyncGenerator<SqlValue[][], void, undefined>}
 */
export async function* readPages(engine, table, viewSpec, columns, options = {}) {
  const pageSize = options.pageSize ?? PAGE_ROWS;
  const clauses = buildViewClauses(table, viewSpec);
  const select = ['"id"', ...columns.map((c) => quoteIdent(c.id))].join(', ');
  const from = `FROM ${quoteIdent(table.id)}`;
  const keyset = !clauses.sorted && !clauses.filtered;
  const sql = keyset
    ? `SELECT ${select} ${from} WHERE "id" > ? ORDER BY "id" LIMIT ?`
    : `SELECT ${select} ${from}${clauses.where} ORDER BY ${clauses.orderBy} LIMIT ? OFFSET ?`;
  const stmt = engine.prepareCached(sql);
  let lastId = -1;
  let offset = 0;
  for (;;) {
    if (options.signal?.aborted) {
      throw new AppError('E_IMPORT_CANCELLED', 'export cancelled', { detail: { done: offset } });
    }
    const params = keyset ? [lastId, pageSize] : [...clauses.params, pageSize, offset];
    const result = engine.exec(stmt, params);
    if (result.rows.length === 0) return;
    /** @type {SqlValue[][]} */
    const page = new Array(result.rows.length);
    for (let r = 0; r < result.rows.length; r += 1) {
      const raw = /** @type {SqlValue[]} */ (result.rows[r]);
      page[r] = raw.slice(1);
      if (r === result.rows.length - 1) lastId = Number(raw[0]);
    }
    offset += page.length;
    yield page;
    if (page.length < pageSize) return;
    // 취소 메시지(postMessage)는 태스크 큐로 오므로 페이지마다 한 번 돌아온다(command.js와 같은 이유).
    await yieldToEventLoop();
  }
}
