// @ts-check
/**
 * 미저장 변경 저널(D-04 3층). 적용된 커맨드를 IndexedDB `journal` 스토어에 순서대로 기록하고,
 * 파일을 저장하면 비운다. 탭이 죽으면 다음 시작 때 같은 `db_id`의 DB에 재생한다.
 *
 * 저널은 가장 최근에 편집한 DB 하나의 기록만 담는다. 다른 `db_id`의 기록이 시작되면 이전 기록은 지운다.
 * 50 MB를 넘으면 기록을 멈추고 `onFull`을 부른다(UI가 "지금 저장하세요" 배너를 띄운다).
 * 자동 저장 타이머(`createSaveTimer`, Step 9)도 여기 있다: dirty가 된 뒤 간격마다 저장을 시도한다.
 */
import { estimateCloneBytes, MB } from '../util/bytes.js';
import { AppError } from '../util/errors.js';

/** @typedef {import('./idb.js').Idb} Idb */
/** @typedef {import('../db/command.js').Command} Command */
/** @typedef {import('../db/client.js').Client} Client */

/** 저널 용량 상한. 넘으면 기록을 멈춘다(Step 2 예외 처리). */
export const JOURNAL_LIMIT_BYTES = 50 * MB;

/**
 * 저널 항목. 구조화 복제 가능한 값만 담는다.
 * @typedef {object} JournalEntry
 * @property {string} dbId
 * @property {number} baseRevision 기록을 시작한 시점의 파일 revision
 * @property {string | null} fileName 저장한 적 없는 새 DB면 null
 * @property {number} seq 같은 dbId 안의 순번(0부터)
 * @property {Command} cmd
 * @property {number} bytes `estimateCloneBytes(cmd)`
 */

/**
 * @typedef {object} JournalSummary
 * @property {string} dbId
 * @property {number} baseRevision
 * @property {string | null} fileName
 * @property {Command[]} commands seq 순
 * @property {boolean} truncated 상한을 넘어 뒤쪽 기록이 빠졌는가
 */

/**
 * @typedef {object} JournalContext
 * @property {string} dbId
 * @property {number} baseRevision
 * @property {string | null} fileName
 */

/**
 * @typedef {object} Autosave
 * @property {(ctx: JournalContext) => void} attach 지금 열린 DB의 문맥을 정한다. 기록은 지우지 않는다
 * @property {(cmd: Command) => Promise<boolean>} recordCommand 기록했으면 true. IDB 없음·상한 초과·정지면 false
 * @property {() => Promise<void>} suspend 기록을 멈춘다(가져오기 뒤, Step 7). 상한 초과와 같은 상태이며 `clear`가 풀어 준다
 * @property {() => Promise<void>} clear 저널을 비운다(저장 성공 뒤). 정지도 풀린다
 * @property {(dbId: string) => Promise<JournalSummary | null>} recoverable 그 dbId의 기록이 있으면 요약
 * @property {() => Promise<JournalSummary | null>} pending 저널에 남아 있는 기록(dbId 무관). 시작 시 확인용
 * @property {(client: Client, commands: Command[], onProgress?: (done: number, total: number) => void) => Promise<{ applied: number, skipped: number }>} replay `command.apply`로 차례로 적용한다. 대상이 외부(비STRICT) 테이블로 바뀐 커맨드는 건너뛰고 그 수를 함께 돌려준다
 * @property {() => boolean} isFull
 * @property {() => JournalContext | null} context
 */

/** 상한 도달을 남기는 설정 키. 재생 시 "일부만 복구됨"을 알리는 데 쓴다. */
const TRUNCATED_KEY = 'journal_truncated';

/**
 * @param {{ idb: Idb | null, onFull?: () => void, limitBytes?: number }} options
 * @returns {Autosave}
 */
