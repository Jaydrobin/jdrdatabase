# CLAUDE.md

이 파일은 이 저장소에서 작업하는 Claude Code(그리고 사람 기여자)를 위한 작성 규약과 코드 점검 지침이다. 설계 결정과 구현 순서는 `DESIGN.md`가 정본이며, 이 파일은 "어떻게 쓰고 어떻게 검사하는가"만 다룬다.

## 1. 프로젝트 한 줄 요약

서버 없이 브라우저에서 단독 동작하는 스프레드시트형 SQLite 데이터베이스 관리 앱. 배포 단위는 `dist/jdrdatabase.html` 파일 하나이며, 같은 소스로 타우리 데스크톱 앱도 빌드한다. 엔진은 브라우저 모드에서 공식 SQLite Wasm(`@sqlite.org/sqlite-wasm`), 데스크톱 모드에서 러스트 rusqlite이고, UI는 프레임워크 없는 Vanilla JS, 저장은 표준 SQLite 파일.

## 2. 작업 시작 전 필독

1. `DESIGN.md` 2장(핵심 설계 결정 D-01 ~ D-15). 결정과 어긋나는 코드는 리뷰에서 반려된다.
2. `DESIGN.md` 5.0의 세션 구성표에서 지금 맡은 세션과 그 Step들을 확인하고, 각 Step의 "주요 함수 / 예외 처리 / 완료 기준"을 읽는다.
3. 이 파일 전체.

설계 결정을 바꿔야 한다고 판단되면 코드보다 먼저 `DESIGN.md`의 해당 D-항목을 고치고 사유를 적는다. 코드와 설계 문서가 어긋난 상태로 PR을 올리지 않는다.

## 3. 명령어

Step 0 완료 후 아래 스크립트가 `package.json`에 존재해야 하며, 이름을 바꾸지 않는다.

```
npm run check        # lint + typecheck + unit 테스트 (PR 전 필수)
npm run lint         # eslint
npm run typecheck    # tsc --checkJs --noEmit
npm test             # node:test, test/unit/**/*.test.js (scripts/run-unit-tests.mjs)
npm run build        # dist/jdrdatabase.html 생성
npm run verify       # 산출물 검증: 외부 참조 0건, 크기 예산, CSP
npm run test:e2e     # playwright (dist를 file://로 열어 검사)
npm run fixture -- --rows 300000   # 벤치마크용 CSV 생성 (--db를 주면 SQLite DB 생성)
npm run test:perf    # 성능 측정: 30만 행 DB 픽스처를 만들고 Playwright로 렌더·질의 시간 측정 (CI의 perf 잡에서도 돈다. 6장)
npm run test:native  # 실제 rusqlite 엔진(core의 jdr-ipc-stdio)에 대해 엔진 적합성 테스트 (Step 11 이후, Rust 필요)
npm run test:desktop # tauri-driver E2E (Step 11 이후. Linux: WebKitWebDriver + Xvfb, Windows: Edge Driver)
npm run tauri:dev    # 데스크톱 개발 실행 (Step 11 이후)
npm run tauri:build  # 데스크톱 설치본 빌드 (Step 11 이후)
cargo test --manifest-path src-tauri/Cargo.toml --workspace   # 러스트 단위 테스트 (Step 11 이후. WebKitGTK 없는 환경은 `-p jdr-core`만)
```

Node.js 20 이상. 런타임 npm 의존성은 없다. `devDependencies`만 허용된다. 데스크톱 빌드는 Rust stable과 Tauri 2 CLI가 추가로 필요하다.

## 4. 디렉터리 규약

`DESIGN.md` 3.1절의 구조를 따른다. 요약:

