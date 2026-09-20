// @ts-check
/**
 * 브라우저 모드 엔진: 공식 SQLite Wasm(D-02) 위의 `Engine` 구현.
 *
 * - DB는 항상 메모리 DB다. `open(bytes)`는 `sqlite3_deserialize`, `snapshot()`은 `sqlite3_js_db_export`.
 * - `sqlite3` 객체를 만지는 코드는 이 파일뿐이다(CLAUDE.md 4장).
 * - wasm 모듈은 스레드당 한 번만 초기화하고 여러 엔진 인스턴스가 공유한다(중복 인스턴스화는 메모리 2배).
 */
import sqlite3InitModule from '../../vendor/sqlite3.mjs';
import { GB, MB } from '../util/bytes.js';
import { AppError, toAppError } from '../util/errors.js';

/** @typedef {import('./engine.js').Engine} Engine */
/** @typedef {import('./engine.js').EngineInfo} EngineInfo */
/** @typedef {import('./engine.js').SqlParams} SqlParams */
/** @typedef {import('./engine.js').SqlSource} SqlSource */
/** @typedef {import('./engine.js').SqlValue} SqlValue */
/** @typedef {import('../../vendor/sqlite3.mjs').Sqlite3Static} Sqlite3Static */
/** @typedef {import('../../vendor/sqlite3.mjs').Database} Database */
/** @typedef {import('../../vendor/sqlite3.mjs').PreparedStatement} PreparedStatement */

/** D-15: wasm 모드의 파일 크기 상한. UI는 이 숫자를 직접 알지 못하고 `capabilities()`로 읽는다. */
export const WASM_WARN_FILE_BYTES = 700 * MB;
export const WASM_MAX_FILE_BYTES = 1.5 * GB;

/** prepared statement 캐시 크기. 넘치면 가장 오래 쓰지 않은 것을 finalize한다. */
const STATEMENT_CACHE_SIZE = 64;
/** `runBatch` 진행률 콜백 간격(행). 시간 간격 조절은 Worker가 한다. */
const BATCH_PROGRESS_EVERY = 500;

/**
 * Emscripten 모듈 설정 중 이 엔진이 쓰는 항목. 상류 타입 선언은 인자를 받지 않는 것으로 되어 있어 여기서 좁혀 쓴다.
 * @typedef {object} Sqlite3InitConfig
 * @property {ArrayBuffer | Uint8Array} wasmBinary
 * @property {(name: string) => string} locateFile
 * @property {(...args: unknown[]) => void} print
 * @property {(...args: unknown[]) => void} printErr
 */

const initSqlite3 = /** @type {(config: Sqlite3InitConfig) => Promise<Sqlite3Static>} */ (
  /** @type {unknown} */ (sqlite3InitModule)
);

/** @type {Promise<Sqlite3Static> | null} */
let sqlite3Promise = null;

/**
 * wasm 모듈을 스레드당 한 번 초기화한다.
 * 번들 안에서는 `import.meta.url`이 비어 있으므로 `locateFile`을 넘겨 별도 파일 요청을 막는다(D-02).
 * @param {ArrayBuffer | Uint8Array} wasmBinary
 * @returns {Promise<Sqlite3Static>}
 */
function loadSqlite3(wasmBinary) {
  if (!sqlite3Promise) {
    sqlite3Promise = initSqlite3({
      wasmBinary,
      locateFile: (name) => name,
      print: () => {},
      printErr: () => {},
    }).catch((err) => {
      sqlite3Promise = null;
      throw new AppError('E_ENV_NO_WASM', 'failed to instantiate SQLite Wasm', { cause: err });
    });
  }
  return sqlite3Promise;
}

/**
 * 이름 바인딩 키에 접두사가 없으면 `:`를 붙인다. sqlite3 oo1은 접두사가 포함된 키만 받는다.
 * @param {SqlParams} params
 * @returns {SqlParams}
 */
function normalizeParams(params) {
  if (Array.isArray(params)) return params;
  /** @type {Record<string, SqlValue>} */
  const out = {};
  for (const [key, value] of Object.entries(params)) {
    out[/^[:$@]/.test(key) ? key : `:${key}`] = value;
  }
  return out;
}

/**
 * sqlite3 예외를 AppError로 바꾼다. 결과 코드 26(SQLITE_NOTADB)은 파일이 SQLite가 아닌 경우다.
 * @param {unknown} err
 * @param {string} sql
 * @param {Record<string, unknown>} [extra]
 * @returns {AppError}
 */
