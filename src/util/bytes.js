// @ts-check
/**
 * base64와 크기 계산. 양쪽(메인·Worker)에서 쓰는 순수 함수만 둔다.
 */

export const KB = 1024;
export const MB = 1024 * 1024;
export const GB = 1024 * 1024 * 1024;

/**
 * base64 문자열을 바이트로 디코딩한다. 공백·줄바꿈은 무시한다.
 * 수 MB 크기(인라인 wasm)를 대상으로 하므로 atob 한 번과 단일 루프만 쓴다.
 * @param {string} b64
 * @returns {Uint8Array<ArrayBuffer>}
 */
export function base64ToBytes(b64) {
  const clean = b64.replace(/[\s]/g, '');
  const bin = atob(clean);
  const out = new Uint8Array(new ArrayBuffer(bin.length));
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

/**
 * 바이트를 base64 문자열로 인코딩한다. 큰 배열도 스택을 넘기지 않도록 조각 단위로 변환한다.
 * @param {Uint8Array} bytes
 * @returns {string}
 */
export function bytesToBase64(bytes) {
  const CHUNK = 0x8000;
  /** @type {string[]} */
  const parts = [];
  for (let i = 0; i < bytes.length; i += CHUNK) {
    parts.push(String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + CHUNK))));
  }
  return btoa(parts.join(''));
}

/**
 * 바이트 수를 사람이 읽는 단위로 만든다(예: "1.5 MB"). 로케일 문구는 없으므로 i18n 밖에 둔다.
 * @param {number} n
 * @returns {string}
 */
export function formatBytes(n) {
  if (!Number.isFinite(n)) return String(n);
  if (n < KB) return `${n} B`;
  if (n < MB) return `${(n / KB).toFixed(1)} KB`;
  if (n < GB) return `${(n / MB).toFixed(1)} MB`;
  return `${(n / GB).toFixed(2)} GB`;
}

/**
 * 구조화 복제로 넘길 때의 대략적인 크기(바이트)를 어림한다. 문자열은 UTF-16 코드 유닛당 2바이트,
 * 숫자는 8바이트, 바이너리는 길이, 그 밖의 값은 8바이트로 센다. 상한 검사용이므로 정확하지 않아도 된다.
 * @param {unknown} value
 * @returns {number}
 */
export function estimateCloneBytes(value) {
  if (value === null || value === undefined) return 8;
  if (typeof value === 'string') return 16 + value.length * 2;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
    return 8;
  if (value instanceof ArrayBuffer) return 16 + value.byteLength;
  if (ArrayBuffer.isView(value)) return 16 + value.byteLength;
  if (Array.isArray(value)) {
    let sum = 16;
    for (const v of value) sum += estimateCloneBytes(v);
    return sum;
  }
  if (typeof value === 'object') {
    let sum = 16;
    for (const [k, v] of Object.entries(value)) sum += 16 + k.length * 2 + estimateCloneBytes(v);
    return sum;
  }
  return 8;
}
