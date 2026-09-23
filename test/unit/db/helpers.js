// @ts-check
/**
 * 엔진 테스트 공용 도우미. vendor/sqlite3.wasm을 읽어 wasm 엔진을 만든다.
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { selectEngine } from '../../../src/db/engine.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

// Node에는 `location`이 없어 sqlite3의 OPFS 설치 시도가 경고를 찍는다(브라우저에서는 조용히 건너뜀).
// 상류가 문서화한 설정 훅으로 테스트 출력만 조용히 만든다.
const g = /** @type {Record<string, unknown>} */ (/** @type {unknown} */ (globalThis));
if (!g.sqlite3ApiConfig) g.sqlite3ApiConfig = { warn: () => {} };

/** @type {Promise<ArrayBuffer> | null} */
let wasmPromise = null;

/** @returns {Promise<ArrayBuffer>} */
export function loadWasmBinary() {
  if (!wasmPromise) {
    wasmPromise = readFile(path.join(ROOT, 'vendor', 'sqlite3.wasm')).then((buf) => {
      const copy = new ArrayBuffer(buf.byteLength);
      new Uint8Array(copy).set(buf);
      return copy;
    });
  }
  return wasmPromise;
}

/**
 * 초기화되고 빈 메모리 DB가 열린 wasm 엔진.
 * @param {Uint8Array} [bytes]
 * @returns {Promise<import('../../../src/db/engine.js').Engine>}
 */
export async function openWasmEngine(bytes) {
  const engine = selectEngine('wasm');
  await engine.init({ wasmBinary: await loadWasmBinary() });
  await engine.open(bytes);
  return engine;
}