export function createAutosave(options) {
  const { idb } = options;
  const limit = options.limitBytes ?? JOURNAL_LIMIT_BYTES;
  /** @type {JournalContext | null} */
  let ctx = null;
  /** 저널에 지금 들어 있는 기록의 dbId. 처음 기록할 때 스토어에서 읽어 채운다. */
  /** @type {string | null | undefined} */
  let storedDbId;
  let total = 0;
  let seq = 0;
  let full = false;

  /**
   * 스토어의 현재 상태(dbId, 크기, 순번)를 한 번 읽어 메모리에 둔다.
   */
  async function sync() {
    if (!idb || storedDbId !== undefined) return;
    const entries = await idb.getAll('journal');
    total = 0;
    seq = 0;
    storedDbId = null;
    for (const { value } of entries) {
      const entry = /** @type {JournalEntry} */ (value);
      storedDbId = entry.dbId;
      total += entry.bytes;
      seq = Math.max(seq, entry.seq + 1);
    }
    full = total > limit;
  }

  /**
   * @param {Array<{ key: IDBValidKey, value: unknown }>} entries
   * @param {boolean} truncated
   * @returns {JournalSummary | null}
   */
  function summarize(entries, truncated) {
    const list = entries
      .map((e) => /** @type {JournalEntry} */ (e.value))
      .sort((a, b) => a.seq - b.seq);
    const first = list[0];
    if (!first) return null;
    return {
      dbId: first.dbId,
      baseRevision: first.baseRevision,
      fileName: first.fileName,
      commands: list.filter((e) => e.dbId === first.dbId).map((e) => e.cmd),
      truncated,
    };
  }

  return {
    attach(next) {
      ctx = { ...next };
    },

    async recordCommand(cmd) {
      if (!idb || !ctx) return false;
      await sync();
      if (storedDbId !== null && storedDbId !== ctx.dbId) {
        // 다른 DB의 기록은 버린다. 저널은 가장 최근에 편집한 DB 하나만 담는다.
        await idb.clear('journal');
        await idb.delete('settings', TRUNCATED_KEY);
        total = 0;
        seq = 0;
        full = false;
      }
      storedDbId = ctx.dbId;
      if (full) return false;
      const bytes = estimateCloneBytes(cmd);
      if (total + bytes > limit) {
        full = true;
        await idb.put('settings', TRUNCATED_KEY, true);
        options.onFull?.();
        return false;
      }
      /** @type {JournalEntry} */
      const entry = {
        dbId: ctx.dbId,
        baseRevision: ctx.baseRevision,
        fileName: ctx.fileName,
        seq,
        cmd,
        bytes,
      };
      await idb.add('journal', entry);
      seq += 1;
      total += bytes;
      return true;
    },

    async suspend() {
      await sync();
      if (ctx && storedDbId === null) storedDbId = ctx.dbId;
      if (full) return;
      full = true;
      if (idb) await idb.put('settings', TRUNCATED_KEY, true);
      options.onFull?.();
    },

    async clear() {
      total = 0;
      seq = 0;
      full = false;
      storedDbId = null;
      if (!idb) return;
      await idb.clear('journal');
      await idb.delete('settings', TRUNCATED_KEY);
    },

    async recoverable(dbId) {
      if (!idb) return null;
      const entries = await idb.getAll('journal');
      const truncated = (await idb.get('settings', TRUNCATED_KEY)) === true;
      const summary = summarize(entries, truncated);
      return summary && summary.dbId === dbId ? summary : null;
    },

    async pending() {
      if (!idb) return null;
      const entries = await idb.getAll('journal');
      const truncated = (await idb.get('settings', TRUNCATED_KEY)) === true;
      return summarize(entries, truncated);
    },

    async replay(client, commands, onProgress) {
      let done = 0;
      let skipped = 0;
      for (const cmd of commands) {
        try {
          // `replay: true`는 대상이 외부(비STRICT) 테이블로 바뀐 커맨드를 오류 대신 건너뛰게 한다.
          // 복구 도중 한 항목 때문에 나머지 복구가 통째로 멈추면 그게 더 큰 손실이다.
          const result = await client.call('command.apply', { cmd, replay: true });
          if (result.skipped) skipped += 1;
        } catch (err) {
          throw new AppError('E_DB_QUERY', `journal replay failed at command ${done}`, {
            cause: err,
            detail: { index: done, type: cmd.type },
          });
        }
        done += 1;
        onProgress?.(done, commands.length);
      }
      return { applied: done - skipped, skipped };
    },

    isFull: () => full,
    context: () => (ctx ? { ...ctx } : null),
  };
}

