// @ts-check
/**
 * 설정 읽기·쓰기(Step 9). IDB `settings` 스토어의 기기 이름, 자동 저장 간격, 압축 저장. IDB가 없으면 기본값이며
 * 기기 이름은 실행마다 새로 만든다. DOM을 만지지 않는다.
 */
import { t } from '../i18n/index.js';
import { AUTOSAVE_INTERVALS_SECONDS } from '../io/autosave.js';
import { toAppError } from '../util/errors.js';

/** @typedef {import('../io/idb.js').Idb} Idb */

/**
 * @typedef {object} Settings
 * @property {string} deviceName `_jdr_meta.saved_by`에 쓰는 이 기기 이름
 * @property {number} autosaveSeconds 0이면 자동 저장 꺼짐
 * @property {boolean} saveGzip 다운로드 폴백의 제안 이름을 `.db.gz`로 만들지
 */

/** IDB `settings` 키. */
export const SETTINGS_KEYS = Object.freeze({
  deviceName: 'device_name',
  autosaveSeconds: 'autosave_seconds',
  saveGzip: 'save_gzip',
});

/** 기기 이름 길이 상한. */
export const DEVICE_NAME_MAX = 60;

/**
 * 무작위 기기 이름(`기기-XXXX`).
 * @returns {string}
 */
export function generateDeviceName() {
  return t('device.defaultName', {
    id: Math.random().toString(36).slice(2, 6).toUpperCase(),
  });
}

/**
 * 기기 이름을 다듬는다. 비면 null.
 * @param {unknown} raw
 * @returns {string | null}
 */
export function normalizeDeviceName(raw) {
  if (typeof raw !== 'string') return null;
  const name = raw.trim().slice(0, DEVICE_NAME_MAX).trim();
  return name || null;
}

/**
 * 자동 저장 간격을 선택지 중 하나로 맞춘다. 모르는 값은 0(꺼짐).
 * @param {unknown} raw
 * @returns {number}
 */
export function normalizeAutosaveSeconds(raw) {
  const n = typeof raw === 'number' ? raw : Number(raw);
  return AUTOSAVE_INTERVALS_SECONDS.includes(n) ? n : 0;
}

/**
 * 설정을 읽는다. 기기 이름이 없으면 만들어 저장한다(D-10). IDB 실패는 기본값으로 폴백하고 콘솔에만 남긴다.
 * @param {Idb | null} idb
 * @returns {Promise<Settings>}
 */
export async function load(idb) {
  /** @type {Settings} */
  const settings = { deviceName: generateDeviceName(), autosaveSeconds: 0, saveGzip: false };
  if (!idb) return settings;
  try {
    const name = normalizeDeviceName(await idb.get('settings', SETTINGS_KEYS.deviceName));
    if (name) settings.deviceName = name;
    else await idb.put('settings', SETTINGS_KEYS.deviceName, settings.deviceName);
    settings.autosaveSeconds = normalizeAutosaveSeconds(
      await idb.get('settings', SETTINGS_KEYS.autosaveSeconds),
    );
    settings.saveGzip = (await idb.get('settings', SETTINGS_KEYS.saveGzip)) === true;
  } catch (err) {
    console.warn(toAppError(err));
  }
  return settings;
}

/**
 * 바뀐 값만 쓴다. IDB가 없으면 아무것도 하지 않는다(그 실행 동안만 유효).
 * @param {Idb | null} idb
 * @param {Partial<Settings>} patch
 * @returns {Promise<void>}
 */
export async function save(idb, patch) {
  if (!idb) return;
  if (patch.deviceName !== undefined) {
    const name = normalizeDeviceName(patch.deviceName);
    if (name) await idb.put('settings', SETTINGS_KEYS.deviceName, name);
  }
  if (patch.autosaveSeconds !== undefined) {
    await idb.put(
      'settings',
      SETTINGS_KEYS.autosaveSeconds,
      normalizeAutosaveSeconds(patch.autosaveSeconds),
    );
  }
  if (patch.saveGzip !== undefined) {
    await idb.put('settings', SETTINGS_KEYS.saveGzip, patch.saveGzip === true);
  }
}
