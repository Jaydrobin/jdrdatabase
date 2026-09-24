# 지원 매트릭스 (실측)

브라우저·WebView API 가용성은 추정하지 않고 실측한 결과만 적는다(CLAUDE.md 9장, DESIGN.md R1·R8). 확인하지 못한 칸은 "미확인"이다.

측정 방법: `npm run test:e2e`가 `dist/test/jdrdatabase.html`을 `file://`로 열어 확인한다(Playwright 1.56.0). `JDR_E2E_HTTP=1 npm run test:e2e`는 같은 파일을 `scripts/serve-dist.mjs`의 `http://localhost`로 열어 같은 검사를 돌린다(세션 H). 다른 브라우저는 같은 파일을 손으로 열어 상태바와 콘솔을 본다.

Firefox·Safari(WebKit) 열은 세션 H에서도 채우지 못했다. Playwright의 브라우저 다운로드(`playwright.download.prss.microsoft.com`, `cdn.playwright.dev`)가 이 실행 환경의 송신 정책에 막혀(HTTP 403) 설치할 수 없었다. 손으로 확인하는 절차: 릴리스의 `jdrdatabase.html`을 해당 브라우저로 열어 (1) 상태바가 "준비됨 · Worker 모드 · SQLite 3.x"인지, (2) 새 테이블·열·셀 편집 뒤 저장(다운로드)과 다시 열기가 되는지, (3) 가져오기 대화상자에서 `test/fixtures/import/euc-kr.csv`의 미리보기가 깨지지 않는지, (4) 설정에서 압축 저장을 켜고 저장한 `.db.gz`가 다시 열리는지 보고, 콘솔의 `E_*` 경고를 아래 표의 해당 칸에 적는다.

## 브라우저 모드 (`file://`로 직접 연 문서)