| 경로 | 규칙 |
|---|---|
| `src/db/*` | Worker에서 실행되는 코드. DOM, `window`, `document`에 접근하지 않는다. `engine-wasm.js`·`engine-native.js` 외의 모듈은 `engine.js` 인터페이스만 호출하고 `sqlite3` 객체나 타우리 invoke를 직접 부르지 않는다 |
| `src/import/*`, `src/export/*` | Worker에서 실행. `DOMParser` 등 메인 스레드 전용 API 금지 |
| `src/ui/*`, `src/app/*`, `src/io/*` | 메인 스레드. `sqlite3` 객체를 직접 호출하지 않고 `db/client.js`만 사용한다. 타우리 invoke는 `io/ipc-bridge.js`와 `io/filesystem.js`에서만 부른다. Worker 쪽에서 러스트를 부르는 곳은 `db/engine-native.js`(앱의 엔진 프로토콜 `jdr://localhost/call`)뿐이다 |
| `src-tauri/` | 러스트 데스크톱 셸. 엔진·저장·작업 사본 로직은 타우리에 의존하지 않는 `core/`(`jdr-core`)의 `db.rs`·`save.rs`·`workcopy.rs`에 두고, 앱 크레이트의 `commands.rs`는 그 함수를 `#[tauri::command]`로 감쌀 뿐이다. 오류는 `error.rs`의 `AppError`로만 돌려준다. 타우리 API(`tauri::`, 플러그인)는 앱 크레이트에서만 쓴다 |
| `src/util/*` | 양쪽에서 쓰는 순수 함수만. 부수효과 금지 |
| `vendor/` | 서드파티 고정 버전. 수정 금지. 파일마다 LICENSE와 `CHECKSUMS`의 SHA-256 동반 |
| `build/` | 빌드·검증 스크립트. 런타임 코드 import 금지 |
| `test/unit/` | `*.test.js`, 대상 모듈과 같은 상대 경로 |
| `test/fixtures/` | 1 MB 이하만 커밋. 큰 픽스처는 `scripts/gen-fixture.mjs`로 생성 |

새 디렉터리를 만들 때는 `DESIGN.md` 3.1절도 함께 갱신한다.

## 5. 코딩 규약

### 5.1 언어와 타입

- ES2022 모듈(`import`/`export`). CommonJS 금지.
- 모든 export 함수·클래스에 JSDoc 타입을 쓴다. `@param`, `@returns`, 복합 타입은 `@typedef`. `any`는 금지하며 불가피하면 `unknown` 후 좁힌다.
- `tsc --checkJs --strict`가 0 오류여야 한다. `// @ts-ignore`는 사유 주석 없이 쓰지 않는다.
- 전역 변수 금지. 상태는 `app/store.js`의 스토어 또는 모듈 스코프 클로저에 둔다.
- 비동기는 `async/await`. 콜백 스타일 금지. 잊힌 Promise(`floating promise`)는 린트로 막는다.

### 5.2 네이밍

- 파일: `kebab-case.js`. 클래스: `PascalCase`. 함수·변수: `camelCase`. 상수: `UPPER_SNAKE_CASE`.
- 물리 DB 식별자: 테이블 `t_<8hex>`, 열 `c_<8hex>`, 메타 테이블 `_jdr_*`. 이 접두사는 `util/ids.js`와 `db/schema.js`에만 문자열로 존재한다.
- 오류 코드: `E_<영역>_<원인>` (예: `E_FILE_CORRUPT`). 목록은 `util/errors.js` 한 곳에서만 정의하고 `DESIGN.md` 7장과 일치시킨다.
- 이벤트 이름: `<영역>:<동사과거>` (예: `table:created`, `file:saved`).
- RPC op: `<모듈>.<동사>` (예: `query.window`). `DESIGN.md` 6장의 표와 일치.

### 5.3 SQL 규칙 (가장 중요)

- 값은 **항상 파라미터 바인딩**(`?` 또는 `:name`)으로 넘긴다. 문자열 연결로 값을 SQL에 넣는 코드는 즉시 반려.
- 식별자(테이블·열 이름)는 `schema.quoteIdent()`를 통해서만 SQL에 넣는다. 물리 이름은 앱이 생성하므로 안전하지만 규칙은 예외 없이 적용한다.
- 전체 테이블을 한 번에 읽는 `SELECT`는 금지. 모든 읽기는 `LIMIT`이 있어야 하며 결과 1만 행 초과는 Worker가 거부한다.
- 쓰기는 `engine.transaction()` 안에서만. 트랜잭션 밖의 `INSERT/UPDATE/DELETE`는 반려.
- `snapshot()`은 statement 캐시를 비우고 PRAGMA를 재적용한다. `snapshot()` 뒤에 캐시된 statement를 재사용하지 말고, statement를 모듈 변수에 캐시하지 말고 `engine.prepareCached()`만 쓴다. `sqlite3_js_db_export`를 `snapshot()` 바깥에서 직접 부르지 않는다.
- 대량 삽입·갱신(가져오기, 붙여넣기)은 `engine.runBatch()`로 보낸다. 행마다 `run()`을 반복하는 코드는 데스크톱 모드에서 IPC 왕복이 행 수만큼 늘어나므로 반려.
- 모드 분기 금지: `mode === 'native'` 같은 비교는 `main.js`와 `engine.js`의 선택 로직에만 허용한다. 나머지 코드는 `capabilities()`가 보고하는 값(상한, 저장 방식)을 읽는다. 파일 크기 상한 숫자를 UI 코드에 두지 않는다.
- 사용자 테이블 DDL은 `STRICT`. 예외는 외부 SQLite 파일을 등록하는 경로뿐이며 그때는 메타에 `strict = 0`을 기록한다.
- 새 PRAGMA는 `engine.applyPragmas()`에만 추가한다(export 후 재적용되는 유일한 장소).

