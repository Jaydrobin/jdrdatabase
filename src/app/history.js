// @ts-check
/**
 * undo/redo 스택(D-08, Step 5)과 저널 연동.
 *
 * - 데이터 커맨드는 `apply()`로 들어온다(`command.apply` → 스토어 기록 → push).
 * - 스키마 커맨드는 Worker가 적용해 스토어가 기록하므로 스토어의 `onCommand` 알림으로 들어온다.
 * - 되돌리기는 `command.apply`를 `undo` 방향으로 부르고, 저널에는 역커맨드(`commands.invert`)를 기록한다.
 *   저널 재생은 항상 `do` 방향이므로 재생 결과가 사용자가 마지막으로 본 상태와 같다.
 * - 되돌릴 수 없는 커맨드(`irreversible`, `undo`가 빈 것)가 들어오거나 데이터베이스 정리가 끝나면(`cleanup:done`) 스택을 비운다.
 * - "+ 열" 직후 이름 편집기의 확정(`mergeWithAdd`)은 스택 맨 위가 같은 열의 추가일 때만 그 항목과 합친다(D-16).
 * - 적용·되돌리기·다시 실행은 먼저 시작한 스키마 op가 끝나 스택에 들어간 뒤에 돈다(`store.schemaIdle`). 스키마 op는
 *   히스토리 큐 밖에서 돌므로, 기다리지 않으면 스택 순서가 Worker의 적용 순서와 어긋난다.
 *   두 커맨드는 저널에 이미 따로 기록되어 있고, 합친 항목을 되돌리면 그 역커맨드가 기록되므로 재생이 맞다.
 * - 실패한 되돌리기·다시 실행은 히스토리에서 제거하고 그리드가 다시 읽게 한다(Step 5 예외 처리).
 *   Worker는 문장 목록을 하나의 트랜잭션으로 실행하므로 DB는 실패 전 상태다. 다만 `E_DB_BUSY`는
 *   엔진에 닿기 전의 거절이라(6장 배타 규칙) DB도 히스토리도 건드릴 이유가 없다.
 * - `command.apply`는 배타 op다. 적용·되돌리기·다시 실행이 겹치면 나중 것이 `E_DB_BUSY`로 거절되므로
 *   히스토리가 보내는 호출은 큐 하나로 차례를 지킨다. 저널 기록도 같은 차례를 따른다.
 */
import { invert, mergeCommands } from './commands.js';
import { toAppError } from '../util/errors.js';

/** @typedef {import('./store.js').Store} Store */
/** @typedef {import('../db/client.js').Client} Client */
/** @typedef {import('../db/command.js').Command} Command */
/** @typedef {import('../db/command.js').ApplyResult} ApplyResult */
/** @typedef {import('../util/errors.js').AppError} AppError */
/** @typedef {import('../i18n/index.js').MessageKey} MessageKey */
/** @typedef {import('../i18n/index.js').MessageParams} MessageParams */

/** 스택 길이 상한(D-08). 넘으면 가장 오래된 것부터 버린다. */
export const HISTORY_LIMIT = 200;

/** @typedef {'irreversible' | 'fileOpened' | 'undoLimit' | 'import' | 'cleanup' | 'user'} ClearReason */

/**
 * @typedef {object} PushOptions
 * @property {boolean} [mergeWithAdd] 스택 맨 위가 **같은 열**(`columnId`)의 `column.add`이고 다시 실행 스택이 비었으면 그 항목과 합친다(D-16)
 * @property {string} [columnId] 이 커맨드가 추가하거나 이름을 바꾼 열(스토어 알림의 `columnId`). `column.add`면 합칠 짝을 찾도록 기억한다
 */

/**
 * @typedef {object} HistoryState
 * @property {number} undo 되돌릴 수 있는 커맨드 수
 * @property {number} redo 다시 실행할 수 있는 커맨드 수
 * @property {boolean} busy 커맨드 적용·되돌리기·다시 실행이 진행 중
 */

/**
 * @typedef {object} ApplyOptions
 * @property {boolean} [refresh] false면 스토어가 `data:changed`를 내지 않는다(호출자가 그리드를 직접 고친 경우)
 */

