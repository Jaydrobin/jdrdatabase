// @ts-check
/**
 * CLAUDE.md 7.1 체크리스트의 grep 항목을 소스 검사로 고정한다(Step 10 보안 점검).
 * - 사용자 데이터가 닿을 수 있는 `innerHTML`·`insertAdjacentHTML`·`document.write`가 src/에 없다(5.5).
 * - 모드 문자열('native' | 'wasm' | 'desktop') 비교는 main.js, db/engine.js, 엔진 구현 파일에만 있다(5.3).
 * - Worker·가져오기·내보내기 코드의 SQL 템플릿 리터럴은 `quoteIdent()`로 감싼 식별자나 절 조립뿐이고
 *   값은 바인딩으로만 넘긴다(5.3). `${` 뒤에 오는 식이 식별자·절 도우미인지 본다.
 * - 새 오류 코드·RPC op가 문서와 어긋나지 않는다(errors.js ↔ i18n, worker OpMap ↔ DESIGN.md 6장).
 */
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { ERROR_CODES } from '../../src/util/errors.js';
import { ko } from '../../src/i18n/ko.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const SRC = path.join(ROOT, 'src');

/**
 * @param {string} dir
 * @returns {Promise<string[]>}
 */
async function listJs(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listJs(full)));
    else if (entry.isFile() && entry.name.endsWith('.js')) out.push(full);
  }
  return out.sort();
}

/**
 * 주석을 뺀 소스. 줄 주석과 블록 주석 안의 언급은 검사 대상이 아니다.
 * @param {string} source
 */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/[^\n]*/g, '$1');
}

/** @param {string} file */
function rel(file) {
  return path.relative(ROOT, file).split(path.sep).join('/');
}

test('src/에 innerHTML·insertAdjacentHTML·document.write가 없다(사용자 데이터는 textContent로만)', async () => {
  /** @type {string[]} */
  const hits = [];
  for (const file of await listJs(SRC)) {
    const code = stripComments(await readFile(file, 'utf8'));
    for (const [index, line] of code.split('\n').entries()) {
      if (/\binnerHTML\b|\bouterHTML\b|insertAdjacentHTML|document\.write\b/.test(line)) {
        hits.push(`${rel(file)}:${index + 1}: ${line.trim().slice(0, 80)}`);
      }
    }
  }
  assert.deepEqual(hits, []);
});

test("모드 문자열('native'·'wasm'·'desktop') 비교는 main.js, db/engine.js, 엔진 구현에만 있다", async () => {
  const allowed = new Set([
    'src/main.js',
    'src/db/engine.js',
    'src/db/engine-wasm.js',
    'src/db/engine-native.js',
  ]);
  /** @type {string[]} */
  const hits = [];
  for (const file of await listJs(SRC)) {
    if (allowed.has(rel(file))) continue;
    const code = stripComments(await readFile(file, 'utf8'));
    for (const [index, line] of code.split('\n').entries()) {
      if (/['"](native|wasm|desktop)['"]/.test(line)) {
        hits.push(`${rel(file)}:${index + 1}: ${line.trim().slice(0, 80)}`);
      }
    }
  }
  assert.deepEqual(hits, []);
});

test('Worker 쪽 SQL 템플릿 리터럴은 식별자(quoteIdent)와 절 조립뿐이고 값은 바인딩한다', async () => {
  // `${...}` 안에 올 수 있는 것: quoteIdent(...) 호출, 절·문장 조각을 만드는 도우미(clauses, where, order,
  // limit 등 이름이 SQL 조각임을 드러내는 식별자), 미리 만든 문자열 상수. 값(row, value, params, input.x)은 안 된다.
  const dirs = ['src/db', 'src/import', 'src/export', 'src/app/commands.js'];
  const files = (
    await Promise.all(
      dirs.map(async (d) => {
        const full = path.join(ROOT, d);
        return d.endsWith('.js') ? [full] : listJs(full);
      }),
    )
  ).flat();
  const valueLike = /\$\{\s*(?:input|row|value|values|params|raw|cell|text|name|search|q)\b[^}]*\}/;
  /** @type {string[]} */
  const hits = [];
  for (const file of files) {
    const code = stripComments(await readFile(file, 'utf8'));
    for (const [index, line] of code.split('\n').entries()) {
      // SQL 키워드는 이 저장소에서 대문자다. 소문자 `table.create` 같은 요약 문자열은 SQL이 아니다.
      if (
        !/`[^`]*\b(SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|WHERE|FROM)\b[^`]*\$\{/.test(line)
      )
        continue;
      if (valueLike.test(line))
        hits.push(`${rel(file)}:${index + 1}: ${line.trim().slice(0, 100)}`);
    }
  }
  assert.deepEqual(hits, []);
});

test('오류 코드마다 i18n 문구가 있고, 문구가 있는 코드는 목록에 있다', () => {
  const codes = /** @type {Set<string>} */ (new Set(ERROR_CODES));
  for (const code of codes) assert.ok(`error.${code}` in ko, `error.${code} 문구 없음`);
  for (const key of Object.keys(ko)) {
    if (key.startsWith('error.E_'))
      assert.ok(codes.has(key.slice('error.'.length)), `${key}는 목록에 없는 코드`);
  }
});

test('DESIGN.md 6장 표의 RPC op와 worker.js OpMap이 같다', async () => {
  const design = await readFile(path.join(ROOT, 'DESIGN.md'), 'utf8');
  const worker = await readFile(path.join(ROOT, 'src/db/worker.js'), 'utf8');
  const section = design.slice(
    design.indexOf('## 6. RPC 프로토콜'),
    design.indexOf('## 7. 공통 예외 처리 카탈로그'),
  );
  // 표의 첫 칸: `op` 하나이거나 `schema.*`처럼 ` / `로 이어진 여럿.
  /** @type {Set<string>} */
  const documented = new Set();
  for (const row of section.matchAll(/^\| ((?:`[a-z]+\.[A-Za-z]+`(?: \/ )?)+) \|/gm)) {
    for (const op of row[1].matchAll(/`([a-z]+\.[A-Za-z]+)`/g)) documented.add(op[1]);
  }
  const opMap = worker.slice(worker.indexOf('@typedef {{'), worker.indexOf('}} OpMap'));
  const implemented = new Set(
    [...opMap.matchAll(/^\s*\*\s+'([a-z]+\.[A-Za-z]+)':/gm)].map((m) => m[1]),
  );
  assert.ok(implemented.size > 20, `OpMap 파싱 실패(${implemented.size})`);
  // 문서에만 있는 op는 데스크톱 전용(`db.save`, Step 11)뿐이어야 한다.
  const nativeOnly = new Set(['db.save']);
  assert.deepEqual(
    [...documented].filter((op) => !implemented.has(op)),
    [...nativeOnly],
    '문서에 있으나 구현되지 않은 op',
  );
  assert.deepEqual(
    [...implemented].filter((op) => !documented.has(op)),
    [],
    '구현됐으나 6장 표에 없는 op',
  );
});
