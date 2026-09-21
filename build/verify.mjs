// @ts-check
/**
 * 산출물 검증(D-01, CLAUDE.md 5.8).
 *
 *  - 외부 참조 0건: http(s) URL, 외부 src=/href=, url(), CSS import 규칙, importScripts().
 *    vendor 코드의 문서 링크 리터럴(정확히 일치)과 XML 네임스페이스 URL(접두사)만 허용한다
 *  - 크기 예산: 6 MiB (DESIGN.md 8장)
 *  - CSP 메타 태그가 정확히 한 번, 첫 스크립트보다 앞에 있고 내용이 D-01과 같음
 *  - 릴리스 산출물에 테스트 훅 이름이 없음
 *  - 브라우저·타우리 변형이 CSP 메타 줄을 빼면 바이트 단위로 같음
 *  - vendor/CHECKSUMS의 SHA-256이 실제 파일과 일치
 *
 * 실패는 빌드 실패로 취급하고 CI가 막는다.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { CSP, CSP_META, DIST_DIR, TEST_HOOK_NAME, VENDOR_DIR } from './build.mjs';

export const SIZE_BUDGET_BYTES = 6 * 1024 * 1024;

/**
 * vendor 코드가 오류 메시지·주석 문자열로 들고 있는 문서 링크. 네트워크 요청을 만들지 않는 리터럴이며
 * 이 목록에 정확히 일치하는 것만 허용한다. 새 항목을 추가하려면 출처를 함께 적는다.
 */
export const ALLOWED_URL_LITERALS = new Set([
  // vendor/sqlite3.mjs: OPFS 설치 실패 안내 메시지와 emscripten/SQLite 라이선스 안내 문자열
  'https://sqlite.org/wasm/doc/trunk/persistence.md#coop-coep',
  'https://emscripten.org:',
  'https://emscripten.org/docs/introducing_emscripten/emscripten_license.html',
  'https://sqlite.org:',
]);

/**
 * XML 네임스페이스 식별자로만 쓰이는 URL 접두사. vendor/xlsx.full.min.js(SheetJS)가 OOXML·ODS·HTML 문서를
 * 읽고 쓸 때 문자열로 비교할 뿐 네트워크 요청을 만들지 않는다. 접두사 아래의 어떤 경로든 허용한다.
 * 새 항목을 추가하려면 출처를 함께 적는다.
 */
export const ALLOWED_URL_PREFIXES = [
  // OOXML 패키지·관계·스프레드시트 네임스페이스(ECMA-376)
  'http://schemas.openxmlformats.org/',
  // SheetJS가 만드는 관계 URI의 접두사(위와 같은 형태로 자체 네임스페이스를 쓴다)
  'http://sheetjs.openxmlformats.org/',
  // Excel 확장 네임스페이스(threadedcomments, richdata, dynamicarray, mac, vbaProject 등)
  'http://schemas.microsoft.com/',
  // XML Schema, XLink, XHTML, RDF, MathML, XForms 등 W3C 네임스페이스
  'http://www.w3.org/',
  // Dublin Core 메타데이터 네임스페이스(docProps/core.xml)
  'http://purl.org/',
  // ISO/IEC 29500 Strict OOXML 네임스페이스
  'http://purl.oclc.org/ooxml/',
  // ODS(OpenDocument) 메타데이터 네임스페이스(OASIS)
  'http://docs.oasis-open.org/ns/office/',
  // OpenOffice.org 확장 네임스페이스(ODS 읽기·쓰기)
  'http://openoffice.org/',
  // VML 스키마 자리표시자 URI(macOS 엑셀). 호스트 이름이 아니라 그대로 쓰이는 식별자다
  'http://macVmlSchemaUri',
];

/**
 * @param {string} html
 * @returns {{ allowedLiterals: number }}
 */
