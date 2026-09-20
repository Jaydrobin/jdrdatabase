// @ts-check
/**
 * 블록 캐시(D-06): 창 질의 결과를 200행 블록 단위로 LRU에 둔다(최대 50블록).
 * 편집·정렬·필터·가져오기 후에는 테이블 단위로 전부 무효화한다. DOM을 만지지 않는 순수 자료구조다.
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
 */

/**
 * @typedef {object} BlockCache
 * @property {(tableId: string, block: number) => CachedBlock | undefined} get 최근 사용으로 올린다
 * @property {(tableId: string, entry: CachedBlock) => void} put
 * @property {(tableId: string, block: number) => boolean} has 사용 순서를 바꾸지 않는다
 * @property {(tableId?: string) => void} invalidate 테이블의 블록 전부(인자 없으면 전체)
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
      return map.has(keyOf(tableId, block));
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
    size: () => map.size,
  };
}
