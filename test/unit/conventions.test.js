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
  assert.deepEqual(
    [...documented].filter((op) => !implemented.has(op)),
    [],
    '문서에 있으나 구현되지 않은 op',
  );
  assert.deepEqual(
    [...implemented].filter((op) => !documented.has(op)),
    [],
    '구현됐으나 6장 표에 없는 op',
  );
});

test("src/ui에 HTML title 속성 쓰기(`.title =`, `setAttribute('title'`)가 없다(툴팁은 data-hint, D-19)", async () => {
  /** @type {string[]} */
  const hits = [];
  for (const file of await listJs(path.join(SRC, 'ui'))) {
    const code = stripComments(await readFile(file, 'utf8'));
    for (const [index, line] of code.split('\n').entries()) {
      if (/\.title\s*=(?!=)|setAttribute\(\s*['"]title['"]/.test(line)) {
        hits.push(`${rel(file)}:${index + 1}: ${line.trim().slice(0, 80)}`);
      }
    }
  }
  assert.deepEqual(hits, []);
});

/**
 * `data-action`을 달지만 툴팁을 달지 않는 요소. 텍스트 입력칸에는 툴팁을 달지 않는다(D-19: 포커스가 늘
 * `:focus-visible`이라 입력하는 내내 떠 있고, 필요한 정보는 레이블·예시가 늘 보인다).
 * @type {Record<string, string[]>}
 */
const HINTLESS_ACTION_ELEMENTS = { 'src/ui/toolbar.js': ['searchInput'] };

test('data-action을 가진 버튼·선택 상자는 data-hint를 가지며, 툴팁 키가 ko.js·en.js에 있다(D-19)', async () => {
  const { en } = await import('../../src/i18n/en.js');
  /** @type {string[]} */
  const missingHint = [];
  /** @type {Set<string>} */
  const hintKeys = new Set();
  for (const file of await listJs(path.join(SRC, 'ui'))) {
    const code = stripComments(await readFile(file, 'utf8'));
    const exempt = HINTLESS_ACTION_ELEMENTS[rel(file)] ?? [];
    // 1) `x.dataset.action = …`을 하는 변수는 같은 파일에서 `x.dataset.hint = …`도 한다.
    for (const m of code.matchAll(/(\w+)\.dataset\.action\s*=/g)) {
      const variable = m[1] ?? '';
      if (exempt.includes(variable)) continue;
      if (!new RegExp(`\\b${variable}\\.dataset\\.hint\\s*=`).test(code)) {
        missingHint.push(`${rel(file)}: ${variable}`);
      }
    }
    // 2) 툴팁 키 리터럴('hint.…')은 그대로 모은다.
    for (const m of code.matchAll(/['"`](hint\.[a-z0-9-]+)['"`]/g)) hintKeys.add(m[1] ?? '');
    // 3) `dataset.hint = \`hint.${action}\``처럼 data-action을 따르는 키는 그 action 값에서 만든다.
    //    action 값: 리터럴 대입, 그 대입을 하는 도우미(makeButton·button)의 호출 인자, 설정 확인 줄의 역할(`${role}-ok`).
    /** @type {Set<string>} */
    const actions = new Set();
    for (const m of code.matchAll(/(\w+)\.dataset\.action\s*=\s*'([a-z0-9-]+)'/g)) {
      if (!exempt.includes(m[1] ?? '')) actions.add(m[2] ?? '');
    }
    const helpers = [
      ...code.matchAll(
        /function (\w+)\([^)]*\baction\b[^)]*\)\s*\{[^}]*dataset\.action = action;/g,
      ),
    ].map((m) => m[1] ?? '');
    for (const helper of helpers) {
      for (const m of code.matchAll(
        new RegExp(`\\b${helper}\\([^;]*?,\\s*'([a-z][a-z0-9-]*)'\\s*[,)]`, 'g'),
      )) {
        actions.add(m[1] ?? '');
      }
    }
    if (code.includes('`${options.role}-ok`')) {
      for (const m of code.matchAll(/role:\s*'([a-z0-9-]+)'/g)) actions.add(`${m[1]}-ok`);
    }
    if (/dataset\.hint = `hint\.\$\{(?:action|options\.role\}-ok)/.test(code)) {
      for (const action of actions) hintKeys.add(`hint.${action}`);
    } else {
      // 도우미가 없는 파일은 대입마다 리터럴 키를 쓴다. 그래도 action과 짝이 맞는지 본다.
      for (const action of actions) {
        if (!hintKeys.has(`hint.${action}`)) missingHint.push(`${rel(file)}: hint.${action}`);
      }
    }
  }
  assert.deepEqual(missingHint, [], 'data-action만 있고 data-hint가 없는 요소');
  assert.ok(hintKeys.size > 40, `툴팁 키 수집 실패(${hintKeys.size})`);
  /** @type {Record<string, unknown>} */
  const koMap = ko;
  /** @type {Record<string, unknown>} */
  const enMap = en;
  assert.deepEqual(
    [...hintKeys].filter((key) => !(key in koMap) || !(key in enMap)).sort(),
    [],
    'ko.js·en.js에 없는 툴팁 키',
  );
});

test('도움말 주제의 title·body와 단축키 설명(shortcut.<action>)이 ko.js·en.js에 있다(D-19)', async () => {
  const { en } = await import('../../src/i18n/en.js');
  const { HELP_TOPICS } = await import('../../src/ui/dialogs/help.js');
  const { SHORTCUTS } = await import('../../src/app/shortcuts.js');
  const keys = [
    ...HELP_TOPICS.flatMap((topic) => [`help.${topic}.title`, `help.${topic}.body`]),
    'help.saving.bodyNative',
    ...SHORTCUTS.map((s) => `shortcut.${s.action}`),
  ];
  /** @type {Record<string, unknown>} */
  const koMap = ko;
  /** @type {Record<string, unknown>} */
  const enMap = en;
  assert.deepEqual(
    keys.filter((key) => !(key in koMap) || !(key in enMap)),
    [],
  );
});

test('툴팁 문구(hint.*)에 키 조합을 적지 않는다: 단축키는 툴팁이 단축키 표에서 붙인다(D-19)', async () => {
  const { en } = await import('../../src/i18n/en.js');
  const { HINT_SHORTCUTS } = await import('../../src/app/shortcuts.js');
  /** @type {string[]} */
  const combos = [];
  for (const [name, map] of /** @type {const} */ ([
    ['ko', ko],
    ['en', en],
  ])) {
    for (const [key, text] of Object.entries(map)) {
      if (!key.startsWith('hint.')) continue;
      if (/\((?:Ctrl|⌘|Cmd|Shift|Alt|Option|F\d{1,2})\b[^)]*\)/.test(String(text))) {
        combos.push(`${name}:${key}`);
      }
    }
  }
  assert.deepEqual(combos, [], '키 조합을 적은 툴팁 문구');
  /** @type {Record<string, unknown>} */
  const koMap = ko;
  /** @type {Record<string, unknown>} */
  const enMap = en;
  assert.deepEqual(
    Object.keys(HINT_SHORTCUTS).filter((key) => !(key in koMap) || !(key in enMap)),
    [],
    'HINT_SHORTCUTS의 툴팁 키',
  );
  assert.ok('tooltip.withShortcut' in koMap && 'tooltip.withShortcut' in enMap);
});
