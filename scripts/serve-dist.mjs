// @ts-check
/**
 * 저장소 루트를 `http://localhost:<port>`로 서빙하는 최소 정적 서버(Step 10, 지원 매트릭스의 http 열 실측).
 * `JDR_E2E_HTTP=1 npm run test:e2e`에서 `playwright.config.js`의 webServer가 띄운다. 런타임 코드가 아니며
 * 배포 산출물은 여전히 `file://`로 여는 단일 파일이다.
 *
 *   node scripts/serve-dist.mjs [port]
 */
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const port = Number(process.argv[2] ?? process.env.JDR_E2E_HTTP_PORT ?? 4173);

/** @type {Record<string, string>} */
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.wasm': 'application/wasm',
  '.db': 'application/octet-stream',
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${port}`);
  const file = path.normalize(path.join(ROOT, decodeURIComponent(url.pathname)));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end();
    return;
  }
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error('not a file');
  } catch {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    'content-type': TYPES[path.extname(file)] ?? 'application/octet-stream',
    'cache-control': 'no-store',
  });
  createReadStream(file).pipe(res);
});

server.listen(port, '127.0.0.1', () => {
  console.log(`serving ${ROOT} at http://localhost:${port}/`);
});