### 5.4 Worker 경계

- 메시지에는 구조화 복제 가능한 값만 넣는다. 함수, DOM 노드, 클래스 인스턴스 금지. 오류는 `{ code, message, detail }`로 직렬화한다.
- 1 MB를 넘는 `ArrayBuffer`는 반드시 transfer 목록에 넣는다(복사 금지).
- 진행률이 1초 이상 걸릴 수 있는 op는 `progress` 이벤트를 최소 250 ms 간격으로 보낸다.
- 새 op를 추가하면 `DESIGN.md` 6장 표, `db/client.js`의 타입, `db/worker.js`의 핸들러, 단위 테스트를 한 PR에서 함께 갱신한다.

### 5.5 UI와 DOM

- 사용자 데이터(셀 값, 테이블 이름, 파일 이름, 가져온 헤더)는 **`textContent`로만** 출력한다. `innerHTML`, `insertAdjacentHTML`에 사용자 데이터가 닿는 코드는 반려. 정적 마크업 템플릿은 `innerHTML`을 써도 되지만 데이터 삽입은 별도 단계로 한다.
- 그리드는 반드시 가상화한다. 행 수만큼 DOM 노드를 만드는 코드는 반려.
- 렌더 경로(`grid.render`, `cells.render`)에서 레이아웃 강제(`offsetHeight`, `getBoundingClientRect`)를 반복 호출하지 않는다. 측정은 한 번 모아서 한다.
- 이벤트 리스너는 마운트 시 등록하고 언마운트 시 해제한다. 익명 함수를 `addEventListener`에 넘기고 해제하지 못하는 패턴 금지.
- 키보드 처리에서 `event.isComposing`을 확인하지 않고 Enter/Esc를 처리하면 한글 입력이 깨진다. 편집기 코드는 반드시 확인한다.
- UI 문자열은 `i18n/ko.js`의 키를 통해서만 쓴다. 코드에 한국어·영어 리터럴 문구 금지(로그·오류 `detail`은 예외).
- CSS는 `styles/*.css`에 두고 클래스 이름은 `jdr-<블록>__<요소>--<변형>` 형태. 인라인 스타일은 가상화 위치 계산(`transform`, `width`, `height`)에만 허용.

### 5.6 오류 처리

- 던지는 오류는 `AppError`만. 원인 예외는 `cause`에 보존한다.
- `catch`에서 조용히 삼키지 않는다. 처리하지 못하면 다시 던지거나 `E_UNKNOWN`으로 감싸 상위로 보낸다.
- 데이터 유실 가능 경로(저장, 삭제, 가져오기, 타입 변경)의 오류 메시지에는 "원본이 어떤 상태인지"를 반드시 포함한다.
- 기능 감지는 `try/catch`로 감싼다(`navigator.storage`, `indexedDB`, `showOpenFilePicker`, `Worker`, `CompressionStream`). 감지 실패는 오류가 아니라 폴백이다.
- 예외: 데스크톱 모드에서 타우리 IPC 실패는 폴백하지 않고 `E_NATIVE_IPC`로 앱을 잠근다. wasm으로 조용히 내려가면 파일 상한이 되돌아오기 때문이다(D-15).

### 5.7 성능 규칙

- `DESIGN.md` 8장의 예산을 넘기는 변경은 원인 분석 없이 병합하지 않는다.
- 핫 경로(스크롤 렌더, 창 질의, 커맨드 적용)에 새 할당·복사를 추가할 때는 PR 설명에 측정치를 적는다.
- 큰 문자열·배열을 로그로 찍지 않는다(장문 셀은 콘솔을 멈추게 한다). 로그에는 길이와 앞 80자만.

