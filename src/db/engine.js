// @ts-check
/**
 * 엔진 인터페이스(D-15)와 모드별 구현 선택, 공통 검증.
 *
 * `engine-wasm.js`·`engine-native.js` 외의 모듈은 이 파일의 `Engine` 인터페이스만 호출한다.
 * 모드 문자열 비교는 이 파일의 `selectEngine`과 `main.js`에서만 한다(CLAUDE.md 5.3).
 */
import { estimateCloneBytes, MB } from '../util/bytes.js';
import { AppError } from '../util/errors.js';
import { createWasmEngine } from './engine-wasm.js';

/** 읽기 결과 행 수 상한. 넘으면 `E_RESULT_TOO_LARGE`(창 질의만 허용, 전체 SELECT 금지). */
export const MAX_RESULT_ROWS = 10_000;
/** `runBatch` 파라미터 목록 길이 상한. */
export const MAX_BATCH_PARAMS = 10_000;
/** `runBatch` 파라미터 목록의 직렬화 크기 상한(바이트). */
export const MAX_BATCH_BYTES = 64 * MB;

/** @typedef {'wasm' | 'native'} EngineMode */
/** @typedef {number | bigint | string | null | Uint8Array} SqlValue */
/** @typedef {SqlValue[] | Record<string, SqlValue>} SqlParams 위치(`?`) 또는 이름(`:name`) 바인딩 */
/** @typedef {{ columns: string[], rows: SqlValue[][] }} ExecResult */
/** @typedef {{ changes: number, lastId: number }} RunResult */
/** @typedef {{ changes: number }} BatchResult */
/** @typedef {{ sql: string }} StatementHandle `prepareCached`가 돌려주는 불투명 핸들 */
/** @typedef {string | StatementHandle} SqlSource */

/**
 * @typedef {object} EngineCapabilities
 * @property {EngineMode} mode
 * @property {number} maxFileBytes 이보다 큰 파일은 거부(`E_FILE_TOO_LARGE`). native는 Infinity
 * @property {number} warnFileBytes 이보다 큰 파일은 경고 후 계속. native는 Infinity
 * @property {'snapshot' | 'native'} persistence 저장 방식: `snapshot()` 바이트 쓰기 / `saveTo()` 네이티브 저장
 * @property {boolean} cancellable 긴 op(가져오기 등)를 배치 사이에서 취소할 수 있는가
 * @property {boolean} fts5 FTS5 모듈 사용 가능 여부
 */

/**
 * @typedef {object} EngineInfo
 * @property {string} sqliteVersion `sqlite_version()`
 * @property {string[]} compileOptions `PRAGMA compile_options`
 */

/**
 * @typedef {object} BatchOptions
 * @property {(done: number, total: number) => void} [onProgress] 진행률 콜백. 호출 간격 조절은 호출자(Worker) 몫
 */

/**
 * 두 모드가 공유하는 엔진 인터페이스(D-15). 구현체는 이 형태의 객체를 돌려준다.
 * @typedef {object} Engine
 * @property {(opts: { wasmBinary?: ArrayBuffer | Uint8Array }) => Promise<EngineInfo>} init 초기화. wasm: `{ wasmBinary }`, native: `{}`
 * @property {() => EngineCapabilities} capabilities
 * @property {(source?: Uint8Array | { originalPath: string }) => Promise<void>} open wasm: 바이트(없으면 빈 DB) / native: 원본 경로
 * @property {() => Promise<void>} close
 * @property {(sql: SqlSource, params?: SqlParams) => ExecResult} exec 읽기. 결과 1만 행 초과 거부
 * @property {(sql: SqlSource, params?: SqlParams) => RunResult} run 쓰기 한 문장. `transaction()` 안에서만 허용
 * @property {(sql: SqlSource, paramsList: SqlParams[], options?: BatchOptions) => Promise<BatchResult>} runBatch 같은 문장을 파라미터 목록만큼 반복. 하나의 트랜잭션(중첩 시 SAVEPOINT)
 * @property {<T>(fn: () => Promise<T> | T) => Promise<T>} transaction BEGIN / COMMIT / ROLLBACK. 중첩은 SAVEPOINT
 * @property {(sql: string) => StatementHandle} prepareCached wasm 전용 최적화. native는 no-op 핸들
 * @property {() => Uint8Array<ArrayBuffer>} snapshot wasm: DB 바이트(statement 캐시 무효화·PRAGMA 재적용 포함) / native: `E_UNSUPPORTED`
 * @property {(originalPath: string, expected: { mtime: number, size: number }) => Promise<void>} saveTo native 전용. wasm은 `E_UNSUPPORTED`
 * @property {() => void} interrupt 진행 중 문장 중단
 * @property {() => void} applyPragmas 새 PRAGMA는 이곳에만 추가한다(export 후 재적용되는 유일한 장소)
 */

