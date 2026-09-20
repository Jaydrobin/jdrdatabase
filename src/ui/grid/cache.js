// @ts-check
/**
 * 블록 캐시(D-06): 창 질의 결과를 200행 블록 단위로 LRU에 둔다(최대 50블록).
 * 편집·정렬·필터·가져오기 후에는 테이블 단위로 전부 무효화한다. DOM을 만지지 않는 순수 자료구조다.
 *
 * 무효화는 두 가지다. `invalidate()`는 블록을 버리고(테이블 전환), `markStale()`은 블록을 낡은 것으로
 * 표시만 한다(같은 테이블의 데이터 변경). 낡은 블록은 `has()`가 없다고 답해 다시 요청되지만 `get()`은
 * 새 응답이 올 때까지 옛 행을 돌려주므로, 편집·되돌리기 뒤에 셀이 잠깐 비었다 채워지는 깜빡임이 없다.
 */

/** @typedef {import('../../db/query.js').WindowRow} WindowRow */

/** 블록 하나의 행 수(D-06). */
export const BLOCK_ROWS = 200;
/** 캐시가 붙잡는 블록 수 상한(D-06). */
export const MAX_BLOCKS = 50;

/**
 * @typedef {object} CachedBlock
 * @property {number} block 블록 번호(`offset / BLOCK_ROWS`)
 * @property {WindowRow[]} rows 블록의 행. 마지막 블록은 짧을 수 있다
 * @property {string[]} columnIds 행이 담은 열 순서
 * @property {number} version 내용 세대. 새 응답이나 셀 패치마다 오르며 그리드가 칸을 다시 그릴지 판단한다
 * @property {boolean} [stale] 데이터가 바뀐 뒤 아직 다시 읽지 않은 블록
 */

/**
 * @typedef {object} BlockCache
 * @property {(tableId: string, block: number) => CachedBlock | undefined} get 최근 사용으로 올린다
 * @property {(tableId: string, entry: CachedBlock) => void} put
 * @property {(tableId: string, block: number) => boolean} has 사용 순서를 바꾸지 않는다
 * @property {(tableId?: string) => void} invalidate 테이블의 블록 전부(인자 없으면 전체)를 버린다
 * @property {(tableId: string) => void} markStale 테이블의 블록을 낡은 것으로 표시한다(`has()`는 false, `get()`은 옛 행)
 * @property {(tableId: string) => CachedBlock[]} blocks 테이블의 블록 목록(셀 패치용). 사용 순서를 바꾸지 않는다
 * @property {() => number} size
 */

/**
 * @param {string} tableId
 * @param {number} block
 * @returns {string}
 */
function keyOf(tableId, block) {
  return `${tableId}\u0000${block}`;
}

/**
 * @param {{ maxBlocks?: number }} [options]
 * @returns {BlockCache}
 */
export function createBlockCache(options = {}) {
  const maxBlocks = options.maxBlocks ?? MAX_BLOCKS;
  /** Map은 삽입 순서를 지키므로 첫 항목이 가장 오래된 것이다. */
  /** @type {Map<string, { tableId: string, entry: CachedBlock }>} */
  const map = new Map();

  return {
    get(tableId, block) {
      const key = keyOf(tableId, block);
      const hit = map.get(key);
      if (!hit) return undefined;
      map.delete(key);
      map.set(key, hit);
      return hit.entry;
    },
    has(tableId, block) {
      const hit = map.get(keyOf(tableId, block));
      return hit !== undefined && hit.entry.stale !== true;
    },
    put(tableId, entry) {
      const key = keyOf(tableId, entry.block);
      map.delete(key);
      map.set(key, { tableId, entry });
      while (map.size > maxBlocks) {
        const oldest = map.keys().next().value;
        if (oldest === undefined) break;
        map.delete(oldest);
      }
    },
    invalidate(tableId) {
      if (tableId === undefined) {
        map.clear();
        return;
      }
      for (const [key, value] of map) {
        if (value.tableId === tableId) map.delete(key);
      }
    },
    markStale(tableId) {
      for (const value of map.values()) {
        if (value.tableId === tableId) value.entry.stale = true;
      }
    },
    blocks(tableId) {
      /** @type {CachedBlock[]} */
      const out = [];
      for (const value of map.values()) {
        if (value.tableId === tableId) out.push(value.entry);
      }
      return out;
    },
    size: () => map.size,
  };
}