### 5.8 의존성 정책

- JS 런타임 서드파티는 공식 SQLite Wasm(`@sqlite.org/sqlite-wasm`)과 SheetJS CE 두 개뿐이다. `@tauri-apps/api`도 런타임 의존이므로 쓰지 않고, `io/ipc-bridge.js`가 `window.__TAURI_INTERNALS__`를 직접 부른다. 러스트 크레이트는 `tauri`·`tauri-build`(플러그인 dialog, single-instance 포함), `rusqlite`(`bundled`), `serde`, `serde_json`으로 제한한다. 추가하려면 `DESIGN.md` D-12를 먼저 고친다.
- `vendor/` 파일 갱신 시: 버전, 출처 URL, SHA-256, 라이선스를 `vendor/CHECKSUMS`와 PR 설명에 기록한다. `verify.mjs`가 체크섬을 검사한다.
- 빌드 산출물에 `http://`, `https://`, CDN 참조가 들어가면 `verify`가 실패한다. 우회하지 않는다.

### 5.9 러스트 규약 (src-tauri)

- `cargo fmt`와 `cargo clippy -- -D warnings`가 깨끗해야 한다.
- 명령 함수와 라이브러리 코드에서 `unwrap()`·`expect()` 금지. 오류는 `AppError`로 변환해 돌려주고 `code`는 `util/errors.js`의 목록과 1:1이다.
- 경로는 `PathBuf`로만 다루고 문자열 결합으로 만들지 않는다. 원본 파일을 바꾸는 코드는 `save.rs` 한 곳에만 둔다.
- 긴 작업은 `spawn_blocking`에서 실행하고 진행률은 `Channel`로 보낸다. 커넥션 뮤텍스를 잡은 채 IPC 응답을 기다리지 않는다.
- 타우리 fs·dialog 스코프는 사용자가 고른 경로와 앱 데이터 폴더로 제한하고, 넓히는 변경은 PR 설명에 사유를 적는다.

## 6. 테스트 규약

- 순수 로직(파서, 타입 추론, 질의 빌더, 값 검증, 커맨드 do/undo, revision 판정)은 `node:test` 단위 테스트가 필수다. SQLite Wasm은 Node에서 동작하므로 DB를 실제로 만들어 검사한다(모킹 금지).
- 커맨드는 "적용 → 되돌리기 → DB 덤프 동일" 대칭성 테스트를 반드시 가진다.
- 엔진 구현은 `test/unit/db/engine-contract.test.js`의 적합성 테스트를 모두 통과해야 한다. wasm 엔진은 `npm test`에서, 네이티브 엔진은 `npm run test:native`(Node `worker_threads` + `jdr-ipc-stdio`로 실제 rusqlite 엔진)에서 같은 파일을 실행한다.
- 러스트는 `cargo test`로 저장 원자성(실패 주입 시 원본 무손상), `run_batch` 원자성, `interrupt`, 한글 경로를 검증한다.
- 파서 테스트는 `test/fixtures/`의 바이트 픽스처를 사용한다. 특히 조각 경계(32 KB) 위에 따옴표 필드가 걸치는 케이스, BOM, EUC-KR, CRLF/LF 혼재.
- E2E는 빌드된 `dist/jdrdatabase.html`을 `file://`로 연다. 소스를 직접 서빙해 테스트하지 않는다(단일 파일 산출물 자체가 검증 대상).
- E2E에서 네이티브 파일 선택기는 자동화할 수 없으므로 폴백 경로(`setInputFiles`, 다운로드 이벤트)를 사용한다. 테스트 빌드는 `window.__jdrTest` 훅을 노출하고 릴리스 빌드는 노출하지 않는다.
- 성능 테스트는 로컬에서는 `DESIGN.md` 8장의 절대 예산으로, CI에서는 기준선 대비 30% 이상 회귀를 실패로 본다. 기준선은 `test/perf/perf-baseline.json`(CI 러너 실측)이며 갱신 사유를 PR 설명에 적는다.
- 버그 수정 PR은 재현 테스트를 먼저 추가한다(빨강 → 초록).

## 7. 코드 점검 체크리스트

### 7.1 PR 올리기 전 (작성자)

