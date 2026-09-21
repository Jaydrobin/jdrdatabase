// @ts-check
/**
 * `npm run test:native`: 러스트 코어의 표준 입출력 하네스(`jdr-ipc-stdio`)를 빌드한 뒤 `test/native/*.test.js`를 돌린다.
 * 적합성 테스트가 실제 rusqlite 엔진에 대해 통과하는지 보는 것이 목적이다(DESIGN.md Step 11 완료 기준).
 * Rust 툴체인이 없으면 실패한다(건너뛰지 않는다. CLAUDE.md 9장).
 */
import { spawn, spawnSync } from 'node:child_process';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CORE_MANIFEST = path.join(ROOT, 'src-tauri', 'core', 'Cargo.toml');
const NATIVE_DIR = path.join(ROOT, 'test', 'native');

const build = spawnSync(
  'cargo',
  ['build', '--release', '--manifest-path', CORE_MANIFEST, '--bin', 'jdr-ipc-stdio'],
  { stdio: 'inherit', cwd: ROOT },
);
if (build.status !== 0) {
  console.error('cargo build failed (Rust toolchain required for test:native)');
  process.exit(build.status ?? 1);
}
const located = spawnSync(
  'cargo',
  ['metadata', '--format-version', '1', '--no-deps', '--manifest-path', CORE_MANIFEST],
  { cwd: ROOT, encoding: 'utf8' },
);
/** @type {{ target_directory: string }} */
const metadata = JSON.parse(located.stdout);
const exe = process.platform === 'win32' ? 'jdr-ipc-stdio.exe' : 'jdr-ipc-stdio';
const binary = path.join(metadata.target_directory, 'release', exe);

const files = (await readdir(NATIVE_DIR))
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(NATIVE_DIR, name));
const child = spawn(process.execPath, ['--test', ...files], {
  stdio: 'inherit',
  cwd: ROOT,
  env: { ...process.env, JDR_IPC_STDIO: binary },
});
child.on('exit', (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