export function assertNoExternalRefs(html) {
  const urlRe = /https?:\/\/[^\s"'`)<>\\]*/g;
  let allowed = 0;
  for (const m of html.matchAll(urlRe)) {
    if (ALLOWED_URL_LITERALS.has(m[0]) || ALLOWED_URL_PREFIXES.some((p) => m[0].startsWith(p))) {
      allowed += 1;
      continue;
    }
    throw new Error(`외부 URL 참조: ${m[0].slice(0, 120)} (offset ${m.index})`);
  }
  const attrRe = /\b(?:src|href)\s*=\s*["']?\s*([^"'\s>]+)/gi;
  for (const m of html.matchAll(attrRe)) {
    const value = m[1];
    if (/^(?:https?:)?\/\//i.test(value) || /^(?:[a-z]+:)?\/\//i.test(value)) {
      throw new Error(`외부 src/href: ${value.slice(0, 120)}`);
    }
  }
  if (/@import\s+(?:url\()?\s*["']?(?:https?:)?\/\//i.test(html))
    throw new Error('CSS @import 외부 참조');
  if (/url\(\s*["']?(?:https?:)?\/\//i.test(html)) throw new Error('CSS url() 외부 참조');
  if (/importScripts\s*\(\s*["'](?:https?:)?\/\//i.test(html))
    throw new Error('importScripts 외부 참조');
  return { allowedLiterals: allowed };
}

/**
 * @param {string} html
 * @param {number} [budget]
 * @returns {number} 바이트 수
 */
export function assertSizeBudget(html, budget = SIZE_BUDGET_BYTES) {
  const bytes = Buffer.byteLength(html, 'utf8');
  if (bytes > budget) {
    throw new Error(`크기 예산 초과: ${bytes} > ${budget} bytes`);
  }
  return bytes;
}

/**
 * CSP 메타 태그가 하나만 있고, 첫 `<script`보다 앞서며, 내용이 D-01과 같아야 한다.
 * @param {string} html
 */
export function assertCsp(html) {
  const metas = [...html.matchAll(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi)];
  if (metas.length !== 1) throw new Error(`CSP 메타 태그 개수: ${metas.length} (1이어야 함)`);
  const [meta] = metas;
  if (meta[0] !== CSP_META)
    throw new Error(`CSP 메타 태그가 D-01과 다름:\n${meta[0]}\n!==\n${CSP_META}`);
  const contentMatch = meta[0].match(/content="([^"]*)"/);
  if (!contentMatch || contentMatch[1] !== CSP) throw new Error('CSP 내용이 D-01과 다름');
  const firstScript = html.search(/<script[\s>]/i);
  if (firstScript !== -1 && (meta.index ?? Infinity) > firstScript) {
    throw new Error('CSP 메타 태그가 첫 <script>보다 뒤에 있음');
  }
}

/**
 * 릴리스 산출물에는 테스트 훅이 없어야 한다(CLAUDE.md 6장).
 * @param {string} html
 */
export function assertNoTestHook(html) {
  if (html.includes(TEST_HOOK_NAME)) {
    throw new Error(`릴리스 산출물에 테스트 훅(${TEST_HOOK_NAME})이 포함됨`);
  }
}

/**
 * 브라우저 변형에서 CSP 메타 줄을 빼면 타우리 변형과 바이트 단위로 같아야 한다(D-01).
 * @param {string} browserHtml
 * @param {string} tauriHtml
 */
export function assertVariantsIdentical(browserHtml, tauriHtml) {
  const stripped = browserHtml.replace(
    new RegExp(`^[ \\t]*${CSP_META.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}\\r?\\n`, 'm'),
    '',
  );
  if (stripped === browserHtml) throw new Error('브라우저 변형에서 CSP 메타 줄을 찾지 못함');
  if (stripped !== tauriHtml) {
    throw new Error('브라우저·타우리 변형이 CSP 메타 태그 외에도 다름');
  }
}

/**
 * vendor/CHECKSUMS의 각 줄(`<sha256>  <파일>`)을 실제 파일과 비교한다.
 * @param {string} [vendorDir]
 * @returns {Promise<string[]>} 검증한 파일 목록
 */
export async function assertVendorChecksums(vendorDir = VENDOR_DIR) {
  const text = await readFile(path.join(vendorDir, 'CHECKSUMS'), 'utf8');
  /** @type {string[]} */
  const checked = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([0-9a-f]{64})\s+\*?(.+)$/);
    if (!m) throw new Error(`CHECKSUMS 형식 오류: ${line}`);
    const [, expected, file] = m;
    const actual = createHash('sha256')
      .update(await readFile(path.join(vendorDir, file)))
      .digest('hex');
    if (actual !== expected) throw new Error(`체크섬 불일치: vendor/${file}`);
    checked.push(file);
  }
  if (checked.length === 0) throw new Error('CHECKSUMS에 항목이 없음');
  return checked;
}

/**
 * dist/의 릴리스 산출물 전체를 검증하고 요약을 돌려준다.
 * @param {string} [distDir]
 * @returns {Promise<{ browserBytes: number, tauriBytes: number, allowedLiterals: number, vendorFiles: string[] }>}
 */
export async function verifyDist(distDir = DIST_DIR) {
  const browserHtml = await readFile(path.join(distDir, 'jdrdatabase.html'), 'utf8');
  const tauriHtml = await readFile(path.join(distDir, 'tauri', 'index.html'), 'utf8');
  const { allowedLiterals } = assertNoExternalRefs(browserHtml);
  const browserBytes = assertSizeBudget(browserHtml);
  const tauriBytes = assertSizeBudget(tauriHtml);
  assertCsp(browserHtml);
  assertNoTestHook(browserHtml);
  assertNoTestHook(tauriHtml);
  assertVariantsIdentical(browserHtml, tauriHtml);
  const vendorFiles = await assertVendorChecksums();
  return { browserBytes, tauriBytes, allowedLiterals, vendorFiles };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isCli) {
  try {
    const r = await verifyDist();
    const mb = (/** @type {number} */ n) => (n / 1024 / 1024).toFixed(2);
    console.log(`verify OK`);
    console.log(
      `  dist/jdrdatabase.html  ${r.browserBytes} bytes (${mb(r.browserBytes)} MiB / budget ${mb(SIZE_BUDGET_BYTES)} MiB)`,
    );
    console.log(`  dist/tauri/index.html  ${r.tauriBytes} bytes`);
    console.log(`  external refs 0, allowed vendor URL literals ${r.allowedLiterals}`);
    console.log(`  vendor checksums OK: ${r.vendorFiles.join(', ')}`);
  } catch (err) {
    console.error(`verify FAILED: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}