- [ ] `npm run check`, `npm run build`, `npm run verify`, `npm run test:e2e` 모두 통과
- [ ] `docs/sessions.md`에 이번 세션 이름의 절을 추가하고, 묶음에 속한 모든 Step의 "완료 기준"을 항목별로 옮겨 적어 각각 어떻게 확인했는지 적음. 확인하지 못한 항목은 "미확인"으로 표시
- [ ] 새 오류 코드가 `util/errors.js`, `i18n/ko.js`, `DESIGN.md` 7장에 모두 있음
- [ ] 새 RPC op가 `DESIGN.md` 6장 표에 있음
- [ ] SQL에 문자열 연결로 값을 넣은 곳이 없음 (`grep -n '\${' src/db src/import` 결과를 눈으로 확인)
- [ ] 사용자 데이터가 `innerHTML`에 닿는 곳이 없음 (`grep -rn 'innerHTML' src/` 결과를 눈으로 확인)
- [ ] 산출물 크기 변화를 PR 설명에 기록(`verify`가 출력)
- [ ] 설계 결정을 바꿨다면 `DESIGN.md`의 D-항목 갱신이 같은 PR에 포함
- [ ] `dist/`는 커밋하지 않음(CI 아티팩트로만 배포). 릴리스 태그에서만 첨부
- [ ] 모드 문자열 비교가 허용 위치 밖에 없음 (`grep -rn "'native'\|'wasm'\|'desktop'" src/` 결과가 `main.js`, `db/engine.js`, 엔진 구현 파일, 테스트에만 있음)
- [ ] Step 11 이후 데스크톱 코드(`src-tauri/`, `db/engine-native.js`, `io/ipc-bridge.js`, `io/filesystem.js`)를 바꿨다면: 로컬에서 `cargo fmt --check`, `cargo clippy --workspace -- -D warnings`, `cargo test --workspace`, `npm run test:native` 통과. PR 검사(`ci`)는 Linux 브라우저 경로만 돌리므로, 세 OS 검사는 `desktop` 워크플로를 PR 브랜치에서 수동 실행해 초록을 확인한다(릴리스의 `release` 워크플로도 세 OS에서 테스트를 거친다). 브라우저·타우리 산출물이 CSP 태그 외 동일함을 `verify`가 확인

### 7.2 리뷰 관점 (리뷰어, 우선순위 순)

1. **데이터 유실**: 실패 경로에서 DB·파일·히스토리 상태가 일관되는가. 트랜잭션 밖 쓰기, 롤백 누락, export 후 statement 재사용이 없는가.
2. **예외 처리**: `DESIGN.md` 해당 Step의 예외 목록이 코드에 모두 대응되는가. 삼켜진 `catch`가 없는가.
3. **보안**: 파라미터 바인딩, `textContent`, CSP 유지, CSV 수식 주입 옵션.
4. **성능**: 가상화 유지, 전체 SELECT 없음, 핫 경로 할당, transfer 사용.
5. **Worker·IPC 경계**: 직렬화 불가 값, DOM 접근, 메인 전용 API, 엔진 인터페이스 우회(`sqlite3`·invoke 직접 호출), 행 단위 반복 대신 `runBatch`.
6. **한글 입력·표시**: `isComposing`, EUC-KR, 코드 포인트 정렬 가정.
7. **접근성**: 키보드만으로 도달 가능한가, 포커스 가시성, aria 속성.
8. **문서 일치**: DESIGN.md·i18n·오류 코드 표.

리뷰 코멘트는 "무엇이 왜 문제인지 + 어떤 입력에서 어떻게 실패하는지"를 적는다. 스타일만의 지적은 린트에 맡기고 사람이 하지 않는다.

### 7.3 푸시·병합 조건

