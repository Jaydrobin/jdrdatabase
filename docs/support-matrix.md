# 지원 매트릭스 (실측)

브라우저·WebView API 가용성은 추정하지 않고 실측한 결과만 적는다(CLAUDE.md 9장, DESIGN.md R1·R8). 확인하지 못한 칸은 "미확인"이다.

측정 방법: `npm run test:e2e`가 `dist/test/jdrdatabase.html`을 `file://`로 열어 확인한다(Playwright 1.56.0). 다른 브라우저는 같은 파일을 손으로 열어 상태바와 콘솔을 본다.

## 브라우저 모드 (`file://`로 직접 연 문서)

| 기능 | Chromium 141 (Playwright headless, Linux) | Chrome/Edge 데스크톱 | Firefox | Safari |
|---|---|---|---|---|
| Blob URL Worker 생성·기동 | ✓ (세션 A, E2E `engine.spec.js`) | 미확인 | 미확인 | 미확인 |
| WebAssembly 인스턴스화, CSP `script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:` | ✓ (세션 A). `'wasm-unsafe-eval'` 없이는 `CompileError: Refused to compile or instantiate WebAssembly module` | 미확인 | 미확인 | 미확인 |
| SQLite Wasm 3.53.4 기동, FTS5 trigram 질의 | ✓ (세션 A, E2E `engine.spec.js`가 Worker 안에서 `CREATE VIRTUAL TABLE … tokenize='trigram'` 후 한글 부분 일치 질의까지 실행) | 미확인 | 미확인 | 미확인 |
| Worker 없이 메인 스레드에서 엔진 실행(인라인 전송) | ✓ (세션 A, E2E 인라인 모드) | 미확인 | 미확인 | 미확인 |
| 런타임 네트워크 요청 0건 | ✓ (세션 A, 문서와 Worker Blob URL 외 요청 없음) | 미확인 | 미확인 | 미확인 |
| IndexedDB | 미확인 (세션 B) | 미확인 | 미확인 | 미확인 |
| File System Access API (`showOpenFilePicker`, `createWritable`) | 해당 없음(헤드리스 자동화 불가). 폴백 경로로 검사 (세션 B) | 미확인 | 미지원(폴백) | 미지원(폴백) |
| `CompressionStream` (gzip 저장) | 미확인 (세션 G) | 미확인 | 미확인 | 미확인 |

## 데스크톱 모드 (타우리 WebView)

| 기능 | Windows WebView2 | macOS WKWebView | Linux WebKitGTK |
|---|---|---|---|
| 전부 | 미확인 (세션 I) | 미확인 (세션 I) | 미확인 (세션 I) |
