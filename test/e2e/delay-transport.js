// @ts-check
/**
 * 특정 RPC op의 도착을 늦추는 검사용 전송 래퍼. 경합 구간을 결정적으로 재현할 때 쓴다.
 *
 * `page.addInitScript(delayTransport)`로 걸어 두면 `window.__jdrDelayOp`를 세우는 검사에서만
 * 동작하고, 세우지 않으면 아무 일도 하지 않으므로 다른 검사에 영향이 없다.
 */

/**
 * 전송 계층을 늦추는 검사용 창 속성.
 * @typedef {object} DelayWindow
 * @property {{ op: string, ms: number }} [__jdrDelayOp]
 */

/** `addInitScript`에 그대로 넘기는 함수. 페이지 안에서 실행된다. */
export function delayTransport() {
  const w = /** @type {DelayWindow} */ (/** @type {unknown} */ (window));
  const original =
    /** @type {(this: Worker, message: unknown, transfer: Transferable[]) => void} */ (
      /** @type {unknown} */ (Worker.prototype.postMessage)
    );
  /**
   * @this {Worker}
   * @param {{ op?: string }} message
   * @param {Transferable[]} transfer
   */
  function patched(message, transfer) {
    const delay = w.__jdrDelayOp;
    if (delay && message && delay.op === message.op) {
      setTimeout(() => original.call(this, message, transfer), delay.ms);
      return;
    }
    original.call(this, message, transfer);
  }
  Worker.prototype.postMessage = /** @type {typeof Worker.prototype.postMessage} */ (
    /** @type {unknown} */ (patched)
  );
}
