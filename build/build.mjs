// @ts-check
/**
 * 단일 HTML 빌드(D-01).
 *
 * src/의 ES 모듈을 esbuild로 두 개의 IIFE 번들(메인, Worker)로 접고, CSS와
 * vendor/sqlite3.wasm(base64)을 build/template.html에 끼워 넣어 아래 산출물을 만든다.
 *
 *   dist/jdrdatabase.html        브라우저용(메타 CSP 포함)
 *   dist/tauri/index.html        타우리용(메타 CSP 없음, 나머지 바이트 동일)
 *   dist/test/jdrdatabase.html   --test: E2E용. window.__jdrTest 훅이 켜진 브라우저용 변형
 *
 * 번들링 전에 자체 모듈 그래프 검사(readModuleGraph)를 돌려 import 순환과
 * src/·vendor/ 밖으로 나가는 상대 경로, bare specifier를 빌드 실패로 만든다.
 * 이 파일은 런타임 코드를 import하지 않는다(CLAUDE.md 4장).
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as esbuild from 'esbuild';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SRC_DIR = path.join(ROOT, 'src');
export const VENDOR_DIR = path.join(ROOT, 'vendor');
export const DIST_DIR = path.join(ROOT, 'dist');

export const MAIN_ENTRY = path.join(SRC_DIR, 'main.js');
export const WORKER_ENTRY = path.join(SRC_DIR, 'db', 'worker.js');
/** 산출물에 넣는 CSS. 이 순서로 이어 붙인다(뒤 파일이 앞 파일의 규칙을 덮어쓸 수 있다). */
export const CSS_FILES = ['app.css', 'grid.css'].map((name) => path.join(SRC_DIR, 'styles', name));
export const WASM_FILE = path.join(VENDOR_DIR, 'sqlite3.wasm');
export const TEMPLATE_FILE = path.join(ROOT, 'build', 'template.html');

/** D-01의 CSP. verify.mjs가 산출물의 메타 태그와 이 값을 비교한다. */
export const CSP =
  "default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:; worker-src blob:; style-src 'unsafe-inline'; img-src data:";
export const CSP_META = `<meta http-equiv="Content-Security-Policy" content="${CSP}" />`;

/** 릴리스·테스트 빌드가 노출하는 훅 이름. verify.mjs가 릴리스 산출물에 없음을 확인한다. */
export const TEST_HOOK_NAME = '__jdrTest';

/** @type {{ version: string }} */
const pkg = JSON.parse(await readFile(path.join(ROOT, 'package.json'), 'utf8'));

/**
 * @typedef {object} ModuleGraph
 * @property {string} entry 절대 경로
 * @property {Map<string, string[]>} modules 모듈 절대 경로 → 그 모듈이 import하는 모듈 절대 경로 목록
 * @property {string[]} order 의존성 우선(post-order) 순서
 */

/**
 * @typedef {object} GraphOptions
 * @property {string[]} [roots] import가 머물러야 하는 디렉터리들. 기본 [src/, vendor/]
 * @property {(file: string) => Promise<string>} [readSource] 테스트용 소스 읽기 훅
 */