function toQueryError(err, sql, extra = {}) {
  if (err instanceof AppError) return err;
  const resultCode =
    typeof err === 'object' && err !== null && 'resultCode' in err
      ? Number(err.resultCode)
      : undefined;
  const message = err instanceof Error ? err.message : String(err);
  const detail = { sql: sql.slice(0, 200), resultCode, ...extra };
  if (resultCode === 26) {
    return new AppError('E_FILE_NOT_SQLITE', message, { cause: err, detail });
  }
  if (resultCode === 7) {
    return new AppError('E_MEM', message, { cause: err, detail });
  }
  return new AppError('E_DB_QUERY', message, { cause: err, detail });
}

/**
 * @typedef {object} WasmEngineOptions
 * @property {number} maxResultRows `exec` 결과 행 상한. `engine.js`의 `MAX_RESULT_ROWS`를 `selectEngine`이 넘긴다
 */

/**
 * `engine.js`가 `selectEngine('wasm')`에서 만든다. 상한 값은 인자로 받아 이 파일이 `engine.js`를 import하지 않게 한다(순환 방지).
 * `runBatch`의 목록 크기 상한은 `engine.js`의 공통 래퍼가 검사한다.
 * @param {WasmEngineOptions} options
 * @returns {Engine}
 */
export function createWasmEngine(options) {
  const { maxResultRows } = options;
  /** @type {Sqlite3Static | null} */
  let sqlite3 = null;
  /** @type {Database | null} */
  let db = null;
  /** @type {EngineInfo | null} */
  let info = null;
  /** @type {Map<string, PreparedStatement>} 삽입 순서 = LRU 순서 */
  const cache = new Map();
  let txDepth = 0;
  let interrupted = false;

  /** @returns {Database} */
  function requireDb() {
    if (!db) throw new AppError('E_DB_QUERY', 'database is not open');
    return db;
  }

  /** @returns {Sqlite3Static} */
  function requireSqlite3() {
    if (!sqlite3) throw new AppError('E_DB_QUERY', 'engine is not initialized');
    return sqlite3;
  }

  function clearStatementCache() {
    for (const stmt of cache.values()) {
      try {
        stmt.finalize();
      } catch {
        // 이미 finalize된 statement는 무시해도 안전하다. DB를 닫는 경로에서만 발생한다.
      }
    }
    cache.clear();
  }

  /**
   * 캐시에서 statement를 꺼내거나 새로 준비한다. 꺼낸 statement는 호출자가 reset한다.
   * @param {SqlSource} source
   * @returns {PreparedStatement}
   */
  function acquire(source) {
    const sql = typeof source === 'string' ? source : source.sql;
    const cached = cache.get(sql);
    if (cached) {
      cache.delete(sql);
      cache.set(sql, cached);
      return cached;
    }
    /** @type {PreparedStatement} */
    let stmt;
    try {
      stmt = requireDb().prepare(sql);
    } catch (err) {
      throw toQueryError(err, sql);
    }
    cache.set(sql, stmt);
    if (cache.size > STATEMENT_CACHE_SIZE) {
      const oldestKey = cache.keys().next().value;
      if (oldestKey !== undefined) {
        const oldest = cache.get(oldestKey);
        cache.delete(oldestKey);
        oldest?.finalize();
      }
    }
    return stmt;
  }

  /**
   * @param {PreparedStatement} stmt
   */
  function release(stmt) {
    try {
      stmt.reset();
      stmt.clearBindings();
    } catch {
      // oo1의 reset()은 직전 step()의 결과 코드를 다시 검사하므로 쓰기가 실패하면 항상 던진다.
      // 캐시에서 빼고 finalize한다. 빼기만 하면 실패한 문장마다 sqlite3_stmt가 남는다.
      for (const [key, value] of cache) {
        if (value === stmt) cache.delete(key);
      }
      try {
        stmt.finalize();
      } catch {
        // 이미 finalize된 statement는 무시해도 안전하다.
      }
    }
  }

  /**
   * @param {PreparedStatement} stmt
   * @param {SqlParams | undefined} params
   */
  function bind(stmt, params) {
    if (params === undefined) return;
    // 빈 목록은 바인딩할 것이 없다. oo1의 bind()는 빈 값을 받으면 던지므로 여기서 걸러낸다.
    // 호출자가 파라미터를 조건부로 모으면 빈 배열뿐 아니라 빈 객체도 나온다.
    const empty = Array.isArray(params) ? params.length === 0 : Object.keys(params).length === 0;
    if (empty) return;
    stmt.bind(normalizeParams(params));
  }

  /** @param {string} sql */
  function execRaw(sql) {
    try {
      requireDb().exec(sql);
    } catch (err) {
      throw toQueryError(err, sql);
    }
  }

  function applyPragmas() {
    // 새 PRAGMA는 여기에만 추가한다. snapshot() 뒤에 다시 적용된다.
    execRaw('PRAGMA foreign_keys = ON');
    execRaw('PRAGMA temp_store = MEMORY');
    execRaw('PRAGMA cache_size = -8000');
  }

  /** @type {Engine} */
  const engine = {
    async init(opts) {
      if (!opts.wasmBinary) {
        throw new AppError('E_ENV_NO_WASM', 'wasm engine requires wasmBinary');
      }
      sqlite3 = await loadSqlite3(opts.wasmBinary);
      const probe = new sqlite3.oo1.DB(':memory:');
      try {
        const version = String(probe.selectValue('SELECT sqlite_version()'));
        const compileOptions = probe.selectValues('PRAGMA compile_options').map((v) => String(v));
        info = { sqliteVersion: version, compileOptions };
      } finally {
        probe.close();
      }
      return info;
    },

    capabilities() {
      return {
        mode: 'wasm',
        maxFileBytes: WASM_MAX_FILE_BYTES,
        warnFileBytes: WASM_WARN_FILE_BYTES,
        persistence: 'snapshot',
        cancellable: true,
        fts5: info?.compileOptions.includes('ENABLE_FTS5') ?? false,
      };
    },

    async open(source) {
      const lib = requireSqlite3();
      if (source !== undefined && !(source instanceof Uint8Array)) {
        throw new AppError('E_UNSUPPORTED', 'wasm engine opens bytes, not a path', {
          detail: { source: typeof source },
        });
      }
      if (source && source.byteLength > WASM_MAX_FILE_BYTES) {
        throw new AppError(
          'E_FILE_TOO_LARGE',
          `file is ${source.byteLength} bytes, limit ${WASM_MAX_FILE_BYTES}`,
          {
            detail: { bytes: source.byteLength, limit: WASM_MAX_FILE_BYTES },
          },
        );
      }
      await engine.close();
      const next = new lib.oo1.DB(':memory:');
      try {
        if (source) {
          const ptr = lib.wasm.allocFromTypedArray(source);
          const flags =
            lib.capi.SQLITE_DESERIALIZE_FREEONCLOSE | lib.capi.SQLITE_DESERIALIZE_RESIZEABLE;
          const rc = lib.capi.sqlite3_deserialize(
            next.pointer ?? 0,
            'main',
            ptr,
            source.byteLength,
            source.byteLength,
            flags,
          );
          next.checkRc(rc);
          // deserialize는 바이트를 검사하지 않으므로 헤더가 틀린 파일은 첫 읽기에서 SQLITE_NOTADB로 드러난다.
          next.selectValue('SELECT count(*) FROM sqlite_master');
        }
        db = next;
        txDepth = 0;
        interrupted = false;
        applyPragmas();
      } catch (err) {
        next.close();
        db = null;
        throw toQueryError(err, 'open');
      }
    },

    async close() {
      if (!db) return;
      clearStatementCache();
      const closing = db;
      db = null;
      txDepth = 0;
      closing.close();
    },

    exec(sql, params) {
      const stmt = acquire(sql);
      const sqlText = typeof sql === 'string' ? sql : sql.sql;
      try {
        // `run()`과 같은 규칙(CLAUDE.md 5.3): DB 파일을 바꾸는 문장은 트랜잭션 안에서만.
        // sqlite3_stmt_readonly는 SELECT·읽기 PRAGMA·트랜잭션 제어에는 참, DDL·DML·대입형 PRAGMA에는 거짓이다.
        if (txDepth === 0 && requireSqlite3().capi.sqlite3_stmt_readonly(stmt) === 0) {
          throw new AppError('E_DB_QUERY', 'write outside transaction', {
            detail: { sql: sqlText.slice(0, 200) },
          });
        }
        bind(stmt, params);
        // 결과 열이 없는 문장(DDL, 대입형 PRAGMA)에서 getColumnNames()는 "Column index 0 is out of
        // range"로 던진다. 열 개수를 먼저 보고 빈 결과로 돌려준다.
        const columns = stmt.columnCount > 0 ? stmt.getColumnNames() : [];
        /** @type {SqlValue[][]} */
        const rows = [];
        while (stmt.step()) {
          if (rows.length >= maxResultRows) {
            throw new AppError('E_RESULT_TOO_LARGE', `result exceeds ${maxResultRows} rows`, {
              detail: { limit: maxResultRows, sql: sqlText.slice(0, 200) },
            });
          }
          rows.push(/** @type {SqlValue[]} */ (stmt.get([])));
        }
        return { columns, rows };
      } catch (err) {
        throw toQueryError(err, sqlText);
      } finally {
        release(stmt);
      }
    },

    run(sql, params) {
      if (txDepth === 0) {
        throw new AppError('E_DB_QUERY', 'write outside transaction', {
          detail: { sql: (typeof sql === 'string' ? sql : sql.sql).slice(0, 200) },
        });
      }
      const database = requireDb();
      const stmt = acquire(sql);
      const sqlText = typeof sql === 'string' ? sql : sql.sql;
      try {
        bind(stmt, params);
        stmt.step();
        const lib = requireSqlite3();
        return {
          changes: database.changes(),
          lastId: Number(lib.capi.sqlite3_last_insert_rowid(database)),
        };
      } catch (err) {
        throw toQueryError(err, sqlText);
      } finally {
        release(stmt);
      }
    },

    async runBatch(sql, paramsList, options = {}) {
      const database = requireDb();
      const sqlText = typeof sql === 'string' ? sql : sql.sql;
      // 취소 표식은 배치가 소비할 때만 지운다. 배치 진입 시 지우면 취소 결정과 배치 시작 사이에
      // 들어온 interrupt()가 사라진다.
      if (interrupted) {
        interrupted = false;
        throw new AppError('E_DB_QUERY', 'runBatch interrupted', {
          detail: { index: 0, reason: 'interrupted' },
        });
      }
      const before = database.changes(true);
      await engine.transaction(() => {
        const stmt = acquire(sql);
        try {
          for (let i = 0; i < paramsList.length; i += 1) {
            if (interrupted) {
              interrupted = false;
              throw new AppError('E_DB_QUERY', 'runBatch interrupted', {
                detail: { index: i, reason: 'interrupted' },
              });
            }
            try {
              bind(stmt, paramsList[i]);
              stmt.step();
              stmt.reset();
              stmt.clearBindings();
            } catch (err) {
              throw toQueryError(err, sqlText, { index: i });
            }
            if (options.onProgress && (i + 1) % BATCH_PROGRESS_EVERY === 0) {
              options.onProgress(i + 1, paramsList.length);
            }
          }
        } finally {
          release(stmt);
        }
      });
      if (options.onProgress) options.onProgress(paramsList.length, paramsList.length);
      return { changes: database.changes(true) - before };
    },

    async transaction(fn) {
      requireDb();
      const depth = txDepth;
      const savepoint = `jdr_sp_${depth}`;
      execRaw(depth === 0 ? 'BEGIN' : `SAVEPOINT ${savepoint}`);
      txDepth += 1;
      try {
        const result = await fn();
        execRaw(depth === 0 ? 'COMMIT' : `RELEASE ${savepoint}`);
        return result;
      } catch (err) {
        try {
          execRaw(depth === 0 ? 'ROLLBACK' : `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
        } catch (rollbackErr) {
          throw new AppError('E_DB_QUERY', 'rollback failed after error', {
            cause: rollbackErr,
            detail: { original: err instanceof Error ? err.message : String(err) },
          });
        }
        throw toAppError(err, 'E_DB_QUERY');
      } finally {
        txDepth -= 1;
      }
    },

    prepareCached(sql) {
      acquire(sql);
      return { sql };
    },

    snapshot() {
      const lib = requireSqlite3();
      const database = requireDb();
      if (txDepth > 0) {
        throw new AppError('E_DB_QUERY', 'snapshot inside transaction');
      }
      clearStatementCache();
      /** @type {Uint8Array} */
      let bytes;
      try {
        bytes = lib.capi.sqlite3_js_db_export(database);
      } catch (err) {
        throw toQueryError(err, 'snapshot');
      }
      applyPragmas();
      return bytes;
    },

    async saveTo() {
      throw new AppError('E_UNSUPPORTED', 'saveTo is native-only; use snapshot() in wasm mode');
    },

    interrupt() {
      // 단일 스레드라 실행 중인 문장 도중에 호출될 수는 없다. 다음 runBatch 행 사이에서 확인하는
      // 취소 표식이며, sqlite3_interrupt는 실행 중인 문장이 없으면 no-op이다.
      interrupted = true;
      if (db && sqlite3) sqlite3.capi.sqlite3_interrupt(db);
    },

    applyPragmas,
  };

  return engine;
}
