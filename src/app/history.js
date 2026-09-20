// @ts-check
/**
 * undo/redo 스택(D-08, Step 5)과 저널 연동.
 *
 * - 데이터 커맨드는 `apply()`로 들어온다(`command.apply` → 스토어 기록 → push).
 * - 스키마 커맨드는 Worker가 적용해 스토어가 기록하므로 스토어의 `onCommand` 알림으로 들어온다.
 * - 되돌리기는 `command.apply`를 `undo` 방향으로 부르고, 저널에는 역커맨드(`commands.invert`)를 기록한다.
 *   저널 재생은 항상 `do` 방향이므로 재생 결과가 사용자가 마지막으로 본 상태와 같다.
 * - 되돌릴 수 없는 커맨드(`irreversible`, `undo`가 빈 것)가 들어오면 스택을 비운다.
 * - 실패한 되돌리기·다시 실행은 히스토리에서 제거하고 그리드가 다시 읽게 한다(Step 5 예외 처리).
 *   Worker는 문장 목록을 하나의 트랜잭션으로 실행하므로 DB는 실패 전 상태다.
 */
import { invert } from './commands.js';
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

/** @typedef {'irreversible' | 'fileOpened' | 'undoLimit' | 'user'} ClearReason */

/**
 * @typedef {object} HistoryState
 * @property {number} undo 되돌릴 수 있는 커맨드 수
 * @property {number} redo 다시 실행할 수 있는 커맨드 수
 * @property {boolean} busy 되돌리기·다시 실행이 진행 중
 */

/**
 * @typedef {object} ApplyOptions
 * @property {boolean} [refresh] false면 스토어가 `data:changed`를 내지 않는다(호출자가 그리드를 직접 고친 경우)
 */

/**
 * @typedef {object} History
 * @property {(cmd: Command, options?: ApplyOptions) => Promise<ApplyResult | null>} apply `command.apply` → 기록 → push. 실패는 알리고 null
 * @property {(cmd: Command) => void} push 이미 적용된 커맨드를 스택에 넣는다
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
  let busy = false;
  /** @type {Set<() => void>} */
  const listeners = new Set();

  function emit() {
    for (const handler of listeners) handler();
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
      if (!writable()) return null;
      /** @type {ApplyResult} */
      let result;
      try {
        result = await client.call('command.apply', { cmd });
      } catch (err) {
        notify.error(toAppError(err));
        // 적용되지 않았지만(트랜잭션 롤백) 그리드가 본 값과 DB가 어긋났을 수 있으니 다시 읽게 한다.
        store.refreshData();
        return null;
      }
      await store.recordCommand(cmd, { fromHistory: true, refresh: options.refresh });
      history.push(cmd);
      return result;
    },

    push(cmd) {
      if (!canUndo(cmd)) {
        history.clear('irreversible');
        return;
      }
      undoStack.push(cmd);
      if (undoStack.length > limit) undoStack = undoStack.slice(undoStack.length - limit);
      redoStack = [];
      emit();
    },

    async undo() {
      if (busy) return false;
      const cmd = undoStack[undoStack.length - 1];
      if (!cmd) return false;
      if (!writable()) return false;
      busy = true;
      emit();
      try {
        await client.call('command.apply', { cmd, direction: 'undo' });
      } catch (err) {
        notify.error(toAppError(err));
        undoStack.pop();
        store.refreshData();
        return false;
      } finally {
        busy = false;
        emit();
      }
      undoStack.pop();
      redoStack.push(cmd);
      await store.recordCommand(invert(cmd), { fromHistory: true });
      await store.refreshTables();
      emit();
      return true;
    },

    async redo() {
      if (busy) return false;
      const cmd = redoStack[redoStack.length - 1];
      if (!cmd) return false;
      if (!writable()) return false;
      busy = true;
      emit();
      try {
        await client.call('command.apply', { cmd });
      } catch (err) {
        notify.error(toAppError(err));
        redoStack.pop();
        store.refreshData();
        return false;
      } finally {
        busy = false;
        emit();
      }
      redoStack.pop();
      undoStack.push(cmd);
      await store.recordCommand(cmd, { fromHistory: true });
      await store.refreshTables();
      emit();
      return true;
    },

    clear(reason) {
      void reason;
      if (undoStack.length === 0 && redoStack.length === 0) return;
      undoStack = [];
      redoStack = [];
      emit();
    },

    state: () => ({ undo: undoStack.length, redo: redoStack.length, busy }),

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
    store.onCommand((cmd) => history.push(cmd)),
    store.on('file:opened', () => history.clear('fileOpened')),
  ];
  return history;
}
