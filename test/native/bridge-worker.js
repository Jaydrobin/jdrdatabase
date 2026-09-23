// @ts-check
/**
 * `engine-native.test.js`가 띄우는 worker_threads 스레드. 러스트 하네스(`jdr-ipc-stdio`)를 자식 프로세스로 띄우고
 * `io/ipc-bridge.js`의 브리지를 `parentPort`에 붙인다. 메인 스레드의 엔진이 `Atomics.wait`로 멈춰 있는 동안
 * 이 스레드의 이벤트 루프가 요청을 받아 하네스에 넘기고 공유 버퍼에 응답을 쓴다(D-15의 중계를 스레드만 바꿔 실행).
 *
 * 브라우저에서는 같은 브리지가 메인 스레드에서 Worker의 요청을 타우리 invoke로 넘긴다.
 */
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { parentPort, workerData } from 'node:worker_threads';
import { createBridge } from '../../src/io/ipc-bridge.js';

/** @typedef {import('../../src/db/engine-native.js').CallerPort} CallerPort */

const port = parentPort;
if (!port) throw new Error('bridge-worker must run inside a worker thread');
const { binary, appData } = /** @type {{ binary: string, appData: string }} */ (workerData);

const child = spawn(binary, [appData], { stdio: ['pipe', 'pipe', 'inherit'] });
let nextId = 1;
/** @type {Map<number, { resolve: (v: unknown) => void, reject: (e: unknown) => void, onProgress?: (p: unknown) => void }>} */
const pending = new Map();
const lines = createInterface({ input: child.stdout });
lines.on('line', (line) => {
  /** @type {{ id: number, ok?: boolean, result?: unknown, error?: unknown, progress?: unknown }} */
  const message = JSON.parse(line);
  const entry = pending.get(message.id);
  if (!entry) return;
  if ('progress' in message) {
    entry.onProgress?.(message.progress);
    return;
  }
  pending.delete(message.id);
  if (message.ok) entry.resolve(message.result);
  else entry.reject(message.error);
});
child.on('exit', (code) => {
  for (const entry of pending.values()) entry.reject(new Error(`harness exited with ${code}`));
  pending.clear();
});

/** @type {import('../../src/io/ipc-bridge.js').EngineInvoke} */
const invoke = (op, args, onProgress) =>
  new Promise((resolve, reject) => {
    const id = nextId;
    nextId += 1;
    pending.set(id, { resolve, reject, onProgress });
    child.stdin.write(`${JSON.stringify({ id, cmd: op, args })}\n`);
  });

/** @type {CallerPort} */
const parentAsPort = {
  postMessage: (message) => port.postMessage(message),
  subscribe: (handler) => {
    port.on('message', handler);
    return () => port.off('message', handler);
  },
};
const bridge = createBridge({ invoke });
bridge.attach(parentAsPort);
port.on('message', (data) => {
  if (data && typeof data === 'object' && 'shutdown' in data) {
    bridge.detach();
    child.stdin.end();
    child.on('exit', () => port.postMessage({ shutdown: true }));
  }
});
