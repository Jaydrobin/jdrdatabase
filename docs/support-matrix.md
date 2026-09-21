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
| IndexedDB (`file://` 오리진에서 열기, journal·known_revisions·backups·settings 스토어) | ✓ (세션 B, E2E `file.spec.js`가 `openIdb()` 성공과 저널 기록 → 재시작 → 복구 대화상자까지 확인) | 미확인 | 미확인 | 미확인 |
| File System Access API (`showOpenFilePicker`, `createWritable`) | 해당 없음(헤드리스에서 선택기 자동화 불가). `addInitScript`로 API를 감춰 폴백 경로(`<input type="file">` + `<a download>`)만 검사 (세션 B) | 미확인 | 미지원(폴백) | 미지원(폴백) |
| `<a download>` 저장 → 내려받은 파일을 `<input type="file">`로 다시 열기 | ✓ (세션 B, E2E `file.spec.js`: revision·db_id 왕복). Playwright 주의: `setInputFiles`에 비ASCII 경로를 주면 Chromium이 change 없이 무시하고, filechooser 가로채기는 change 대신 cancel을 내는 경우가 있어 둘 다 피했다 | 미확인 | 미확인 | 미확인 |
| BroadcastChannel (같은 db_id를 연 다른 탭 감지) | ✓ 생성 가능 (세션 B, E2E `file.spec.js`). 두 탭 동시 열기 시나리오는 미확인 | 미확인 | 미확인 | 미확인 |
| `CompressionStream` (gzip 저장) | 미확인 (세션 G) | 미확인 | 미확인 | 미확인 |
| 그리드가 쓰는 `ResizeObserver`, Pointer Events(`setPointerCapture`로 열 너비 끌기), `performance.mark/measure`(테스트 빌드의 렌더 시간) | ✓ (세션 C, E2E `grid.spec.js`·`test/perf/grid.perf.spec.js`) | 미확인 | 미확인 | 미확인 |
| 300 MB DB(30만 행)를 `<input type="file">`로 열기 | ✓ (세션 C, `test:perf`: 읽기 → transfer → deserialize → integrity_check까지 약 2~3초) | 미확인 | 미확인 | 미확인 |
| 클립보드: `navigator.clipboard.writeText`(복사), 포커스된 비편집 요소(`role="grid"` div)에 오는 `paste` 이벤트(Ctrl+V), `window.isSecureContext` | ✓ (세션 D, E2E `edit.spec.js`. `file://`도 secure context이며 Playwright가 `clipboard-read`·`clipboard-write` 권한을 준 컨텍스트에서 실제 Ctrl+C·Ctrl+V로 확인). 권한 프롬프트가 있는 실제 브라우저에서의 동작은 미확인 | 미확인 | 미확인 | 미확인 |
| 한글 IME 조합 중 Enter 무시(`isComposing`) | 시뮬레이션만 ✓ (세션 D, 합성 `compositionstart/end` + `isComposing: true` keydown). 실제 IME는 헤드리스에서 미확인 | 미확인 | 미확인 | 미확인 |
| FTS5 external-content 테이블 + `AFTER UPDATE OF` 트리거 + `{ index }` 청크 인덱싱을 Blob Worker 안에서 커맨드(트랜잭션) 하나로 만들고 되돌리기 | ✓ (세션 E, E2E `view.spec.js`: 인덱스 생성 → 셀 편집이 인덱스를 따라감 → Ctrl+Z로 인덱스 삭제 → Ctrl+Y로 재생성) | 미확인 | 미확인 | 미확인 |
| `<input type="search">`의 `input`·`compositionend`로 검색어 디바운스(조합 중 `InputEvent.isComposing` 무시) | 디바운스만 ✓ (세션 E, `fill` 뒤 300 ms 안에 반영). 실제 IME 조합 중의 동작은 미확인 | 미확인 | 미확인 | 미확인 |

## 데스크톱 모드 (타우리 WebView)

| 기능 | Windows WebView2 | macOS WKWebView | Linux WebKitGTK |
|---|---|---|---|
| 전부 | 미확인 (세션 I) | 미확인 (세션 I) | 미확인 (세션 I) |
