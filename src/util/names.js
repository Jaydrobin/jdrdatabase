// @ts-check
/**
 * 자동 이름(D-16). 형식 문자열의 `{n}`을 1부터 올리며 이미 있는 이름을 건너뛴다.
 * 양쪽(메인·Worker)에서 쓰는 순수 함수다. 형식 문자열은 호출자가 i18n에서 꺼내 넘긴다(Worker는 i18n을 모른다).
 */

/**
 * `format`의 `{n}`을 1부터 올리며 `taken`에 없는 이름을 `count`개 돌려준다. 돌려준 이름끼리도 겹치지 않는다.
 * `format`에 `{n}`이 없으면 모든 번호가 같은 이름이 되므로 빈 배열이 아니라 오류로 알린다.
 * @param {string} format 예: `열 {n}`
 * @param {ReadonlySet<string>} taken 이미 쓰는 이름(소프트 삭제된 열의 이름을 포함해 호출자가 모은다)
 * @param {number} count
 * @returns {string[]}
 */
export function nextNames(format, taken, count) {
  if (!format.includes('{n}')) throw new RangeError('format must contain {n}');
  /** @type {string[]} */
  const out = [];
  for (let n = 1; out.length < count; n += 1) {
    const name = format.replaceAll('{n}', String(n));
    if (!taken.has(name)) out.push(name);
  }
  return out;
}