같은 산출물을 `http://localhost:4173`(`scripts/serve-dist.mjs`)로 열어도 E2E 65개(스모크의 "요청 0건" 검사는 문서 원점만 허용)가 전부 통과했다(세션 H, Chromium 141). 아래 Chromium 열의 ✓는 `file://`와 `http://localhost` 둘 다에 해당한다. `https://` 원점은 미확인이다(IndexedDB·Worker·Blob URL은 원점 종류와 무관하지만 실측하지 않았다).

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
| `CompressionStream('gzip')`·`DecompressionStream('gzip')` + `Blob.stream().pipeThrough()` + `new Response(stream).arrayBuffer()` (`.db.gz` 저장·열기) | ✓ (세션 G, E2E `export.spec.js`: 설정에서 압축 저장을 켜고 다운로드한 파일이 gzip 매직 `1f 8b`로 시작하고, `<input type="file">`로 다시 열면 같은 db_id·revision·데이터) | 미확인 | 미확인 | 미확인 |
| `<a download>`로 내려받는 파일 이름에 비ASCII(한글)가 있을 때 | 헤드리스에서 Playwright의 `download.suggestedFilename()`이 `download`로 온다(실측. 앱은 `src.csv`처럼 ASCII 이름이면 그대로). 실제 브라우저에서 한글 파일 이름이 유지되는지는 미확인. E2E는 ASCII 테이블 이름으로 검사한다 | 미확인 | 미확인 | 미확인 |
| 내보내기: Worker가 보내는 조각 이벤트(`{ id, chunk }`, transfer)를 메인이 모아 `<a download>`로 내려받기 → 그 CSV·XLSX를 가져오기 입력으로 다시 열기 | ✓ (세션 G, E2E `export.spec.js`: CSV·XLSX 왕복에서 타입·값 동일). FSA 경로의 `createWritable()` 싱크(조각 순서 쓰기·`abort()`)는 헤드리스에서 미확인 | 미확인 | 미확인 | 미확인 |
| 구조화 복제로 Worker에 넘긴 `File`의 `stream()` → `TextDecoderStream('utf-8' \| 'utf-16le' \| 'utf-16be' \| 'euc-kr')`로 209 MB CSV 스트리밍 파싱, `slice().arrayBuffer()`로 머리 64 KB 읽기 | ✓ (세션 F, E2E `import.spec.js`(EUC-KR·UTF-8 BOM)와 `test/perf/import.perf.spec.js`(30만 행 209 MB, Worker 모드 18.0초)) | 미확인 | 미확인 | 미확인 |
| Worker 안의 SheetJS CE 0.18.12(`XLSX.read`, dense, cellDates)로 xlsx 파싱과 `Blob.arrayBuffer()` | ✓ (세션 F, E2E `import.spec.js`(시트 2개·병합·오류 셀·수식·1904 픽스처)와 `test/perf/import-xlsx.perf.spec.js`) | 미확인 | 미확인 | 미확인 |
| 가져오기 대화상자: 숨은 `<input type="file" accept=".csv,.tsv,.txt,.xlsx,.xlsm">` + `<progress>` + 비동기 검사 중 버튼 잠금·취소 가로채기 | ✓ (세션 F, E2E `import.spec.js`. 실제 파일 선택기와 취소 버튼 클릭 자체는 미확인: 단위 테스트가 `AbortSignal` 경로를 검사) | 미확인 | 미확인 | 미확인 |
| 그리드가 쓰는 `ResizeObserver`, Pointer Events(`setPointerCapture`로 열 너비 끌기), `performance.mark/measure`(테스트 빌드의 렌더 시간) | ✓ (세션 C, E2E `grid.spec.js`·`test/perf/grid.perf.spec.js`) | 미확인 | 미확인 | 미확인 |
| 300 MB DB(30만 행)를 `<input type="file">`로 열기 | ✓ (세션 C, `test:perf`: 읽기 → transfer → deserialize → integrity_check까지 약 2~3초) | 미확인 | 미확인 | 미확인 |
| 클립보드: `navigator.clipboard.writeText`(복사), 포커스된 비편집 요소(`role="grid"` div)에 오는 `paste` 이벤트(Ctrl+V), `window.isSecureContext` | ✓ (세션 D, E2E `edit.spec.js`. `file://`도 secure context이며 Playwright가 `clipboard-read`·`clipboard-write` 권한을 준 컨텍스트에서 실제 Ctrl+C·Ctrl+V로 확인). 권한 프롬프트가 있는 실제 브라우저에서의 동작은 미확인 | 미확인 | 미확인 | 미확인 |
| 한글 IME 조합 중 Enter 무시(`isComposing`) | 시뮬레이션만 ✓ (세션 D, 합성 `compositionstart/end` + `isComposing: true` keydown). 실제 IME는 헤드리스에서 미확인 | 미확인 | 미확인 | 미확인 |
| FTS5 external-content 테이블 + `AFTER UPDATE OF` 트리거 + `{ index }` 청크 인덱싱을 Blob Worker 안에서 커맨드(트랜잭션) 하나로 만들고 되돌리기 | ✓ (세션 E, E2E `view.spec.js`: 인덱스 생성 → 셀 편집이 인덱스를 따라감 → Ctrl+Z로 인덱스 삭제 → Ctrl+Y로 재생성) | 미확인 | 미확인 | 미확인 |
| `<input type="search">`의 `input`·`compositionend`로 검색어 디바운스(조합 중 `InputEvent.isComposing` 무시) | 디바운스만 ✓ (세션 E, `fill` 뒤 300 ms 안에 반영). 실제 IME 조합 중의 동작은 미확인 | 미확인 | 미확인 | 미확인 |
| 기동 뒤 Worker의 `error` 이벤트(처리되지 않은 예외)와 `terminate()` → client가 이후 RPC를 즉시 거부, 앱 잠금(저널 상태 안내) → 새로 고침 → 저널 복구 제안 | ✓ (세션 H, E2E `fault.spec.js`: `Worker` 생성자를 감싸 인스턴스에 `ErrorEvent`를 보내고 종료) | 미확인 | 미확인 | 미확인 |
| `indexedDB` 접근이 던지는 환경 → `E_ENV_NO_IDB` 상태바 안내, 저널·백업 없이 새 테이블·저장(다운로드) 동작 | ✓ (세션 H, E2E `fault.spec.js`: `indexedDB` getter가 던지게 주입) | 미확인 | 미확인 | 미확인 |
| FSA 핸들의 `createWritable().write()` 실패 → `E_FILE_WRITE`, 원본·dirty·저널 유지, 다음 저장이 모든 변경을 담음 | ✓ (세션 H, E2E `fault.spec.js`: 가짜 `showSaveFilePicker`·핸들 주입. 실제 FSA 핸들의 실패는 미확인) | 미확인 | 미확인 | 미확인 |
| axe(WCAG 2.1 A·AA) critical·serious 0건: 빈 앱, 그리드, 대화상자 7종, 장문·인라인 편집기, 가져오기 결과 | ✓ (세션 H, E2E `a11y.spec.js`, `@axe-core/playwright` 4.13.0) | 해당 없음(정적 검사) | 해당 없음 | 해당 없음 |
| 툴팁(D-19): 비활성(`disabled`) 버튼 위의 포인터 이벤트 | ✓ 이벤트가 온다(세션 P: Chromium 141은 꺼진 버튼에도 `pointerover`·`pointerenter`·`mouseover`를 대상 버튼으로 낸다. 그래서 꺼진 버튼에도 툴팁이 보인다. E2E `help.spec.js`의 "뷰 삭제"). 키보드로는 꺼진 버튼에 포커스가 가지 않으므로 툴팁을 볼 수 없다(도움말 "테이블·열·빈 행" 주제가 꺼진 까닭을 설명) | 미확인 | 미확인 | 미확인 |
| 도움말 단축키 F1: 문서의 `keydown`으로 오고 `preventDefault()`로 앱이 가져감 | ✓ 도움말이 열린다(세션 P, E2E `help.spec.js`). 모든 처리기가 돈 뒤의 `defaultPrevented`가 대화상자 없음·도움말이 떠 있음·설정이 떠 있음·인라인 셀 편집 중·머리글 이름 편집 중의 다섯 경우 모두 `true`다(세션 P 리뷰 수정, E2E "F1: 대화상자가 떠 있어도…"). 수정 전에는 모달이 떠 있거나 셀 편집 중이면 `false`였다. 헤드리스라 `preventDefault()`가 실제 Chrome의 도움말 탭을 막는지는 볼 수 없다(미확인) | 미확인 | 미확인 | 미확인 |
| 시크릿(off-the-record) 프로필의 IndexedDB 수명(D-18) | ✓ (세션 P, Playwright `browser.newContext()`는 off-the-record 컨텍스트다): 같은 컨텍스트의 다른 탭에서는 IDB 값이 보이고, 컨텍스트를 닫은 뒤 새 컨텍스트에서는 스토어가 없다. 즉 시크릿 창을 모두 닫으면 저널·직전 저장본이 함께 사라진다. 실제 Chrome 시크릿 창에서 손으로 확인하지는 않았다 | 미확인 | 미확인 | 미확인 |
| CDP `SystemInfo.getProcessInfo` + `/proc/<pid>/status`로 렌더러 RSS, `HeapProfiler.collectGarbage` + `Performance.getMetrics`로 JS 힙 측정 | ✓ (세션 H, `test/perf/app.perf.spec.js`·`memory.perf.spec.js`. Linux 전용) | 해당 없음(측정 도구) | 해당 없음 | 해당 없음 |