/** 자동 저장 간격 선택지(초). 0은 꺼짐(기본, DESIGN.md 9장). */
export const AUTOSAVE_INTERVALS_SECONDS = Object.freeze([0, 30, 60, 120, 300]);

/**
 * @typedef {object} SaveTimer
 * @property {(ms: number) => void} setInterval 0이면 끈다. 바꾸면 대기 중인 틱을 다시 잡는다
 * @property {() => void} markDirty 미저장 변경이 생겼다. 간격이 켜져 있으면 틱을 잡는다
 * @property {() => void} markClean 저장됐다. 대기 중인 틱을 지운다
 * @property {() => boolean} armed 틱이 잡혀 있는가(테스트용)
 * @property {() => void} dispose
 */

/**
 * @typedef {object} SaveTimerOptions
 * @property {() => Promise<boolean>} save 저장 시도. true면 저장됐고, false면 미뤘거나 실패했다(같은 간격 뒤 다시)
 * @property {number} [intervalMs] 기본 0(꺼짐)
 * @property {(fn: () => void, ms: number) => unknown} [setTimer] 테스트용 주입. 기본 `setTimeout`
 * @property {(handle: unknown) => void} [clearTimer] 테스트용 주입. 기본 `clearTimeout`
 */

/**
 * 자동 저장 타이머(Step 9). dirty가 되면 `intervalMs` 뒤에 `save()`를 부르고, 저장되지 않았으면(미룸·실패)
 * 같은 간격 뒤에 다시 시도한다. 저장되면 다음 dirty까지 쉰다. 저장 자체의 뮤텍스·조건(정본 핸들, 읽기 전용)은
 * 스토어의 몫이고, 이 타이머는 시점만 정한다.
 * @param {SaveTimerOptions} options
 * @returns {SaveTimer}
 */
export function createSaveTimer(options) {
  const setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const clearTimer = options.clearTimer ?? ((h) => clearTimeout(/** @type {number} */ (h)));
  let intervalMs = options.intervalMs ?? 0;
  let dirty = false;
  /** dirty가 된 횟수. 저장 중에 들어온 변경을 저장 성공으로 지우지 않기 위해 센다. */
  let generation = 0;
  let ticking = false;
  /** @type {unknown} */
  let handle = null;
  let disposed = false;

  function clear() {
    if (handle !== null) clearTimer(handle);
    handle = null;
  }

  function arm() {
    clear();
    if (disposed || !dirty || intervalMs <= 0) return;
    handle = setTimer(() => {
      handle = null;
      void tick();
    }, intervalMs);
  }

  async function tick() {
    if (disposed || !dirty) return;
    const before = generation;
    ticking = true;
    let saved = false;
    try {
      saved = await options.save();
    } catch {
      // save()는 실패를 알리고 false를 돌려주는 계약이다. 그래도 던지면 다음 틱에 다시 시도한다.
      saved = false;
    }
    ticking = false;
    // 저장 중에 들어온 변경은 이번 저장에 담기지 않았을 수 있으므로 dirty로 남긴다.
    if (saved && generation === before) dirty = false;
    // 저장이 실패·미뤄졌거나(dirty 유지), 저장 중에 다시 dirty가 됐으면 다음 간격을 잡는다.
    arm();
  }

  return {
    setInterval(ms) {
      intervalMs = Math.max(0, ms);
      arm();
    },
    markDirty() {
      dirty = true;
      generation += 1;
      if (handle === null && !ticking) arm();
    },
    markClean() {
      dirty = false;
      clear();
    },
    armed: () => handle !== null,
    dispose() {
      disposed = true;
      clear();
    },
  };
}
