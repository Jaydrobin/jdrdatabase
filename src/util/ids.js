// @ts-check
/**
 * 물리 식별자 생성(D-03). 접두사 문자열은 이 파일과 db/schema.js에만 둔다(CLAUDE.md 5.2).
 * 양쪽(메인·Worker)에서 쓰는 순수 함수만 있다.
 */

export const TABLE_PREFIX = 't_';
export const COLUMN_PREFIX = 'c_';
/** 저장된 뷰(`_jdr_views.id`)의 접두사. */
export const VIEW_PREFIX = 'v_';
/** 접두사 뒤의 16진수 자릿수. */
export const HEX_LENGTH = 8;

/**
 * @returns {string} 8자리 소문자 16진수
 */
function randomHex() {
  const bytes = crypto.getRandomValues(new Uint8Array(HEX_LENGTH / 2));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 접두사가 붙은 새 식별자. `existing`에 있으면 다시 만든다(충돌 시 재생성).
 * @param {string} prefix
 * @param {Iterable<string>} [existing]
 * @returns {string}
 */
function newId(prefix, existing = []) {
  const taken = existing instanceof Set ? existing : new Set(existing);
  for (;;) {
    const id = `${prefix}${randomHex()}`;
    if (!taken.has(id)) return id;
  }
}

/**
 * @param {Iterable<string>} [existing] 이미 쓰는 테이블 id
 * @returns {string} `t_<8hex>`
 */
export function newTableId(existing) {
  return newId(TABLE_PREFIX, existing);
}

/**
 * @param {Iterable<string>} [existing] 같은 테이블에서 이미 쓰는 열 id
 * @returns {string} `c_<8hex>`
 */
export function newColumnId(existing) {
  return newId(COLUMN_PREFIX, existing);
}

/**
 * @param {Iterable<string>} [existing] 이미 쓰는 뷰 id
 * @returns {string} `v_<8hex>`
 */
export function newViewId(existing) {
  return newId(VIEW_PREFIX, existing);
}

const TABLE_RE = new RegExp(`^${TABLE_PREFIX}[0-9a-f]{${HEX_LENGTH}}$`);
const COLUMN_RE = new RegExp(`^${COLUMN_PREFIX}[0-9a-f]{${HEX_LENGTH}}$`);

/**
 * 앱이 만든 테이블 id 형식인가(외부 파일에서 등록한 테이블은 아니다).
 * @param {string} id
 * @returns {boolean}
 */
export function isTableId(id) {
  return TABLE_RE.test(id);
}

/**
 * @param {string} id
 * @returns {boolean}
 */
export function isColumnId(id) {
  return COLUMN_RE.test(id);
}