## 데스크톱 모드 (타우리 WebView)

측정 방법: `npm run test:desktop`(`test/desktop/run.mjs`)이 테스트 변형(`dist/test/tauri/index.html`)을 담은 디버그 바이너리를 tauri-driver로 띄워 WebDriver로 검사한다. Linux는 세션 I가 이 실행 환경(Ubuntu 24.04, WebKitGTK 2.52.6, Xvfb, `WEBKIT_DISABLE_COMPOSITING_MODE=1`·`WEBKIT_DISABLE_DMABUF_RENDERER=1`)에서, Windows는 세션 M이 CI `desktop` 잡(`windows-latest`, WebView2 런타임 152.0.4191.66과 같은 버전의 Edge Driver)에서 실측했다. 앱은 Edge Driver가 주는 WebView2 환경 변수를 메인 창에 넘긴다(`src-tauri/src/lib.rs`의 `create_main_window`). macOS는 tauri-driver가 지원하지 않아 CI가 빌드만 하므로 미확인이다.

| 기능 | Windows WebView2 | macOS WKWebView | Linux WebKitGTK 2.52 |
|---|---|---|---|
| 타우리 전역 객체(`__TAURI_INTERNALS__`)로 데스크톱 모드 판정, 상태바 "데스크톱 모드" | ✓ (세션 M) | 미확인 | ✓ (세션 I) |
| Blob URL Worker 안에서 `jdr://localhost/call` 커스텀 프로토콜에 동기 XHR·fetch(엔진 프로토콜, D-15) | ✓ (세션 M: `http://jdr.localhost/call` 형태. Worker 안 `SELECT 1`, FTS5 trigram 한글 부분 일치) | 미확인 | ✓ (세션 I: Worker 안 `SELECT 1`, FTS5 trigram 한글 부분 일치) |
| `SharedArrayBuffer`·`crossOriginIsolated`(`app.security.headers`의 COOP/COEP) | ✓ `crossOriginIsolated: true`, `SharedArrayBuffer` 있음(세션 M). 엔진은 그래도 프로토콜 경로가 기본이다 | 미확인 | ✗ `crossOriginIsolated: false`, `SharedArrayBuffer` 없음(세션 I). 공유 버퍼 중계 폴백은 쓰이지 않고 프로토콜 경로로 동작 |
| 작업 사본 열기 → 편집 → `db.save`(VACUUM INTO → `.bak` → rename) → 다시 열기 | ✓ (세션 M: 한글 폴더·파일 이름, revision 1 → 2, `.bak` 생성) | 미확인 | ✓ (세션 I: 한글 폴더·파일 이름, revision 1 → 2, `.bak` 생성) |
| `.bak` 복원(러스트 `restore_backup`) | ✓ (세션 M) | 미확인 | ✓ (세션 I) |
| 원본 변경 감지(`E_ORIGINAL_CHANGED`) → 대화상자 → 취소 | ✓ (세션 M) | 미확인 | ✓ (세션 I: 대화상자의 "취소" 버튼 클릭까지) |
| 파일 대화상자(dialog 플러그인 `pick_open`·`pick_save`) | 미확인 | 미확인 | 미확인(자동화 불가. E2E는 테스트 훅으로 경로를 넣는다) |
| 내보내기 경로 싱크(`sink_write` raw 본문) | 미확인 | 미확인 | 미확인(WebView에서 실측하지 않음. Node `test:native`가 JSON 경로로 코어 싱크를 검사) |
| IndexedDB(`known_revisions`·설정), BroadcastChannel | ✓ (세션 M: 둘 다 true) | 미확인 | ✓ (세션 I: 테스트 훅 `idbAvailable()`·`tabLockAvailable()` 둘 다 true) |
| 비정상 종료로 남은 dirty 작업 사본: 시작 안내, 설정의 작업 사본 목록에서 키보드로 버리기·열어서 복구 | ✓ (세션 M) | 미확인 | ✓ (세션 L) |
| 도움말(D-19): 저장 주제가 데스크톱 문구(작업 사본·`.bak`), Esc로 닫으면 도움말 버튼으로 포커스 복귀 | 미확인(`desktop` 워크플로의 Windows 잡이 같은 시나리오를 돌린다) | 미확인 | ✓ (세션 P, `test/desktop/run.mjs` 7번) |
| 툴팁: 키보드 포커스(`:focus-visible`)로 즉시 표시와 `aria-describedby` | 미확인 | 미확인 | ✓ (세션 P: WebDriver Shift+Tab) |
| 도움말 단축키 F1이 WebView에서 문서로 옴 | 미확인 | 미확인 | ✓ 도움말이 열린다(세션 P, WebDriver 키 입력) |
| 비활성 버튼 위의 포인터 이벤트(툴팁 표시) | 미확인 | 미확인 | ✓ 툴팁이 보인다(세션 P: WebDriver 포인터 이동을 꺼진 "되돌리기" 위로) |
| 두 번째 인스턴스 실행(single-instance 플러그인) | 미확인 | 미확인 | 미확인 |
