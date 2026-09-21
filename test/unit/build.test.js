// @ts-check
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import {
  CSP_META,
  escapeScriptBody,
  extractImportSpecifiers,
  readModuleGraph,
  renderTemplate,
  writeDist,
} from '../../build/build.mjs';
import {
  assertCsp,
  assertNoExternalRefs,
  assertNoTestHook,
  assertSizeBudget,
  assertVariantsIdentical,
  assertVendorChecksums,
} from '../../build/verify.mjs';

/**
 * 가상 파일 시스템으로 readModuleGraph를 검사한다.
 * @param {Record<string, string>} files 경로(루트 기준) → 소스
 * @param {string} root
 */
function fakeReader(files, root) {
  return async (/** @type {string} */ file) => {
    const key = path.relative(root, file);
    const src = files[key];
    if (src === undefined) throw new Error(`no such file: ${key}`);
    return src;
  };
}

test('extractImportSpecifiers: 정적·재export·동적 import를 찾고 주석은 무시한다', () => {
  const src = `
    import a from './a.js';
    import { b, c as d } from "../b.js";
    import * as ns from './ns.js';
    import './side.js';
    export { x } from './x.js';
    export * from './y.js';
    const z = await import('./z.js');
    // import ignored from './ignored.js';
    /* import alsoIgnored from './ignored2.js'; */
  `;
  assert.deepEqual(extractImportSpecifiers(src), [
    './a.js',
    '../b.js',
    './ns.js',
    './side.js',
    './x.js',
    './y.js',
    './z.js',
  ]);
});

test("extractImportSpecifiers: 'import' 문자열 리터럴은 import 문이 아니다", () => {
  const src = `
    const reason = state.journalStop === 'import' ? t('toolbar.journalImport') : '';
    const kind = "import";
    import real from './real.js';
  `;
  assert.deepEqual(extractImportSpecifiers(src), ['./real.js']);
});

test('readModuleGraph: 의존성 우선 순서로 모듈을 나열한다', async () => {
  const root = path.resolve('/virtual/src');
  const files = {
    'main.js': "import './a.js'; import './b.js';",
    'a.js': "import './c.js';",
    'b.js': "import './c.js';",
    'c.js': 'export const c = 1;',
  };
  const graph = await readModuleGraph(path.join(root, 'main.js'), {
    roots: [root],
    readSource: fakeReader(files, root),
  });
  assert.deepEqual(
    graph.order.map((f) => path.relative(root, f)),
    ['c.js', 'a.js', 'b.js', 'main.js'],
  );
  assert.equal(graph.modules.size, 4);
});

test('readModuleGraph: import 순환은 실패한다', async () => {
  const root = path.resolve('/virtual/src');
  const files = {
    'main.js': "import './a.js';",
    'a.js': "import './b.js';",
    'b.js': "import './a.js';",
  };
  await assert.rejects(
    readModuleGraph(path.join(root, 'main.js'), {
      roots: [root],
      readSource: fakeReader(files, root),
    }),
    /import 순환: .*a\.js -> .*b\.js -> .*a\.js/,
  );
});

test('readModuleGraph: 허용 디렉터리 밖 상대 경로와 bare import는 실패한다', async () => {
  const root = path.resolve('/virtual/src');
  await assert.rejects(
    readModuleGraph(path.join(root, 'main.js'), {
      roots: [root],
      readSource: fakeReader({ 'main.js': "import '../outside.js';" }, root),
    }),
    /허용 디렉터리.*밖 import/,
  );
  await assert.rejects(
    readModuleGraph(path.join(root, 'main.js'), {
      roots: [root],
      readSource: fakeReader({ 'main.js': "import 'left-pad';" }, root),
    }),
    /bare import 금지/,
  );
});

test('escapeScriptBody: 스크립트 종료 태그와 HTML 주석 시작을 이스케이프한다', () => {
  assert.equal(escapeScriptBody('a="</script><!--"'), 'a="<\\/script><\\!--"');
  assert.equal(escapeScriptBody('"</SCRIPT>"'), '"<\\/SCRIPT>"');
});

