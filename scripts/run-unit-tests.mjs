// @ts-check
/**
 * `test/unit/**\/*.test.js`를 찾아 `node --test`에 파일 목록으로 넘긴다.
 * Node 20은 glob 인자를, Node 22는 디렉터리 인자를 받지 않으므로 둘 다에서 같은 파일 집합을 돌리기 위한 러너다.
 */
import { spawn } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const UNIT_DIR = path.join(ROOT, 'test', 'unit');

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function collect(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await collect(full)));
    else if (entry.isFile() && entry.name.endsWith('.test.js')) out.push(full);
  }
  return out.sort();
}

const files = await collect(UNIT_DIR);
if (files.length === 0) {
  console.error('no unit test files found under test/unit');
  process.exit(1);
}
const extra = process.argv.slice(2);
const child = spawn(process.execPath, ['--test', ...extra, ...files], {
  stdio: 'inherit',
  cwd: ROOT,
});
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
