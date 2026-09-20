// @ts-check
/**
 * 엔진 인터페이스 적합성 테스트(D-15, Step 1 완료 기준).
 * 구현과 분리되어 있어 Step 11의 네이티브 엔진도 `defineEngineContract('native', factory)`로 같은 검사를 돌린다.
 */
import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { MAX_BATCH_PARAMS, MAX_RESULT_ROWS } from '../../../src/db/engine.js';
import { AppError } from '../../../src/util/errors.js';
import { openWasmEngine } from './helpers.js';

/** @typedef {import('../../../src/db/engine.js').Engine} Engine */

/**
 * @param {Promise<unknown> | (() => unknown)} action
 * @param {string} code
 * @returns {Promise<AppError>}
 */
async function expectAppError(action, code) {
  try {
    await (typeof action === 'function' ? action() : action);
  } catch (err) {
    assert.ok(err instanceof AppError, `AppError여야 함: ${String(err)}`);
    assert.equal(err.code, code, `code: ${err.message}`);
    return err;
  }
  assert.fail(`${code}를 던져야 함`);
}

/**
 * @param {string} label
 * @param {(bytes?: Uint8Array) => Promise<Engine>} open 초기화되고 (bytes가 있으면 그것으로) 열린 엔진을 돌려준다
 */