test('renderTemplate: 자리표시자를 채우고 타우리 변형은 CSP 줄만 뺀다', () => {
  const template = [
    '<html><head>',
    '    {{CSP_META}}',
    '<style>{{CSS}}</style></head><body>',
    '<script type="text/plain" id="w">{{WORKER_JS}}</script>',
    '<script type="text/plain" id="b">{{WASM_B64}}</script>',
    '<script>{{MAIN_JS}}</script></body></html>',
    '',
  ].join('\n');
  const input = {
    template,
    css: 'body{}',
    mainJs: 'x("</script>")',
    workerJs: 'w()',
    wasmB64: 'AAAA',
  };
  const browser = renderTemplate(input);
  const tauri = renderTemplate({ ...input, withCsp: false });
  assert.ok(browser.includes(CSP_META));
  assert.ok(browser.includes('x("<\\/script>")'));
  assert.ok(!tauri.includes('Content-Security-Policy'));
  assert.doesNotThrow(() => assertVariantsIdentical(browser, tauri));
  assert.throws(
    () => renderTemplate({ ...input, template: '<html>{{CSS}}' }),
    /자리표시자가 없습니다/,
  );
});

test('verify 검사기: 외부 참조·크기·CSP·테스트 훅을 각각 잡아낸다', () => {
  assert.throws(() => assertNoExternalRefs('<script src="https://cdn.example.com/x.js">'), /외부/);
  assert.throws(
    () => assertNoExternalRefs('<link href="//cdn.example.com/a.css">'),
    /외부 src\/href/,
  );
  assert.throws(
    () => assertNoExternalRefs('<style>@import url(https://x.y/a.css)</style>'),
    /외부/,
  );
  assert.throws(() => assertNoExternalRefs('body{background:url(//x.y/a.png)}'), /url\(\) 외부/);
  assert.throws(() => assertNoExternalRefs('importScripts("https://x.y/w.js")'), /외부/);
  assert.deepEqual(assertNoExternalRefs('<html>"https://sqlite.org:"</html>'), {
    allowedLiterals: 1,
  });
  assert.equal(assertSizeBudget('abc', 3), 3);
  assert.throws(() => assertSizeBudget('abcd', 3), /크기 예산 초과/);
  assert.throws(() => assertCsp('<html><script></script></html>'), /개수: 0/);
  assert.throws(() => assertCsp(`<html><script></script>${CSP_META}</html>`), /뒤에 있음/);
  assert.throws(
    () => assertCsp('<meta http-equiv="Content-Security-Policy" content="default-src *" />'),
    /D-01과 다름/,
  );
  assert.doesNotThrow(() => assertCsp(`<head>${CSP_META}</head><script></script>`));
  assert.throws(() => assertNoTestHook('window.__jdrTest = 1'), /테스트 훅/);
});

test('writeDist: 실제 산출물이 만들어지고 verify를 통과한다', async () => {
  const outDir = await mkdtemp(path.join(os.tmpdir(), 'jdr-dist-'));
  try {
    const release = await writeDist({ outDir });
    const browser = await readFile(release.outputs.browser ?? '', 'utf8');
    const tauri = await readFile(release.outputs.tauri ?? '', 'utf8');
    assertNoExternalRefs(browser);
    assertSizeBudget(browser);
    assertCsp(browser);
    assertNoTestHook(browser);
    assertNoTestHook(tauri);
    assertVariantsIdentical(browser, tauri);
    assert.ok(browser.includes('id="jdr-worker-src"'));
    assert.ok(browser.includes('id="jdr-wasm-b64"'));
    assert.ok(release.parts.wasmB64 > 100_000, 'wasm base64가 인라인되어야 한다');

    const testBuild = await writeDist({ outDir, test: true });
    const testHtml = await readFile(testBuild.outputs.test ?? '', 'utf8');
    assert.ok(testHtml.includes('__jdrTest'), '테스트 빌드는 훅을 노출한다');
    assertCsp(testHtml);
  } finally {
    await rm(outDir, { recursive: true, force: true });
  }
});

test('vendor/CHECKSUMS가 실제 파일과 일치한다', async () => {
  const files = await assertVendorChecksums();
  assert.ok(files.includes('sqlite3.wasm'));
  assert.ok(files.includes('sqlite3.mjs'));
});