/** import 문에서 specifier를 뽑는 정규식. 정적 import/export-from과 동적 import()를 모두 본다. */
const IMPORT_RE =
  /(?:^|[^\w$.])(?:import\s*(?:[\w${},*\s]*?\s*from\s*)?|export\s+(?:\*|\{[^}]*\})\s*from\s*|import\s*\()\s*(['"])([^'"\n]+)\1/g;

/**
 * 소스 텍스트에서 import specifier 목록을 뽑는다. 주석 안의 import는 무시한다.
 * @param {string} source
 * @returns {string[]}
 */
export function extractImportSpecifiers(source) {
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  /** @type {string[]} */
  const out = [];
  for (const m of stripped.matchAll(IMPORT_RE)) {
    out.push(m[2]);
  }
  return out;
}

/**
 * 진입점에서 시작해 상대 import를 따라가며 모듈 그래프를 만든다.
 * 순환, 허용 디렉터리 밖 경로, bare specifier는 예외를 던진다.
 * @param {string} entry 절대 또는 ROOT 기준 상대 경로
 * @param {GraphOptions} [options]
 * @returns {Promise<ModuleGraph>}
 */
export async function readModuleGraph(entry, options = {}) {
  const roots = (options.roots ?? [SRC_DIR, VENDOR_DIR]).map((r) => path.resolve(r));
  const readSource = options.readSource ?? ((file) => readFile(file, 'utf8'));
  const entryAbs = path.resolve(ROOT, entry);
  assertInsideRoots(entryAbs, roots, '(entry)');

  /** @type {Map<string, string[]>} */
  const modules = new Map();
  /** @type {string[]} */
  const order = [];
  /** @type {Set<string>} */
  const visiting = new Set();
  /** @type {string[]} */
  const stack = [];

  /** @param {string} file */
  async function visit(file) {
    if (modules.has(file)) return;
    if (visiting.has(file)) {
      const cycle = [...stack.slice(stack.indexOf(file)), file].map(rel).join(' -> ');
      throw new Error(`import 순환: ${cycle}`);
    }
    visiting.add(file);
    stack.push(file);
    const source = await readSource(file);
    /** @type {string[]} */
    const deps = [];
    for (const spec of extractImportSpecifiers(source)) {
      if (!spec.startsWith('./') && !spec.startsWith('../')) {
        throw new Error(`bare import 금지 (런타임 의존성 없음): ${rel(file)} → '${spec}'`);
      }
      const target = path.resolve(path.dirname(file), spec);
      assertInsideRoots(target, roots, rel(file));
      deps.push(target);
    }
    for (const dep of deps) await visit(dep);
    stack.pop();
    visiting.delete(file);
    modules.set(file, deps);
    order.push(file);
  }

  await visit(entryAbs);
  return { entry: entryAbs, modules, order };
}

/**
 * @param {string} target
 * @param {string[]} roots
 * @param {string} from
 */
function assertInsideRoots(target, roots, from) {
  const inside = roots.some((r) => target === r || target.startsWith(r + path.sep));
  if (!inside) {
    throw new Error(
      `허용 디렉터리(${roots.map(rel).join(', ')}) 밖 import: ${from} → ${rel(target)}`,
    );
  }
}

/** @param {string} file */
function rel(file) {
  return path.relative(ROOT, file) || '.';
}

/**
 * @typedef {object} InlineOptions
 * @property {boolean} [minify] 기본 true
 * @property {boolean} [test] `__JDR_TEST__` 값. 기본 false
 */

/**
 * 모듈 그래프의 진입점을 esbuild로 단일 스코프 IIFE 번들로 접는다.
 * vendor/ 모듈에서 나오는 `import.meta` 경고(번들에서는 비어 있음, D-02)는 허용하고
 * 그 밖의 경고는 빌드 실패로 본다.
 * @param {ModuleGraph} graph
 * @param {InlineOptions} [options]
 * @returns {Promise<string>}
 */
export async function inlineImports(graph, options = {}) {
  const result = await esbuild.build({
    entryPoints: [graph.entry],
    bundle: true,
    write: false,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    charset: 'utf8',
    minify: options.minify ?? true,
    legalComments: 'none',
    logLevel: 'silent',
    define: {
      __JDR_TEST__: options.test ? 'true' : 'false',
      __JDR_VERSION__: JSON.stringify(pkg.version),
    },
  });
  const unexpected = result.warnings.filter(
    (w) => !(w.id === 'empty-import-meta' && w.location?.file.startsWith('vendor/')),
  );
  if (unexpected.length > 0) {
    const lines = unexpected.map((w) => `${w.location?.file}:${w.location?.line} ${w.text}`);
    throw new Error(`esbuild 경고를 오류로 취급합니다:\n${lines.join('\n')}`);
  }
  const [file] = result.outputFiles;
  if (!file) throw new Error('esbuild가 출력을 만들지 않았습니다.');
  return file.text;
}

/**
 * 파일을 base64 문자열로 읽는다.
 * @param {string} filePath
 * @returns {Promise<string>}
 */
export async function embedBase64(filePath) {
  const buf = await readFile(filePath);
  return buf.toString('base64');
}

/**
 * `<script>` 블록 안에 안전하게 들어가도록 종료 태그 시퀀스를 이스케이프한다.
 * 번들은 압축되어 `</script`가 문자열·정규식 리터럴 안에서만 나타나므로 `<\/script`로 바꿔도 의미가 같다.
 * @param {string} js
 * @returns {string}
 */
export function escapeScriptBody(js) {
  return js.replace(/<\/script/gi, (m) => `<\\/${m.slice(2)}`).replace(/<!--/g, '<\\!--');
}

/**
 * @typedef {object} TemplateInput
 * @property {string} template build/template.html 내용
 * @property {string} css
 * @property {string} mainJs
 * @property {string} workerJs
 * @property {string} wasmB64
 * @property {boolean} [withCsp] 기본 true. false면 메타 CSP 줄을 통째로 뺀다(타우리 변형)
 */

/**
 * 템플릿의 자리표시자를 채운다. 문자열 split/join을 써서 `$` 같은 치환 특수문자 문제를 피한다.
 * @param {TemplateInput} input
 * @returns {string}
 */
export function renderTemplate(input) {
  const withCsp = input.withCsp ?? true;
  let html = input.template;
  if (withCsp) {
    html = html.split('{{CSP_META}}').join(CSP_META);
  } else {
    // 타우리 변형은 CSP 메타 줄만 통째로 빠지고 나머지 바이트는 같다(verify의 동일성 검사 대상).
    html = html.replace(/^[ \t]*\{\{CSP_META\}\}\r?\n/m, '');
  }
  /** @type {Record<string, string>} */
  const values = {
    '{{CSS}}': input.css.replace(/<\/style/gi, '<\\/style'),
    '{{MAIN_JS}}': escapeScriptBody(input.mainJs),
    '{{WORKER_JS}}': escapeScriptBody(input.workerJs),
    '{{WASM_B64}}': input.wasmB64,
  };
  for (const [key, value] of Object.entries(values)) {
    if (!html.includes(key)) throw new Error(`템플릿에 ${key} 자리표시자가 없습니다.`);
    html = html.split(key).join(value);
  }
  const leftover = html.match(/\{\{[A-Z_]+\}\}/);
  if (leftover) throw new Error(`치환되지 않은 자리표시자: ${leftover[0]}`);
  return html;
}

/**
 * @typedef {object} BuildOptions
 * @property {boolean} [test] 테스트 빌드(dist/test/jdrdatabase.html) 생성
 * @property {string} [outDir] 기본 dist/
 * @property {boolean} [minify] 기본 true
 */

/**
 * @typedef {object} BuildResult
 * @property {Record<string, string>} outputs 변형 이름 → 파일 경로
 * @property {Record<string, number>} sizes 변형 이름 → 바이트 수
 * @property {{ mainJs: number, workerJs: number, wasmB64: number, css: number }} parts 부품 크기(바이트)
 */

/**
 * 산출물을 만든다. `test`가 아니면 브라우저·타우리 두 변형, `test`면 테스트 변형만 만든다.
 * @param {BuildOptions} [options]
 * @returns {Promise<BuildResult>}
 */
export async function writeDist(options = {}) {
  const outDir = options.outDir ?? DIST_DIR;
  const test = options.test ?? false;

  const [mainGraph, workerGraph] = await Promise.all([
    readModuleGraph(MAIN_ENTRY),
    readModuleGraph(WORKER_ENTRY),
  ]);
  const [mainJs, workerJs, css, wasmB64, template] = await Promise.all([
    inlineImports(mainGraph, { minify: options.minify, test }),
    inlineImports(workerGraph, { minify: options.minify, test }),
    Promise.all(CSS_FILES.map((file) => readFile(file, 'utf8'))).then((parts) => parts.join('\n')),
    embedBase64(WASM_FILE),
    readFile(TEMPLATE_FILE, 'utf8'),
  ]);

  const base = { template, css, mainJs, workerJs, wasmB64 };
  /** @type {Record<string, string>} */
  const outputs = {};
  /** @type {Record<string, number>} */
  const sizes = {};

  /**
   * @param {string} name
   * @param {string} file
   * @param {string} html
   */
  async function emit(name, file, html) {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, html, 'utf8');
    outputs[name] = file;
    sizes[name] = Buffer.byteLength(html, 'utf8');
  }

  if (test) {
    await emit(
      'test',
      path.join(outDir, 'test', 'jdrdatabase.html'),
      renderTemplate({ ...base, withCsp: true }),
    );
  } else {
    await emit('browser', path.join(outDir, 'jdrdatabase.html'), renderTemplate(base));
    await emit(
      'tauri',
      path.join(outDir, 'tauri', 'index.html'),
      renderTemplate({ ...base, withCsp: false }),
    );
  }

  return {
    outputs,
    sizes,
    parts: {
      mainJs: Buffer.byteLength(mainJs, 'utf8'),
      workerJs: Buffer.byteLength(workerJs, 'utf8'),
      wasmB64: wasmB64.length,
      css: Buffer.byteLength(css, 'utf8'),
    },
  };
}

/**
 * @param {number} n
 * @returns {string}
 */
function kb(n) {
  return `${(n / 1024).toFixed(1)} KB`;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  const test = process.argv.includes('--test');
  const result = await writeDist({ test });
  for (const [name, file] of Object.entries(result.outputs)) {
    console.log(`${name.padEnd(8)} ${rel(file)}  ${kb(result.sizes[name] ?? 0)}`);
  }
  const p = result.parts;
  console.log(
    `parts    main ${kb(p.mainJs)}, worker ${kb(p.workerJs)}, wasm(b64) ${kb(p.wasmB64)}, css ${kb(p.css)}`,
  );
}
