// @ts-check
/**
 * 저장된 뷰(Step 6): 저장·덮어쓰기·삭제 커맨드의 대칭성, 목록·불러오기, 스펙 정규화, 이름 규칙,
 * 테이블 삭제 시 함께 지워짐. 실제 wasm DB로 검사한다.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyCommand } from '../../../src/db/command.js';
import { migrate } from '../../../src/db/schema.js';
import * as tables from '../../../src/db/tables.js';
import * as views from '../../../src/db/views.js';
import { AppError } from '../../../src/util/errors.js';
import { dumpDb } from './command.test.js';
import { openWasmEngine } from './helpers.js';

async function setup() {
  const engine = await openWasmEngine();
  await migrate(engine, { appVersion: 'test' });
  const { tableId } = await tables.create(engine, { name: '고객' });
  const name = (await tables.addColumn(engine, tableId, { name: '이름', type: 'text' })).columnId;
  const age = (await tables.addColumn(engine, tableId, { name: '나이', type: 'integer' })).columnId;
  return { engine, tableId, name, age };
}

test('normalizeSavedSpec: 모르는 키는 버리고 빠진 값은 채우며 너비는 양의 정수만', () => {
  const spec = views.normalizeSavedSpec({
    sort: [{ colId: 'c_1', dir: 'desc' }, { colId: 'c_1', dir: 'asc' }, { nope: 1 }],
    filter: { logic: 'or', conditions: [{ colId: 'c_2', op: '>', value: 3 }, { op: 'x' }] },
    hidden: ['c_3', 'c_3', 7],
    search: '  hi ',
    widths: { c_1: 120.4, c_2: -5, c_3: 'x' },
    frozen: 2.9,
    extra: true,
  });
  assert.deepEqual(spec, {
    sort: [{ colId: 'c_1', dir: 'desc' }],
    filter: { logic: 'or', conditions: [{ colId: 'c_2', op: '>', value: '3' }] },
    hidden: ['c_3'],
    search: 'hi',
    widths: { c_1: 120 },
    frozen: 2,
  });
  assert.deepEqual(views.normalizeSavedSpec(null), {
    sort: [],
    filter: null,
    hidden: [],
    search: '',
    widths: {},
    frozen: 0,
  });
});

test('save(새 뷰) → list/load, 되돌리기로 덤프 동일, 이름 중복·빈 이름 거부', async () => {
  const { engine, tableId, name, age } = await setup();
  const before = dumpDb(engine);
  const spec = {
    sort: [{ colId: age, dir: 'desc' }],
    filter: { logic: 'and', conditions: [{ colId: name, op: 'contains', value: "O'" }] },
    hidden: [],
    search: '홍',
    widths: { [name]: 200 },
    frozen: 1,
  };
  const { viewId, cmd } = await views.save(engine, tableId, { name: ' 기본 ', spec });
  assert.match(viewId, /^v_[0-9a-f]{8}$/);
  assert.equal(cmd.type, 'view.create');
  const listed = views.list(engine, tableId);
  assert.equal(listed.length, 1);
  assert.equal(listed[0]?.name, '기본', '앞뒤 공백은 지운다');
  assert.deepEqual(listed[0]?.spec, spec);
  assert.deepEqual(views.load(engine, viewId), listed[0]);
  assert.equal(views.load(engine, 'v_00000000'), null);

  await assert.rejects(
    views.save(engine, tableId, { name: '기본', spec }),
    (e) => e instanceof AppError && e.code === 'E_NAME_INVALID',
  );
  await assert.rejects(
    views.save(engine, tableId, { name: '  ', spec }),
    (e) => e instanceof AppError && e.code === 'E_NAME_INVALID',
  );
  await assert.rejects(
    views.save(engine, 't_00000000', { name: 'x', spec }),
    (e) => e instanceof AppError && e.code === 'E_DB_QUERY',
  );

  const after = dumpDb(engine);
  await applyCommand(engine, cmd, 'undo');
  assert.deepEqual(dumpDb(engine), before);
  assert.deepEqual(views.list(engine, tableId), []);
  await applyCommand(engine, cmd, 'do');
  assert.deepEqual(dumpDb(engine), after);
  await engine.close();
});

test('save(viewId) 덮어쓰기: 이름·스펙을 바꾸고 되돌리면 옛 이름·스펙, 다른 뷰의 이름과 겹치면 거부', async () => {
  const { engine, tableId, age } = await setup();
  const empty = views.normalizeSavedSpec({});
  const first = await views.save(engine, tableId, { name: 'A', spec: empty });
  await views.save(engine, tableId, { name: 'B', spec: empty });
  const before = dumpDb(engine);
  const updated = await views.save(engine, tableId, {
    name: 'A2',
    spec: { ...empty, sort: [{ colId: age, dir: 'asc' }] },
    viewId: first.viewId,
  });
  assert.equal(updated.viewId, first.viewId);
  assert.equal(updated.cmd.type, 'view.update');
  assert.deepEqual(
    views.list(engine, tableId).map((v) => v.name),
    ['A2', 'B'],
  );
  assert.deepEqual(views.load(engine, first.viewId)?.spec.sort, [{ colId: age, dir: 'asc' }]);
  await applyCommand(engine, updated.cmd, 'undo');
  assert.deepEqual(dumpDb(engine), before);
  // 같은 이름으로 자기 자신을 덮어쓰는 것은 된다. 다른 뷰의 이름은 안 된다.
  await views.save(engine, tableId, { name: 'A', spec: empty, viewId: first.viewId });
  await assert.rejects(
    views.save(engine, tableId, { name: 'B', spec: empty, viewId: first.viewId }),
    (e) => e instanceof AppError && e.code === 'E_NAME_INVALID',
  );
  await assert.rejects(
    views.save(engine, tableId, { name: 'C', spec: empty, viewId: 'v_00000000' }),
    (e) => e instanceof AppError && e.code === 'E_DB_QUERY',
  );
  await engine.close();
});

test('remove: 지우고 되돌리면 같은 id·이름·스펙, 없는 뷰는 E_DB_QUERY, 테이블 삭제는 뷰도 지운다', async () => {
  const { engine, tableId } = await setup();
  const empty = views.normalizeSavedSpec({});
  const { viewId } = await views.save(engine, tableId, { name: 'A', spec: empty });
  const before = dumpDb(engine);
  const { cmd } = await views.remove(engine, viewId);
  assert.equal(cmd.type, 'view.delete');
  assert.equal(cmd.tableId, tableId);
  assert.deepEqual(views.list(engine, tableId), []);
  await applyCommand(engine, cmd, 'undo');
  assert.deepEqual(dumpDb(engine), before);
  await assert.rejects(
    views.remove(engine, 'v_00000000'),
    (e) => e instanceof AppError && e.code === 'E_DB_QUERY',
  );
  await tables.drop(engine, tableId);
  assert.deepEqual(views.list(engine, tableId), []);
  await engine.close();
});

test('손상된 spec JSON은 빈 뷰로 읽힌다', async () => {
  const { engine, tableId } = await setup();
  await engine.transaction(() => {
    engine.run('INSERT INTO _jdr_views (id, table_id, name, spec) VALUES (?, ?, ?, ?)', [
      'v_deadbeef',
      tableId,
      '깨짐',
      '{not json',
    ]);
  });
  assert.deepEqual(views.load(engine, 'v_deadbeef')?.spec, views.normalizeSavedSpec({}));
  await engine.close();
});
