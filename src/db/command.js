// @ts-check
/**
 * 커맨드 실행기(D-08). `do` 또는 `undo` 문장 목록을 하나의 트랜잭션으로 실행한다.
 *
 * 문장은 `{ sql, params }`이며, Step 3의 열 타입 변경이 더하는 `{ convert }` 단계는 이 파일의
 * `runConvert`가 처리한다. 커맨드는 구조화 복제 가능한 값이어야 한다(저널에 그대로 기록되고 Worker 경계를 넘는다).
 */
import { AppError } from '../util/errors.js';
import { quoteIdent } from './schema.js';
import { coerce, isLogicalType } from './values.js';

/** @typedef {import('./engine.js').Engine} Engine */
/** @typedef {import('./engine.js').SqlParams} SqlParams */
/** @typedef {import('./engine.js').SqlValue} SqlValue */
/** @typedef {import('./values.js').LogicalType} LogicalType */
/** @typedef {import('./values.js').CoercePolicy} CoercePolicy */
/** @typedef {import('./values.js').ColumnOptions} ColumnOptions */

/** @typedef {{ sql: string, params?: SqlParams }} SqlStatement */

/**
 * 열 타입 변경의 "변환 복사" 단계(D-08). `from` 열의 값을 `type`으로 검증·변환해 `to` 열에 쓴다.
 * @typedef {object} ConvertStep
 * @property {string} table 물리 테이블 이름
 * @property {string} from 원본 물리 열
 * @property {string} to 새 물리 열
 * @property {LogicalType} type 목표 논리 타입
 * @property {CoercePolicy} policy 변환 실패 값 정책
 * @property {ColumnOptions} [options] select 항목 등
 */
/** @typedef {{ convert: ConvertStep }} ConvertStatement */
/** @typedef {SqlStatement | ConvertStatement} Statement */

/** 변환 복사가 한 번에 읽는 행 수. `runBatch` 상한(1만)보다 작게 둔다. */
export const CONVERT_CHUNK_ROWS = 5_000;

/**
 * @typedef {object} Command
 * @property {string} type `<영역>.<동사>` (예: `table.create`)
 * @property {string | null} tableId 대상 테이블. 테이블 생성처럼 아직 없거나 전체에 걸치면 null
 * @property {Statement[]} do
 * @property {Statement[]} undo 비어 있으면 되돌릴 수 없는 커맨드(`irreversible`와 함께)
 * @property {string} summary 히스토리·저널 표시용 요약(i18n 키가 아니라 커맨드 종류와 대상 이름)
 * @property {boolean} [irreversible]
 */

/** @typedef {'do' | 'undo'} Direction */

/**
 * @typedef {object} ApplyContext
 * @property {AbortSignal} [signal]
 * @property {(progress: { phase: string, done: number, total: number }) => void} [progress]
 */

/**
 * @param {unknown} value
 * @returns {value is ConvertStep}
 */
function isConvertStep(value) {
  if (typeof value !== 'object' || value === null) return false;
  const v = /** @type {Record<string, unknown>} */ (value);
  return (
    typeof v.table === 'string' &&
    typeof v.from === 'string' &&
    typeof v.to === 'string' &&
    isLogicalType(v.type) &&
    (v.policy === 'null' || v.policy === 'abort')
  );
}

/**
 * @param {unknown} value
 * @returns {value is Statement}
 */
export function isStatement(value) {
  if (typeof value !== 'object' || value === null) return false;
  const v = /** @type {Record<string, unknown>} */ (value);
  if ('convert' in v) return isConvertStep(v.convert);
  return typeof v.sql === 'string';
}

/**
 * Worker 경계를 넘어온 값이 커맨드 형태인지 확인한다.
 * @param {unknown} value
 * @returns {value is Command}
 */
export function isCommand(value) {
  if (typeof value !== 'object' || value === null) return false;
  const v = /** @type {Record<string, unknown>} */ (value);
  return (
    typeof v.type === 'string' &&
    (typeof v.tableId === 'string' || v.tableId === null) &&
    Array.isArray(v.do) &&
    v.do.every(isStatement) &&
    Array.isArray(v.undo) &&
    v.undo.every(isStatement) &&
    typeof v.summary === 'string'
  );
}

/**
 * @param {unknown} value
 * @returns {Command}
 */
export function assertCommand(value) {
  if (!isCommand(value)) {
    throw new AppError('E_DB_QUERY', 'malformed command', {
      detail: { type: typeof value === 'object' && value !== null ? 'object' : typeof value },
    });
  }
  return value;
}

/**
 * @typedef {object} ApplyResult
 * @property {number} affected 변경된 행 수의 합(DDL은 0)
 * @property {number} [nulled] 변환 복사에서 NULL이 된 값의 수(변환 단계가 있을 때만)
 */