export function defineEngineContract(label, open) {
  describe(`engine contract: ${label}`, () => {
    test('init: SQLite 3.37 이상, FTS5 포함, capabilities 형태', async () => {
      const engine = await open();
      const caps = engine.capabilities();
      assert.ok(['wasm', 'native'].includes(caps.mode));
      assert.ok(typeof caps.maxFileBytes === 'number' && caps.maxFileBytes > 0);
      assert.ok(typeof caps.warnFileBytes === 'number' && caps.warnFileBytes <= caps.maxFileBytes);
      assert.ok(['snapshot', 'native'].includes(caps.persistence));
      assert.equal(typeof caps.cancellable, 'boolean');
      assert.equal(caps.fts5, true, 'FTS5가 있어야 한다(D-07)');

      const version = String(engine.exec('SELECT sqlite_version()').rows[0]?.[0]);
      const [major = 0, minor = 0] = version.split('.').map(Number);
      assert.ok(major > 3 || (major === 3 && minor >= 37), `sqlite_version ${version} >= 3.37`);
      const options = engine.exec('PRAGMA compile_options').rows.map((r) => String(r[0]));
      assert.ok(options.includes('ENABLE_FTS5'), 'compile_options에 ENABLE_FTS5');
      await engine.close();
    });

    test('exec: 열 이름과 행 배열, 위치·이름 바인딩, 타입 왕복', async () => {
      const engine = await open();
      const one = engine.exec('SELECT 1 AS one, ? AS two', [2]);
      assert.deepEqual(one, { columns: ['one', 'two'], rows: [[1, 2]] });
      const named = engine.exec('SELECT :a AS a, :b AS b', { a: '가나다', b: null });
      assert.deepEqual(named.rows, [['가나다', null]]);
      const prefixed = engine.exec('SELECT :a AS a', { ':a': 7 });
      assert.deepEqual(prefixed.rows, [[7]]);

      await engine.transaction(() => {
        engine.run('CREATE TABLE t (i INTEGER, r REAL, s TEXT, b BLOB) STRICT');
        engine.run('INSERT INTO t VALUES (?, ?, ?, ?)', [
          2 ** 53 - 1,
          1.5,
          '수십만 자',
          new Uint8Array([1, 2, 3]),
        ]);
      });
      const row = engine.exec(
        'SELECT i, r, s, b, typeof(i), typeof(r), typeof(s), typeof(b) FROM t',
      ).rows[0];
      assert.ok(row);
      assert.equal(row[0], 2 ** 53 - 1);
      assert.equal(row[1], 1.5);
      assert.equal(row[2], '수십만 자');
      assert.deepEqual(Array.from(/** @type {Uint8Array} */ (row[3])), [1, 2, 3]);
      assert.deepEqual(row.slice(4), ['integer', 'real', 'text', 'blob']);
      await engine.close();
    });

    test('exec: 결과 1만 행 초과는 E_RESULT_TOO_LARGE, 1만 행은 허용', async () => {
      const engine = await open();
      const limit = engine.exec(
        'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT x FROM c',
        [MAX_RESULT_ROWS],
      );
      assert.equal(limit.rows.length, MAX_RESULT_ROWS);
      await expectAppError(
        () =>
          engine.exec(
            'WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT x FROM c',
            [MAX_RESULT_ROWS + 1],
          ),
        'E_RESULT_TOO_LARGE',
      );
      await engine.close();
    });

    test('exec: SQL 오류는 E_DB_QUERY이며 detail에 sql이 있다', async () => {
      const engine = await open();
      const err = await expectAppError(() => engine.exec('SELEC 1'), 'E_DB_QUERY');
      assert.match(err.message, /syntax error/);
      assert.equal(/** @type {{ sql: string }} */ (err.detail).sql, 'SELEC 1');
      await engine.close();
    });

    test('run: 트랜잭션 밖의 쓰기는 거부, 안에서는 changes·lastId', async () => {
      const engine = await open();
      await expectAppError(() => engine.run('CREATE TABLE t (a)'), 'E_DB_QUERY');
      const result = await engine.transaction(() => {
        engine.run('CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT) STRICT');
        engine.run('INSERT INTO t (a) VALUES (?)', ['x']);
        return engine.run('INSERT INTO t (a) VALUES (?)', ['y']);
      });
      assert.deepEqual(result, { changes: 1, lastId: 2 });
      await engine.close();
    });

    test('transaction: 실패 시 롤백, 중첩은 SAVEPOINT로 부분 롤백, 반환값 전달', async () => {
      const engine = await open();
      await engine.transaction(() => {
        engine.run('CREATE TABLE t (a INTEGER) STRICT');
      });
      await expectAppError(
        engine.transaction(() => {
          engine.run('INSERT INTO t VALUES (1)');
          throw new AppError('E_VALUE_INVALID', 'stop');
        }),
        'E_VALUE_INVALID',
      );
      assert.deepEqual(engine.exec('SELECT count(*) FROM t').rows, [[0]]);

      const value = await engine.transaction(async () => {
        engine.run('INSERT INTO t VALUES (1)');
        await expectAppError(
          engine.transaction(() => {
            engine.run('INSERT INTO t VALUES (2)');
            throw new Error('inner');
          }),
          'E_DB_QUERY',
        );
        engine.run('INSERT INTO t VALUES (3)');
        return 'done';
      });
      assert.equal(value, 'done');
      assert.deepEqual(engine.exec('SELECT a FROM t ORDER BY a').rows, [[1], [3]]);
      await engine.close();
    });

    test('runBatch: 1만 행이 하나의 트랜잭션, 중간 행 실패 주입 시 0행 삽입', async () => {
      const engine = await open();
      await engine.transaction(() => {
        engine.run('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL) STRICT');
      });
      const ok = Array.from({ length: MAX_BATCH_PARAMS }, (_, i) => [i + 1, `v${i}`]);
      /** @type {Array<[number, number]>} */
      const progress = [];
      const result = await engine.runBatch('INSERT INTO t VALUES (?, ?)', ok, {
        onProgress: (done, total) => progress.push([done, total]),
      });
      assert.equal(result.changes, MAX_BATCH_PARAMS);
      assert.equal(progress.at(-1)?.[0], MAX_BATCH_PARAMS);
      assert.deepEqual(engine.exec('SELECT count(*) FROM t').rows, [[MAX_BATCH_PARAMS]]);

      await engine.transaction(() => {
        engine.run('DELETE FROM t');
      });
      const bad = Array.from({ length: MAX_BATCH_PARAMS }, (_, i) => [
        i + 1,
        i === 5_000 ? null : `v${i}`,
      ]);
      const err = await expectAppError(
        engine.runBatch('INSERT INTO t VALUES (?, ?)', bad),
        'E_DB_QUERY',
      );
      assert.equal(/** @type {{ index: number }} */ (err.detail).index, 5_000);
      assert.deepEqual(engine.exec('SELECT count(*) FROM t').rows, [[0]]);
      await engine.close();
    });

    test('runBatch: 상한 초과는 E_BATCH_TOO_LARGE, 바깥 트랜잭션 안에서는 SAVEPOINT', async () => {
      const engine = await open();
      await engine.transaction(() => {
        engine.run('CREATE TABLE t (a INTEGER) STRICT');
      });
      await expectAppError(
        engine.runBatch(
          'INSERT INTO t VALUES (?)',
          Array.from({ length: MAX_BATCH_PARAMS + 1 }, () => [1]),
        ),
        'E_BATCH_TOO_LARGE',
      );
      await expectAppError(
        engine.runBatch('INSERT INTO t VALUES (?)', [['x'.repeat(40 * 1024 * 1024)]]),
        'E_BATCH_TOO_LARGE',
      );
      await expectAppError(
        engine.transaction(async () => {
          await engine.runBatch('INSERT INTO t VALUES (?)', [[1], [2]]);
          await expectAppError(
            engine.runBatch('INSERT INTO t VALUES (?)', [[3], ['bad']]),
            'E_DB_QUERY',
          );
          assert.deepEqual(engine.exec('SELECT count(*) FROM t').rows, [[2]]);
          throw new AppError('E_IMPORT_CANCELLED', 'cancel');
        }),
        'E_IMPORT_CANCELLED',
      );
      assert.deepEqual(engine.exec('SELECT count(*) FROM t').rows, [[0]]);
      await engine.close();
    });

    test('prepareCached: 핸들로 exec/run을 반복해도 결과가 같다', async () => {
      const engine = await open();
      await engine.transaction(() => {
        engine.run('CREATE TABLE t (a INTEGER) STRICT');
      });
      const insert = engine.prepareCached('INSERT INTO t VALUES (?)');
      const count = engine.prepareCached('SELECT count(*) FROM t');
      await engine.transaction(() => {
        for (let i = 0; i < 5; i += 1) engine.run(insert, [i]);
      });
      assert.deepEqual(engine.exec(count).rows, [[5]]);
      assert.deepEqual(engine.exec(count).rows, [[5]]);
      await engine.close();
    });

    test('interrupt: 진행 중인 runBatch를 다음 행에서 멈추고 롤백한다', async () => {
      const engine = await open();
      await engine.transaction(() => {
        engine.run('CREATE TABLE t (a INTEGER) STRICT');
      });
      const rows = Array.from({ length: 2_000 }, (_, i) => [i]);
      const err = await expectAppError(
        engine.runBatch('INSERT INTO t VALUES (?)', rows, {
          onProgress: (done) => {
            if (done === 500) engine.interrupt();
          },
        }),
        'E_DB_QUERY',
      );
      assert.equal(/** @type {{ reason: string }} */ (err.detail).reason, 'interrupted');
      assert.deepEqual(engine.exec('SELECT count(*) FROM t').rows, [[0]]);
      // 표식은 소비되었으므로 다음 배치는 정상이다.
      await engine.runBatch('INSERT INTO t VALUES (?)', rows.slice(0, 10));
      assert.deepEqual(engine.exec('SELECT count(*) FROM t').rows, [[10]]);
      await engine.close();
    });

    test('FTS5 trigram: 한글 부분 일치', async () => {
      const engine = await open();
      await engine.transaction(() => {
        engine.run("CREATE VIRTUAL TABLE f USING fts5(body, tokenize = 'trigram')");
        engine.run('INSERT INTO f VALUES (?)', ['서울특별시 강남구']);
        engine.run('INSERT INTO f VALUES (?)', ['부산광역시 해운대구']);
      });
      assert.deepEqual(engine.exec('SELECT body FROM f WHERE f MATCH ?', ['강남구']).rows, [
        ['서울특별시 강남구'],
      ]);
      await engine.close();
    });

    test('open/close: 닫힌 뒤 exec는 실패, 다시 열면 빈 DB', async () => {
      const engine = await open();
      await engine.transaction(() => {
        engine.run('CREATE TABLE t (a INTEGER) STRICT');
      });
      await engine.close();
      await expectAppError(() => engine.exec('SELECT 1'), 'E_DB_QUERY');
      await engine.open();
      assert.deepEqual(engine.exec("SELECT count(*) FROM sqlite_master WHERE name = 't'").rows, [
        [0],
      ]);
      await engine.close();
    });

    test('snapshot 왕복(persistence=snapshot): 테이블 생성 → snapshot → 새 엔진에 open → 같은 데이터', async () => {
      const engine = await open();
      if (engine.capabilities().persistence !== 'snapshot') {
        await expectAppError(() => engine.snapshot(), 'E_UNSUPPORTED');
        await engine.close();
        return;
      }
      await engine.transaction(() => {
        engine.run('CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT) STRICT');
        engine.run('INSERT INTO t (s) VALUES (?)', ['가'.repeat(100_000)]);
        engine.run('INSERT INTO t (s) VALUES (?)', ['b']);
      });
      const cached = engine.prepareCached('SELECT count(*) FROM t');
      const bytes = engine.snapshot();
      assert.ok(bytes instanceof Uint8Array);
      assert.equal(new TextDecoder().decode(bytes.subarray(0, 15)), 'SQLite format 3');
      // snapshot 뒤에도 캐시 핸들과 PRAGMA는 계속 쓸 수 있어야 한다.
      assert.deepEqual(engine.exec(cached).rows, [[2]]);
      assert.deepEqual(engine.exec('PRAGMA foreign_keys').rows, [[1]]);

      const reopened = await open(bytes);
      assert.deepEqual(reopened.exec('SELECT id, length(s) FROM t ORDER BY id').rows, [
        [1, 100_000],
        [2, 1],
      ]);
      await reopened.close();
      await engine.close();
    });

    test('open: SQLite 파일이 아닌 바이트는 E_FILE_NOT_SQLITE', async () => {
      const junk = new TextEncoder().encode('definitely not a database '.repeat(64));
      await expectAppError(open(junk), 'E_FILE_NOT_SQLITE');
    });
  });
}

defineEngineContract('wasm', openWasmEngine);