/**
 * @typedef {object} History
 * @property {(cmd: Command, options?: ApplyOptions) => Promise<ApplyResult | null>} apply `command.apply` → 기록 → push. 실패는 알리고 null
 * @property {(cmd: Command, options?: PushOptions) => void} push 이미 적용된 커맨드를 스택에 넣는다
 * @property {() => Promise<boolean>} undo
 * @property {() => Promise<boolean>} redo
 * @property {(reason: ClearReason) => void} clear
 * @property {() => HistoryState} state
 * @property {(handler: () => void) => () => void} onChange 스택이 바뀔 때. 구독 해제 함수를 돌려준다
 * @property {() => void} dispose 스토어 구독 해제
 */

/**
 * @typedef {object} HistoryDeps
 * @property {Client} client
 * @property {Store} store
 * @property {{ error: (err: AppError) => void, info: (key: MessageKey, params?: MessageParams) => void }} notify
 * @property {number} [limit]
 */

/**
 * @param {HistoryDeps} deps
 * @returns {History}
 */
export function createHistory(deps) {
  const { client, store, notify } = deps;
  const limit = deps.limit ?? HISTORY_LIMIT;
  /** @type {Command[]} */
  let undoStack = [];
  /** @type {Command[]} */
  let redoStack = [];
  /** 큐에서 실행 중인 작업 수. 0보다 크면 되돌리기·다시 실행 버튼을 잠근다. */
  let running = 0;
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /**
   * 스택에 들어간 `column.add` 커맨드 → 그 커맨드가 만든 열 id. "+ 열"의 이름 확정은 이 열과만 합친다(D-16).
   * @type {WeakMap<Command, string>}
   */
  const addedColumns = new WeakMap();

  /**
   * 히스토리가 보내는 `command.apply`와 그에 딸린 저널 기록을 차례로 실행한다.
   * @type {Promise<unknown>}
   */
  let queue = Promise.resolve();

  /**
   * @template T
   * @param {() => Promise<T>} fn
   * @returns {Promise<T>}
   */
  function serialize(fn) {
    const run = queue.then(fn, fn);
    queue = run.catch(() => {});
    return run;
  }

  function emit() {
    for (const handler of listeners) handler();
  }

  /**
   * 엔진에 닿기 전에 거절된 실패인가. 배타 op가 겹칠 때 Worker가 내는 `E_DB_BUSY`는 커맨드를
   * 실행조차 하지 않았으므로 DB도 히스토리도 그대로 두어야 한다.
   * @param {AppError} err
   * @returns {boolean}
   */
  function neverRan(err) {
    return err.code === 'E_DB_BUSY';
  }

  /** @param {Command} cmd */
  function canUndo(cmd) {
    return !cmd.irreversible && cmd.undo.length > 0;
  }

  /** @returns {boolean} */
  function writable() {
    if (store.getState().readOnly !== 'none') {
      notify.info('file.readOnlyBlocked');
      return false;
    }
    return true;
  }

  /** @type {History} */
  const history = {
    async apply(cmd, options = {}) {
      return serialize(async () => {
        // 먼저 시작한 스키마 op(머리글 이름의 포커스 이탈 확정 등)가 스택에 들어간 뒤에 돈다(D-16).
        await store.schemaIdle();
        if (!writable()) return null;
        running += 1;
        emit();
        /** @type {ApplyResult} */
        let result;
        try {
          result = await client.call('command.apply', { cmd });
        } catch (err) {
          const appErr = toAppError(err);
          notify.error(appErr);
          // 적용되지 않았지만(트랜잭션 롤백) 그리드가 본 값과 DB가 어긋났을 수 있으니 다시 읽게 한다.
          if (!neverRan(appErr)) store.refreshData();
          return null;
        } finally {
          running -= 1;
          emit();
        }
        await store.recordCommand(cmd, { fromHistory: true, refresh: options.refresh });
        history.push(cmd);
        return result;
      });
    },

    push(cmd, options = {}) {
      if (!canUndo(cmd)) {
        history.clear('irreversible');
        return;
      }
      const top = undoStack[undoStack.length - 1];
      if (
        options.mergeWithAdd &&
        top !== undefined &&
        top.type === 'column.add' &&
        top.tableId === cmd.tableId &&
        options.columnId !== undefined &&
        addedColumns.get(top) === options.columnId &&
        redoStack.length === 0 &&
        canUndo(top)
      ) {
        undoStack[undoStack.length - 1] = mergeCommands(top, cmd);
        emit();
        return;
      }
      undoStack.push(cmd);
      if (cmd.type === 'column.add' && options.columnId !== undefined) {
        addedColumns.set(cmd, options.columnId);
      }
      if (undoStack.length > limit) undoStack = undoStack.slice(undoStack.length - limit);
      redoStack = [];
      emit();
    },

    async undo() {
      // 스택의 맨 위는 차례가 온 시점에 읽는다. 앞선 작업이 스택을 바꿨을 수 있다.
      return serialize(async () => {
        // 이름 편집기의 포커스 이탈 확정은 되돌리기 버튼의 pointerdown에서 시작한다. 그 확정이 스택에 들어가기
        // 전에 맨 위를 읽으면 되돌리기가 엉뚱한 항목을 되돌리고, 뒤늦게 들어온 확정이 다시 실행 스택을 비운다.
        await store.schemaIdle();
        const cmd = undoStack[undoStack.length - 1];
        if (!cmd) return false;
        if (!writable()) return false;
        running += 1;
        emit();
        try {
          await client.call('command.apply', { cmd, direction: 'undo' });
        } catch (err) {
          const appErr = toAppError(err);
          notify.error(appErr);
          if (!neverRan(appErr)) {
            undoStack.pop();
            store.refreshData();
          }
          return false;
        } finally {
          running -= 1;
          emit();
        }
        undoStack.pop();
        redoStack.push(cmd);
        await store.recordCommand(invert(cmd), { fromHistory: true });
        await store.refreshTables();
        emit();
        return true;
      });
    },

    async redo() {
      return serialize(async () => {
        await store.schemaIdle();
        const cmd = redoStack[redoStack.length - 1];
        if (!cmd) return false;
        if (!writable()) return false;
        running += 1;
        emit();
        try {
          await client.call('command.apply', { cmd });
        } catch (err) {
          const appErr = toAppError(err);
          notify.error(appErr);
          if (!neverRan(appErr)) {
            redoStack.pop();
            store.refreshData();
          }
          return false;
        } finally {
          running -= 1;
          emit();
        }
        redoStack.pop();
        undoStack.push(cmd);
        await store.recordCommand(cmd, { fromHistory: true });
        await store.refreshTables();
        emit();
        return true;
      });
    },

    clear(reason) {
      void reason;
      if (undoStack.length === 0 && redoStack.length === 0) return;
      undoStack = [];
      redoStack = [];
      emit();
    },

    state: () => ({ undo: undoStack.length, redo: redoStack.length, busy: running > 0 }),

    onChange(handler) {
      listeners.add(handler);
      return () => {
        listeners.delete(handler);
      };
    },

    dispose() {
      for (const off of unsubscribe) off();
      listeners.clear();
    },
  };

  const unsubscribe = [
    store.onCommand((cmd, notice) =>
      history.push(cmd, {
        mergeWithAdd: notice.mergeWithAdd,
        ...(notice.columnId !== null ? { columnId: notice.columnId } : {}),
      }),
    ),
    store.on('file:opened', () => history.clear('fileOpened')),
    // 가져오기는 커맨드가 아니라 스택 위에 놓이지 않는다. 앞선 `column.add`를 되돌리면 `DROP COLUMN`이
    // 가져온 값을 지우므로 스택을 비운다(Step 7).
    store.on('import:done', () => history.clear('import')),
    // 데이터베이스 정리는 되돌릴 수 없고 테이블을 다시 쓴다. 앞선 커맨드의 되돌리기가 지운 열을 가리킬 수 있다(D-17).
    store.on('cleanup:done', () => history.clear('cleanup')),
  ];
  return history;
}
