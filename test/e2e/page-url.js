// @ts-check
/**
 * E2E가 여는 산출물 URL. 기본은 테스트 빌드(`dist/test/jdrdatabase.html`)를 `file://`로 연다(CLAUDE.md 6장).
 * `JDR_E2E_HTTP=1`이면 `playwright.config.js`가 `scripts/serve-dist.mjs`를 띄우고 같은 파일을
 * `http://localhost`로 연다(지원 매트릭스의 http 열 실측, Step 10). 두 경우의 차이는 URL뿐이다.
 */
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const DIST_TEST_HTML = path.resolve('dist/test/jdrdatabase.html');
export const HTTP_PORT = Number(process.env.JDR_E2E_HTTP_PORT ?? 4173);
export const USE_HTTP = process.env.JDR_E2E_HTTP === '1';
export const PAGE_URL = USE_HTTP
  ? `http://localhost:${HTTP_PORT}/dist/test/jdrdatabase.html`
  : pathToFileURL(DIST_TEST_HTML).href;
/** 문서 자체의 요청으로 허용하는 접두사(스모크 검사의 "네트워크 요청 0건"). */
export const PAGE_ORIGIN_PREFIX = USE_HTTP ? `http://localhost:${HTTP_PORT}/` : 'file://';
