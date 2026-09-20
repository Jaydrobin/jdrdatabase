// @ts-check
/**
 * 커맨드 실행기(D-08). `do` 또는 `undo` 문장 목록을 하나의 트랜잭션으로 실행한다.
 *
 * 문장은 `{ sql, params }`이며, Step 3의 열 타입 변경이 더하는 `{ convert }` 단계는 이 파일의
 * `runConvert`가 처리한다. 커맨드는 구조화 복제 가능한 값이어야 한다(저널에 그대로 기록되고 Worker 경계를 넘는다).
 */
import { AppError } from '../util/errors.js';

/** @typedef {import('./engine.js').Engine} Engine */
/** @typedef {import('./engine.js').SqlParams} SqlParams */

/** @typedef {{ sql: string, params?: SqlParams }} SqlStatement */
/** @typedef {SqlStatement} Statement */

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
 * @returns {value is Statement}
 */
export function isStatement(value) {
  if (typeof value !== 'object' || value === null) return false;
  const v = /** @type {Record<string, unknown>} */ (value);
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
 * 커맨드를 한 방향으로 적용한다. 한 문장이라도 실패하면 전체를 롤백한다.
 * @param {Engine} engine
 * @param {Command} cmd
 * @param {Direction} [direction]
 * @param {ApplyContext} [ctx]
 * @returns {Promise<{ affected: number }>}
 */
export async function applyCommand(engine, cmd, direction = 'do', ctx = {}) {
  const statements = direction === 'undo' ? cmd.undo : cmd.do;
  if (direction === 'undo' && (cmd.irreversible || statements.length === 0)) {
    throw new AppError('E_UNDO_LIMIT', `command ${cmd.type} cannot be undone`, {
      detail: { type: cmd.type },
    });
  }
  return engine.transaction(async () => {
    let affected = 0;
    for (let i = 0; i < statements.length; i += 1) {
      if (ctx.signal?.aborted) {
        throw new AppError('E_IMPORT_CANCELLED', 'command cancelled', {
          detail: { type: cmd.type, index: i },
        });
      }
      const statement = statements[i];
      if (!statement) continue;
      affected += engine.run(statement.sql, statement.params).changes;
    }
    return { affected };
  });
}
