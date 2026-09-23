// @ts-check
/**
 * 숫자·날짜 표시용 순수 함수(3.1). 양쪽 스레드에서 쓸 수 있고 부수효과가 없다.
 */

/** 로케일 자릿수 구분에 쓰는 포맷터. 한국어 UI 기본(D-14)이며 구분 기호는 쉼표다. */
const INTEGER_FORMAT = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });

/**
 * 정수를 천 단위 구분 기호와 함께 표시한다. 길이 배지·행 수 표시에 쓴다.
 * @param {number} n
 * @returns {string}
 */
export function formatInteger(n) {
  if (!Number.isFinite(n)) return '';
  return INTEGER_FORMAT.format(Math.trunc(n));
}
