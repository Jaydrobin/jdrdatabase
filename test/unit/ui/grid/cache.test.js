// @ts-check
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BLOCK_ROWS, createBlockCache, MAX_BLOCKS } from '../../../../src/ui/grid/cache.js';

/**
 * @param {number} block
 * @returns {import('../../../../src/ui/grid/cache.js').CachedBlock}
 */
function entry(block) {
  return {
    block,
    rows: [{ id: block * BLOCK_ROWS + 1, cells: [], lengths: [] }],
    columnIds: [],
    version: 0,
  };
}

test('블록 캐시: markStale은 블록을 버리지 않고 has만 false로, put이 다시 살린다', () => {
  const cache = createBlockCache();
  cache.put('t_a', entry(0));
  cache.put('t_b', entry(0));
  cache.markStale('t_a');
  assert.equal(cache.has('t_a', 0), false, '다시 요청하게 한다');
  assert.equal(cache.get('t_a', 0)?.rows[0]?.id, 1, '새 응답 전까지 옛 행을 돌려준다');
  assert.equal(cache.has('t_b', 0), true);
  cache.put('t_a', entry(0));
  assert.equal(cache.has('t_a', 0), true);
  assert.deepEqual(
    cache.blocks('t_a').map((b) => b.block),
    [0],
  );
  assert.equal(cache.size(), 2);
});

test('블록 캐시: D-06 상수(200행, 50블록)', () => {
  assert.equal(BLOCK_ROWS, 200);
  assert.equal(MAX_BLOCKS, 50);
});

test('블록 캐시: put/get/has와 테이블 단위 무효화', () => {
  const cache = createBlockCache();
  cache.put('t_a', entry(0));
  cache.put('t_b', entry(0));
  assert.equal(cache.get('t_a', 0)?.rows[0]?.id, 1);
  assert.equal(cache.has('t_b', 0), true);
  assert.equal(cache.get('t_a', 1), undefined);
  cache.invalidate('t_a');
  assert.equal(cache.has('t_a', 0), false);
  assert.equal(cache.has('t_b', 0), true);
  cache.invalidate();
  assert.equal(cache.size(), 0);
});

test('블록 캐시: LRU — 상한을 넘으면 가장 오래 안 쓴 블록부터 버린다', () => {
  const cache = createBlockCache({ maxBlocks: 3 });
  cache.put('t', entry(0));
  cache.put('t', entry(1));
  cache.put('t', entry(2));
  assert.ok(cache.get('t', 0), '0을 최근 사용으로 올린다');
  cache.put('t', entry(3));
  assert.equal(cache.has('t', 1), false, '가장 오래 안 쓴 1이 나간다');
  assert.equal(cache.has('t', 0), true);
  assert.equal(cache.size(), 3);
  cache.put('t', entry(0));
  assert.equal(cache.size(), 3, '같은 블록을 다시 넣으면 교체된다');
});