/**
 * `runBatch` 인자를 상한과 비교한다. 두 구현이 같은 규칙을 쓰도록 여기서만 정의한다.
 * @param {SqlParams[]} paramsList
 */
export function assertBatchWithinLimits(paramsList) {
  if (!Array.isArray(paramsList)) {
    throw new AppError('E_DB_QUERY', 'runBatch paramsList must be an array');
  }
  if (paramsList.length > MAX_BATCH_PARAMS) {
    throw new AppError(
      'E_BATCH_TOO_LARGE',
      `runBatch paramsList length ${paramsList.length} exceeds ${MAX_BATCH_PARAMS}`,
      {
        detail: { length: paramsList.length, limit: MAX_BATCH_PARAMS },
      },
    );
  }
  const bytes = estimateCloneBytes(paramsList);
  if (bytes > MAX_BATCH_BYTES) {
    throw new AppError(
      'E_BATCH_TOO_LARGE',
      `runBatch payload ~${bytes} bytes exceeds ${MAX_BATCH_BYTES}`,
      {
        detail: { bytes, limit: MAX_BATCH_BYTES },
      },
    );
  }
}

/**
 * 읽기 결과가 상한을 넘으면 던진다. 구현은 스텝 중에 이 검사를 직접 수행해 메모리를 아끼고,
 * 이 래퍼는 구현이 검사를 빠뜨렸을 때의 최종 방어선이다.
 * @param {number} rowCount
 */
export function assertResultWithinLimit(rowCount) {
  if (rowCount > MAX_RESULT_ROWS) {
    throw new AppError(
      'E_RESULT_TOO_LARGE',
      `result has ${rowCount} rows, limit ${MAX_RESULT_ROWS}`,
      {
        detail: { rows: rowCount, limit: MAX_RESULT_ROWS },
      },
    );
  }
}

/**
 * 구현체를 공통 검증으로 감싼다.
 * @param {Engine} impl
 * @returns {Engine}
 */
export function withCommonChecks(impl) {
  return {
    ...impl,
    exec(sql, params) {
      const result = impl.exec(sql, params);
      assertResultWithinLimit(result.rows.length);
      return result;
    },
    async runBatch(sql, paramsList, options) {
      assertBatchWithinLimits(paramsList);
      return impl.runBatch(sql, paramsList, options);
    },
  };
}

/**
 * 모드에 맞는 엔진 구현을 만든다. 네이티브 구현은 Step 11에서 추가된다.
 * @param {EngineMode} mode
 * @returns {Engine}
 */
export function selectEngine(mode) {
  if (mode === 'wasm')
    return withCommonChecks(createWasmEngine({ maxResultRows: MAX_RESULT_ROWS }));
  if (mode === 'native') {
    throw new AppError('E_UNSUPPORTED', 'native engine is not available yet (Step 11)', {
      detail: { mode },
    });
  }
  throw new AppError('E_UNSUPPORTED', `unknown engine mode: ${String(mode)}`, { detail: { mode } });
}