/**
 * 변환 복사(Step 3 예외 처리): 5,000행씩 읽어 JS에서 검증·변환하고 `runBatch`로 갱신한다.
 * 바깥 트랜잭션 안에서 실행되며(runBatch는 SAVEPOINT), 취소는 청크 사이에서 확인한다.
 * 10만 행 이상에서도 진행률을 보내므로 UI가 표시·취소할 수 있다.
 * @param {Engine} engine
 * @param {ConvertStep} step
 * @param {ApplyContext} ctx
 * @returns {Promise<{ rows: number, nulled: number }>}
 */
export async function runConvert(engine, step, ctx) {
  const table = quoteIdent(step.table);
  const from = quoteIdent(step.from);
  const to = quoteIdent(step.to);
  const total = Number(engine.exec(`SELECT count(*) FROM ${table}`).rows[0]?.[0] ?? 0);
  // 커서(`id > ?`)에는 "아직 아무것도 읽지 않음"을 뜻하는 값이 없다. rowid는 음수일 수 있으므로
  // 0 같은 시작값을 두면 그 아래 행이 통째로 빠진다. 첫 청크만 커서 없는 문장으로 읽는다.
  const selectFirst = engine.prepareCached(
    `SELECT "id", ${from} FROM ${table} ORDER BY "id" LIMIT ${CONVERT_CHUNK_ROWS}`,
  );
  const selectNext = engine.prepareCached(
    `SELECT "id", ${from} FROM ${table} WHERE "id" > ? ORDER BY "id" LIMIT ${CONVERT_CHUNK_ROWS}`,
  );
  const update = engine.prepareCached(`UPDATE ${table} SET ${to} = ? WHERE "id" = ?`);
  /**
   * 마지막으로 읽은 행의 id. 아직 아무것도 읽지 않았으면 null.
   * @type {number | null}
   */
  let lastId = null;
  let rows = 0;
  let nulled = 0;
  ctx.progress?.({ phase: 'convert', done: 0, total });
  for (;;) {
    if (ctx.signal?.aborted) {
      throw new AppError('E_IMPORT_CANCELLED', 'type change cancelled', {
        detail: { table: step.table, done: rows, total },
      });
    }
    /** @type {SqlValue[][]} */
    const chunk =
      lastId === null ? engine.exec(selectFirst).rows : engine.exec(selectNext, [lastId]).rows;
    if (chunk.length === 0) break;
    /** @type {SqlValue[][]} */
    const params = [];
    for (const row of chunk) {
      const id = Number(row[0]);
      const raw = /** @type {import('./values.js').RawValue} */ (row[1]);
      /** @type {SqlValue} */
      let value;
      try {
        value = coerce(step.type, raw, step.policy, step.options);
      } catch (err) {
        if (err instanceof AppError && err.code === 'E_VALUE_INVALID') {
          err.detail = { ...(typeof err.detail === 'object' ? err.detail : {}), rowId: id };
        }
        throw err;
      }
      if (value === null && raw !== null && raw !== undefined) nulled += 1;
      params.push([value, id]);
      lastId = id;
    }
    await engine.runBatch(update, params);
    rows += chunk.length;
    ctx.progress?.({ phase: 'convert', done: rows, total });
  }
  return { rows, nulled };
}

/**
 * 커맨드를 한 방향으로 적용한다. 한 문장이라도 실패하면 전체를 롤백한다.
 * @param {Engine} engine
 * @param {Command} cmd
 * @param {Direction} [direction]
 * @param {ApplyContext} [ctx]
 * @returns {Promise<ApplyResult>}
 */
export async function applyCommand(engine, cmd, direction = 'do', ctx = {}) {
  const statements = direction === 'undo' ? cmd.undo : cmd.do;
  if (direction === 'undo' && (cmd.irreversible || statements.length === 0)) {
    throw new AppError('E_UNDO_LIMIT', `command ${cmd.type} cannot be undone`, {
      detail: { type: cmd.type },
    });
  }
  return engine.transaction(async () => {
    /** @type {ApplyResult} */
    const result = { affected: 0 };
    for (let i = 0; i < statements.length; i += 1) {
      if (ctx.signal?.aborted) {
        throw new AppError('E_IMPORT_CANCELLED', 'command cancelled', {
          detail: { type: cmd.type, index: i },
        });
      }
      const statement = statements[i];
      if (!statement) continue;
      if ('convert' in statement) {
        const converted = await runConvert(engine, statement.convert, ctx);
        result.affected += converted.rows;
        result.nulled = (result.nulled ?? 0) + converted.nulled;
      } else {
        result.affected += engine.run(statement.sql, statement.params).changes;
      }
    }
    return result;
  });
}
