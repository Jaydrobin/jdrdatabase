// @ts-check
/**
 * Worker 진입점. Step 1에서 RPC 디스패처(`dispatch`)로 채운다.
 * 지금은 빌드가 Worker 소스를 별도 번들로 인라인하는 경로를 확인하기 위한 최소 진입점이다.
 */

/**
 * @typedef {object} MessagePortLike
 * @property {(message: unknown) => void} postMessage
 * @property {((ev: MessageEvent) => void) | null} onmessage
 */

const port = /** @type {MessagePortLike} */ (/** @type {unknown} */ (self));
port.onmessage = (/** @type {MessageEvent} */ ev) => {
  port.postMessage({ echo: ev.data });
};
