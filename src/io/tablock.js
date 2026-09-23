// @ts-check
/**
 * 같은 `db_id`를 연 다른 탭 감지(Step 2 예외 처리). BroadcastChannel이 없으면 항상 "없음"으로 본다.
 *
 * 프로토콜: 여는 탭이 `{ type: 'probe', dbId, from }`을 보내고 잠시 기다린다. 그 db_id를 쓰고 있는 탭은
 * `{ type: 'held', dbId, to: from }`으로 답한다. 답이 오면 두 번째 탭은 읽기 전용으로 연다.
 */

export const TABLOCK_CHANNEL = 'jdrdatabase-tabs';
/** 다른 탭의 응답을 기다리는 시간(ms). 같은 기기 안의 BroadcastChannel은 수 ms면 충분하다. */
export const TABLOCK_PROBE_MS = 150;

/** @typedef {{ type: 'probe', dbId: string, from: string } | { type: 'held', dbId: string, to: string }} TabMessage */

/**
 * @typedef {object} TabLock
 * @property {boolean} available BroadcastChannel을 쓸 수 있는가
 * @property {(dbId: string) => Promise<{ heldElsewhere: boolean }>} claim 다른 탭이 쥐고 있지 않으면 이 탭이 쥔다
 * @property {() => void} release
 * @property {() => void} close
 */

/**
 * @param {{ channelName?: string, probeMs?: number }} [options]
 * @returns {TabLock}
 */
export function createTabLock(options = {}) {
  /** @type {BroadcastChannel | null} */
  let channel = null;
  try {
    if (typeof BroadcastChannel === 'function') {
      channel = new BroadcastChannel(options.channelName ?? TABLOCK_CHANNEL);
      // Node의 BroadcastChannel은 이벤트 루프를 붙잡는다. 브라우저에는 unref가 없으므로 있을 때만 부른다.
      const maybeUnref = /** @type {{ unref?: () => void }} */ (/** @type {unknown} */ (channel));
      maybeUnref.unref?.();
    }
  } catch {
    // 기능 감지 실패는 폴백이다(CLAUDE.md 5.6). 잠금 없이 동작한다.
    channel = null;
  }
  const probeMs = options.probeMs ?? TABLOCK_PROBE_MS;
  const tabId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
  /** @type {string | null} */
  let held = null;
  /** @type {((message: TabMessage) => void) | null} */
  let listener = null;

  if (channel) {
    channel.onmessage = (ev) => {
      const message = /** @type {TabMessage} */ (ev.data);
      if (!message || typeof message !== 'object') return;
      if (message.type === 'probe' && held && message.dbId === held && channel) {
        channel.postMessage(
          /** @type {TabMessage} */ ({ type: 'held', dbId: message.dbId, to: message.from }),
        );
      }
      listener?.(message);
    };
  }

  return {
    available: channel !== null,
    async claim(dbId) {
      if (!channel) {
        held = dbId;
        return { heldElsewhere: false };
      }
      const active = channel;
      const heldElsewhere = await new Promise((resolve) => {
        const timer = setTimeout(() => {
          listener = null;
          resolve(false);
        }, probeMs);
        listener = (message) => {
          if (message.type === 'held' && message.dbId === dbId && message.to === tabId) {
            clearTimeout(timer);
            listener = null;
            resolve(true);
          }
        };
        active.postMessage(/** @type {TabMessage} */ ({ type: 'probe', dbId, from: tabId }));
      });
      held = heldElsewhere ? null : dbId;
      return { heldElsewhere };
    },
    release() {
      held = null;
    },
    close() {
      held = null;
      channel?.close();
      channel = null;
    },
  };
}
