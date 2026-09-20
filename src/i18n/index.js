// @ts-check
import { ko } from './ko.js';

/** @typedef {keyof typeof ko} MessageKey */
/** @typedef {Record<string, string | number>} MessageParams */

/**
 * 문자열 키를 현재 로케일(v1: 한국어) 문구로 바꾼다. `{name}` 자리표시자를 params로 채운다.
 * 없는 키는 키 자체를 돌려주어 화면에서 바로 눈에 띄게 한다.
 * @param {MessageKey} key
 * @param {MessageParams} [params]
 * @returns {string}
 */
export function t(key, params) {
  const template = ko[key] ?? key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * 키 존재 여부. 오류 코드처럼 동적으로 만든 키를 확인할 때 쓴다.
 * @param {string} key
 * @returns {key is MessageKey}
 */
export function hasMessage(key) {
  return Object.prototype.hasOwnProperty.call(ko, key);
}
