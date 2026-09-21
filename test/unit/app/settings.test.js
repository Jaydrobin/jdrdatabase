// @ts-check
/**
 * 설정(Step 9): 기본값, 기기 이름 생성·저장, 간격 선택지 정규화, IDB 없음.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEVICE_NAME_MAX,
  load,
  normalizeAutosaveSeconds,
  normalizeDeviceName,
  save,
  SETTINGS_KEYS,
} from '../../../src/app/settings.js';
import { createMemoryIdb } from '../../../src/io/idb.js';

test('load: 처음이면 기기 이름을 만들어 저장하고, 두 번째부터는 그 이름', async () => {
  const idb = createMemoryIdb();
  const first = await load(idb);
  assert.match(first.deviceName, /^기기-[0-9A-Z]{4}$/);
  assert.equal(first.autosaveSeconds, 0);
  assert.equal(first.saveGzip, false);
  assert.equal(await idb.get('settings', SETTINGS_KEYS.deviceName), first.deviceName);
  const second = await load(idb);
  assert.equal(second.deviceName, first.deviceName);
});

test('save → load: 바뀐 값만 쓰고 정규화한다', async () => {
  const idb = createMemoryIdb();
  await load(idb);
  await save(idb, { deviceName: '  노트북  ', autosaveSeconds: 60, saveGzip: true });
  const s = await load(idb);
  assert.equal(s.deviceName, '노트북');
  assert.equal(s.autosaveSeconds, 60);
  assert.equal(s.saveGzip, true);
  await save(idb, { autosaveSeconds: 45 });
  assert.equal((await load(idb)).autosaveSeconds, 0, '선택지에 없는 값은 꺼짐');
  await save(idb, { deviceName: '   ' });
  assert.equal((await load(idb)).deviceName, '노트북', '빈 이름은 쓰지 않는다');
});

test('normalize: 이름 길이 상한, 간격 선택지', () => {
  assert.equal(normalizeDeviceName('x'.repeat(100))?.length, DEVICE_NAME_MAX);
  assert.equal(normalizeDeviceName(3), null);
  assert.equal(normalizeAutosaveSeconds('300'), 300);
  assert.equal(normalizeAutosaveSeconds(-1), 0);
});

test('IDB가 없으면 기본값이고 save는 아무것도 하지 않는다', async () => {
  const s = await load(null);
  assert.match(s.deviceName, /^기기-/);
  await save(null, { saveGzip: true });
});