- 구현은 작업 브랜치 하나와 그 PR 하나에서 진행한다. 세션은 `DESIGN.md` 5.0의 묶음 하나(A~I)를 맡아 Step 단위 커밋으로 푸시하며, 푸시 전에 7.1 체크리스트를 전부 확인한다. 컨텍스트 부족으로 묶음을 끝내지 못하면 완료된 Step까지만 푸시하고 후속 세션(예: B-2)으로 이어 간다.
- 세션별 검증 기록은 `docs/sessions.md`에 세션 이름의 절로 쌓는다. 세션이 끝난 뒤 그 절이 없거나 미확인 항목이 표시되지 않은 푸시는 되돌린다. 기록을 저장소 파일에 두는 이유는 세 가지다. GitHub 설명·댓글에는 65,536자 상한이 있어 세션 아홉 개가 들어가지 않고, 병합하면 GitHub 메타데이터는 저장소에 남지 않으며, 파일이면 `grep -n 미확인 docs/sessions.md` 한 번으로 남은 항목을 전부 볼 수 있다. PR 설명에는 이 파일로 가는 링크만 둔다.
- PR 병합은 세션 I까지 끝나고 CI 초록, 리뷰어 1명 승인, `docs/sessions.md`의 모든 절에서 미확인 항목이 해소된 뒤에 한다.
- 리팩터링과 기능 추가를 한 커밋에 섞지 않는다.

## 8. Git 규약

- 브랜치: v1 구현은 PR이 열린 작업 브랜치 하나를 모든 세션이 공유한다. 세션마다 새 브랜치를 만들지 않는다. 병합 뒤의 수정은 `fix/<요약>`, `docs/<요약>`. 기본 브랜치 `main`에 직접 푸시하지 않는다.
- 공유 브랜치에서는 history를 다시 쓰지 않는다(rebase, amend, force-push 금지). 원격이 앞서 있으면 merge로 맞춘다.
- 커밋 메시지: Conventional Commits. 제목은 영어 또는 한국어 72자 이내, 본문에 "왜"를 적는다.
  - `feat(grid): 열 가상화 추가`
  - `fix(csv): 32KB 조각 경계에 걸친 따옴표 필드 파싱 오류 수정`
  - `docs(design): D-08 열 삭제를 소프트 삭제로 변경`
- `vendor/` 갱신은 단독 커밋(`chore(vendor): sqlite-wasm 3.x.y`)으로 분리한다.
- `docs/sessions.md`의 세션 절 추가도 단독 커밋(`docs(session): 세션 E 점검 기록`)으로 분리한다. 구현 커밋의 diff에 기록 문서가 섞이지 않게 한다.
- 커밋에 `dist/`, `node_modules/`, 1 MB 초과 픽스처를 넣지 않는다(`.gitignore`로 막고 CI에서 검사).

## 9. Claude Code 작업 지침

- 작업 범위는 요청된 세션 묶음(`DESIGN.md` 5.0) 또는 이슈로 한정한다. 다음 세션의 Step을 앞당겨 구현하지 않는다.
- 세션 시작 시 작업 브랜치를 원격 최신으로 맞추고 그 상태에서 `npm run check`가 초록인지 확인한다. 초록이 아니면 직전 세션의 문제이므로 새 Step을 시작하기 전에 먼저 고친다. `docs/sessions.md`에 쌓인 "미확인" 항목을 이어받는다. 세션 종료 시 그 파일에 세션 이름의 절을 추가해 검증 결과와 미확인 항목을 분리해 적는다.
- `docs/sessions.md`는 통독하지 않는다. 미확인 항목은 세션 D부터 누적으로 이월되어 직전 절만 읽으면 인계가 빠지므로, `grep -n 미확인 docs/sessions.md`로 이월된 항목의 줄 번호를 모은 뒤 필요한 줄의 앞뒤 맥락만 읽는다.
- 코드를 쓰기 전에 `DESIGN.md`의 해당 Step "주요 함수" 이름을 그대로 쓴다. 이름을 바꿔야 하면 문서를 먼저 고친다.
- 구현 후 반드시 `npm run check && npm run build && npm run verify`를 실행하고 결과를 그대로 보고한다. 실패를 "무관한 실패"로 넘기지 않는다.
- 테스트를 건너뛰거나 `skip`으로 바꿔 초록을 만드는 행위는 금지다.
- 대용량 픽스처가 필요하면 `scripts/gen-fixture.mjs`로 생성하고 커밋하지 않는다.
- 브라우저·WebView API 가용성(`file://`에서의 Worker, IndexedDB, File System Access, WKWebView의 CompressionStream)과 rusqlite 번들 빌드의 컴파일 플래그는 추정으로 단정하지 않는다. 실측 결과를 `docs/support-matrix.md`에 기록하고, 확인하지 못한 항목은 "미확인"으로 남긴다.
- 사용자에게 보고할 때는 무엇을 검증했고 무엇을 검증하지 못했는지를 분리해서 적는다.
