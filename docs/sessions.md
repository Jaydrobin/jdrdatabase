# 세션별 검증 기록

`DESIGN.md` 5.0의 세션 묶음(A~I)과 그 사이의 점검 세션이 무엇을 검증했고 무엇을 검증하지 못했는지를 쌓는 파일이다. 세션을 끝낼 때마다 절을 하나 더하고, 그 절에 해당 Step의 "완료 기준"을 항목별로 옮겨 적어 각각 어떻게 확인했는지 적는다. 확인하지 못한 것은 **미확인**으로 표시한다(`CLAUDE.md` 7.1·7.3·9장).

다음 세션은 이 파일에 쌓인 "미확인" 항목을 이어받는다. 항목은 세션 D부터 누적으로 이월되므로 마지막 절만 읽으면 앞 세션 것이 빠진다. 통독하는 대신 아래 grep으로 줄 번호를 모아 필요한 줄의 앞뒤 맥락만 읽는다. 병합 전에는 모든 절의 미확인 항목이 해소됐는지 확인한다.

```
grep -n 미확인 docs/sessions.md
```

브라우저·WebView API 가용성의 실측표는 이 파일이 아니라 `docs/support-matrix.md`에 있다.

## 세션 진행 현황

| 세션 | Step | 상태 |
|---|---|---|
| 문서 | DESIGN.md, CLAUDE.md, README.md | 완료 |
| A | 0 + 1 (골격·빌드, 엔진 인터페이스·wasm 엔진·RPC) | 완료 |
| A 점검 | 세션 A 산출물 코드 점검과 수정 | 완료 |
| B | 2 + 3 (파일 열기·저장·저널·백업, 메타 스키마·테이블·열) | 완료 |
| B 점검 | 세션 B 산출물 코드 점검과 수정 | 완료 |
| C | 4 (가상 그리드 읽기 전용) | 완료 |
| C 점검 | 세션 C 산출물 코드 점검과 수정 | 완료 |
| D | 5 (편집·되돌리기·붙여넣기) | 완료 |
| D 점검 | 세션 D 산출물 코드 점검과 수정 | 완료 |
| E | 6 (정렬·필터·검색·뷰) | 완료 |
| E 점검 | 세션 E 산출물 코드 점검과 수정 | 완료 |
| F | 7 + 8 (CSV·XLSX 가져오기) | 완료 |
| F 점검 | 세션 F 산출물 코드 점검과 수정 | 완료 |
| F 점검 후속 | 간헐 실패 E2E 원인 규명과 수정 | 완료 |
| G | 9 (내보내기·백업·압축·클라우드 안내) | 완료 |
| G 점검 | 세션 G 산출물 코드 점검과 수정 | 완료 |
| H | 10 (성능·하드닝·접근성) | 완료 |
| H 점검 | 세션 H 산출물 코드 점검과 수정 | 완료 |
| I | 11 (타우리 셸·네이티브 엔진) | 완료(데스크톱 E2E는 Linux만 실측, Windows·macOS 미확인) |
| I 점검 | 세션 I 산출물 코드 점검과 수정 | 완료(CI 다섯 잡 초록. Windows·macOS WebView 실측은 미확인) |
| J | 누적 미수정 항목 정리(세션 A~I의 "점검했지만 고치지 않은 것" 12건) | 완료(CI 다섯 잡 초록) |
| K | CI 유지보수(concurrency, 문서 전용 변경 건너뛰기) | 완료(코드 푸시·문서 전용 푸시 양쪽 실측. main 푸시 경로는 미확인. PR 실행의 concurrency 취소는 세션 L에서 실측) |
| L | 누적 미확인 항목 정리(SheetJS 0.20.3, 두 탭·인덱스 배지·작업 사본 목록 E2E, `E_MEM`·concurrency 실측, 5 GB 데스크톱 성능, Windows E2E 시도) | 완료(작업 사본 목록의 데이터 유실 버그 수정. Windows E2E는 WebView2 인자 문제로 되돌림, 작업 사본 복사는 성능 예산 초과로 제안 대기) |

## 기록

### 문서 (2026-09-19 ~ 09-20)

- `DESIGN.md` v0.2: 타당성 답변(0장), 설계 결정 D-01 ~ D-15, 아키텍처, 데이터 모델, 세션 구성표와 Step 0~11 계획, RPC 프로토콜, 오류 카탈로그, 성능 예산, 리스크 R1 ~ R9.
- `CLAUDE.md`: 작성 규약, 테스트 규약, 점검 체크리스트, 단일 브랜치 운영 규칙.
- 미확인: `file://` 환경의 Worker·IndexedDB·File System Access 가용성(R1), rusqlite 번들 빌드의 컴파일 플래그(R9), 기본 확장자와 자동 저장 기본값(9장 미확정). 각각 세션 A·B·I에서 실측한다.

### 세션 A (Step 0 + 1) — 2026-09-20

커밋: `docs(design)` D-01/D-02 수정 → `chore(vendor)` sqlite-wasm 3.53.4-build1 → `feat(build)` Step 0 → `feat(db)` Step 1 → `fix(ci)` Node 20용 단위 테스트 러너(`node --test`가 Node 20에서 glob을 받지 않아 CI 첫 실행이 실패한 것을 수정).

CI: 헤드 커밋 `b85738c`에서 `check-build-e2e` 초록(push·pull_request 두 실행 모두 성공).

**설계 변경 (코드보다 먼저 DESIGN.md v0.3에 반영, 리뷰어 확인 필요)**

- **D-02: 브라우저 엔진을 sql.js → 공식 `@sqlite.org/sqlite-wasm`으로 변경.** 세션 시작 시 실측한 sql.js 1.14.2 배포 빌드는 `PRAGMA compile_options`에 `ENABLE_FTS3`만 있고 `ENABLE_FTS5`가 없으며 `CREATE VIRTUAL TABLE … USING fts5`가 `no such module: fts5`로 실패합니다. Step 1 완료 기준(ENABLE_FTS5 고정)과 D-07(trigram 검색)을 만족할 수 없어, FTS5·`sqlite3_interrupt`·`sqlite3_deserialize`·`sqlite3_js_db_export`를 모두 갖춘 공식 배포본으로 바꿨습니다. 단일 파일화는 esbuild IIFE 번들 + `wasmBinary` + `locateFile` 주입으로 해결됩니다. D-12 서드파티 목록, 3.1 vendor, CLAUDE.md 5.8 등 관련 문구를 함께 갱신했습니다.
- **D-01: CSP에 `'wasm-unsafe-eval'` 추가.** Chromium은 `script-src`가 선언된 문서에서 이 소스 없이 `WebAssembly.instantiate`를 거부합니다(`CompileError: Refused to compile or instantiate WebAssembly module`로 실측).
- 6장 RPC 표에 `engine.exec`(진단·테스트 전용) 추가, 7장에 `E_BATCH_TOO_LARGE` 추가, Step 0 예외에 `vendor/`를 허용 import 루트로 명시.

**Step 0 완료 기준**
- [x] `npm run check`(lint + typecheck + unit) 통과: 로컬과 CI(Node 20)에서 실행. eslint 0건, tsc 0오류, node:test 54개 통과.
- [x] `npm run build && npm run verify` 통과: 로컬과 CI에서 실행(아래 산출물 크기).
- [x] Playwright가 `file://…/dist/test/jdrdatabase.html`을 열어 제목 텍스트 확인: `test/e2e/smoke.spec.js` 통과(로컬·CI). 네트워크 요청은 문서(file://)와 Worker Blob URL(blob:) 외 0건.
- 참고: E2E는 릴리스 빌드와 훅 유무만 다른 테스트 빌드(`dist/test/jdrdatabase.html`)를 엽니다. `verify`가 릴리스 산출물에 `__jdrTest`가 없음을 확인합니다.

**Step 1 완료 기준**
- [x] 단위: `PRAGMA compile_options`에 `ENABLE_FTS5`, `sqlite_version() >= 3.37`(실측 3.53.4): `test/unit/db/engine-contract.test.js`, `engine-wasm.test.js`.
- [x] 왕복: 테이블 생성 → `snapshot()` → 새 엔진에 `open(bytes)` → 같은 데이터(10만 자 셀 포함): engine-contract.
- [x] 단위: `runBatch` 1만 행 단일 트랜잭션, 중간 행(5,000번째) 실패 주입 시 0행: engine-contract.
- [x] 단위: 적합성 테스트를 구현과 분리된 `engine-contract.test.js`의 `defineEngineContract(label, open)`로 두어 Step 11의 네이티브 엔진이 같은 검사를 돌릴 수 있게 함.
- [x] E2E: Worker 모드와 인라인 모드 각각 `SELECT 1` 성공: `test/e2e/engine.spec.js`(추가로 상태바 모드 표시, FTS5 컴파일 옵션 확인).
- Step 1 예외 처리 대응: Worker 생성 실패·핸드셰이크 10초 초과 → 인라인 폴백 + 상태바 "단일 스레드 모드"(단위 테스트로 폴백 경로 확인). wasm 인스턴스화 실패 → `E_ENV_NO_WASM` 잠금 화면(단위 테스트로 오류 코드 확인, 화면은 E2E로 재현 불가). `runBatch` 실패 시 전체 롤백 + `detail.index`. RPC 타임아웃 없음, `signal`로 취소 메시지 전송. 1만 행 초과 `E_RESULT_TOO_LARGE`.

**산출물 크기 (`verify` 출력)**
- `dist/jdrdatabase.html` 1,619,317 bytes (1.54 MiB / 예산 6 MiB). 부품: main 228.8 KB, worker 219.0 KB, wasm(base64) 1,131.4 KB, css 1.6 KB.
- `dist/tauri/index.html` 1,619,125 bytes (CSP 메타 줄만 다름을 `verify`가 확인).
- vendor URL 리터럴 허용 2건(sqlite3.mjs의 안내 문자열, `verify.mjs`의 명시 목록). 그 외 외부 참조 0건.

**미확인 (후속 세션에서 이어받음)**
- 지원 매트릭스(`docs/support-matrix.md`): Chromium 141 headless `file://`만 실측. Chrome/Edge 데스크톱, Firefox, Safari의 Blob Worker·WebAssembly·CSP 동작은 미확인. IndexedDB·File System Access·CompressionStream은 세션 B·G에서 실측.
- wasm 엔진의 `interrupt()`는 단일 스레드 특성상 실행 중 문장을 멈추지 못하고 `runBatch` 행 사이에서만 동작함(설계 문서 Step 1 예외에 기록). 실사용 취소 경로(가져오기)는 세션 F에서 검증.
- Rust/rusqlite 컴파일 플래그(R9), 기본 확장자·자동 저장 기본값은 여전히 미확정.

### 세션 A 점검 (세션 A 산출물 코드 점검) — 2026-09-20

세션 A의 `b85738c`를 원격 최신으로 맞춘 뒤 전체 파이프라인을 재현하고(모두 초록) 코드를 점검했습니다. 초록인 상태에서 드러나지 않은 문제 8건을 재현 테스트와 함께 고쳤습니다. 새 기능은 없고 Step 2 이후를 앞당겨 구현하지 않았습니다.

커밋: `058a608` → `ab8a281` → `5df6ae6` → `42a2615` → `d313acb` → `68e8bd8` → `1379a20` → `7eba95f` (문제 하나당 커밋 하나).

**고친 문제**

| # | 문제 | 커밋 |
|---|---|---|
| 1 | `exec()`가 결과 열 없는 문장을 전부 거부 | `058a608` |
| 2 | E2E의 FTS5 trigram 테스트가 trigram을 검사하지 않음 | `42a2615` |
| 3 | 부팅 후 Worker가 죽으면 모든 RPC가 영구히 멈춤 | `5df6ae6` |
| 4 | `runBatch` 시작 직전의 `interrupt()`가 삼켜짐 | `ab8a281` |
| 5 | 빈 객체 파라미터가 바인딩 오류를 냄 | `d313acb` |
| 6 | 쓰기 실패마다 `sqlite3_stmt`가 남음 | `68e8bd8` |
| 7 | 엔진 기동 전 실패 시 잠금 화면이 뜨지 않음 | `1379a20` |
| 8 | `E_UNKNOWN`이 DESIGN.md 7장 표에 없음 | `7eba95f` |

1. **`exec()`가 결과 열 없는 문장을 전부 거부.** oo1의 `getColumnNames()`가 첫 줄에서 열 인덱스 0의 존재를 단언하므로, `exec()`가 `step()` 전에 이를 부르면 DDL·대입형 PRAGMA·`RETURNING` 없는 DML이 `E_DB_QUERY: Column index 0 is out of range`로 실패했습니다. 진단·테스트 전용 op인 `engine.exec`가 SELECT만 실행할 수 있었고 실패 메시지가 원인을 가렸습니다. 열 개수를 먼저 보고 0이면 빈 결과를 돌려주며, 이로써 열리는 "트랜잭션 밖 쓰기" 경로는 `sqlite3_stmt_readonly`로 `run()`과 같은 규칙(CLAUDE.md 5.3)을 적용해 막았습니다.
2. **E2E의 FTS5 trigram 테스트가 trigram을 검사하지 않음.** 이름과 달리 `pragma_compile_options`의 행 수만 셌고, trigram 실검증은 Node 단위 테스트에만 있었습니다. D-02의 근거인 "브라우저에서의 FTS5"가 확인된 적이 없었던 셈입니다. `engine.exec` 핸들러가 한 문장을 트랜잭션 하나로 감싸 DDL도 보낼 수 있게 하고, 테스트 훅이 문장 목록을 같은 세션에서 실행하도록 해, `CREATE VIRTUAL TABLE … tokenize='trigram'` → `INSERT` → `MATCH` 한글 부분 일치를 `file://` 문서의 Blob Worker 안에서 실행합니다.
3. **부팅 후 Worker가 죽으면 모든 RPC가 영구히 멈춤.** `createTransport`가 핸드셰이크에만 `worker.onerror`를 걸고 성공하면 `null`로 되돌려, 이후 Worker 오류를 아무도 알지 못했습니다. RPC에는 의도적으로 타임아웃이 없으므로 대기 중인 Promise가 영원히 settle되지 않고 화면이 "준비됨"인 채로 굳습니다(CLAUDE.md 5.6 위반). `Transport`에 `onFatal`을 두어 Worker 전송이 `onerror`·`onmessageerror`를 계속 듣고, `createClient`가 이를 구독해 대기 중인 호출을 모두 거부합니다.
4. **`runBatch` 시작 직전의 `interrupt()`가 삼켜짐.** 배치 진입 시 `interrupted = false`로 표식을 지워, 취소 결정과 배치 시작 사이에 들어온 취소가 사라졌습니다. `capabilities().cancellable`이 이미 `true`이고 세션 F의 가져오기 취소가 이 경로를 씁니다. 표식은 그것을 본 배치가 지우도록 바꿔, 진입 시점과 행 사이 모두에서 멈추고 롤백합니다.
5. **빈 객체 파라미터가 바인딩 오류를 냄.** `bind()`가 빈 배열은 조기 반환했지만 빈 객체는 oo1로 넘겨 `exec('SELECT 1', {})`가 `This statement has no bindable parameters.`로 실패했습니다. 호출자가 파라미터를 조건부로 모으면 둘 다 자연스럽게 나오므로 같게 다룹니다.
6. **쓰기 실패마다 `sqlite3_stmt`가 남음.** oo1의 `reset()`은 `sqlite3_reset`의 결과 코드가 직전 `step()`의 오류를 그대로 되돌려주므로 쓰기 실패 뒤 항상 던집니다. `release()`의 catch가 statement를 캐시에서 빼기만 하고 `finalize()`하지 않아 실패한 쓰기 하나마다 wasm 힙에 남았습니다. 가져오기처럼 검증 실패가 많은 경로에서 계속 쌓입니다.
7. **엔진 기동 전 실패 시 잠금 화면이 뜨지 않음.** `boot()`에서 기능 감지와 임베드 블록 읽기가 `try` 밖이라, 여기서 던지면 `void boot()`의 미처리 거부가 되고 화면이 "시작 중…"에 멈춘 채 아무 안내도 나오지 않았습니다. 루트 요소가 없을 때 던지던 것도 `AppError`가 아닌 raw `Error`에 한국어 리터럴이라 CLAUDE.md 5.5·5.6에 어긋났습니다. 셸을 띄운 뒤의 시작 작업을 `start()`로 묶어 통째로 `try` 안에 두었습니다.
8. **`E_UNKNOWN`이 DESIGN.md 7장 표에 없음.** `util/errors.js`와 `i18n/ko.js`·`en.js`에는 있는데 표에는 행이 없었습니다(본문 원칙 3에만 언급).

**재현 테스트**

수정 전 빨강을 확인한 것:
- `engine-contract.test.js`: `exec: 결과 열이 없는 문장(DDL·대입형 PRAGMA)은 빈 결과를 돌려준다`, `exec: 트랜잭션 밖의 쓰기는 run과 마찬가지로 거부된다`, `interrupt: 배치가 시작되기 전에 온 취소도 첫 행 전에 멈춘다`, `interrupt: 빈 배치는 표식을 소비하지 않고 다음 배치가 멈춘다`, `exec/run: 빈 파라미터는 배열이든 객체든 바인딩을 건너뛴다`
- `rpc.test.js`: `client: 부팅 후 Worker가 죽으면 대기 중인 호출이 거부된다`
- `errors.test.js`: `DESIGN.md 7장 표가 모든 오류 코드를 담는다 (CLAUDE.md 7.1)` — 같은 누락의 재발을 막는 검사
- `e2e/engine.spec.js`: `FTS5 trigram 부분 일치가 Blob Worker 안에서 동작한다`, `엔진 기동 전에 실패해도 잠금 화면이 뜬다`(`addInitScript`로 임베드 블록을 가려 재현)

빨강을 만들지 못한 것:
- 6번(statement 누수)의 `engine-wasm.test.js: statement 캐시: 쓰기 실패로 reset이 던져도 캐시와 결과가 일관된다`는 회귀 테스트이며 누수 자체를 단언하지 못합니다. 엔진이 커넥션 핸들을 밖으로 내보내지 않아 `sqlite3_next_stmt`로 남은 statement 수를 셀 수 없기 때문입니다. `reset()`이 실패 `step()` 뒤 항상 던진다는 전제는 vendor 소스(`checkSqlite3Rc`)와 실측으로 확인했고, 동작 정합성은 제약 위반 200회로 확인했습니다.

**문서 갱신 (해당 커밋에 포함)**
- `DESIGN.md` 6장 `engine.exec` 행: 결과 열 없는 문장의 결과 형태, 트랜잭션 하나로 감싸 실행하므로 DDL 가능함.
- `DESIGN.md` Step 1 `interrupt()` 항목: 표식을 배치 진입 시점이 아니라 그것을 본 배치가 지운다는 점과 그 이유.
- `DESIGN.md` 7장 표: `E_UNKNOWN` 행 추가.
- `docs/support-matrix.md`: FTS5 trigram 칸이 무엇으로 측정된 ✓인지 명시.

**검증 결과**
- [x] `npm run check`: eslint 0건, prettier 통과, tsc 0오류, 단위 테스트 62개 통과(세션 A의 54개 + 신규 8개).
- [x] `npm run build && npm run verify`: `verify OK`, 외부 참조 0건(허용 vendor 리터럴 2건), vendor 체크섬 일치.
- [x] `npm run test:e2e`: Chromium `file://`에서 7개 통과(세션 A의 5개 + 신규 3개, 기존 1개는 이름을 내용에 맞게 분리).
- [x] 7.1 체크리스트 grep: `innerHTML` 0건, 모드 문자열 허용 위치 밖 0건, SQL 문자열 연결 0건(`jdr_sp_${depth}`는 앱이 만든 정수).
- [x] 새 오류 코드 없음. `E_UNKNOWN` 누락을 메워 `util/errors.js`·`i18n/ko.js`·`en.js`·`DESIGN.md` 7장이 일치하며, 단위 테스트가 이를 강제합니다.

**산출물 크기 (`verify` 출력)**
- `dist/jdrdatabase.html` 1,620,351 bytes (1.55 MiB / 예산 6 MiB). 세션 A 대비 +1,034 bytes. 부품: main 229.4 KB, worker 219.4 KB, wasm(base64) 1,131.4 KB, css 1.6 KB.
- `dist/tauri/index.html` 1,620,159 bytes (CSP 메타 줄만 다름을 `verify`가 확인).

**미확인 (세션 A에서 이어받아 그대로 남음)**
- 지원 매트릭스: Chromium 141 headless `file://`만 실측. Chrome/Edge 데스크톱, Firefox, Safari는 미확인. IndexedDB·File System Access·CompressionStream은 세션 B·G에서 실측.
- Rust/rusqlite 컴파일 플래그(R9), 기본 확장자·자동 저장 기본값은 여전히 미확정.

### 세션 B (Step 2 + 3) — 2026-09-20

커밋: `2540700` docs(design) 착수 전 설계 확정 → `1773152` refactor(ui) 상태바 분리 → `a5bf7a7` feat(io) Step 2 → `f5300f0` feat(db) Step 3.

시작 상태: 원격 `7eba95f`를 받아 `npm run check`(62개)와 `npm run test:e2e`(7개)가 초록임을 확인한 뒤 시작했습니다. 세션 A 점검의 미확인 항목 중 IndexedDB·File System Access 실측을 이 세션에서 이어받았습니다.

**설계 변경 (코드보다 먼저 DESIGN.md v0.4에 반영, 리뷰어 확인 필요)**

- **D-08 커맨드 형식 확정.** `do`/`undo`는 `{ sql, params }` 문장 목록이고, 열 타입 변경의 "변환 복사"만 Worker가 청크로 실행하는 `{ convert: { table, from, to, type, policy } }` 단계입니다. 값 검증이 JS(`values.coerce`)에 있고 10만 행 이상에서 진행률·취소가 필요해 SQL 한 문장으로 만들 수 없기 때문입니다. 스키마 커맨드는 Worker(`db/tables.js`)가 만들어 즉시 적용한 뒤 메인에 돌려주고, 메인은 그것을 저널(과 Step 5의 히스토리)에 넣습니다. 커맨드가 스스로 만든 물리 테이블·열은 `undo`가 `DROP TABLE`·`DROP COLUMN`으로 지우는 것을 소프트 삭제 규칙의 예외로 명시했습니다(그래야 "적용 → 되돌리기 → 덤프 동일"이 성립하고 다시 실행이 이름 충돌 없이 됩니다).
- **D-03·4.1 메타 스키마.** 메타 `id`는 물리 이름 그 자체입니다(앱 생성 `t_/c_<8hex>`, 외부 파일 등록 시 원래 이름). 다른 도구가 만든 파일을 등록하기 위해 `_jdr_tables.strict`(0이면 읽기 전용)를 추가하고, 외부 파일의 서로 다른 테이블이 같은 열 이름을 가질 수 있어 `_jdr_columns`의 기본 키를 `(table_id, id)`로 바꿨습니다.
- **6장 RPC.** `db.open` 인자 `{ bytes?, dbId?, adoptExternal? }`와 결과 `{ meta, tables, unmanaged?, readOnly? }`, `db.snapshot` 결과 `{ bytes, meta }`(revision 증가 후의 메타), `schema.list`·`schema.adopt`·`schema.*` 행, `command.apply` `{ cmd, direction? }` → `{ affected, nulled? }`. 쓰기 op(`command.apply`, `schema.list` 외 `schema.*`, `import.run`, `search.enable`) 배타 규칙. 규칙 문단의 `E_BUSY` 오타를 `E_DB_BUSY`로 고쳤습니다.
- 3.1에 `db/command.js`, `app/revision.js`, `io/tablock.js`, `ui/dialogs/dialog.js` 추가. 7장 `E_IMPORT_CANCELLED` 상황에 열 타입 변경을 더하고 i18n 문구를 "작업을 취소했습니다"로 일반화(새 오류 코드 없음).

**Step 2 완료 기준**
- [x] E2E(폴백 경로): 새 DB → 테이블 생성 → 다운로드된 파일을 다시 열기 → 데이터 동일: `test/e2e/schema.spec.js` "테이블 2개·열 5개 만들고 저장 → 다시 열기 → 같은 스키마"(FSA를 `addInitScript`로 감춰 `<a download>`·`<input type="file">` 폴백을 타고, 파일은 `setInputFiles`로 넣음). `test/e2e/file.spec.js`는 같은 경로로 메타(db_id, revision 0 → 1, saved_by) 왕복을 확인.
- [x] 단위: `validateHeader`, 마이그레이션(빈 파일 → 최신, 재실행 무해, 앱보다 새 schema_version은 readOnly), revision 판정표 5개 조건: `test/unit/db/schema.test.js`, `test/unit/app/revision.test.js`. 스토어 수준의 흐름(경고 후 취소, 저널 복구/버리기/불일치)은 `test/unit/app/store.test.js`.
- [x] 손상 파일·비SQLite 파일 픽스처가 올바른 오류 코드로 거부됨: `test/fixtures/corrupt.db`(b-tree 페이지를 깨뜨린 파일, `integrity_check`가 `invalid page number` 보고), `test/fixtures/not-sqlite.txt`. 단위(`schema.test.js`, `rpc.test.js`, `store.test.js`)와 E2E(`file.spec.js`, 토스트에 `E_FILE_NOT_SQLITE`/`E_FILE_CORRUPT` 표시 후 새 DB로 복귀).
- Step 2 예외 처리 대응: 외부 SQLite 파일(`unmanaged` → 확인 대화상자 → `schema.adopt`, 거절 시 새 DB; 단위+E2E, 픽스처 `external.db`), 크기 상한(`capabilities().warnFileBytes/maxFileBytes` 기준, 숫자는 UI에 없음; 단위에서 상한 주입), 메모리 부족(`RangeError` → `E_MEM`; 코드 경로만), 핸들 권한 만료(`queryPermission` → `requestPermission`, 거부는 `E_FILE_PERMISSION`; 코드 경로만), 저장 도중 이탈(`createWritable` 원자성 + `beforeunload` dirty 확인; 코드 경로만), 저널 50 MB(기록 중단·배너·`truncated` 표식; 단위에서 상한 주입), 두 탭(BroadcastChannel probe/held; 단위에서 두 인스턴스로 읽기 전용 전환 확인), revision 경고(단위). 저장한 적 없는 새 DB의 저널은 다음 시작 때 같은 `db_id`로 재생을 제안(단위+E2E).

**Step 3 완료 기준**
- [x] 단위: 각 논리 타입의 `validate` 경계값(정수 2^53 경계, `2026-02-30`, 빈 문자열 → NULL, datetime 정규화, select 항목): `test/unit/db/values.test.js`.
- [x] 단위: 타입 변경 후 되돌리기로 완전 복원: `test/unit/db/tables.test.js`가 모든 스키마 커맨드(create, rename, addColumn, renameColumn, reorderColumns, softDeleteColumn, restoreColumn, changeColumnType)에 대해 "적용 → 되돌리기 → 덤프(sqlite_master.sql + table_info + 전체 행) 동일 → 다시 적용"을 검사. 타입 변경은 원본 열 값이 그대로 남고 새 열이 DROP COLUMN으로 지워짐을 확인.
- [x] E2E: 테이블 2개, 열 5개 만들고 저장·재열기: `test/e2e/schema.spec.js`(UI 대화상자로 생성, 이름 바꾸기·순서·소프트 삭제 포함, 재열기 후 스키마 동일과 물리 DDL이 STRICT + 시스템 열임을 확인). 추가로 스키마 변경의 저널 복구, 외부 파일 테이블의 읽기 전용 표시.
- Step 3 예외 처리 대응: 빈·중복·긴 이름 `E_NAME_INVALID`(단위, UI 사전 검사), 열 상한 2,000 거부(단위, 메타 직접 채워 상한 직전 재현)·1,000부터 토스트 경고(코드 경로만), 타입 변경 정책 NULL/중단(단위: 중단 시 트랜잭션 롤백으로 덤프 동일), 대용량 진행률·취소(단위: 1.2만 행을 5,000행 청크로 변환하며 첫 청크 뒤 취소 → `E_IMPORT_CANCELLED`, 잔여물 없음; UI는 진행률 토스트 + 취소 버튼), 시스템 열 `E_SYSTEM_COLUMN`(단위+RPC).

**검증 결과**
- [x] `npm run check`: eslint 0건, prettier 통과, tsc 0오류, 단위 테스트 133개 통과(세션 A 점검 62 + 신규 71).
- [x] `npm run build && npm run verify`: `verify OK`, 외부 참조 0건(허용 vendor 리터럴 2건), vendor 체크섬 일치, 두 변형 CSP 외 동일.
- [x] `npm run test:e2e`: Chromium `file://`에서 15개 통과(기존 7 + `file.spec.js` 5 + `schema.spec.js` 3). 3회 반복 실행으로 안정성 확인.
- [x] 7.1 grep: `innerHTML` 0건, 모드 문자열 허용 위치 밖 0건, `src/db`의 SQL 템플릿 리터럴은 모두 `quoteIdent()` 식별자·`physicalType()` 상수·정수 상수(`CONVERT_CHUNK_ROWS`, `jdr_sp_${depth}`)이고 값은 파라미터 바인딩.
- [x] 새 오류 코드 없음. i18n ko/en 키 동일과 `error.<코드>` 완비를 단위 테스트가 강제.
- [x] 새 op는 6장 표, `db/client.js`(`OpMap`), `db/worker.js`, 단위 테스트에 함께 반영.

**산출물 크기 (`verify` 출력)**
- `dist/jdrdatabase.html` 1,711,410 bytes (1.63 MiB / 예산 6 MiB). 세션 A 점검(1,620,351) 대비 +91,059 bytes. 부품: main 291.5 KB, worker 239.8 KB, wasm(base64) 1,131.4 KB, css 8.1 KB.
- `dist/tauri/index.html` 1,711,218 bytes (CSP 메타 줄만 다름을 `verify`가 확인).

**지원 매트릭스 실측 (`docs/support-matrix.md`)**
- Chromium 141 headless `file://`: IndexedDB 열기와 저널 기록 → 재시작 → 복구 ✓, `<a download>` 저장 → `<input type="file">` 재열기 ✓, BroadcastChannel 생성 ✓.
- Playwright 주의 2건 기록: `setInputFiles`에 비ASCII 경로(테스트 제목이 든 outputPath)를 주면 Chromium이 change 없이 조용히 무시하고, filechooser 가로채기는 change 대신 cancel을 내는 경우가 있어 둘 다 피했습니다(ASCII 임시 디렉터리 + 상주 입력 요소에 직접 `setInputFiles`).

**미확인 (후속 세션에서 이어받음)**
- File System Access 경로(`showOpenFilePicker`/`showSaveFilePicker`/`createWritable`/권한 재요청/최근 파일 핸들 복원)는 헤드리스에서 자동화할 수 없어 코드 경로만 있고 실측 미확인. Chrome/Edge 데스크톱에서 손으로 확인해야 합니다.
- Firefox·Safari의 IndexedDB(`file://`)·다운로드 폴백 미확인.
- 메모리 부족(`E_MEM`) 경로, 두 탭 동시 열기의 실제 브라우저 시나리오, 10만 행 이상 타입 변경의 진행률·취소 UI(단위는 1.2만 행), 저널 50 MB 배너의 실사용은 미확인.
- `filesystem.capabilities().native`는 스텁(Step 11).
- Rust/rusqlite 컴파일 플래그(R9), 기본 확장자·자동 저장 기본값은 여전히 미확정.

### 세션 B 점검 (세션 B 산출물 코드 점검) — 2026-09-20

세션 B의 `f5300f0`을 원격 최신으로 맞춘 뒤 전체 파이프라인을 재현하고(`check` 133개, `build`, `verify`, `test:e2e` 15개 모두 초록) 코드를 점검했습니다. 초록인 상태에서 드러나지 않은 문제 6건을 재현 테스트와 함께 고쳤습니다. 새 기능은 없고 Step 4 이후를 앞당겨 구현하지 않았습니다.

커밋: `2e2db57` → `28b0b8b` → `09014e5` → `11f3078` → `10e874f` → `1dbd532` (문제 하나당 커밋 하나).

**고친 문제**

| # | 문제 | 커밋 |
|---|---|---|
| 1 | 파일을 열 때 앞 DB의 dirty가 새 파일에 옮겨 붙고, 저널 복구 결과가 덮어써짐 | `2e2db57` |
| 2 | 열 타입 변경이 id가 0 이하인 행을 건너뛰어 값이 조용히 사라짐 | `28b0b8b` |
| 3 | Worker 모드에서 변환 중 취소가 닿지 않음(취소 버튼이 무동작) | `09014e5` |
| 4 | 쓰기 도중의 저장이 트랜잭션에 끼어들어 롤백이 깨지고 가짜 revision이 남음 | `11f3078` |
| 5 | 읽기 전용(외부 파일) 테이블을 되돌릴 수 없이 삭제할 수 있음 | `10e874f` |
| 6 | 모달이 떠 있는 동안 Ctrl+S가 아직 확정되지 않은 DB를 저장함 | `1dbd532` |

1. **열기 흐름의 dirty와 저널 복구 결과.** `openPicked`가 `reconcileRevision`을 `setOpened`보다 먼저 부르고, 재생이 세운 dirty를 살리려고 `setOpened` 전후로 dirty를 손으로 옮겨 담고 있었습니다. 그래서 (a) 미저장 변경이 있는 상태에서 "버리기"를 고르고 파일을 열면 옮겨 담은 값이 앞 DB의 dirty라 방금 연 파일이 곧바로 변경됨으로 표시되고(상태 표시·이탈 경고가 거짓말을 하고 다음 열기가 또 확인을 묻습니다), (b) 열기 도중 저널을 재생하면 재생 뒤 다시 읽은 테이블 목록을 `setOpened`가 열기 직전 목록으로 덮어써 DB에는 있는 테이블이 사이드바에서 사라졌습니다. 상태를 먼저 세우고 그 위에서 판정·재생하도록 순서를 바꿨습니다.

2. **열 타입 변경이 id ≤ 0인 행을 건너뜀.** 변환 복사의 청크 커서가 `lastId = 0`에서 출발해 `WHERE "id" > ?`로 넘어가므로, rowid를 명시해 넣어 id가 0이거나 음수인 행은 한 번도 읽히지 않았습니다. 옛 열은 그대로 소프트 삭제되므로 그 행들의 값은 새 열에서 NULL이 되어 사라지고, 건너뛴 행은 `nulled`에도 잡히지 않아 경고조차 나가지 않습니다. 지금 UI에는 행을 넣는 경로가 없어 실사용에서 재현되지 않지만, 원본 id를 보존해 넣는 가져오기(Step 7)와 편집(Step 5)이 바로 이 경로를 씁니다. 첫 청크만 커서 없는 문장으로 읽게 고쳤습니다.

3. **Worker 모드에서 변환 취소가 닿지 않음.** 취소 메시지는 Worker의 태스크 큐로 들어오므로 실행 중인 작업이 이벤트 루프로 돌아와야 배달됩니다. 변환 복사 루프의 await는 `runBatch`를 포함해 전부 마이크로태스크라 루프가 끝날 때까지 큐가 돌지 않았고, 취소 버튼을 눌러도 `signal`이 변환이 다 끝난 뒤에야 abort됐습니다. **Step 3의 "대용량 진행률·취소" 완료 기준이 실제로는 인라인(단일 스레드) 폴백에서만 성립하고 있었습니다.** 기존 취소 단위 테스트가 인라인 전송을 쓰는데 인라인 전송은 `dispatch`를 동기로 부르므로 이 차이가 드러나지 않았습니다. 청크마다 태스크 하나를 양보하고(10만 행이면 20회, 수십 ms), 회귀 테스트는 진짜 Worker처럼 메시지를 태스크로 배달하는 전송을 씁니다. 진행률 이벤트는 Worker → 메인 방향이라 원래도 정상 표시됩니다.

4. **쓰기 도중의 저장.** 6장 배타 규칙이 쓰기 op만 열거하고 `db.snapshot`은 빼 두어, 긴 쓰기가 도는 중의 Ctrl+S가 그 트랜잭션 안으로 끼어들었습니다. `bumpRevision`이 중첩 SAVEPOINT로 들어가고 이름(`jdr_sp_<depth>`)이 겹쳐 저장이 `E_DB_QUERY: rollback failed after error`로 끝나는데, **파일에는 아무것도 쓰이지 않았는데 `revision`과 `saved_by`는 올라간 DB가 남습니다**(실측: revision 0 → 1, saved_by 기록됨). 저장되지 않은 것을 저장된 것처럼 기록하므로 이후 revision 판정이 어긋납니다. 3번 수정이 Worker 모드에서도 이 틈을 열기 때문에 함께 고쳤습니다. `db.snapshot`·`db.close`를 배타 op에 넣어 `E_DB_BUSY`로 거절합니다.

5. **읽기 전용 테이블의 삭제.** `tables.drop`에만 `requireStrict`가 없어 외부 파일에서 등록한 테이블을 되돌릴 수 없이 지울 수 있었고, 사이드바도 그 테이블에 "삭제" 버튼을 그렸습니다. 같은 테이블에 "외부" 읽기 전용 배지가 붙고 열 추가는 비활성인데 삭제만 열려 있어, 안전하다고 안내한 자리에서 남의 파일의 데이터가 사라집니다(실측: `users` 테이블과 2행이 물리 삭제됨). `table.drop`은 앱 전체에서 유일하게 `undo`가 비어 있는 커맨드입니다. DESIGN.md 4.1과 R7이 `strict = 0` 테이블을 v1에서 읽기 전용으로 규정하므로 문서 변경 없이 코드를 문서에 맞췄습니다. 표시 이름 변경은 메타만 바꾸고 되돌릴 수 있어 그대로 뒀습니다(세션 B 테스트의 "이름 변경과 삭제는 허용된다" 주석을 이 기준으로 고쳤습니다 — **리뷰어 확인 필요**).

6. **모달 뒤의 Ctrl+S.** 저널 복구 대화상자가 "복구할까요?"를 묻는 동안 Ctrl+S를 누르면, 아직 답하지 않아 복구 전인 DB가 그대로 파일로 쓰이고 revision이 오르며 저널이 비워집니다. 복구하려던 변경이 저장 대상에서 빠진 채 "저장됨"이 됩니다. 모달 뒤에서 앱이 움직이면 안 된다는 것은 포커스 트랩과 같은 규칙인데 전역 단축키만 그 밖에 있었습니다. 같은 처리기에 빠져 있던 `isComposing` 검사도 넣었습니다(CLAUDE.md 5.5).

**테스트 하네스 문제 (같은 커밋 `1dbd532`)**

`dist/test/jdrdatabase.html`은 `npm run test:e2e`만 만들었습니다. 그래서 `npx playwright test -g …`로 하나만 돌리면 지금 소스가 아니라 마지막으로 빌드된 산출물이 열리고 통과도 실패도 믿을 수 없습니다. 실제로 6번 회귀 테스트를 이 탓에 한 번 "고치지 않아도 초록"으로 잘못 읽어 수정을 버릴 뻔했습니다. `playwright.config.js`의 `globalSetup`에서 테스트 빌드를 만들게 해 어떤 방식으로 실행하든 지금 소스를 검사합니다.

**재현 테스트 (모두 수정 전 빨강 확인)**

- `store.test.js`: `열기: 미저장 변경을 버리고 연 파일은 깨끗한 상태로 시작한다`, `열기: 저널을 복구하면 복구된 테이블이 스토어 목록에도 보인다`
- `tables.test.js`: `changeColumnType: id가 0 이하인 행도 빠짐없이 변환된다`, `외부 파일에서 등록한 테이블(strict = 0)은 스키마 변경을 거부한다`(삭제 거부와 행 보존 단언 추가)
- `rpc.test.js`: `취소: 메시지가 태스크로 배달되는 Worker 모드에서도 변환 중에 닿는다`, `db.snapshot: 쓰기 op가 도는 중의 저장은 E_DB_BUSY이고 DB를 건드리지 않는다`
- `e2e/file.spec.js`: `모달이 열려 있는 동안 Ctrl+S는 동작하지 않는다`(globalSetup 수정 뒤 빨강 → 초록을 다시 확인)
- `e2e/schema.spec.js`: 외부 파일 테이블에 `table-drop` 버튼이 없음을 추가 확인

**문서 갱신 (해당 커밋에 포함)**

- `DESIGN.md` 6장 규칙: `db.snapshot`·`db.close`를 배타 op에 추가하고 그 이유(트랜잭션 전제, 중첩 SAVEPOINT 충돌, 가짜 revision)를 적음.
- `DESIGN.md` 6장: 긴 작업은 청크 사이에서 이벤트 루프로 돌아와야 취소 메시지를 받는다는 규칙 추가(변환 복사, 가져오기).

**검증 결과**

- [x] `npm run check`: eslint 0건, prettier 통과, tsc 0오류, 단위 테스트 138개 통과(세션 B의 133개 + 신규 5개).
- [x] `npm run build && npm run verify`: `verify OK`, 외부 참조 0건(허용 vendor 리터럴 2건), vendor 체크섬 일치, 두 변형 CSP 외 동일.
- [x] `npm run test:e2e`: Chromium `file://`에서 16개 통과(세션 B의 15개 + 신규 1개).
- [x] 7.1 grep: `innerHTML` 0건, 모드 문자열 허용 위치 밖 0건, `src/db`의 남은 템플릿 리터럴은 모두 오류 메시지·`summary` 문자열이며 SQL 값 삽입 없음.
- [x] 새 오류 코드 없음. 새 RPC op 없음(기존 op의 배타 규칙만 바뀜).

**산출물 크기 (`verify` 출력)**

- `dist/jdrdatabase.html` 1,711,868 bytes (1.63 MiB / 예산 6 MiB). 세션 B(1,711,410) 대비 +458 bytes. 부품: main 291.7 KB, worker 240.0 KB, wasm(base64) 1,131.4 KB, css 8.1 KB.
- `dist/tauri/index.html` 1,711,676 bytes (CSP 메타 줄만 다름을 `verify`가 확인).

**점검했지만 고치지 않은 것 (판단 근거와 함께)**

- 저널은 "버리기"를 골라도 남습니다. 미저장 변경이 있는 DB-A에서 "버리고" 파일 B를 열면 A의 저널은 그대로 있다가, 나중에 A를 다시 열 때 복구 후보로 제안됩니다(다른 dbId의 기록은 B에 처음 기록할 때 지워집니다). 크래시 안전망으로서는 안전한 쪽이지만 "버리기"라는 말과는 어긋납니다. 어느 쪽이 의도인지 설계 판단이라 그대로 두고 적습니다.
- `openDialog`는 이미 열린 대화상자가 있으면 그것을 DOM에서 지우기만 하고 앞 Promise를 resolve하지 않습니다(호출자가 영원히 대기 + `document` keydown 리스너 누수). 지금은 포커스 트랩과 배경 때문에 두 개를 동시에 열 경로를 찾지 못해 재현하지 못했고, 재현 없이 고치지 않았습니다. Step 4 이후 경로가 늘면 다시 봐야 합니다.
- `engine.exec`가 핸들러에서 문장을 트랜잭션으로 감싸므로 쓰기와 동시에 오면 4번과 같은 SAVEPOINT 충돌을 낼 수 있습니다. 진단·테스트 전용 op이고 스토어가 부르지 않아 배타 목록에 넣지 않았습니다.
- `validateInteger`·`validateReal`이 문자열에서 쉼표를 모두 지웁니다(`"1,2"` → `12`). 천 단위 구분 기호를 받으려는 의도로 보이며, 가져오기(Step 7)에서 로케일 판단과 함께 다시 볼 문제라 두었습니다.
- `reorderColumns`는 살아 있는 열에 0..n-1을 새로 매기므로 소프트 삭제된 열의 `position`과 겹칠 수 있습니다. 표시 순서는 `position, id`로 결정되어 어긋나 보이지 않아 두었습니다.

**미확인 (세션 B에서 이어받아 그대로 남음)**

- File System Access 경로(`showOpenFilePicker`/`showSaveFilePicker`/`createWritable`/권한 재요청/최근 파일 핸들 복원)는 헤드리스에서 자동화할 수 없어 코드 경로만 있고 실측 미확인. Chrome/Edge 데스크톱에서 손으로 확인해야 합니다.
- Firefox·Safari의 IndexedDB(`file://`)·다운로드 폴백 미확인. 지원 매트릭스는 여전히 Chromium 141 headless `file://`만 실측.
- 메모리 부족(`E_MEM`) 경로, 두 탭 동시 열기의 실제 브라우저 시나리오, 10만 행 이상 타입 변경의 진행률·취소 UI(단위·회귀 테스트는 1.2만 행), 저널 50 MB 배너의 실사용은 미확인.
- 이번에 넣은 청크당 이벤트 루프 양보의 실제 변환 시간 영향은 10만 행 이상에서 측정하지 않았습니다(산술로는 20회 × 수 ms).
- `filesystem.capabilities().native`는 스텁(Step 11).
- Rust/rusqlite 컴파일 플래그(R9), 기본 확장자·자동 저장 기본값은 여전히 미확정.

### 세션 C (Step 4) — 2026-09-20

커밋: `da6a08a` docs(design) 착수 전 창 질의 형식·픽스처 규격 확정 → `14e188d` feat(grid) Step 4 → `6bab4b1` test(e2e) 저널 복구 검사의 경쟁 조건 수정 → `ef2fc3b` test(e2e) 열 고정 검사의 경쟁 조건 수정.

시작 상태: 원격 `1dbd532`를 받아 `npm run check`(138개)가 초록임을 확인한 뒤 시작했습니다. 세션 B 점검의 미확인 항목은 아래 "미확인"에 그대로 이어받았습니다.

**설계 변경 (코드보다 먼저 DESIGN.md v0.5에 반영, 리뷰어 확인 필요)**

- **Step 4 완료 기준의 픽스처 규격.** 원문 "2열은 평균 5 KB, 1%는 100 KB 이상"은 30만 행에서 약 3 GB가 되어 wasm 엔진의 `maxFileBytes`(1.5 GB)를 넘고 8장의 측정 환경(약 300 MB DB)과도 맞지 않습니다. 장문 2열을 "평균 약 200자, 0.1%는 100 KB 이상"으로 바꿨습니다(실측 314 MB). 장문 셀의 미리보기·배지 경로는 0.1%(열당 300셀)로 충분히 검사됩니다.
- **D-06 창 질의의 실측과 id 탐색 경로.** `OFFSET m`은 rowid b-tree 잎 셀을 m개 걸어야 해서 30만 행 끝에서 50~60 ms가 걸려 8장 예산(50 ms)을 넘었습니다(첫 측정 최대 60.8 ms, Node 벤치 OFFSET 0/5만/15만/29.98만 = 10/15/28/50 ms). 정렬·필터가 없는 기본 뷰에서 id가 빈틈없이 연속이면(`max - min + 1 = count`) `WHERE id >= min + m ORDER BY id LIMIT n`으로 O(log n) 탐색을 쓰도록 했고(7~12 ms), 행 삭제로 연속이 깨지면 OFFSET으로 돌아갑니다(R6에 남김). 연속 판정에 쓰는 행 수는 Worker가 쓰기 op 일련번호와 함께 캐시합니다(`count(*)`는 35 ms). `min`·`max`는 따로 묻습니다(한 문장에 둘을 넣으면 SQLite가 전체 스캔을 해 57 ms).
- **6장 RPC.** `query.window` 인자 `{ tableId, viewSpec, offset, limit, seq }` → 결과 `{ rows, columnIds, seq, elapsedMs }`(`rows[i] = { id, cells, lengths }`, text·longtext는 `substr(1, 256)` 미리보기와 잘렸을 때만 전체 길이), `query.count` → `{ count }`, `query.row` → `{ row: { id, cells } | null }`. Step 4의 `viewSpec`은 `{ hidden }`만 해석하고 정렬·필터는 Step 6이 같은 빌더에 더합니다.
- 3.1에 `ui/grid/cache.js`(블록 캐시), `test/perf/`(성능 측정, CI 밖), `gen-fixture --db`. CLAUDE.md 3장에 `npm run test:perf`. 뷰 상태(열 너비·고정 열)는 메모리에만 두고 파일 저장은 Step 6의 뷰 저장이 맡는다고 Step 4 산출물에 명시했습니다(Step 4에는 너비를 쓰는 RPC op가 없음).

**Step 4 완료 기준**
- [x] 30만 행 × 20열(장문 2열) DB에서 스크롤 프레임당 렌더 16 ms 이하, 창 질의 50 ms 이하: `npm run test:perf`(`test/perf/grid.perf.spec.js`). 픽스처는 `scripts/gen-fixture.mjs --db --rows 300000`(314,286,080 bytes, 생성 18.7초). 측정은 무작위 점프 40회(캐시에 없는 블록을 계속 요청) + 휠 스크롤 120단계이고, 렌더 시간은 테스트 빌드의 `performance.measure('jdr:grid.render')`, 창 질의 시간은 Worker가 `query.window` 결과에 실은 `elapsedMs`의 최댓값입니다. Chromium 141 headless(이 세션의 컨테이너):
  - 1차(OFFSET만): 렌더 p50 0.4 / p95 1.4 / 최대 4.4 ms, 창 질의 53회 최대 **60.8 ms — 예산 초과**. 원인 분석(위 D-06)과 id 탐색 경로 추가.
  - 2차(id 탐색): 렌더 p50 0.4 / p95 1.4 / 최대 5.7 ms, 창 질의 53회 최대 **29.7 ms**, 300 MB 파일 열기(읽기 → transfer → deserialize → integrity_check → 그리드 행 수 표시) 1.9~3.2초. DOM 행 46개.
  - 3차: 렌더 p50 0.4 / p95 1.5 / 최대 3.4 ms, 창 질의 53회 최대 **33.7 ms**, 열기 1.9초. 최대값은 100 KB 셀이 든 블록(`substr`·`length`가 overflow 페이지를 읽음)으로 보이며 예산 안입니다.
  - 주의: 이 수치는 컨테이너의 헤드리스 Chromium 값이고 8장의 "4코어 노트북"이 아닙니다. 아래 미확인 참조.
- [x] 단위: `computeRange` 경계(첫 행, 마지막 행, 뷰포트보다 적은 행 수, 행 0개, 행 경계에 걸친 scrollTop): `test/unit/ui/grid/grid.test.js`. 같은 파일에서 1,000만 px 초과 시 스크롤 스케일링(캔버스 상한, 끝 행 도달, 환산 함수의 역함수 관계)과 열 배치·열 범위·고정 열 제외를 검사.
- Step 4 예외 처리 대응:
  - 지나간 범위의 응답 폐기: 테이블 전환·무효화마다 세대 번호를 올리고 이전 세대 응답은 캐시에 넣지 않음. 같은 세대 응답은 블록 캐시에 넣고 현재 가시 범위만 다시 그림(요청 순번 `seq`는 왕복 확인용, RPC 단위 테스트). DESIGN.md Step 4 예외 항목에 구현 방식을 적었습니다.
  - 창 질의 실패(테이블 삭제 등): `E_DB_QUERY` 토스트 → 그리드 해제 → `selectTable(null)` → "테이블을 선택하세요" 빈 상태 + 목록 재조회(RPC 단위 테스트가 삭제된 테이블의 `query.window`가 `E_DB_QUERY`임을 확인, UI 경로는 코드 경로만).
  - 스크롤 스케일링: 단위 테스트(100만 행). 실제 100만 행 픽스처의 스크롤은 미확인.
  - 미리보기 초과 값의 말줄임·길이 배지: 단위(`cells.preview`, `query.fetchWindow`가 256자 + 전체 길이) + E2E(1,600자 셀 → 257자 표시 + "1,600자" 배지, 짧은 값에는 배지 없음). `length()`가 큰 값도 SQL이 256자만 돌려주므로 그리드는 256자만 받습니다(100 KB 셀은 perf 픽스처의 0.1%로 스크롤 중 실제 통과).
  - 열이 모두 소프트 삭제된 테이블: E2E(열 삭제 → "열이 없습니다" → 복원 → 그리드 복귀 → 테이블 삭제 → 테이블 선택 안내).
- 그 밖의 목표 항목: 열 너비 조절(머리글 손잡이 끌기, `setPointerCapture`, 하한 40 px, 스토어 뷰 상태에 남아 테이블을 오가도 유지; E2E), 열 고정(그리드 상단 바의 선택 상자 0~5개, 행 번호 열은 항상 고정, 가로 스크롤에도 왼쪽에 남음; E2E), 행 번호(1부터, 천 단위 구분; E2E). 키보드(화살표·PageUp/Down·Home/End·Ctrl+Home/End로 활성 셀 이동 + 자동 스크롤, 셀 클릭; E2E). 접근성: `role="grid"`·`row`·`gridcell`·`columnheader`·`rowheader`, `aria-rowcount/colcount/rowindex/colindex`, 포커스 가시 윤곽. 편집·선택 범위는 Step 5.

**검증 결과**
- [x] `npm run check`: eslint 0건, prettier 통과, tsc 0오류, 단위 테스트 163개 통과(세션 B 점검 138 + 신규 25: query 10, grid 6, cache 3, cells 3, format 1, rpc 2).
- [x] `npm run build && npm run verify`: `verify OK`, 외부 참조 0건(허용 vendor 리터럴 2건), vendor 체크섬 일치, 두 변형 CSP 외 동일.
- [x] `npm run test:e2e`: Chromium `file://`에서 22개 통과(세션 B 점검 16 + `grid.spec.js` 6). 전체 3회 반복 통과. 테스트 쪽 경쟁 조건 2건을 고쳤습니다(앱 코드 변경 없음): (1) 기존 `schema.spec.js`의 저널 복구 검사가 `db_id`만 기다리고 재생이 끝나기 전의 빈 테이블 목록을 단언해 3회 중 1회 실패 → 스키마도 poll(`6bab4b1`). (2) 새 `grid.spec.js`의 열 고정 검사가 scrollLeft를 바꾼 직후 boundingBox를 읽어 다음 프레임의 translateX 갱신 전 값을 볼 수 있었음(CI push 실행 `35504591380`에서 1회 재현, 같은 커밋의 pull_request 실행은 통과) → 고정 칸·다음 칸 위치도 poll(`ef2fc3b`).
- [x] `npm run test:perf`: 위 수치.
- [x] 7.1 grep: `innerHTML` 0건, 모드 문자열 허용 위치 밖 0건, `src/db/query.js`의 템플릿 리터럴은 `quoteIdent()` 식별자와 상수 `PREVIEW_CHARS`뿐이고 offset·limit·fromId는 바인딩(단위 테스트가 SQL 문자열에 값이 없음을 확인).
- [x] 새 오류 코드 없음. 새 RPC op 3개(`query.window`·`query.count`·`query.row`)는 6장 표, `db/worker.js` OpMap·핸들러, RPC 단위 테스트에 함께 반영. i18n ko/en 키 동일(단위 테스트).
- [x] 핫 경로 측정치(CLAUDE.md 5.7): 렌더 p50 0.4 ms, p95 1.4 ms(5,000행 E2E와 30만 행 perf 모두 DOM 행 30~46개). 렌더는 뷰포트 크기를 `ResizeObserver`로 받고 렌더당 `scrollTop/scrollLeft`만 읽으며, 텍스트 노드·배지·transform·width는 값이 바뀔 때만 씁니다.

**산출물 크기 (`verify` 출력)**
- `dist/jdrdatabase.html` 1,737,463 bytes (1.66 MiB / 예산 6 MiB). 세션 B 점검(1,711,868) 대비 +25,595 bytes. 부품: main 309.1 KB, worker 242.7 KB, wasm(base64) 1,131.4 KB, css 11.1 KB.
- `dist/tauri/index.html` 1,737,271 bytes (CSP 메타 줄만 다름을 `verify`가 확인).

**미확인 (후속 세션에서 이어받음)**
- 성능 수치는 이 세션 컨테이너의 헤드리스 Chromium 141에서 잰 것입니다. 8장의 측정 환경(4코어 노트북, 실제 화면 합성 포함)에서의 60 fps와 창 질의 50 ms는 미확인이며 세션 H에서 `perf-baseline.json`과 함께 다시 잽니다. `test:perf`는 CI에서 돌리지 않습니다(픽스처 314 MB 생성 + 열기).
- 행 삭제 뒤(id가 성긴 테이블)의 OFFSET 폴백은 30만 행 끝부분에서 50~60 ms로 예산을 넘을 수 있습니다. Step 5(삭제)·Step 6(정렬·필터는 어차피 OFFSET)에서 R6의 대응(정렬 열 인덱스, keyset)을 판단해야 합니다.
- 100만 행 이상(스크롤 스케일링 실동작)은 단위 테스트만 있고 실측 미확인.
- 창 질의 실패 → 사이드바 복귀의 UI 경로는 코드 경로만(테이블이 사라지는 시나리오를 E2E에서 만들 방법이 UI 삭제뿐이고 그 경우는 `tables:changed`가 먼저 그리드를 닫습니다).
- 세션 B 점검에서 이어받은 항목 그대로: File System Access 경로 실측, Firefox·Safari, `E_MEM`, 두 탭 동시 열기, 10만 행 이상 타입 변경 UI, 저널 50 MB 배너, `filesystem.capabilities().native` 스텁, Rust/rusqlite 플래그(R9), 기본 확장자·자동 저장 기본값.

### 세션 C 점검 (세션 C 산출물 코드 점검) — 2026-09-20

세션 C의 `ef2fc3b`를 원격 최신으로 맞춘 뒤 전체 파이프라인을 재현하고(`check` 163개, `build`, `verify`, `test:e2e` 22개, `test:perf` 모두 초록) 코드를 점검했습니다. 초록인 상태에서 드러나지 않은 문제 5건을 재현 테스트와 함께 고쳤습니다. 새 기능은 없고 Step 5 이후를 앞당겨 구현하지 않았습니다.

커밋: `3beac90` → `4646dab` → `94a5c1e` → `1f6565a` → `57d2e21` (문제 하나당 커밋 하나).

**고친 문제**

| # | 문제 | 커밋 |
|---|---|---|
| 1 | 테이블을 오가면 활성 셀 표시가 지워지지 않고 쌓임 | `3beac90` |
| 2 | 닫았다 다시 연 그리드에서 스크롤 외 상호작용이 전부 죽음 | `4646dab` |
| 3 | 테이블 목록을 다시 읽을 때마다 스크롤·활성 셀이 처음으로 돌아감 | `94a5c1e` |
| 4 | `role="grid"`가 행을 소유하지 못하는 DOM 구조 | `1f6565a` |
| 5 | 스키마가 바뀐 뒤 온 창 질의 응답이 값을 한 칸 밀어 그림 | `57d2e21` |

1. **활성 셀 표시가 남음.** 활성 셀을 모듈 변수 `cursorEl` 하나로 가리켰는데, `clearRows()`는 그 포인터만 null로 만들고 DOM의 `--active` 클래스와 `aria-selected`는 그대로 둡니다. 풀로 돌아간 칸이 활성 표시를 단 채 남고, 그 칸이 다른 행에 재사용될 때 `renderRow`의 `else if (cursorEl === cell)` 분기가 걸리지 않아(포인터가 이미 null) 표시가 지워지지 않습니다. `clearRows()`는 `mount()`가 부르므로 테이블을 옮기기만 해도 재현됩니다. 실측: 테이블 A(행 5,000) → 빈 테이블 만들기 → A로 돌아오기 뒤 `.jdr-grid__cell--active`가 2개, `aria-selected="true"`도 2개입니다. 화면에 활성 셀이 둘로 보이고 선택된 칸이 둘이라고 노출됩니다. 칸마다 마지막으로 쓴 활성 여부를 `cellCursor`에 들고 비교하도록 바꿨습니다(`cellFrozen`·`cellWidths`와 같은 방식이라 렌더 경로 할당이 늘지 않고, 풀로 돌려보낼 때 표시를 떼고 갑니다).

2. **닫았다 다시 연 그리드가 죽음.** `unmount()`는 리스너 여덟 개를 다 떼는데 `mount()`는 스크롤 하나만 다시 겁니다. 나머지 일곱(열 고정 선택 상자, 머리글 포인터 4종, 셀 클릭, 키보드)은 `createGrid()`에서 한 번만 걸려 있어 언마운트 뒤에는 돌아오지 않습니다. 그리드 호스트는 선택된 테이블이 없거나 보이는 열이 없으면 `closeGrid()`로 언마운트하므로 닫혔다 열리는 경로가 흔합니다 — 열 없는 테이블을 골랐다 돌아오기, 보던 테이블을 삭제한 뒤 다른 테이블 고르기, 창 질의 실패로 `onError`가 `selectTable(null)`로 되돌린 뒤 다시 고르기. **이 뒤로 그리드는 멀쩡히 그려지지만 열 너비 조절·열 고정·셀 클릭·키보드 이동이 전부 무반응이고 사용자가 볼 수 있는 단서가 없습니다.** 실측: 위 첫 경로 뒤 `.jdr-grid__frozen-select`를 바꿔도 `--frozen` 클래스가 붙지 않습니다. 등록·해제를 `addListeners()`·`removeListeners()` 한 쌍으로 묶었습니다(CLAUDE.md 5.5).

3. **목록을 다시 읽으면 스크롤이 처음으로.** 호스트가 `tables:changed`마다 `grid.mount()`를 다시 불렀고, `mount()`는 세대를 올리고 블록 캐시를 비우고 `scrollTop`·`scrollLeft`·활성 셀을 0으로 되돌립니다. `runSchemaOp`는 성공·실패 양쪽에서 `refreshTables()`를 부르므로 지금 보는 것과 무관한 변경도 포함됩니다. 실측: 5,000행 테이블을 `scrollTop = 40000`까지 내린 뒤 **테이블 이름만 바꿔도** `scrollTop`이 0이 됩니다(열 이름 바꾸기, 다른 테이블의 스키마 변경, 저널 재생도 같음). 30만 행 끝부분을 보던 중이라면 다시 스크롤해 찾아가야 합니다. `grid.applyTable(table)`을 두어, 같은 테이블이고 보이는 열의 id 목록이 순서까지 같으면 메타만 갈아 끼우고 머리글을 다시 그립니다. 목록을 다시 읽은 이유가 행도 바꿨을 수 있으므로(저널 재생은 `data:changed` 없이 행을 바꿉니다) 데이터는 `invalidate()`로 버리고 행 수를 다시 셉니다. 열이 늘거나 줄거나 순서가 바뀌면 `false`를 돌려주어 전처럼 다시 마운트합니다.

4. **`role="grid"`의 소유 관계.** `role="grid"`를 바깥 상자에 두어 그 자식이 도구 모음(행 수 표시 + 고정 열 선택 상자)과 스크롤 영역이었습니다. ARIA에서 grid가 소유할 수 있는 것은 row와 rowgroup뿐인데, 도구 모음은 둘 다 아니고 머리글 행·행 그룹은 역할 없는 스크롤 div 아래에 있어 grid의 것이 아닙니다. 실측(Chromium 141, 접근성 트리 `interestingOnly: false` 덤프): grid의 자식이 `none`(도구 모음)과 `generic`(스크롤 영역)이고 row·rowgroup·columnheader·rowheader·gridcell은 그 `generic` 아래에 있습니다. **역할 자체는 붙어 있지만** grid가 행을 소유하지 않으므로 `aria-rowcount`·`aria-colcount`·`aria-rowindex`가 무엇을 세는지 성립하지 않습니다. `role="grid"`와 `tabindex`·`aria-label`·`aria-rowcount`·`aria-colcount`, 키보드 처리기를 스크롤 영역으로 옮겨 `grid > row`(머리글)와 `grid > rowgroup > row`가 직접 이어지게 했습니다. 수정 뒤 같은 덤프에서 grid의 자식은 row와 rowgroup 둘뿐입니다. **실제 스크린 리더의 읽기는 이 환경에서 확인하지 못했습니다(미확인).**

5. **창 질의 응답의 열 목록을 확인하지 않음.** 그리드와 Worker가 "보여 줄 열 목록"을 따로 정합니다. 그리드는 `mount()` 시점의 메타로 `columns`를 굳히고, Worker는 `query.window`가 올 때마다 그 시점의 메타로 `visibleColumns()`를 다시 부릅니다. 그런데 값은 열 이름이 아니라 위치로 맞춥니다(`cells[j]`를 `columns[j]`에 꽂습니다). 응답에는 어떤 목록으로 만들었는지 `columnIds`가 실려 오는데 읽는 곳이 없었습니다(캐시에 저장만 했습니다). `runSchemaOp`는 DDL을 적용한 뒤 `recordCommand`(→ `data:changed` → `grid.invalidate()`)와 `refreshTables`(→ `tables:changed` → 다시 마운트)를 차례로 기다리므로, `invalidate()`가 예약한 렌더가 `refreshTables` 응답보다 먼저 돌면 옛 열 목록을 가진 그리드가 새 메타를 쓰는 Worker에게 창 질의를 보냅니다. 보통은 `schema.list` 왕복이 rAF보다 빨라 다시 마운트가 이기지만, Worker가 밀려 있거나 테이블이 많으면 뒤집힙니다. 실측(회귀 테스트로 `schema.list`만 3초 늦춰 재현): 열이 [이름, 나이, 비고]인 테이블에서 가운데 "나이"를 지우면 Worker는 [이름, 비고] 두 칸을 돌려주는데 그리드는 아직 셋을 그려, **"나이" 머리글 밑에 "비고1"이 들어가고**(정수 열의 오른쪽 정렬로 그려집니다) "비고" 열은 빈칸이 됩니다. 값이 사라지지는 않지만 다른 열 이름 밑에 보이므로 읽는 사람이 틀린 값을 가져갑니다. `fetchBlock`이 이미 받고 있던 `columnIds`를 지금 `columns`와 대조해 길이나 순서가 다르면 그 응답을 버립니다. 버린 블록은 캐시에 없으므로 목록이 맞춰진 뒤의 렌더가 다시 요청합니다(그 사이 해당 칸은 비어 보입니다. 캐시는 `invalidate()`가 막 비운 참이라 새로 생기는 빈 구간은 없습니다).

**재현 테스트 (모두 수정 전 빨강 확인)**

- `e2e/grid.spec.js`: `테이블을 오가도 활성 셀은 하나뿐이다`(1번), `그리드를 닫았다 다시 열어도 고정·너비·클릭·키보드가 살아 있다`(2번), `열 구성이 그대로면 목록을 다시 읽어도 스크롤·활성 셀·열 너비가 남는다`(3번, 열을 더하면 다시 마운트되어 스크롤이 0으로 돌아가는 것도 함께 단언), `접근성: role="grid"가 행·행 그룹을 직접 소유하고 다른 자식이 없다`(4번), `스키마가 바뀐 뒤 다시 마운트되기 전에 온 창 질의 응답은 버린다`(5번).
- 1번은 세션 C의 원본 코드(`ef2fc3b`)에서 따로 확인했습니다(2번 수정이 만든 경로가 아니라 테이블 전환만으로 재현됨을 가리기 위해).
- 5번은 경쟁 조건이라 `beforeEach`에 op 하나의 도착을 늦추는 전송 래퍼를 두어 결정적으로 재현합니다. `window.__jdrDelayOp`를 세우는 검사에서만 동작하고 세우지 않으면 무동작이라 다른 검사에 영향이 없습니다.

**문서 갱신 (해당 커밋에 포함)**

- `DESIGN.md` Step 4 주요 함수: `grid.applyTable(table)` 행 추가(언제 호출되고, 무엇을 유지하며, 언제 `false`를 돌려주는지).

**검증 결과**

- [x] `npm run check`: eslint 0건, prettier 통과, tsc 0오류, 단위 테스트 163개 통과(세션 C와 동일. 이번 수정은 모두 DOM·전송 경로라 단위 테스트가 늘지 않았습니다).
- [x] `npm run build && npm run verify`: `verify OK`, 외부 참조 0건(허용 vendor 리터럴 2건), vendor 체크섬 일치, 두 변형 CSP 외 동일.
- [x] `npm run test:e2e`: Chromium `file://`에서 27개 통과(세션 C의 22개 + 신규 5개). 전체 3회 반복 통과.
- [x] `npm run test:perf`: 30만 행 픽스처(314,286,080 bytes) 재생성 후 렌더 p50 0.4 / p95 1.4 / 최대 2.9 ms(212 표본), 창 질의 53회 최대 21.4 ms, DOM 행 46개. 둘 다 예산(16 ms / 50 ms) 안이고 세션 C의 3차(p50 0.4 / p95 1.5 / 질의 최대 33.7 ms)와 같은 수준입니다. 1번 수정이 렌더 경로에 칸당 불리언 배열 하나와 행을 풀로 돌려보낼 때의 짧은 루프를 더하고 5번이 응답당 열 목록 비교(열 수만큼)를 더하지만 측정에 나타나지 않습니다(CLAUDE.md 5.7). 파일 열기는 4.8초로 세션 C의 1.9~3.2초보다 길게 나왔는데, 같은 컨테이너에서 픽스처 생성 직후에 잰 값이고 앱 코드 변경과 무관합니다. (이 수치는 5번 수정 전에 잰 것이고, 5번은 렌더 경로가 아니라 응답 처리 경로에 상수 시간 비교를 더합니다.)
- [x] 7.1 grep: `innerHTML` 0건, 모드 문자열 허용 위치 밖 0건, `src/db/query.js`의 템플릿 리터럴은 `quoteIdent()` 식별자와 상수 `PREVIEW_CHARS`뿐이며 offset·limit·fromId는 바인딩.
- [x] 새 오류 코드 없음. 새 RPC op 없음. i18n 키 변화 없음.

**산출물 크기 (`verify` 출력)**

- `dist/jdrdatabase.html` 1,738,002 bytes (1.66 MiB / 예산 6 MiB). 세션 C(1,737,463) 대비 +539 bytes. 부품: main 310.5 KB, worker 243.6 KB, wasm(base64) 1,131.4 KB, css 11.1 KB.
- `dist/tauri/index.html` 1,737,810 bytes (CSP 메타 줄만 다름을 `verify`가 확인).

**점검했지만 고치지 않은 것 (판단 근거와 함께)**

- **행 수 캐시가 `viewSpec`을 키에 넣지 않습니다.** `worker.js`의 `countCache`는 `table.id`만으로 캐시하고 `query.count`는 `viewSpec`을 무시합니다(`void viewSpec`). Step 4에는 필터가 없어 맞지만, Step 6이 필터를 더하면 필터가 다른 두 뷰가 같은 행 수를 받고 그 값이 `denseFromId`의 연속 판정에까지 쓰입니다. Step 6에서 같이 봐야 합니다.
- **고정 열 뒤로 스크롤한 열이 가려집니다.** `computeColumnRange`는 `scrollLeft`만 보고 고정 열이 차지한 왼쪽 폭을 빼지 않으므로, 가로로 스크롤하면 첫 비고정 열이 고정 열 아래로 들어갑니다(z-index는 고정 열이 위). 표 도구의 흔한 동작이라 의도로 보고 두었습니다.
- **긴 타입 변환이 도는 중의 창 질의는 5번 수정으로 버려집니다.** `changeColumnType`의 `do`는 변환 복사보다 먼저 옛 열을 소프트 삭제하고 새 열 메타를 넣고, 변환 루프는 청크마다 이벤트 루프로 돌아오므로 그동안의 창 질의가 처리됩니다. 새 열이 옛 열의 `position`을 물려받아 목록 길이·순서는 그대로지만 id가 다르므로 5번의 대조에 걸려 버려집니다. 결과적으로 변환이 끝날 때까지 그 테이블의 그리드가 비어 보입니다(10만 행이면 수 분). 변환 중에 반쯤 채워진 새 열 값을 옛 열의 타입으로 그려 보이는 것보다 낫다고 판단했지만, 진행률 토스트 외에 "왜 비었는지"를 알리지 않으므로 Step 5·6에서 다시 볼 문제로 적어 둡니다 — **리뷰어 판단 필요**.
- **창 질의 실패가 재요청 루프를 만들지는 않습니다.** `fetchBlock`의 실패는 `onError` → 호스트가 `closeGrid()` + `selectTable(null)`로 그리드를 내리므로 같은 블록을 다시 요청하지 않는 것을 코드로 확인했습니다(UI 경로 자체는 세션 C에서 미확인으로 남은 그대로).
- 세션 B 점검이 남긴 "저널은 버리기를 골라도 남는다", "`openDialog`가 앞 Promise를 resolve하지 않는다", "`validateInteger`가 쉼표를 지운다", "`reorderColumns`의 position 겹침"은 이번 범위 밖이라 그대로 둡니다.

**미확인 (세션 C에서 이어받아 그대로 남음 + 이번에 생긴 것)**

- 4번 수정의 실제 스크린 리더 동작(NVDA·VoiceOver의 행·열 번호 안내)은 이 환경에서 확인할 수 없어 미확인입니다. 접근성 트리 구조만 실측했습니다.
- 5번 수정 뒤 긴 타입 변환 중 그리드가 비어 보이는 시간은 1.2만 행 이하에서만 관찰했고, 10만 행 이상에서 실제로 얼마나 오래 비는지는 미확인입니다.
- 성능 수치는 이 세션 컨테이너의 헤드리스 Chromium 141 값입니다. 8장의 측정 환경(4코어 노트북, 실제 화면 합성)에서의 60 fps와 창 질의 50 ms는 여전히 미확인이며 세션 H에서 `perf-baseline.json`과 함께 다시 잽니다.
- 행 삭제 뒤(id가 성긴 테이블)의 OFFSET 폴백은 30만 행 끝부분에서 50~60 ms로 예산을 넘을 수 있습니다(R6). Step 5·6에서 판단해야 합니다.
- 100만 행 이상(스크롤 스케일링 실동작)은 단위 테스트만 있고 실측 미확인.
- 창 질의 실패 → 사이드바 복귀의 UI 경로는 코드 경로만.
- File System Access 경로 실측, Firefox·Safari, `E_MEM`, 두 탭 동시 열기, 10만 행 이상 타입 변경 UI, 저널 50 MB 배너, `filesystem.capabilities().native` 스텁, Rust/rusqlite 플래그(R9), 기본 확장자·자동 저장 기본값.

### 세션 D (Step 5) — 2026-09-20

커밋: `afa2574` docs(design) 착수 전 데이터 커맨드·배치 문장·행 읽기 op 확정 → `8d557b9` feat(edit) Step 5.

시작 상태: 원격 `57d2e21`을 받아 `npm run check`(163개)가 초록임을 확인한 뒤 시작했습니다. 세션 C 점검의 미확인 항목은 아래 "미확인"에 이어받았습니다.

**설계 변경 (코드보다 먼저 DESIGN.md v0.6에 반영, 리뷰어 확인 필요)**

- **D-08 배치 문장과 옛 값의 출처.** `Statement`에 세 번째 형태 `{ batch: { sql, paramsList } }`(Worker가 `engine.runBatch()`로 실행)를 더했습니다. 붙여넣기·다중 편집·행 다중 삭제와 그 되돌리기가 이것을 쓰며, 목록 하나는 `runBatch` 상한(1만 건·64 MB) 안이어야 하므로 커맨드 생성기(`commands.chunkParams`)가 그 단위로 나눕니다. 데이터 커맨드는 메인의 순수 함수(`app/commands.js`)가 만들고, 되돌리기에 필요한 옛 값(셀 값, `_updated_at`, 삭제할 행 전체)은 커맨드를 만들기 전에 `query.rows`·`query.row`로 읽어 커맨드 안에 넣습니다. 그래야 되돌리기가 DB를 다시 읽지 않고도 "적용 → 되돌리기 → 덤프 동일"을 만족하고 저널에 기록된 커맨드만으로 재생이 끝납니다.
- **D-08 되돌리기의 저널 기록.** 저널 재생은 항상 `do` 방향이므로 되돌리기는 `do`·`undo`를 맞바꾼 역커맨드(`commands.invert`)로, 다시 실행은 원래 커맨드로 기록합니다. 재생 결과는 사용자가 마지막으로 본 상태와 같습니다(단위 테스트로 재생 확인).
- **D-08 새 행의 id.** 새 행의 `id`는 커맨드를 만들 때 정합니다(`query.stats`의 `maxId + 1`부터 연속). SQLite가 배정하게 두면 되돌리기가 지울 행과 다시 실행이 만들 행의 id를 알 수 없습니다. 행은 언제나 `id` 순서의 끝에 붙습니다. 그리드가 `id` 순으로 그리므로 "중간에 삽입"은 다른 행의 id를 바꿔야 하고, 그러면 앞선 커맨드의 되돌리기가 가리키는 행이 달라집니다. Step 5 원문의 `insertRows({ tableId, count, at })`는 `{ tableId, count, firstId, now }`가 되었습니다.
- **D-06 무효화의 두 가지.** 같은 테이블의 데이터 변경(편집·되돌리기)에 따른 무효화는 블록을 버리지 않고 낡은 것으로 표시해(`cache.markStale`) 다시 요청하며, 새 응답이 올 때까지 옛 행을 그대로 그립니다. 편집·되돌리기마다 셀이 비었다 채워지는 깜빡임이 사라집니다. 테이블 전환은 전처럼 블록을 버립니다.
- **6장 RPC.** `query.rows { tableId, viewSpec, offset, limit, colIds? }` → `{ rows }`(뷰 순서의 전문 행, 1만 이하. `colIds`를 비우면 소프트 삭제된 열까지 물리 열 전부 — 행 삭제의 되돌리기 스냅샷용), `query.stats { tableId }` → `{ count, minId, maxId }`. `query.row` 결과에 `createdAt`·`updatedAt`(시스템 열) 추가.
- 3.1에 `ui/grid/editing.js`(편집 컨트롤러), `styles/editor.css`. Step 5 주요 함수의 인자 확정(`editCell`·`insertRows`·`deleteRows`·`deleteRowRange`·`bulkEdit`·`invert`), 붙여넣기 값이 열 타입에 맞지 않으면 전체 거부(일부만 적용하면 무엇이 들어갔는지 알 수 없음), 읽기 전용 상태에서는 편집기를 열지 않음.

**Step 5 완료 기준**
- [x] 단위: 커맨드 do/undo 대칭성(모든 커맨드 타입에 대해 적용 → 되돌리기 → DB 덤프 동일): `test/unit/app/commands.test.js`가 `editCell`, `insertRows`, `deleteRows`(소프트 삭제된 열의 값까지 담은 스냅샷), `bulkEdit`(편집 + 삽입, 삽입만), `invert`에 대해 "적용 → 되돌리기 → 덤프 동일 → 다시 적용 → 첫 적용과 동일 → 되돌리기 → 동일"을 실제 wasm DB로 검사합니다. `deleteRowRange`는 `irreversible`이라 `undo`가 `E_UNDO_LIMIT`임을 확인합니다. 배치 문장 자체는 `test/unit/db/command.test.js`(do → undo 덤프 동일, 배치 중간 실패 시 앞 문장까지 전체 롤백, 빈 목록 건너뜀). 스키마 커맨드의 대칭성은 세션 B의 `tables.test.js` 그대로입니다.
- [x] E2E: 한글 IME 시뮬레이션으로 셀 편집 확정: `test/e2e/edit.spec.js` "인라인 편집: 한글 IME 시뮬레이션으로 확정, 조합 중의 Enter는 확정하지 않는다" — Enter로 편집기를 열고 `compositionstart` 디스패치 → `keyboard.insertText('한')` → `isComposing: true`인 합성 Enter keydown → 편집기가 그대로 열려 있음 → `insertText('글')` → `compositionend` → 실제 Enter → 셀 '한글', 커서 한 칸 아래, 포커스는 그리드, dirty 표시, `_updated_at`이 기록된 행 1건.
- [x] E2E: 1,000 × 20 TSV 붙여넣기 → 되돌리기 → 다시 실행: "1,000 × 20 TSV 붙여넣기 → 되돌리기 → 다시 실행" — 텍스트 열 20개 테이블에서 `navigator.clipboard.writeText` 뒤 실제 Ctrl+V → 행 1,000, 셀 (999, 19) '값1000-20', 토스트 "1,000행 × 20열" → Ctrl+Z → 행 0 → Ctrl+Shift+Z → 행 1,000, `count/min/max = 1000/1/1000`.
- Step 5 예외 처리 대응(어디서 확인했는지):
  - IME `isComposing`: 인라인 편집기(E2E 시뮬레이션), 장문 패널과 단축키 표(`shortcuts.test.js`: 조합 중 Enter·Esc·`Process`는 어떤 행동도 아님). 셀에서 바로 타이핑 → 첫 글자가 초기값: E2E("타이핑으로 편집 시작…", 정수 열에 `42`).
  - 확정값 검증 실패 시 편집기 유지: E2E(정수 열에 `abc` → "정수가 아닙니다." + `aria-invalid`, Esc로 취소하면 원래 값).
  - 편집 중 다른 곳 클릭: E2E(잘못된 값 → 원래 값으로 되돌리고 토스트, 올바른 값 → 확정).
  - 붙여넣기 경계 초과(행 자동 추가, 열 버리고 안내): E2E("붙여넣기: 기존 행 덮어쓰기 + 경계 밖 행 자동 추가…") + 단위 `clipboard.test.js`(`planPaste`).
  - 100만 셀 상한 `E_PASTE_TOO_LARGE`: 단위(`planPaste`). UI 토스트는 코드 경로만.
  - 되돌리기 스냅샷 10,000행: 단위(`deleteRows`·`bulkEdit`이 `E_UNDO_LIMIT`, `bulkEdit`의 `irreversible` 옵션은 상한 없이 `undo`가 빈 커맨드, `deleteRowRange`). 확인 대화상자 → `irreversible` 적용 → 히스토리 비움(`history.test.js`)은 각각 단위이고, UI에서 1만 행을 넘게 고르는 시나리오는 코드 경로만.
  - 커맨드 실행 중 Worker 오류(히스토리 제거, 재조회, 토스트): 단위 `history.test.js`("실패한 apply·undo는 알리고 히스토리에서 빠지며 DB는 그대로다").
  - 장문 편집기 열림 상태에서 행 삭제: E2E(패널이 닫히고 안내).
  - 5 MB 경고: 코드 경로만(`TextEncoder` 바이트 수 기준, 저장 허용).
  - 읽기 전용: 단위 `history.test.js`(앱보다 새 schema_version 파일에서 apply·undo 거부 + `file.readOnlyBlocked`). 편집기가 열리지 않는 경로는 코드 경로만.
- 그 밖의 목표 항목: 셀·범위·행 선택(클릭, Shift+클릭, 드래그, Shift+화살표, Ctrl+A, 행 번호 클릭; 단위 `selection.test.js` + E2E), 행 추가(`+ 행`, Ctrl+Shift+Enter)·행 삭제(`행 삭제`, Ctrl+Shift+Delete)·범위 지우기(Delete/Backspace)와 되돌리기(E2E "행 추가·행 삭제·범위 지우기와 되돌리기"), 복사 Ctrl+C → 클립보드 TSV(E2E, 전문은 `query.rows`로 읽음), 불리언 Enter 토글(E2E), 장문 패널의 전문 로드·확정·되돌리기(E2E), 스키마 커맨드의 undo/redo(E2E 열 추가 되돌리기·다시 실행 + 단위), 되돌릴 수 없는 커맨드(테이블 삭제) 유입 시 스택 비움과 파일 열기 시 비움(단위), 상한 200개(단위), TSV 직렬화·파싱 왕복(탭·줄바꿈·따옴표·CRLF; 단위).

**검증 결과**
- [x] `npm run check`: eslint 0건, prettier 통과, tsc 0오류, 단위 테스트 199개 통과(node:test 집계, 세션 C 점검 163 + 36). 새 `test()` 28개: `app/commands.test.js` 9, `app/history.test.js` 6, `app/shortcuts.test.js` 3, `ui/grid/selection.test.js` 3, `ui/grid/clipboard.test.js` 4, 기존 파일에 3(`db/command.test.js` 배치, `db/query.test.js` `fetchRows`·`stats`, `ui/grid/cache.test.js` `markStale`). `rpc.test.js`의 `query.*` 검사에 `query.rows`·`query.stats`를 더했습니다.
- [x] `npm run build && npm run verify`: `verify OK`, 외부 참조 0건(허용 vendor 리터럴 2건), vendor 체크섬 일치, 두 변형 CSP 외 동일.
- [x] `npm run test:e2e`: Chromium `file://`에서 35개 통과(세션 C 점검 27 + `edit.spec.js` 8). 전체 4회 실행 모두 통과. 기존 `grid.spec.js`의 "스키마가 바뀐 뒤 다시 마운트되기 전에 온 창 질의 응답은 버린다"는 D-06 변경에 맞춰 단언을 고쳤습니다: 경주 구간에서 칸이 비는 대신 옛 머리글 아래에 옛 값(`3`, `비고1`)이 그대로 남고, 다른 열 목록으로 만든 응답은 여전히 버려집니다.
- [x] `npm run test:perf`: 30만 행 픽스처(314,286,080 bytes) 재생성 후 렌더 p50 0.3 / p95 1.3 / 최대 4.4 ms(210 표본), 창 질의 51회 최대 26.9 ms, 열기 3.1초, DOM 행 45개. 세션 C 점검(p50 0.4 / p95 1.4 / 최대 2.9, 질의 21.4)과 같은 수준으로 예산(16 ms / 50 ms) 안입니다. 렌더 경로에 더한 것(CLAUDE.md 5.7): 칸당 선택 여부 비교와 불리언 배열 하나(`cellSelected`, `cellCursor`와 같은 방식), 렌더당 선택 스냅샷 객체 3개(행마다 다시 읽지 않도록 렌더 시작에 한 번), 응답당 블록 `version` 정수 하나.
- [x] 7.1 grep: `innerHTML` 0건, 모드 문자열 허용 위치 밖 0건, `src/db`와 `src/app/commands.js`의 SQL 템플릿 리터럴은 `quoteIdent()` 식별자·상수뿐이고 값은 전부 바인딩(단위 테스트가 값이 SQL 문자열에 없음을 확인).
- [x] 새 오류 코드 없음(기존 `E_UNDO_LIMIT`·`E_PASTE_TOO_LARGE`·`E_VALUE_INVALID` 사용). 새 RPC op 2개(`query.rows`·`query.stats`)는 6장 표, `db/worker.js` OpMap·핸들러, `rpc.test.js`에 함께 반영. i18n ko/en 키 동일(단위 테스트).
- [x] 검증 실패 사유 문구(`validate.<reason>`), 편집기·장문 패널·복사·붙여넣기·되돌릴 수 없는 작업 확인 문구를 `i18n/ko.js`·`en.js`에 추가. 코드에 리터럴 문구 없음.

**산출물 크기 (`verify` 출력)**
- `dist/jdrdatabase.html` 1,771,008 bytes (1.69 MiB / 예산 6 MiB). 세션 C 점검(1,738,002) 대비 +33,006 bytes. 부품: main 338.8 KB, worker 245.0 KB, wasm(base64) 1,131.4 KB, css 13.7 KB.
- `dist/tauri/index.html` 1,770,816 bytes (CSP 메타 줄만 다름을 `verify`가 확인).

**지원 매트릭스 실측 (`docs/support-matrix.md`)**
- Chromium 141 headless `file://`(Playwright가 `clipboard-read`·`clipboard-write` 권한을 준 컨텍스트): `window.isSecureContext`가 true, `navigator.clipboard.writeText/readText` ✓, 포커스된 비편집 요소(`role="grid"` div)에 실제 Ctrl+V의 `paste` 이벤트 도착 ✓. 권한 프롬프트가 있는 실제 브라우저에서의 동작은 미확인.
- 한글 IME는 합성 composition 이벤트로만 검사(실제 IME는 헤드리스에서 미확인).

**점검했지만 고치지 않은 것 (판단 근거와 함께)**
- 행 삭제 뒤 id가 성기면 D-06의 id 탐색 빠른 경로가 꺼지고 OFFSET으로 돌아갑니다(R6). 이번 세션에서 30만 행 테이블의 행 삭제 뒤 끝부분 창 질의 지연은 측정하지 않았습니다.
- 세션 C 점검이 "리뷰어 판단 필요"로 남긴 "긴 타입 변환 중 그리드가 비어 보임"은 이번 D-06 변경으로 증상이 바뀌었습니다: 다른 열 목록의 응답은 여전히 버리지만 낡은 블록의 옛 열 값이 변환이 끝날 때까지 그대로 보입니다(비지 않음). 변환 중 값이 옛 타입으로 보이는 것이 빈 화면보다 낫다고 보고 두었습니다.
- 붙여넣기는 포커스된 그리드에 오는 `paste` 이벤트에 기댑니다(별도의 숨은 textarea 없음). Chromium에서는 비편집 요소에도 이벤트가 오는 것을 실측했지만 Firefox·Safari는 미확인입니다.
- 복사는 그리드 캐시의 미리보기를 쓰지 않고 항상 `query.rows`로 전문을 다시 읽습니다(1만 행 단위, 100만 셀 상한). 캐시에 256자만 있는 텍스트 셀 때문이며, 작은 범위에서도 왕복 한 번이 듭니다.
- 붙여넣기·삭제 커맨드는 옛 값을 `do`·`undo` 양쪽에 담으므로 저널·히스토리 메모리가 데이터의 두 배입니다. 큰 붙여넣기는 50 MB 저널 상한에 더 빨리 닿습니다(기존 배너로 안내).
- 커맨드 실패 뒤 `history.apply`가 `store.refreshData()`로 그리드를 다시 읽게 합니다. Worker가 트랜잭션을 롤백하므로 DB는 그대로이고, 다시 읽기는 캐시가 미리보기로 이미 낙관 갱신된 경우(`patchCell`)를 위한 것입니다.

**미확인 (후속 세션에서 이어받음)**
- 실제 한글 IME(Chrome 데스크톱)에서 그리드 셀에 포커스를 두고 바로 한글을 치기 시작할 때 첫 음절이 편집기로 넘어가는지. 비편집 요소의 keydown은 `key === 'Process'`로 오고 이를 무시하므로 편집기가 열리지 않고 첫 음절이 버려질 가능성이 있습니다(Enter·F2·더블클릭으로 연 뒤 입력하는 경로는 시뮬레이션으로 확인). 세션 H에서 손으로 확인해야 합니다.
- 1만 행 초과 삭제·붙여넣기·지우기의 확인 대화상자 → `irreversible` 흐름은 단위와 코드 경로만(E2E 없음).
- 5 MB 경고, 100만 셀 초과 토스트, 읽기 전용에서 편집기가 열리지 않음, 복사 실패 토스트: 코드 경로만.
- 수십만 자 장문 셀의 textarea 편집 성능은 측정하지 않았습니다.
- 세션 C 점검에서 이어받은 항목 그대로: 스크린 리더, 8장 환경의 성능, R6 OFFSET 폴백, 100만 행 스크롤 스케일링, 창 질의 실패 UI 경로, File System Access 실측, Firefox·Safari, `E_MEM`, 두 탭 동시 열기, 10만 행 이상 타입 변경 UI, 저널 50 MB 배너, `filesystem.capabilities().native` 스텁, Rust/rusqlite 플래그(R9), 기본 확장자·자동 저장 기본값.

### 세션 D 점검 (세션 D 산출물 코드 점검) — 2026-09-20

세션 D의 `8d557b9`를 원격 최신으로 맞춘 뒤 전체 파이프라인을 재현하고(`check` 199개, `build`, `verify`, `test:e2e` 35개 모두 초록) 코드를 점검했습니다. 초록인 상태에서 드러나지 않은 문제 8건을 재현 테스트와 함께 고쳤습니다. 새 기능은 없고 Step 6 이후를 앞당겨 구현하지 않았습니다.

커밋: `252545c` → `581ca65` → `0ef6678` → `6b5f0b5` → `b228d27` → `8dc6fa0` → `a21488e` → `d8fb1df` (문제 하나당 커밋 하나).

**고친 문제**

| # | 문제 | 커밋 |
|---|---|---|
| 1 | 붙여넣기가 선택 범위의 왼쪽 위가 아니라 활성 셀에서 시작 | `252545c` |
| 2 | 겹친 커맨드가 `E_DB_BUSY`를 내고 그 실패가 되돌리기 항목을 지움 | `581ca65` |
| 3 | 되돌릴 수 없는 범위 지우기가 범위 전체의 옛 값을 읽어 옴 | `0ef6678` |
| 4 | `real` 열의 표시 반올림이 편집·복사 왕복에서 저장값을 깎음 | `6b5f0b5` |
| 5 | 범위 선택이 접근성 트리에 드러나지 않음 | `b228d27` |
| 6 | 붙여넣기 거부 안내가 그리드 행 번호가 아닌 데이터 순번을 알림 | `8dc6fa0` |
| 7 | 편집기가 고정 열에서 셀을 따라가지 않음 | `a21488e` |
| 8 | 낡은 블록의 셀을 캐시 값으로 열어 되돌린 값이 다시 저장됨 | `d8fb1df` |

6~8번은 처음에 "점검했지만 고치지 않은 것"으로 분류했다가 다시 따져 보고 고친 것입니다. 6·7번은 분류 근거 자체가 틀렸고(아래에 무엇이 틀렸는지 적었습니다), 8번은 고치는 방식이 설계 판단이라 리뷰어에게 물어 "낡은 블록일 때만 `query.row`" 쪽으로 정했습니다.

1. **붙여넣기의 앵커.** `paste` 처리기가 앵커로 `selection.getActive()`를 넘겼습니다. 활성 셀은 범위를 어느 방향으로 넓혔느냐에 따라 네 귀퉁이 중 어디에나 있습니다 — 아래·오른쪽으로 끌거나 Shift+화살표로 넓히면 오른쪽 아래, `selectAll()`(Ctrl+A)은 마지막 행, `selectRows()`는 마지막으로 지난 행입니다. 복사(`onCopy`)는 `getRange()`를 써서 범위의 왼쪽 위에서 읽는데 붙여넣기만 다른 자리에서 씁니다. **그래서 범위를 복사해 그 자리에 다시 붙여넣는 것만으로 값이 밀립니다**(실측: 행 0~1의 한 열을 Ctrl+C 한 뒤 바로 Ctrl+V 하면 '이름1'·'이름2'가 행 1~2에 쓰여 행 1의 '이름2'가 '이름1'로 덮입니다). 경계를 넘으면 행까지 늘어납니다. 사용자가 고른 자리가 아닌 곳에 값이 들어가므로 무엇이 덮였는지 알 수 없습니다. 앵커를 `getRange()`의 `r0`·`c0`로 바꿔 복사와 같은 기준을 씁니다.

2. **겹친 커맨드와 사라지는 되돌리기.** `command.apply`는 6장의 배타 op인데 `history.apply()`는 `busy` 표식을 보지도 세우지도 않아 적용·되돌리기·다시 실행이 서로 겹칠 수 있었고, 겹치면 나중 호출이 Worker의 `assertNotBusy`에 걸려 `E_DB_BUSY`로 거절됩니다. `undo()`·`redo()`는 그 거절을 다른 실패와 똑같이 다뤄 스택에서 커맨드를 뺍니다. **긴 붙여넣기가 도는 중에 Ctrl+Z를 누르면, 되돌리기는 아무것도 하지 않은 채 오류만 띄우고 멀쩡히 적용돼 있던 앞 커맨드가 되돌리기 목록에서 영영 사라집니다**(실측: 커맨드 3건을 적용했는데 스택은 2건. DB에는 3건이 다 들어 있습니다). 저장(Ctrl+S)의 `db.snapshot`과 스키마 op도 배타 op라 같은 경로를 엽니다. 히스토리가 보내는 호출을 큐 하나로 묶어 스스로 겹치지 않게 하고(되돌리기가 적용 도중에 눌리면 버려지지 않고 차례를 기다립니다. 저널 기록도 같은 차례를 따르므로 두 기록이 겹쳐 같은 `seq`를 쓰는 일도 없어집니다), `E_DB_BUSY`는 엔진에 닿기 전의 거절이므로 스택에서 빼지 않습니다. `busy`가 이제 적용도 포함해 세므로 붙여넣기가 도는 동안 되돌리기·다시 실행 버튼이 잠깁니다.

3. **되돌릴 수 없는 범위 지우기의 비용.** `clearRange`는 1만 행을 넘는 지우기도 다른 모든 지우기와 같은 길을 갔습니다. 범위의 행을 `query.rows`로 전부 읽고(미리보기가 아니라 전문입니다), 행마다 옛 값이 든 `RowEdit`을 만들고, `bulkEdit`이 `do`와 `undo` 문장을 다 만든 뒤 `undo` 쪽을 버립니다. 되돌릴 수 없는 커맨드라 옛 값은 쓰이지 않습니다. DESIGN.md는 상한을 넘는 삭제를 문장 하나로 규정하고 `deleteRowRange`가 그대로 따르는데 같은 상한을 넘는 지우기만 예외였습니다. Ctrl+A 뒤 Delete가 그 경로입니다. 실측(행 30,000 × 열 5, 셀당 400자): 옛 값 읽기 1,354 ms에 heap +131 MB, 커맨드 만들기 87 ms에 +28 MB, 저널에 적을 커맨드 1.7 MB. 8장의 목표 규모(30만 행 × 20열)로 늘리면 선형으로 늘어 탭이 버티지 못합니다. `commands.clearRowRange`를 더해 `deleteRowRange`와 같은 부분 질의를 쓰는 `UPDATE ... SET c = NULL` 문장 하나로 만듭니다(같은 규모에서 0.1 ms, 587 바이트). 이미 모두 NULL인 행은 `AND (c1 IS NOT NULL OR ...)`로 건드리지 않아 되돌릴 수 있는 경로가 빈 행을 건너뛰는 것과 `_updated_at` 결과가 같습니다.

4. **`real` 열의 표시 반올림.** `cellToText`는 인라인 편집기의 초기값과 복사한 TSV를 만드는데, 그리드 표시와 같은 `toDisplay(type, value, column.options)`를 썼습니다. `real`의 `options.decimals`는 `toFixed(decimals)`로 반올림하는 표시 설정입니다. 여기서 만든 문자열은 사용자가 그대로 확정하면 `validate`를 거쳐 저장값이 되므로, **`decimals = 2`인 열의 셀을 열어 아무것도 고치지 않고 Enter만 눌러도 3.14159가 3.14로 저장되고** 그 열을 복사해 다시 붙여넣어도 같은 일이 납니다. `applyCellEdit`은 옛 값과 새 값이 다르니 진짜 편집으로 보고 커맨드를 적용합니다. `real`은 옵션 없이 `String(value)`로 만들어 표시와 편집·복사를 갈라놓았습니다(`select`의 `choices`처럼 값 자체를 정하는 옵션은 그대로 넘깁니다). 지금 열 만들기 대화상자는 `decimals`를 두지 않아 UI만으로는 재현되지 않지만 `schema.addColumn`의 `options`로 들어오고 `tables.normalizeOptions`가 메타에 저장합니다 — 가져오기(Step 7)가 이 경로를 씁니다. 반올림된 결과를 기대하던 기존 단위 테스트를 함께 고쳤습니다(**리뷰어 확인 필요**).

5. **범위 선택의 접근성.** Step 4의 그리드는 활성 셀 하나만 있었고 `setCursorCell`이 그 칸에 `aria-selected`를 붙였습니다. Step 5가 범위 선택을 더하면서 범위 표시는 CSS 클래스만 붙였습니다. 그래서 보조 기술에는 범위를 아무리 넓혀도 늘 칸 하나만 선택된 것으로 보입니다. 지우기·복사·행 삭제가 모두 이 범위를 대상으로 하므로 무엇이 지워지고 복사되는지 화면을 보지 않고는 알 수 없습니다. `setSelectedCell`이 `aria-selected`를 함께 쓰고 스크롤 영역에 `aria-multiselectable="true"`를 붙였습니다. 행 번호 칸(`rowheader`)은 뺐습니다 — 그 칸의 `--selected`는 범위가 지나는 행을 눈으로 짚어 주는 것이라 셀 하나만 골라도 켜지는데, `aria-selected`까지 붙이면 행 전체를 고른 것처럼 읽힙니다.

6. **붙여넣기 거부 안내의 행 번호.** 붙여넣기 값이 열 타입에 맞지 않으면 전체를 거부하고 첫 번째 위치를 알립니다(Step 5 예외 처리). 그런데 `convertPastedCell`이 `detail.row`에 담는 것은 붙여넣기 데이터 안에서의 순번이고, 안내 문구는 '{row}번째 행의 "{column}" 열'이라 그리드의 행 번호로 읽힙니다. 앵커가 첫 행일 때만 두 값이 우연히 같습니다. 6번째 행에 세 줄을 붙여넣다 두 번째 줄에서 막히면 "2번째 행"이라고 알리지만 실제로 손봐야 할 칸은 7번째 행입니다. 무엇을 고쳐야 할지 알려 주려고 띄우는 안내가 엉뚱한 곳을 가리킵니다. 앵커의 행을 더해 그리드 행 번호로 알립니다. **처음에는 이 건을 "문구 문제"로 보고 Step 6의 i18n 정리로 미뤘는데, 문구가 아니라 넘기는 값이 틀린 것이고 재현도 쉬우며 설계 판단도 필요 없는 한 줄짜리 수정이라 분류가 잘못이었습니다.**

7. **편집기가 고정 열에서 셀을 따라가지 않음.** 인라인 편집기는 열 때 잰 캔버스 좌표에 한 번 놓이고 그 뒤로 움직이지 않았습니다. 세로 스크롤은 행 좌표가 캔버스 기준이라 저절로 맞지만, 고정 열의 칸은 렌더마다 `scrollLeft`만큼 다시 놓입니다(`cellRect`도 고정 열에 `scrollLeft`를 더합니다). 그래서 고정 열의 셀을 편집하는 중에 가로로 스크롤하면 칸은 제자리에 남고 편집기만 캔버스와 함께 밀려납니다. 열 너비 조절도 같습니다. 스크롤은 포커스를 옮기지 않으므로 blur도 확정도 일어나지 않아, 편집기는 열린 채 엉뚱한 칸 위에 떠 있고 거기서 Enter를 누르면 화면에서 가리키던 칸이 아니라 원래 편집하던 칸에 값이 들어갑니다. 실측(뷰포트 700 px, 첫 열 고정, scrollLeft 300): 고정 칸은 x 385에 그대로인데 편집기는 x 85로 300 px 어긋납니다. 그리드가 렌더 끝에 `hooks.onRelayout()`을 부르고 편집 컨트롤러가 열려 있는 편집기를 `cellRect`로 다시 놓습니다(`inline.moveTo`). **처음에는 "편집 중 가로 스크롤·너비 변경을 할 경로를 찾지 못해 재현하지 못했다"고 적었는데 사실이 아니었습니다** — 스크롤은 포커스를 건드리지 않으므로 편집 중에도 얼마든지 할 수 있고, 위 실측이 그것입니다.

8. **낡은 블록의 셀을 캐시 값으로 엶.** D-06은 같은 테이블의 데이터 변경 뒤 블록을 버리지 않고 낡은 것으로만 표시해, 새 응답이 올 때까지 옛 행을 그대로 그립니다(깜빡임 방지). 그리기만 할 때는 맞는 선택입니다. 그런데 `openEditor`는 미리보기가 잘린 셀만 `query.row`로 전문을 읽고 그 밖에는 캐시 값을 편집기의 초기값으로 실었습니다. 그래서 그 구간에 편집기를 열면 화면에 보이던 옛 값이 편집기에 실리고, **아무것도 고치지 않고 Enter만 눌러도 그 값이 저장됩니다**(`applyCellEdit`은 확정 시점에 옛 값을 다시 읽으므로 "값이 달라졌다"고 보고 커맨드를 적용합니다). 되돌리기 직후가 바로 이 구간이라 **Ctrl+Z 한 뒤 그 셀에서 Enter만 눌러도 되돌린 것이 조용히 다시 적용됩니다.**

   낡은 블록에서 열 때도 전문을 읽습니다. 잘린 셀이 이미 타고 있던 경로를 그대로 씁니다. 무조건 왕복하지 않고 낡은 블록으로 좁힌 이유는 비용이 붙는 때와 위험한 때가 다르기 때문입니다(실측, 5만 행): 캐시에서 바로 열기 p50 **0.90 ms**, `query.row` 왕복 뒤 열기 p50 **3.10 ms**(왕복 2.2 ms), 1만 행 배치 쓰기가 도는 중의 왕복은 **575 ms**(Worker가 단일 스레드라 뒤에 줄을 섭니다). 그런데 쓰기가 도는 중에는 블록이 낡지 않았습니다 — `data:changed`는 커맨드가 끝나야 나고 그때까지 트랜잭션은 커밋 전이라 캐시 값이 곧 DB 값입니다. 즉 무조건 왕복하면 **위험하지도 않은 구간에서만 비싸집니다.** 위험한 구간은 쓰기가 끝난 직후의 몇 ms이고 그때 Worker는 한가하므로 2.2 ms입니다. `boolean`은 캐시가 낡아도 값을 잃지 않고(뒤집은 값이 DB의 현재 값과 같아져 `applyCellEdit`의 같은 값 검사에 걸려 아무것도 쓰지 않습니다) `longtext`는 패널이 언제나 `query.row`로 열므로, 인라인 편집기 경로만 고쳤습니다.

**재현 테스트 (모두 수정 전 빨강 확인)**

- `e2e/edit.spec.js`: `붙여넣기는 선택 범위의 왼쪽 위에서 시작한다(복사한 자리에 그대로 붙여넣기)`(1번. 끌어 넓힌 범위와 Ctrl+A 둘 다), `접근성: 선택한 범위의 칸이 aria-selected로 드러난다`(5번), 기존 `붙여넣기: … 잘못된 값은 전체 거부`에 앵커를 6번째 행으로 옮긴 경우 추가(6번), `편집기는 고정 열에서도 셀을 따라간다(가로 스크롤·열 너비 변경)`(7번. 편집기와 칸의 x 차이를 재고, 확정한 값이 원래 칸에 들어가는 것까지 확인), `낡은 블록의 셀은 전문을 읽고 연다(되돌린 값이 다시 적용되지 않는다)`(8번)
- `app/history.test.js`: `적용이 도는 중에 눌린 되돌리기는 차례를 기다리고, 히스토리를 잃지 않는다`(2번. 적용 3건 뒤 스택이 2건이 아니라 `undo 2 / redo 1`이고 DB도 맞는지 확인), `히스토리 밖의 배타 op와 겹쳐 난 E_DB_BUSY는 되돌리기 항목을 지우지 않는다`(2번의 나머지 절반. 저장·스키마 op는 큐 밖이라 타이밍에 기대지 않도록 되돌리기 호출 한 번만 막는 전송을 끼워 결정적으로 재현)
- `app/commands.test.js`: `clearRowRange: 되돌릴 수 없는 범위 지우기는 옛 값을 읽지 않고 문장 하나로 한다`(3번. 문장 수·바인딩·빈 행을 건드리지 않음)
- `ui/grid/clipboard.test.js`: `cellToText: 편집·복사는 저장된 값 그대로를 쓴다(그리드 표시의 반올림을 따르지 않는다)`(4번)

8번은 창이 몇 ms라 `query.window`의 도착을 4초 늦춰 "DB는 이미 옛 값인데 화면은 아직 새 값"인 구간을 결정적으로 만듭니다. 세션 C가 `grid.spec.js`에만 두었던 전송 래퍼를 `test/e2e/delay-transport.js`로 옮겨 두 spec이 함께 씁니다(코드는 그대로 옮겼고 `grid.spec.js`의 기존 11개 검사가 통과함을 따로 확인했습니다).

3번은 `editing.js`의 배선(1만 행 초과 시 `readRows`를 아예 부르지 않음)까지는 단위 테스트로 덮지 못했습니다. `createEditingController`가 DOM을 요구해 Node에서 만들 수 없고, 1만 행 초과 시나리오를 E2E로 만들면 검사 하나가 수 분이 됩니다. 커맨드 쪽은 단위 테스트로, 배선은 코드로 확인했고 비용은 위 실측으로 갈음했습니다.

**문서 갱신 (해당 커밋에 포함)**

- `DESIGN.md` 5장 Step 5 주요 함수: `commands.clearRowRange({ tableId, colIds, offset, count, now })` 추가.
- `DESIGN.md` 5장 Step 5 예외 처리(되돌리기 스냅샷 상한): 상한을 넘는 지우기도 문장 하나라는 점과, 되돌릴 수 없는 작업은 옛 값을 읽지 않는다는 원칙(붙여넣기만 덮어쓸 행의 id가 필요해 예외이며 100만 셀 상한이 그 범위를 묶는다).
- `DESIGN.md` D-06: 낡은 블록을 그리는 동안 화면 값이 DB와 다를 수 있으므로, 그 값을 **읽어서 다시 쓰는** 경로(편집기 초기값)는 낡은 블록에서 열 때 `query.row`로 전문을 읽는다는 규칙. 그리지만 하는 경로는 낡은 값을 그대로 쓴다.
- `DESIGN.md` 5장 Step 5 `inline.open`: 잘린 셀과 낡은 블록의 셀은 전문을 읽은 뒤 열고, 블록이 최신이면 왕복 없이 캐시에서 연다.

**검증 결과**

- [x] `npm run check`: eslint 0건, prettier 통과, tsc 0오류, 단위 테스트 203개 통과(세션 D의 199개 + 신규 4개. 8번은 DOM·전송 경로라 E2E로만 덮었습니다).
- [x] `npm run build && npm run verify`: `verify OK`, 외부 참조 0건(허용 vendor 리터럴 2건), vendor 체크섬 일치, 두 변형 CSP 외 동일.
- [x] `npm run test:e2e`: Chromium `file://`에서 39개 통과(세션 D의 35개 + 신규 4개).
- [x] `npm run test:perf`: 30만 행 픽스처(314,286,080 bytes) 재생성 후 렌더 p50 0.4 / p95 1.3 / 최대 3.9 ms(208 표본), 창 질의 51회 최대 22.0 ms, 열기 3.2초, DOM 행 45개. 둘 다 예산(16 ms / 50 ms) 안이고 세션 D(p50 0.3 / p95 1.3 / 최대 4.4, 질의 26.9)와 같은 수준입니다. 렌더 경로에 닿는 것은 5·7·8번입니다. 5번은 선택 여부가 바뀐 칸에만 속성 하나를 더 쓰고(이미 클래스를 토글하던 자리), 7번은 렌더 끝에 훅 호출 하나를 더하는데 편집기가 닫혀 있으면 즉시 반환하며, 8번은 `rowAt()`이 남기는 불리언 하나만 늘었습니다.
- [x] 7.1 grep: `innerHTML` 0건, 모드 문자열 허용 위치 밖 0건, `src/db`·`src/app`의 SQL 템플릿 리터럴은 `quoteIdent()` 식별자와 상수뿐이고 값은 전부 바인딩(3번이 더한 `clearRowRange`의 `now`·`count`·`offset`도 바인딩이며 단위 테스트가 확인).
- [x] 새 오류 코드 없음(3번은 기존 `E_DB_QUERY`·`E_UNDO_LIMIT`). 새 RPC op 없음(8번은 기존 `query.row`를 더 많은 경우에 부를 뿐입니다). i18n 키 변화 없음(6번은 넘기는 값만 바뀜).
- [x] TSV 직렬화·파싱을 별도로 퍼즈했습니다(1~3행 × 1~3열, 탭·줄바꿈·CR·따옴표·빈 셀·한글 조각 35,028건): 어긋남 0건. 마지막 행이 전부 빈 셀인 경우만 파서가 끝의 빈 줄과 구분할 수 없어 버리는데, 이는 설계에 적힌 동작이고 기존 테스트가 덮습니다.

**산출물 크기 (`verify` 출력)**

- `dist/jdrdatabase.html` 1,772,523 bytes (1.69 MiB / 예산 6 MiB). 세션 D(1,771,008) 대비 +1,515 bytes.
- `dist/tauri/index.html` 1,772,331 bytes (CSP 메타 줄만 다름을 `verify`가 확인).

**점검했지만 고치지 않은 것 (판단 근거와 함께)**

- **`clearRange`의 되돌릴 수 있는 경로는 행을 "비어 있지 않은 열 집합"으로 묶습니다.** `bulkEdit`의 그룹 키가 열 id 목록이라, 행마다 NULL 자리가 다르면 그룹이 늘고 그룹 하나가 `runBatch` 하나가 됩니다. 상한이 1만 행이므로 그룹도 최대 1만 개이고(행마다 패턴이 다 다를 때) 메모리는 묶여 있으며 값이 틀리지도 않습니다. 늘어나는 것은 문장 수뿐입니다. 자연스러운 해법은 "NULL인 열도 UPDATE에 넣어 그룹을 하나로 합치기"인데, 그러면 이미 비어 있던 셀까지 쓰고 `_updated_at`이 헛돌아 3번 수정과 반대 방향이 됩니다. 어느 쪽이 나은지는 실제 데이터의 NULL 분포를 봐야 하고 그건 가져오기(Step 7) 다음입니다. 지금은 측정도 하지 않았으므로 근거 없는 최적화가 됩니다.
- **`selectAll()`은 활성 셀을 마지막 행에 둡니다.** 범위를 앵커와 활성 셀 두 점으로만 표현하므로, 모든 행을 덮으려면 활성 셀이 마지막 행에 있어야 하는 구조입니다. 1번 수정으로 가장 해로운 증상(붙여넣기가 마지막 행에서 시작)은 사라졌고, 남은 것은 Ctrl+A 뒤에 글자를 치면 편집기가 마지막 행에서 열린다는 점인데 되돌릴 수 있는 편집입니다. 제대로 고치려면 "모든 행" 표식을 따로 두거나 범위 표현을 바꿔야 하는데, Step 6이 정렬·필터를 더하면 "보이는 모든 행"의 의미가 또 바뀌므로 그때 함께 보는 것이 맞습니다.
- **`command.apply`는 대상 테이블이 `strict`인지 보지 않습니다.** 외부 파일 테이블의 데이터 편집은 UI(`editableTable`)가 막지만, 세션 B 점검 5번이 `tables.drop`에 `requireStrict`를 넣은 것과 같은 층의 방어는 Worker에 없습니다. 방어를 넣는 것 자체는 한 줄인데 재현 테스트를 쓸 수가 없습니다 — UI 밖에서 데이터 커맨드를 만드는 경로가 지금 없기 때문입니다(세션 B 점검 5번은 사이드바에 삭제 버튼이 실제로 있어서 재현됐습니다). 게다가 저널 재생도 `command.apply`를 타므로, 재생 중 대상 테이블이 외부 등록으로 바뀐 경우와의 상호작용을 확인하지 않은 채 막으면 복구를 가로막는 새 버그가 됩니다. UI 밖에서 커맨드를 만들기 시작하는 Step 7에서 실제 경로와 함께 넣는 것이 맞습니다.
- 세션 B·C 점검이 남긴 "저널은 버리기를 골라도 남는다", "`openDialog`가 앞 Promise를 resolve하지 않는다", "`validateInteger`가 쉼표를 지운다", "`reorderColumns`의 position 겹침", "행 수 캐시가 `viewSpec`을 키에 넣지 않는다", "고정 열 뒤로 스크롤한 열이 가려진다"는 세션 D 산출물이 아니라 이번 점검 범위 밖입니다(CLAUDE.md 9장). 담당도 이미 정해져 있습니다: 행 수 캐시는 Step 6, 쉼표는 Step 7, 나머지는 판단 대기.

**미확인 (세션 D에서 이어받아 그대로 남음 + 이번에 생긴 것)**

- 5번 수정의 실제 스크린 리더 동작(NVDA·VoiceOver가 범위 선택을 어떻게 읽는지)은 이 환경에서 확인할 수 없어 미확인입니다. DOM 속성만 실측했습니다.
- 3번 수정의 1만 행 초과 지우기는 단위 테스트(커맨드)와 코드 경로만입니다. 실제 UI에서 Ctrl+A → Delete → 확인 대화상자로 30만 행을 지우는 시나리오는 재지 않았습니다.
- 2번 수정으로 되돌리기가 큐에서 기다리게 되면서, Ctrl+Z를 빠르게 여러 번 누르면 이제 그만큼 차례로 되돌아갑니다(전에는 `busy` 중의 입력이 버려졌습니다). 의도한 동작이지만 실사용 감각은 확인하지 못했습니다.
- 7번 수정은 고정 열 + 가로 스크롤만 E2E로 검사했습니다. 편집 중 열 너비를 끌어 바꾸는 경로는 같은 렌더 훅을 타므로 코드로만 확인했습니다.
- 8번 수정 뒤 낡은 블록의 셀을 여는 지연은 위 5만 행 실측(2.2 ms)까지입니다. 30만 행에서, 그리고 쓰기가 막 끝난 직후의 실제 지연은 재지 않았습니다. 또한 낡은 블록에서 연 편집기가 화면의 값과 다른 값을 보여 주게 되는데(화면은 옛 값, 편집기는 새 값) 그 편이 낫다고 보았으나 실사용 감각은 미확인입니다.
- 세션 D에서 이어받은 항목 그대로: 실제 한글 IME(Chrome 데스크톱)에서 셀에 바로 타이핑할 때 첫 음절, 1만 행 초과 삭제·붙여넣기의 확인 대화상자 흐름(E2E 없음), 5 MB 경고·100만 셀 초과 토스트·읽기 전용에서 편집기가 열리지 않음·복사 실패 토스트(코드 경로만), 수십만 자 장문 셀의 textarea 편집 성능.
- 세션 C 점검에서 이어받은 항목 그대로: 8장 환경(4코어 노트북, 실제 화면 합성)의 성능, R6 OFFSET 폴백, 100만 행 스크롤 스케일링, 창 질의 실패 UI 경로, File System Access 실측, Firefox·Safari, `E_MEM`, 두 탭 동시 열기, 10만 행 이상 타입 변경 UI, 저널 50 MB 배너, `filesystem.capabilities().native` 스텁, Rust/rusqlite 플래그(R9), 기본 확장자·자동 저장 기본값.

### 세션 E (Step 6) — 2026-09-21

커밋: `212c70a` docs(design) 착수 전 뷰 스펙·필터 빌더·검색 인덱스 단계·뷰 op 확정 → `3bd1699` feat(view) Step 6.

시작 상태: 원격 `d8fb1df`를 받아 `npm run check`(203개)가 초록임을 확인한 뒤 시작했습니다. 세션 D 점검의 미확인 항목은 아래 "미확인"에 이어받았습니다.

**설계 변경 (코드보다 먼저 DESIGN.md v0.7에 반영, 리뷰어 확인 필요)**

- **D-08 네 번째 문장 `{ index: { table, fts, columns } }`.** 검색 인덱스의 초기 인덱싱 단계입니다. Worker가 원본 테이블을 id 순으로 5,000행씩(직렬화 크기가 16 MB를 넘으면 그 안에서 더 잘게 `runBatch`) 읽어 FTS 테이블에 넣고 진행률·취소는 변환 단계와 같습니다. 인덱스 생성이 이 단계를 포함한 커맨드 하나이므로 취소하면 트랜잭션 롤백이 FTS 테이블·트리거·`fts_enabled`를 모두 되돌리고, 저널 재생과 되돌리기·다시 실행이 실행기 하나로 끝납니다.
- **D-07 구체화.** 검색 대상 열은 물리 타입이 TEXT인 살아 있는 열(`text`·`longtext`·`date`·`datetime`·`select`)이고 FTS와 LIKE 폴백이 같은 열 집합을 봅니다. 인덱스 열 집합은 만드는 시점에 고정되며(그 뒤 추가된 열은 지웠다 다시 만들어야 검색됨) 비STRICT 외부 테이블은 LIKE만 씁니다. 물리 이름 `_jdr_fts_<table id>`와 트리거 `_ai`·`_ad`·`_au`(`AFTER UPDATE OF <인덱스 열>`이라 `_updated_at`만 바뀌는 갱신은 인덱스를 건드리지 않음)는 `db/schema.js`에만 둡니다. 질의는 입력 전체를 `"..."` 구절 하나로 감싸고 안의 `"`는 `""`로 이스케이프합니다(trigram에서 구절 일치 = 부분 문자열 일치라 LIKE 폴백과 의미가 같음).
- **뷰 스펙.** `viewSpec = { hidden, sort: [{ colId, dir }], filter: { logic: 'and' | 'or', conditions: [{ colId, op, value | values }] } | null, search }`. `query.window`·`query.count`·`query.rows`가 같은 형식을 받아 같은 `buildViewClauses`로 WHERE·ORDER BY를 붙이므로 그리드의 행 순번과 편집이 읽는 행이 어긋나지 않습니다. 되돌릴 수 없는 범위 커맨드(`deleteRowRange`·`clearRowRange`)도 `clauses`를 받아 같은 부분 질의를 씁니다(Step 5 서명 갱신). 정렬·필터·검색이 하나라도 있으면 D-06의 id 탐색 빠른 경로를 쓰지 않습니다.
- **`buildOrderBy(sortSpec, columns)`.** 타입에 맞는 정렬(텍스트 계열 `COLLATE NOCASE`, 숫자·불리언 수치)과 살아 있지 않은 열 무시에 열 목록이 필요해 `columns`를 더했습니다. 빈 값은 방향과 무관하게 `NULLS LAST`, 마지막은 언제나 `"id"`입니다.
- **저장된 뷰 = 커맨드.** `_jdr_views` 쓰기는 DB 변경이므로 스키마 op처럼 Worker(`db/views.js`)가 커맨드를 만들어 적용하고 돌려줍니다(`views.save`·`views.delete`, 저널·되돌리기·dirty). 불러오기는 DB를 바꾸지 않습니다. 저장 스펙 JSON은 `{ sort, filter, hidden, search, widths, frozen }`(4.1 갱신. 열 너비를 파일에 남기는 것이 여기입니다).
- **6장 RPC.** `query.count` → `{ count, elapsedMs }`(행 수 캐시 키에 뷰 조건을 넣어 세션 C 점검의 "행 수 캐시가 `viewSpec`을 키에 넣지 않는다"를 해소), `search.enable`(취소 가능)·`search.disable`·`views.save`·`views.delete` → `{ cmd }`, `views.list` → `{ views }`. 배타 op에 셋을 더하고 `views.list`는 읽기입니다.
- 3.1에 `db/views.js`, `ui/dialogs/filter.js`(정렬·필터 대화상자). Step 6 예외 처리에 "필터 지우기는 검색도 함께", "필터가 있는 뷰의 행 추가 안내", "검색할 열 없음·이미 켜짐·외부 테이블 거부", "인덱스 커맨드의 되돌리기·다시 실행은 진행률 없음"을 더했습니다.

**Step 6 완료 기준**
- [x] 단위: `buildWhere`가 항상 파라미터 바인딩을 쓰고 문자열 연결로 값을 넣지 않음: `test/unit/db/query.test.js` "buildWhere: 값은 항상 바인딩…"이 `O'Brien; DROP TABLE x --`와 `50%_'`를 넣어 SQL 문자열에 값이 없고 `params`에만 있음을, 연산자별 SQL 형태(`COLLATE NOCASE`, `LIKE ? ESCAPE '\'`, `IS NOT`, `IN (?, ?)`)와 실제 DB 결과(대소문자 무시 등호, 부분 일치, OR, 빈 값 `=` → `IS NULL`, 숫자 열 `contains`는 문자열로)를 확인합니다. 타입 불일치 `E_VALUE_INVALID`(사유·열 이름 포함), 빈 `in` 목록 거부, 살아 있지 않은 열 무시, 조건 없음은 빈 조각. `commands.test.js`는 `deleteRowRange`·`clearRowRange`의 부분 질의에 필터·정렬이 붙고 값이 바인딩됨을 확인합니다.
- [x] 30만 행에서 trigram 검색 200 ms 이하, 인덱스 없이 LIKE 1초 이하: `npm run test:perf`의 새 `test/perf/search.perf.spec.js`(314,286,080 bytes 픽스처, `query.count`의 `elapsedMs`). **LIKE `grape 7` 812.8 ms(9,756건), LIKE `멜`(2자 폴백) 987 ms(0건)** — 예산 안이지만 끝에 가깝습니다(아래 "점검했지만"). 인덱스 생성 43.4초(기록만). **trigram `grape 7` 59.5 ms(같은 9,756건), `바나나 1` 31.4 ms(9,740건), 없는 단어 0.2 ms.** 8장의 "정렬 변경(인덱스 없음) 1초 이하"도 함께 쟀습니다: 정수 열 내림차순 첫 창 91.2 ms, 텍스트 열 98.2 ms, 필터(`> 500000`) 행 수 62.8 ms(149,748건). 같은 실행의 `grid.perf.spec.js`는 렌더 p50 0.4 / p95 1.4 / 최대 4.3 ms, 창 질의 최대 29.4 ms로 세션 D 점검과 같은 수준입니다.
- [x] E2E: 정렬·필터·검색 조합 후 뷰 저장 → 재열기 시 복원: `test/e2e/view.spec.js` "정렬·필터·검색·숨김·너비 조합을 뷰로 저장 → 파일 저장 → 다시 열기 → 뷰 선택 → 복원" — 머리글 클릭 2회(나이 내림차순), 필터 대화상자(나이 > 300), 검색 `이름19`(→ 10행, 첫 행 이름199), 사이드바에서 본문 열 숨김(머리글 3개), 이름 열 너비 끌기 → "뷰 저장…" `보고` → `_jdr_views`에 검색어·숨김·너비가 든 JSON → 저장(다운로드) → 새 DB → `<input type="file">`로 다시 열기 → 테이블 선택(뷰 상태는 비어 있음: 201행, 머리글 4개) → 뷰 선택 → 10행·이름199·`aria-sort="descending"`·"필터 (1)…"·검색 상자 값·머리글 3개·같은 너비. 뷰 삭제 → 되돌리기로 목록에 복귀.
- Step 6 예외 처리 대응(어디서 확인했는지):
  - 필터 값 타입 불일치는 UI에서 거부: E2E(정수 열에 `abc` → 대화상자 유지, `"나이" 열의 값: 정수가 아닙니다.`) + 단위(Worker 빌더 `E_VALUE_INVALID`).
  - FTS 구문 오류 원천 차단: 단위(`"quoted"`·`OR`가 든 검색어가 구절로 감싸져 일치).
  - 3자 미만·인덱스 없음 → LIKE, `%`·`_`·`\` 이스케이프: E2E(`50%_`가 그대로 1행, 2자 검색어는 인덱스가 있어도 LIKE) + 단위.
  - 인덱스 생성 취소 → 롤백·`fts_enabled = 0`: 단위(덤프 동일, 객체 없음) + `store.test.js`. 진행률 토스트·취소 버튼은 코드 경로만.
  - 0건 빈 상태와 "필터 지우기": E2E. 정렬 대상 열 소프트 삭제 시 항목 제거·안내: E2E + 단위(정렬·필터·숨김 모두, 복원해도 되돌아오지 않음).
- 그 밖의 목표 항목: 다중 정렬(Shift+클릭 순번, 대화상자; E2E), AND/OR 1단계(E2E), 열 숨김·표시(E2E), 검색 디바운스(E2E), 인덱스 만들기·삭제와 되돌리기·다시 실행(E2E: 편집이 트리거로 인덱스를 따라감, Ctrl+Z/Ctrl+Y), 커맨드 do/undo 대칭(`views.test.js`·`search.test.js`, FTS 그림자 테이블까지 덤프 동일), 뷰 이름 규칙(단위), 필터가 있는 뷰의 행 추가 안내(E2E).

**검증 결과**
- [x] `npm run check`: eslint 0건, prettier 통과, tsc 0오류, 단위 테스트 242개 통과(세션 D 점검 203 + 39). 새 `test()` 25개: `db/search.test.js` 9, `db/views.test.js` 5, `db/query.test.js` 5, `app/store.test.js` 4, `app/commands.test.js` 1, `db/rpc.test.js` 1. `dumpDb`는 WITHOUT ROWID 테이블(FTS5 그림자)을 기본 키 순서로 읽도록 고쳤습니다.
- [x] `npm run build && npm run verify`: `verify OK`, 외부 참조 0건(허용 vendor 리터럴 2건), vendor 체크섬 일치, 두 변형 CSP 외 동일.
- [x] `npm run test:e2e`: Chromium `file://`에서 44개 통과(세션 D 점검 39 + `view.spec.js` 5). `mountToolbar`가 `toasts`를 받도록 바뀌었지만 기존 spec은 그대로 통과합니다.
- [x] `npm run test:perf`: 위 완료 기준 항목(2개 spec 모두 통과).
- [x] 7.1 grep: `innerHTML` 0건, 모드 문자열 허용 위치 밖 0건, `src/db`·`src/app`의 SQL 템플릿 리터럴은 `quoteIdent()` 식별자·상수·`?` 자리표시자뿐이고 값(필터 값, LIKE 패턴, FTS 구절, 뷰 이름·스펙)은 전부 바인딩.
- [x] 새 오류 코드 없음(`E_VALUE_INVALID`·`E_DB_QUERY`·`E_IMPORT_CANCELLED`·`E_NAME_INVALID` 재사용). 새 RPC op 5개는 6장 표, `db/worker.js` OpMap·핸들러·배타 집합, `rpc.test.js`에 함께 반영. i18n ko/en 키 동일(단위 테스트). 검색·정렬·필터·뷰 문구와 `validate.empty_list`를 추가했고 코드에 리터럴 문구 없음.
- [x] `docs/support-matrix.md`: FTS5 external-content + `AFTER UPDATE OF` 트리거 + 청크 인덱싱을 Blob Worker 안에서 커맨드 하나로 만들고 되돌리기(Chromium 141 headless ✓), 검색 상자 디바운스(✓, 실제 IME 조합 중은 미확인) 행 추가.

**산출물 크기 (`verify` 출력)**
- `dist/jdrdatabase.html` 1,814,320 bytes (1.73 MiB / 예산 6 MiB). 세션 D 점검(1,772,523) 대비 +41,797 bytes. 부품: main 368.7 KB, worker 255.7 KB, wasm(base64) 1,131.4 KB, css 15.4 KB.
- `dist/tauri/index.html` 1,814,128 bytes (CSP 메타 줄만 다름을 `verify`가 확인).

**점검했지만 고치지 않은 것 (판단 근거와 함께)**
- **정렬·필터가 있으면 창 질의마다 다시 정렬합니다.** 사용자 열에 인덱스가 없으므로 `ORDER BY … LIMIT 200 OFFSET m`은 매 창에서 전체를 훑습니다(30만 행 첫 창 91~98 ms). 8장의 창 질의 예산(50 ms)은 정렬·필터가 없는 기본 뷰 기준이고, 정렬 변경의 예산(1초)은 지킵니다. R6의 대응(정렬 열 인덱스 자동 생성 옵션, keyset 페이징)은 파일을 바꾸는 결정이라 이번 세션에 넣지 않았습니다. 스크롤 중 여러 창의 지연은 재지 않았습니다(아래 미확인).
- **LIKE 폴백이 예산 끝에 가깝습니다**(2자 검색어 987 ms). 장문 2열을 포함한 TEXT 열 6개를 모두 훑는 비용이며 이 환경의 CPU 기준입니다. 8장 환경(4코어 노트북)에서는 넘을 수 있습니다. 완화책은 인덱스 생성이고 UI가 그 버튼을 두므로 예산을 낮추지 않았습니다.
- **인덱스 열 집합은 만드는 시점에 고정됩니다**(D-07). 그 뒤 추가된 열은 검색되지 않고, 소프트 삭제된 열은 인덱스에 남아 지운 열의 값으로 행이 맞을 수 있습니다(화면에는 일치하는 칸이 안 보임). 스키마 커맨드마다 인덱스를 다시 만들면 열 추가가 30만 행에서 40초짜리 작업이 되므로 v1은 사용자가 지웠다 다시 만드는 것으로 두었습니다. UI가 "인덱스가 오래되었음"을 알리지는 않습니다.
- **인덱스 생성의 되돌리기·다시 실행은 진행률·취소 없이 돕니다**(30만 행에서 43초). 히스토리 경로는 `onProgress`를 주지 않고 되돌리기 버튼은 `busy`로 잠깁니다. 설계에 적어 두었습니다.
- **인라인 편집기가 열린 채 머리글을 클릭(정렬)하면 편집이 취소됩니다.** 그리드가 다시 마운트되며 `onReset`이 편집기를 닫고, 머리글은 포커스를 받지 않아 blur 확정이 먼저 일어나지 않습니다. Step 5의 "다른 곳 클릭 → 확정 시도"와 어긋나는 한 경우이지만 정렬 뒤 그 행의 위치를 알 수 없어 그대로 두었습니다(리뷰어 판단 필요).
- 뷰 저장·삭제가 `runSchemaOp` 공통 경로의 `data:changed`로 보이는 창을 한 번 더 읽습니다(200행 창 질의 하나).
- 세션 D 점검이 남긴 `selectAll()`의 활성 셀 위치는 정렬·필터가 들어온 지금도 "보이는 모든 행"에 대해 같은 구조라 그대로입니다(붙여넣기 앵커는 D 점검 1번으로 이미 왼쪽 위).

**미확인 (후속 세션에서 이어받음)**
- 정렬·필터가 있는 뷰에서 30만 행을 연속 스크롤할 때 창 질의 지연(첫 창만 쟀음)과 편집 뒤 재조회 지연.
- 8장 환경(4코어 노트북)에서의 LIKE 폴백 시간.
- 검색 상자의 실제 한글 IME(조합 중 `InputEvent.isComposing`으로 질의를 미루는 경로)는 `fill`로만 검사했습니다.
- `aria-sort`·정렬 순번의 스크린 리더 낭독, 정렬·필터 대화상자의 실제 키보드만 조작(포커스 트랩은 기존 `dialog.js`).
- 100 KB 이상 셀이 많은 테이블에서 인덱싱 청크(16 MB 예산)의 메모리·`runBatch` 상한 — 픽스처(0.1% 100 KB)에서만 확인.
- 비STRICT 외부 테이블의 혼합 타입 열 정렬(`NULLS LAST`·NOCASE는 물리 값 기준).
- Firefox·Safari에서의 FTS5 trigram·`input type="search"`.
- 세션 D 점검의 "미확인" 목록(실제 한글 IME 첫 음절, 1만 행 초과 확인 대화상자 흐름, 코드 경로만 확인한 토스트들, 스크린 리더, 8장 환경 성능, R6, 100만 행, Firefox·Safari, `E_MEM`, 두 탭, R9, 기본 확장자·자동 저장 기본값 등)은 그대로 남습니다.

### 세션 E 점검 (세션 E 산출물 코드 점검) — 2026-09-21

세션 E의 `3bd1699`를 원격 최신으로 맞춘 뒤 전체 파이프라인을 재현하고(`check` 242개, `build`, `verify`, `test:e2e` 44개 모두 초록) 코드를 점검했습니다. 초록인 상태에서 드러나지 않은 문제 2건을 재현 테스트와 함께 고쳤고, 세션 E가 "고치지 않은 것"으로 적은 항목 하나는 사실과 달라 실제 동작을 검사로 못박았습니다. 새 기능은 없고 세션 F 이후를 앞당겨 구현하지 않았습니다.

커밋: `201d857` → `408941a` → `4a91894` (문제 하나당 커밋 하나).

**고친 문제**

| # | 문제 | 커밋 |
|---|---|---|
| 1 | 테이블을 지워도 그 테이블의 검색 인덱스가 파일에 영영 남음 | `201d857` |
| 2 | 행 수 캐시가 검색어마다 항목을 쌓고 비우는 곳이 없음 | `408941a` |

1. **지운 테이블의 검색 인덱스가 파일에 남습니다.** `tables.drop`의 `do`는 메타 정리와 `DROP TABLE` 뿐입니다. `DROP TABLE`은 원본 테이블에 달린 트리거(`_ai`·`_ad`·`_au`)는 함께 없애지만 **FTS5 가상 테이블과 그림자 테이블(`_data`·`_idx`·`_docsize`·`_config`)은 그대로 둡니다.** `_jdr_tables` 행이 사라진 뒤에는 그 인덱스를 가리킬 손잡이가 UI에 없으므로 남은 객체는 누구도 지울 수 없고, 메타 접두사를 쓰는 이름이라 테이블 목록에도 나타나지 않아 **사용자는 무엇이 파일을 차지하는지조차 알 수 없습니다.** 지워진 페이지가 아니라 살아 있는 페이지라 뒤이은 쓰기가 재사용하지도 않습니다.

   실측(20,000행 × 텍스트·장문 2열, `PRAGMA page_count - freelist_count`): 인덱스 없이 테이블을 지우면 살아 있는 페이지가 **73,728 바이트**인데, 인덱스를 켜고 지우면 **4,456,448 바이트**입니다. 차이 **4,382,720 바이트**가 전부 고아 인덱스입니다. 8장의 목표 규모(30만 행)로 늘리면 테이블 하나를 지울 때마다 수십 MB가 쌓이고, 파일 하나로 주고받는 배포 형태라 그대로 사용자에게 전달됩니다. `do`를 "인덱스 삭제 → 메타 정리 → `DROP TABLE`" 순서로 바꿨습니다(인덱스가 없는 테이블에서도 안전하도록 `IF EXISTS`). 수정 뒤 같은 실측에서 차이는 **0 바이트**입니다.

2. **행 수 캐시가 검색어마다 자랍니다.** 세션 E는 세션 C 점검의 "행 수 캐시가 `viewSpec`을 키에 넣지 않는다"를 해소하면서 키를 `tableId`에서 `tableId + 필터 + 검색어`로 바꿨습니다. 그 결과 전까지 **테이블 수만큼으로 묶여 있던 항목 수가 사용자가 치는 글자 수만큼** 늘게 됐습니다. 검색 상자는 디바운스마다 `query.count`를 부르므로 검색어 하나에 여러 항목이 생기고, 낡은 항목(`serial`이 다른 것)은 다시 쓰이지 않으면서도 지워지지 않습니다. `countCache`를 지우거나 크기를 보는 코드가 한 줄도 없어 탭을 오래 열어 둘수록 Worker의 Map이 단조 증가합니다(실측: 검색어 74개를 넣으면 항목 75개가 그대로 남습니다).

   답이 틀리지는 않습니다(낡은 항목은 `serial` 검사에 걸려 그냥 안 맞을 뿐입니다). 고친 것은 수명입니다. 쓰기 뒤에는 모든 항목이 어차피 낡으므로 `serial`만 올리지 말고 통째로 비우고(`invalidateCounts`), 쓰기 없이 검색·필터만 바꾸는 동안에도 자라지 않도록 `COUNT_CACHE_MAX`(64)로 가장 오래된 것부터 밀어냅니다. 캐시는 계산을 아끼는 장치일 뿐이라 밀려난 항목은 다시 세면 같은 답이 나옵니다.

**세션 E의 "고치지 않은 것" 하나는 사실과 다릅니다 (`4a91894`)**

세션 E는 "인라인 편집기가 열린 채 머리글을 클릭(정렬)하면 편집이 취소됩니다 … 머리글은 포커스를 받지 않아 blur 확정이 먼저 일어나지 않습니다"를 **리뷰어 판단이 필요한 항목**으로 올렸습니다. 실제 산출본(`file://`)에서 재현해 보면 그렇지 않습니다. 머리글이 포커스를 받지 않아도 클릭하면 편집기 입력에서 포커스가 떠나므로 `blur`가 나고, `inline.js`의 `onBlur`가 확정을 마친 뒤에야 정렬로 인한 재마운트가 `onReset`으로 편집기를 닫습니다. 실측: 셀을 열어 `머리글클릭확정`을 입력하고 "나이" 머리글을 클릭하면 `aria-sort="ascending"`이 붙고 **DB에는 `머리글클릭확정`이 저장돼 있습니다**(다른 셀을 클릭했을 때와 같습니다). 그러므로 이 항목에는 판단할 것이 없습니다.

다만 Step 6이 "뷰가 바뀌면 그리드를 다시 마운트"를 들여와 확정과 재마운트가 경주하는 경로 자체는 새로 생겼으므로, 순서를 `view.spec.js`의 검사로 고정했습니다(확정 → 정렬 → 편집기 닫힘).

**재현 테스트 (1·2번은 수정 전 빨강 확인)**

- `test/unit/db/search.test.js`: `table.drop: 검색 인덱스를 함께 지워 파일에 고아 FTS 테이블이 남지 않는다`(1번. `sqlite_master`에 FTS 객체가 0개이고, 삭제가 살아 있는 페이지를 늘리지 않는지 확인)
- `test/unit/db/rpc.test.js`: `query.count: 행 수 캐시는 검색어마다 늘지 않고 쓰기 뒤에는 다시 센다`(2번. 검색어 74개 뒤 항목 수가 `COUNT_CACHE_MAX` 이하이고, 밀려난 항목도 다시 세어 같은 답을 주며, 쓰기 뒤에는 항목이 0개). 캐시 크기를 볼 수 있도록 디스패처에 `countCacheSize()`를 더했습니다(`engine()`과 같은 검사·진단용 접근자).
- `test/e2e/view.spec.js`: `편집 중 머리글 클릭(정렬): 입력은 blur로 확정된 뒤 정렬이 걸린다`

**점검했지만 고치지 않은 것 (판단 근거와 함께)**

- **FTS 인덱스의 이스케이프는 적대적 입력 18종에 안전합니다.** `"`, `""`, `\`, `***`, `NEAR(a b)`, `AND OR NOT`, `col:val`, `{a b}`, `^abc`, `a* b`, `100%`, `_under`, `O'Brien`, 500자 등을 FTS·LIKE 두 경로에 넣어 **구문 오류 0건**이고 결과 의미도 일치합니다(`ftsMatchQuery`의 구절 감싸기와 `likePattern`의 `ESCAPE '\'`). 고칠 것이 없어 검사로도 남기지 않았습니다(단위 테스트가 이미 대표 사례를 덮습니다).
- **정렬·검색이 걸린 뷰에서의 범위 삭제·지우기는 인덱스를 어긋나게 하지 않습니다.** `DELETE ... WHERE "id" IN (SELECT ... FROM fts WHERE fts MATCH ?)`는 삭제 트리거가 같은 FTS 테이블에 쓰는데도 부분 질의가 먼저 확정되어, 삭제·지우기 뒤 FTS `integrity-check`가 통과하고 남은 행 수도 기대와 같습니다(FTS 경로·LIKE 폴백 둘 다 확인).
- **인덱스가 있는 테이블의 스키마 변경은 깨지지 않습니다.** 열 추가와 그 되돌리기(`DROP COLUMN`), 타입 변경과 그 되돌리기를 인덱스가 켜진 상태에서 모두 확인했습니다. 다만 인덱스에 든 열의 타입을 바꾸면 D-07대로 **인덱스는 소프트 삭제된 옛 열을 계속 가리킵니다**(검색은 맞는데 화면에 일치하는 칸이 없습니다). 세션 E가 이미 "고치지 않은 것"으로 적어 둔 그 항목의 구체적 경로이며, 고치려면 스키마 커맨드마다 인덱스를 다시 만들어야 해 같은 판단을 따릅니다.
- **`buildOrderBy`의 `NULLS LAST`는 빈 문자열을 뒤로 보내지 않습니다.** 주석은 "빈 값은 항상 뒤"라고 적혀 있지만 `NULLS LAST`가 잡는 것은 NULL뿐입니다. 앱이 만드는 값은 `values.validate`가 공백뿐인 문자열을 NULL로 바꾸므로 차이가 없고, `''`가 들어 있을 수 있는 것은 비STRICT 외부 테이블(R7)뿐입니다. 필터의 `empty`는 `IS NULL OR = ''`로 둘 다 잡으므로 정렬과 필터의 "빈 값"이 외부 테이블에서만 어긋납니다. 세션 E의 미확인 "비STRICT 외부 테이블의 혼합 타입 열 정렬"과 같은 자리라 그 항목에 함께 남깁니다.
- **뷰 스펙이 손상된 뷰를 지웠다 되돌리면 정규화된 스펙으로 돌아옵니다.** `views.remove`의 `undo`는 `JSON.stringify(view.spec)`, 즉 `parseSpec`을 거친 값을 다시 넣습니다. 앱이 저장한 스펙은 같은 정규화 함수의 출력이라 왕복이 그대로지만, 다른 도구가 손으로 고쳐 넣은 스펙은 되돌리기 뒤 빈 뷰가 됩니다. 손상된 스펙을 그대로 보존할 가치가 낮고(이미 빈 뷰로 읽히고 있습니다) 원문을 들고 다니려면 `View`에 필드를 더해야 해서 두었습니다.
- **`store.saveView`는 `views.list` 실패를 삼키고 새 뷰를 만듭니다.** 목록 읽기가 실패하면 `listViews`가 오류 토스트를 띄우고 `[]`를 돌려주므로, 같은 이름의 뷰가 이미 있어도 덮어쓰기가 아니라 새로 만들기로 갑니다(Worker의 `normalizeName`이 "이름 (2)"로 바꿉니다). 같은 스레드에서 바로 앞 호출이 실패해야 하는 경로라 실사용에서 닿기 어렵고, 고치면 "목록을 못 읽었으니 저장도 막는다"가 되어 저장을 더 자주 잃습니다.
- **진행 중인 확정이 끝나기 전에 새 편집기를 열면 그 편집기가 닫힙니다.** `inline.commit`은 `finally`로 `committing`만 되돌리고, `if (ok) teardown()`이 그 사이 새로 열린 편집기를 닫습니다. Step 5부터 있던 구조이고 Step 6은 재마운트 경로를 더해 창을 넓혔을 뿐이라 이번 점검 범위 밖입니다(CLAUDE.md 9장). 닿으려면 RPC 왕복이 끝나기 전에 다른 셀을 여는 조작이 필요합니다.
- **머리글 정렬은 마우스 전용입니다.** 머리글 칸은 `tabindex`가 없고 `keydown` 처리도 없어 키보드만으로는 머리글을 눌러 정렬할 수 없습니다. 세션 E가 정렬 대화상자를 키보드 경로로 두었고(`[data-action="sort"]`), 대화상자가 다중 정렬까지 다루므로 기능 자체는 도달 가능합니다. 머리글을 포커스 가능하게 만드는 것은 그리드 로빙 tabindex와 겹치는 결정이라 접근성을 맡은 Step 10에서 함께 보는 것이 맞습니다.
- 빌드 산출물 크기가 세션 E가 적은 값(1,814,320)과 12바이트 다릅니다(같은 소스에서 1,814,332). 무엇이 다른지 확인하지 않았습니다(아래 미확인).

**검증 결과**

- [x] `npm run check`: eslint 0건, prettier 통과, tsc 0오류, 단위 테스트 **244개 통과**(세션 E 242 + 신규 2).
- [x] `npm run build && npm run verify`: `verify OK`, 외부 참조 0건(허용 vendor 리터럴 2건), vendor 체크섬 일치, 두 변형 CSP 외 동일.
- [x] `npm run test:e2e`: Chromium `file://`에서 **45개 통과**(세션 E 44 + 신규 1).
- [ ] `npm run test:perf`: **미확인.** 이번 수정은 렌더·창 질의 핫 경로에 닿지 않습니다(1번은 `table.drop`의 `do` 목록, 2번은 `query.count`의 캐시 관리뿐이고 캐시 적중 조건은 그대로입니다). 30만 행 픽스처 재생성 비용에 견주어 재측정하지 않았습니다.
- [x] 7.1 grep: `innerHTML` 0건, 모드 문자열 허용 위치 밖 0건. 새로 더한 SQL은 `DROP TRIGGER/TABLE IF EXISTS` + `quoteIdent()` 식별자뿐이고 값이 들어가는 자리가 없습니다.
- [x] 새 오류 코드 없음. 새 RPC op 없음. i18n 키 변화 없음.
- [x] `DESIGN.md` 갱신이 같은 커밋(`201d857`)에 포함: D-07에 "테이블을 지우면 인덱스도 같은 커맨드에서 지운다"와 그 이유, D-08 `tables.drop` 항목에 `do`의 순서.

**산출물 크기 (`verify` 출력)**

- `dist/jdrdatabase.html` 1,814,939 bytes (1.73 MiB / 예산 6 MiB). 세션 E(1,814,320) 대비 +619 bytes.
- `dist/tauri/index.html` 1,814,747 bytes (CSP 메타 줄만 다름을 `verify`가 확인).

**미확인 (세션 E에서 이어받아 그대로 남음 + 이번에 생긴 것)**

- 1번 수정의 실측은 20,000행까지입니다. 30만 행에서 인덱스가 켜진 테이블을 지우는 시간(그림자 테이블 4개를 지우는 비용)은 재지 않았습니다.
- 2번의 `COUNT_CACHE_MAX`(64)는 근거 있는 측정값이 아니라 "테이블 수 × 자주 쓰는 뷰 몇 개"를 넉넉히 덮는 어림입니다. 실사용에서 적중률이 떨어지는지 확인하지 못했습니다.
- 편집 중 머리글 클릭은 `fill`로 값을 넣고 클릭했습니다. 한글 IME로 조합 중인 상태에서 머리글을 클릭하는 경우(조합 문자의 확정과 `blur` 확정의 순서)는 확인하지 못했습니다.
- 검색 상자의 디바운스 타이머는 `isComposing`일 때 새로 걸지 않지만 **이미 걸린 타이머를 끄지는 않습니다.** 영문·숫자를 친 직후 200 ms 안에 한글 조합을 시작하면 조합 중간 값으로 질의가 한 번 나갈 수 있습니다. 코드로만 짚었고 실제 IME로 재현하지는 못했습니다.
- 빌드 산출물의 12바이트 차이(같은 소스, 다른 크기)의 원인.
- 세션 E의 "미확인" 목록(정렬·필터 뷰의 연속 스크롤 지연, 8장 환경의 LIKE 폴백, 실제 한글 IME, 스크린 리더, 100 KB 셀의 인덱싱 청크, 비STRICT 외부 테이블 정렬, Firefox·Safari의 FTS5 trigram)과 세션 D 점검에서 이어진 항목은 그대로 남습니다.

### 세션 F (Step 7 + 8) — 2026-09-21

커밋: `d918393` docs(design) 착수 전 가져오기 파이프라인·op 인자·저널 정지 확정 → `7215faf` feat(import) Step 7 CSV 가져오기 → `e5ef51e` chore(vendor) SheetJS CE 0.18.12 → `9b49ef6` feat(import) Step 8 XLSX 가져오기 → 이 기록.

시작 상태: 원격 `0cbe1a3`를 받아 `npm run check`(244개)가 초록임을 확인한 뒤 시작했습니다. 세션 E 점검의 미확인 항목은 아래 "미확인"에 이어받았습니다.

**설계 변경 (코드보다 먼저 DESIGN.md v0.8에 반영, 리뷰어 확인 필요)**

- **가져오기는 커맨드가 아니다(D-08의 예외, D-04 3층 갱신).** 30만 행 CSV를 커맨드 객체로 만들면 그 객체가 저널 상한(50 MB)과 되돌리기 스냅샷 상한(1만 행)을 모두 넘고, 재생하려면 원본 파일이 다시 필요합니다. 그래서 `import.run`이 트랜잭션 하나로 직접 삽입하고 커맨드를 돌려주지 않습니다. 성공 뒤 메인은 (1) 되돌리기 스택을 비우고(앞선 `column.add`를 되돌리면 `DROP COLUMN`이 가져온 값을 지웁니다), (2) 저널 기록을 멈추고(`autosave.suspend()`. 재생 시 "뒤쪽 변경 일부는 남지 않았다"로 표시), (3) dirty로 두고 "가져오기는 변경 기록에 남지 않아 … 지금 저장하세요" 배너를 띄웁니다. 저장이 성공하면 저널이 비워지며 기록이 다시 시작됩니다. 탭이 죽으면 가져온 데이터와 그 뒤 변경은 복구되지 않으며 배너가 그 사실을 알립니다.
- **취소·오류는 전체 롤백(청크 커밋 없음).** Step 7 예외 처리의 "기존 테이블이면 지금까지 커밋된 행은 유지되었음을 명시"를 "새 테이블이든 기존 테이블이든 시작 전과 같다"로 바꿨습니다. 절반만 들어간 상태는 사용자가 어디까지 들어갔는지 알 수 없고 커맨드가 아니라 되돌릴 수도 없기 때문입니다. 완료 기준 "취소 후 잔여물 없음"은 두 대상 모두 덤프 동일로 검사합니다.
- **6장 RPC.** `import.preview` `{ file, options }` → `{ format, encoding, delimiter, hasHeader, sheets?, sheet?, headerRow?, headers, sample(20행), sampleRows, exhausted, inferred, warnings }`, `import.run` `{ file, options, mapping, target, policy }` → `{ report }`. `file`은 Blob(File)을 구조화 복제로 넘기고 메인은 바이트를 읽지 않습니다(Worker가 `stream()`·`arrayBuffer()`). `mapping.columns[i] = { source, name?, type?, columnId?, policy? }`, `target = { kind: 'new', name } | { kind: 'existing', tableId }`. `import.preview`는 읽기 op(언제나 허용), `import.run`은 배타 op입니다.
- **Step 7 함수 서명 구체화.** `csv.createParser({ delimiter })`(조각 사이 상태 유지, `\r\n`이 경계에서 갈라져도 한 줄), `csv.parse(blob, { encoding, delimiter, onEnd })`(헤더 처리는 `pipeline.openSource`가), `infer.sample` → `{ rows, exhausted }`, `infer.columnName`(빈 헤더 `열N`, 중복 ` (2)`. Step 8의 규칙을 CSV에도), `infer.column`의 `date`는 시각 부분이 없는 값만, `pipeline.run({ engine, file, options, mapping, target, policy, signal, progress })`. 보고서 `{ tableId, inserted, skipped, nulled, errors[], errorCount, demoted[] }`.
- **Step 8.** `xlsx.listSheets`는 `sheetRows: 1` + `!fullref`, `xlsx.parse`는 dense 모드로 `n/s/b/d/e/z`를 바꾸되 날짜는 SheetJS Date의 로컬 시각 부품으로 문자열을 만들어(`YYYY-MM-DD` 또는 `YYYY-MM-DDTHH:mm:ss`) CSV와 같은 추론·검증을 탑니다. 100 MB 초과는 `E_FILE_TOO_LARGE`(`detail.format = 'xlsx'`)를 재사용합니다(7장 표 갱신, 새 오류 코드 없음). `verify.mjs`는 SheetJS가 문자열로만 쓰는 XML 네임스페이스 URL을 접두사 목록으로 허용합니다.
- 3.1에 `vendor/xlsx.full.min.d.ts`·`vendor/package.json`(`"type": "commonjs"`: Node가 UMD를 CommonJS로 읽게 한다. esbuild는 구문으로 판정), `test/fixtures/import/`, `scripts/gen-import-fixtures.mjs`.

**Step 7 완료 기준**
- [x] 단위 픽스처(따옴표 안 개행·쉼표, BOM UTF-8, UTF-16LE, EUC-KR, 빈 줄, CRLF/LF 혼재, 필드 수 불일치, 32 KB 조각 경계): `test/fixtures/import/*.csv`(`scripts/gen-import-fixtures.mjs`가 만듭니다. EUC-KR 바이트는 손으로 적지 않고 `TextDecoder('euc-kr')`로 역표를 만들어 인코딩) + `test/unit/import/csv.test.js` 13개. 경계 픽스처는 32,581바이트에서 시작하는 따옴표 필드(쉼표·개행·`""` 포함)가 32 KB 지점을 지나 닫히며, 조각 크기 32 KB·1 KB·13·1과 통째로 파싱한 결과, 그리고 `Blob.stream()`으로 읽은 결과가 모두 같음을 확인합니다. UTF-16BE(BOM)와 BOM 없는 UTF-16LE(NUL 분포 감지)도 더했습니다.
- [x] 30만 행 × 20열 CSV 가져오기 60초 이하(Chromium, Worker 모드): `test/perf/import.perf.spec.js`가 `gen-fixture.mjs`로 만든 **209,173,818바이트**(장문 2열 20~60단어. 8장의 "약 150 MB"보다 큼) CSV를 실제 대화상자로 가져와 **미리보기 186 ms, 가져오기 18,005 ms**(예산 60,000 ms). 인라인 모드는 재지 않았습니다.
- [x] 취소 후 DB에 잔여물 없음: `pipeline.test.js` "취소하면 전체가 롤백되어 새 테이블도 기존 테이블의 행도 남지 않는다"(첫 배치 뒤 취소 → 새 테이블·기존 테이블 모두 `dumpDb` 동일, 행 수 0), "이미 취소된 신호로 시작하면 아무것도 넣지 않는다", `rpc.test.js`(취소 메시지가 디스패처의 AbortController를 거쳐 롤백).
- Step 7 예외 처리 대응(어디서 확인했는지):
  - 인코딩 오판 경고와 재선택: 단위(`warnings[0].kind === 'encoding'`) + E2E(EUC-KR 파일을 UTF-8로 바꾸면 "깨진 문자" 경고, 되돌리면 사라짐).
  - 필드 수 불일치(부족 NULL, 초과 버림·기록), 10% 초과 시 `ragged` 경고: 단위.
  - 닫히지 않은 따옴표: 단위(`unterminated_quote`).
  - 정책 `null`/`text`/`abort`: 단위(NULL + 보고서, 강등 후 재시도가 테이블을 두 번 만들지 않음, abort는 행 번호·열을 담은 `E_VALUE_INVALID`와 덤프 동일) + E2E(중단 → 테이블 없음·dirty 아님·대화상자에 사유, NULL로 바꾸면 성공).
  - 10 MB 셀: 단위(NULL + `too_long`).
  - 기존 테이블 매핑: 단위(없는·지운·중복 열, 외부 테이블, `text` 정책 거부, select 자동 추가) + E2E(같은 이름 자동 대응, 대응 없는 열 건너뜀, text 정책 없음).
  - 메모리 경고: `import.memoryWarning`은 `capabilities().warnFileBytes − 현재 파일 크기`로 계산하며 코드 경로만 확인(픽스처가 작아 뜨지 않음).
  - 가져오기 중 편집 잠금: 모달 + 배타 op(`isExclusiveOp('import.run')` 단위). 실제로 실행 중에 그리드를 누르는 시나리오는 재지 않았습니다.
  - 읽기 전용: `store.test.js`(다른 탭 점유 → `file.readOnlyBlocked`, null).
- 저널·히스토리: `autosave.test.js`(suspend → 기록 중단·truncated, clear가 풀어 줌), `store.test.js`(가져오기 뒤 `journalStop = 'import'`, 이후 커맨드 미기록, 저장 뒤 해제, 새 테이블 선택, 기존 테이블 추가는 선택 유지), `history.test.js`(`import:done`이 스택을 비움), E2E(배너 문구, 되돌리기 버튼 잠김, 저장 뒤 배너 사라짐).

**Step 8 완료 기준**
- [x] 픽스처(날짜·시간·불리언·수식·병합·오류 셀·빈 헤더·1904 체계): `test/fixtures/import/basic.xlsx`(시트 "데이터": 빈·중복 헤더, 날짜·시각·불리언·수식(`f`+계산값)·`#N/A`·`#REF!`·병합 A4:B5·선행 0 우편번호·실수·일련번호 60/61; 시트 "둘째": 헤더가 3행), `date1904.xlsx`, `encrypted.xlsx`(CFB에 `EncryptedPackage`·`EncryptionInfo` 스트림). `xlsx.test.js` 5개 + `pipeline.test.js` 2개 + E2E 2개. **1900 윤년 버그는 SheetJS가 일련번호 60을 `1900-02-28`, 61을 `1900-03-01`로 돌려줍니다**(위임한 대로 두고 검사로 못박음). 1904 통합 문서의 같은 날짜가 같은 문자열로 읽힙니다. (→ 세션 L: 이 검사는 0.18.12의 1904 쓰기·읽기 버그가 서로 상쇄돼 초록이었습니다. 0.20.3으로 픽스처를 다시 만들었고, 일련번호 60은 이제 숫자 셀로 옵니다.) 손상은 잘린 zip(`E_XLSX_CORRUPT`)으로 검사했고, **빈 입력과 평문은 SheetJS가 CSV로 읽어 던지지 않습니다**(형식은 확장자로 정하므로 실사용에서는 `.xlsx`로 이름만 바꾼 CSV가 표로 읽힙니다).
- [x] 5만 행 × 20열 xlsx 가져오기 20초 이하: `test/perf/import-xlsx.perf.spec.js`(SheetJS로 만든 35,546,232바이트) **미리보기 2,907 ms, 가져오기 5,925 ms**(예산 20,000 ms).
- Step 8 예외 처리 대응: 암호화 `E_XLSX_ENCRYPTED`(단위 + E2E: 미리보기 경고 문구, 가져오기 버튼은 같은 문구로 거부), 100 MB 상한 `E_FILE_TOO_LARGE`(단위. UI 문구 `import.xlsxTooLarge`는 코드 경로만), 병합(`merged` 경고 + 나머지 칸 NULL: 단위·E2E), 오류 셀(NULL + 보고서 `error_cell`: 단위·E2E), 빈·중복 헤더(`열2`, `이름 (2)`: 단위·E2E), 선행 0(`text`: 단위·E2E), 손상 zip(단위).

**검증 결과**
- [x] `npm run check`: eslint 0건, prettier 통과, tsc 0오류, 단위 테스트 **297개 통과**(세션 E 점검 244 + 53). 새 파일: `test/unit/import/csv.test.js` 13, `infer.test.js` 6, `pipeline.test.js` 15, `xlsx.test.js` 5. 기존 파일에 `rpc.test.js` 2, `store.test.js` 2, `autosave.test.js` 1, `history.test.js` 1, `build.test.js` 1(`'import'` 문자열 리터럴).
- [x] `npm run build && npm run verify`: `verify OK`, 외부 참조 0건(허용 vendor URL 리터럴 160건: sqlite3 문서 링크 2건과 SheetJS의 XML 네임스페이스 URL), vendor 체크섬 6개 일치, 두 변형 CSP 외 동일.
- [x] `npm run test:e2e`: Chromium `file://`에서 **52개 통과**(세션 E 점검 45 + `import.spec.js` 7).
- [x] `npm run test:perf`의 새 spec 2개: 위 완료 기준 항목. 기존 `grid`·`search` spec은 다시 돌리지 않았습니다(아래 미확인).
- [x] 7.1 grep: `innerHTML` 0건, 모드 문자열 허용 위치 밖 0건, `src/import`의 SQL 템플릿 리터럴은 `INSERT INTO ${quoteIdent(tableId)} (…) VALUES (?, …)` 하나뿐이고 값은 전부 `runBatch` 바인딩. `_jdr_columns.options` 갱신도 바인딩.
- [x] 새 오류 코드 없음(`E_IMPORT_ENCODING`은 던지지 않고 미리보기 경고 문구에만, `E_IMPORT_CANCELLED`·`E_VALUE_INVALID`·`E_XLSX_ENCRYPTED`·`E_XLSX_CORRUPT`·`E_FILE_TOO_LARGE` 재사용). 새 RPC op 2개는 6장 표, `db/worker.js` OpMap·핸들러·읽기 집합, `rpc.test.js`에 함께 반영. i18n ko/en 키 동일(단위 테스트). 가져오기 문구 76개를 추가했고 코드에 리터럴 문구 없음(Worker의 자동 열 이름도 `t('import.columnDefault')`).
- [x] `docs/support-matrix.md`: `File.stream()` + `TextDecoderStream(euc-kr 등)`의 Worker 스트리밍, Worker 안의 SheetJS, 가져오기 파일 입력·`<progress>` 행 추가.
- [x] `build/build.mjs`의 import 검출 정규식이 `state.journalStop === 'import' ? t(…)`의 `'import'`를 import 문으로 오인해 빌드가 깨졌던 것을 고쳤습니다(따옴표 앞의 `import`는 제외. 회귀 테스트 `build.test.js`).

**산출물 크기 (`verify` 출력)**
- `dist/jdrdatabase.html` 3,706,784 bytes (3.54 MiB / 예산 6 MiB). 세션 E 점검(1,814,939) 대비 +1,891,845 bytes. 거의 전부 SheetJS(압축 후 약 1.8 MB)이고 Step 7 코드는 약 67 KB입니다(Step 7 커밋 시점 1,882,036).
- `dist/tauri/index.html` 3,706,592 bytes (CSP 메타 줄만 다름을 `verify`가 확인).

**점검했지만 고치지 않은 것 (판단 근거와 함께)**
- **SheetJS가 0.18.12입니다(0.20.3이 아님).** 이 세션의 실행 환경에서는 공식 배포 CDN(`cdn.sheetjs.com`)과 `git.sheetjs.com`이 프록시에 막혀(CONNECT 403) 받을 수 없었고, npm 레지스트리의 `xlsx`는 0.18.5에서 멈춰 있습니다. SheetJS 조직의 GitHub 미러(`SheetJS/sheetjs`, 커밋 `515d1c6f`)에서 받은 0.18.12가 가장 새 것이라 그것을 vendor에 넣었습니다(출처·SHA-256은 `vendor/CHECKSUMS`). 0.18.12는 프로토타입 오염(CVE-2023-30533, 0.19.3에서 수정)과 ReDoS(CVE-2024-22363, 0.20.2에서 수정) 이전 버전입니다. 둘 다 "악의적으로 만든 xlsx를 사용자가 직접 골라 가져올 때"가 경로이고 파서는 Worker 안에서만 돌아 DOM에 닿지 않지만, 갱신이 맞습니다. 아래 미확인으로 남깁니다(`chore(vendor)` 커밋 하나로 교체 가능하도록 어댑터 경계를 지켰습니다: `denseRows`가 0.18의 배열 시트와 0.20의 `!data`를 둘 다 받습니다).
- **SheetJS가 메인 번들과 Worker 번들에 한 번씩 들어갑니다.** 메인 번들은 Worker를 만들 수 없는 환경의 인라인 전송 폴백(D-02)을 위해 디스패처(`db/worker.js`) 전체를 품고, 그 디스패처가 `import/pipeline.js` → `import/xlsx.js` → SheetJS를 끌어옵니다. 그래서 부품 크기가 main 400 KB → 1,292 KB, worker 288 KB → 1,179 KB로 늘었고 산출물은 3.54 MiB(예산 6 MiB)입니다. 한 사본을 `<script type="text/plain">` 블록에 두고 양쪽이 같은 소스를 평가하게 바꾸면 약 900 KB를 줄일 수 있지만 빌드 구조(D-01) 변경이라 크기 예산을 맡은 Step 10의 판단으로 남깁니다. 가져오기 대화상자 자체는 파이프라인 모듈을 가져오지 않습니다.
- **`verify.mjs`가 SheetJS의 XML 네임스페이스 URL을 접두사로 허용합니다.** 정확히 일치하는 리터럴만 허용하던 규칙에 접두사 목록(`schemas.openxmlformats.org`, `schemas.microsoft.com`, `www.w3.org`, `purl.org`, `purl.oclc.org/ooxml`, `docs.oasis-open.org/ns/office`, `openoffice.org`, `macVmlSchemaUri`)을 더했습니다. 모두 SheetJS가 OOXML·ODS 문서를 읽고 쓸 때 문자열로 비교하는 네임스페이스 식별자이며 요청을 만들지 않습니다. 접두사 밖의 URL은 여전히 막힙니다(`build.test.js`).
- **평문 `.xlsx`는 SheetJS가 CSV로 읽습니다.** 형식은 확장자로 정하므로(`formatOf`) 이름만 바꾼 CSV가 xlsx 경로로 들어가면 오류 대신 표가 나옵니다. 사용자에게 해롭지 않고, 막으려면 zip 매직을 따로 검사해야 해 두었습니다.
- **미리보기 인코딩 감지의 UTF-16 추정은 라틴 문자 위주 텍스트에만 맞습니다.** BOM 없는 UTF-16 한글 파일은 NUL이 한쪽에 몰리지 않아 UTF-8 `fatal` 실패 → EUC-KR로 추정됩니다. 사용자가 인코딩을 고쳐 고를 수 있고 BOM 없는 UTF-16 CSV는 드물어 두었습니다.
- **가져오기 대화상자의 열 설정 표는 열이 많으면 깁니다**(30만 행 × 20열 픽스처에서 20행이라 문제없지만 수백 열이면 스크롤). 표 자체가 `max-height: 260px` 스크롤 상자라 동작은 하지만 자동화·접근성은 Step 10에서 봅니다.
- **`select` 타입은 새 테이블의 타입 선택지에 없습니다.** 항목을 미리 알 수 없어서이며(`addColumn`이 항목 1개 이상을 요구), 기존 select 열에는 4.2대로 자동 추가됩니다. 새 테이블에서 원하면 가져온 뒤 타입 변경(Step 3)을 쓰면 됩니다.
- **기존 테이블에 추가할 때 `text` 정책이 없습니다.** 강등은 스키마 변경이라 열 타입 변경(Step 3)의 몫입니다(Worker도 거부).
- 대화상자 옵션 컨트롤은 처음에 요소를 갈아 끼우는 방식이었다가, E2E가 미리보기 재로드와 입력이 겹칠 때 값이 되돌아가는 경주를 잡아내어 요소를 유지하고 값만 맞추는 방식으로 바꿨습니다(포커스도 유지됩니다).

**미확인 (후속 세션에서 이어받음)**
- SheetJS 0.20.3으로의 갱신(위 CVE 2건). CDN에 닿는 환경에서 `chore(vendor)` 커밋으로 교체하고 `xlsx.test.js`·`import.spec.js`를 다시 돌려야 합니다.
- 8장 환경(4코어 노트북)에서의 CSV·xlsx 가져오기 시간. 이 환경에서는 209 MB CSV 18.0초, 35,546,232바이트 xlsx 5,925 ms입니다. 150 MB 규격의 CSV(장문이 더 짧은 것)는 따로 만들지 않았습니다.
- 가져오기 실행 중 실제 취소 버튼 클릭(E2E는 취소 뒤 롤백을 단위·RPC 테스트로만 확인. 픽스처가 작아 실행 중에 누를 틈이 없음)과 그때의 "취소하는 중…" 문구.
- 100 MB 넘는 xlsx의 UI 문구, 메모리 경고 문구(코드 경로만).
- 실제 파일 선택기(`accept` 필터)와 인라인 전송 모드에서의 가져오기 시간.
- 기존 `test/perf/grid.perf.spec.js`·`search.perf.spec.js`는 이번에 다시 돌리지 않았습니다(가져오기는 렌더·창 질의 핫 경로를 바꾸지 않습니다).
- Firefox·Safari의 `TextDecoderStream('euc-kr')`·`Blob.stream()`(Worker 안), SheetJS 동작.
- 가져오기 대화상자의 키보드만 조작·스크린 리더(포커스 트랩은 `dialog.js`, 표 안의 컨트롤은 Tab 순서대로).
- 세션 E 점검의 "미확인" 목록(30만 행에서 인덱스 켜진 테이블 삭제 시간, `COUNT_CACHE_MAX` 근거, IME 조합 중 머리글 클릭·검색 디바운스, 12바이트 산출물 차이, 정렬·필터 뷰의 연속 스크롤 지연, 8장 환경의 LIKE 폴백, 스크린 리더, 100 KB 셀의 인덱싱 청크, 비STRICT 외부 테이블 정렬, Firefox·Safari의 FTS5 trigram)과 세션 D 점검에서 이어진 항목은 그대로 남습니다.

### 세션 F 점검 (세션 F 산출물 코드 점검) — 2026-09-21

세션 F의 `9b78bd0`을 원격 최신으로 맞춘 뒤 전체 파이프라인을 재현하고 코드를 점검했습니다.
초록인 상태에서 드러나지 않은 문제 4건과, 받은 직후 드러난 불안정한 테스트 1건을 재현 테스트와 함께
고쳤습니다. 새 기능은 없고 Step 9 이후를 앞당겨 구현하지 않았습니다.

시작 상태에 한 가지 짚을 것이 있습니다. 받은 직후 첫 `npm run check`가 단위 테스트 1건 실패로
끝났습니다(`# tests 297 # pass 296 # fail 1`). 출력의 꼬리만 봐서 그 자리에서는 어떤 테스트인지
특정하지 못했고, 이어 돌린 **186회**(세션 F 트리 136회 + 수정 뒤 트리 50회)에서 한 번 더 나왔습니다.
그 한 번에서 이름을 건졌습니다: `query.test.js`의 `buildWindowSQL: 값은 바인딩 …`입니다. 원인과
수정은 아래 5번입니다. 세션 F가 초록으로 본 것은 운이고, 이 테스트는 그 전부터 약 0.9% 확률로
실패하고 있었습니다.

커밋: `7d7b941` → `7d09199` → `b12557d` → `b0ed0e0` → `6d3a7a9` (문제 하나당 커밋 하나).

**고친 문제**

| # | 문제 | 커밋 |
|---|---|---|
| 1 | 겹치는 긴 헤더의 자동 열 이름이 이름 상한을 넘어 가져오기 전체가 실패 | `7d7b941` |
| 2 | 이름 대화상자가 상한을 넘는 이름을 걸러내지 않고 Worker까지 보냄 | `7d09199` |
| 3 | `select` 자동 추가가 항목을 다듬지 않아 같아 보이는 항목이 둘로 늚 | `b12557d` |
| 4 | `select` 항목 조회가 행마다 선형 탐색이라 가져오기가 제곱으로 느려짐 | `b0ed0e0` |
| 5 | 창 질의 SQL 검사가 무작위 식별자와 충돌해 약 0.9% 확률로 실패 | `6d3a7a9` |

1. **겹치는 긴 헤더의 자동 열 이름이 이름 상한을 넘음.** `infer.columnName`은 헤더를
   `MAX_NAME_LENGTH`(200자)로 자른 뒤 중복이면 ` (2)`를 덧붙입니다. 잘린 이름이 이미 상한에 닿아
   있으므로 접미사가 붙는 순간 204자가 되고, 그 이름이 그대로 `addColumn`에 가서
   `E_NAME_INVALID`(too_long)로 가져오기 전체가 실패했습니다. 앱이 스스로 만든 이름이라 사용자가
   원인을 알 수 없고, 대화상자의 `validateForm`은 빈 이름과 중복만 보고 길이는 보지 않아 실행 버튼을
   누른 뒤에야 드러났습니다. 접미사 길이만큼 base를 줄여 붙입니다.
2. **이름 대화상자가 상한 초과를 거르지 않음.** `nameValidator`(테이블·열·뷰 이름과 가져오기의 새
   테이블 이름이 모두 씁니다)는 빈 이름과 중복만 사전 검사했습니다. `normalizeName`이 200자 초과를
   거절하므로 긴 이름은 확인 버튼을 누른 뒤에야, 그것도 스키마 op가 실패하는 형태로 이유가
   돌아왔습니다. 1번이 앱이 만든 이름 쪽이라면 이것은 사용자가 넣는 쪽의 같은 실패입니다.
   i18n `validate.nameTooLong`을 더했습니다(새 오류 코드는 없습니다. 기존 `E_NAME_INVALID`의
   사전 검사입니다).
3. **`select` 자동 추가가 항목을 다듬지 않음.** `tables.normalizeOptions`는 선택 항목을 `trim` +
   중복 제거로 정리하는데, 가져오기의 자동 추가(4.2)만 이 경로를 거치지 않고
   `_jdr_columns.options`를 직접 갱신하면서 원본 값을 그대로 넣었습니다. CSV의 `" 일반 "`이 기존
   항목 `"일반"`과 별개 항목으로 늘고 셀에도 다듬지 않은 값이 들어갑니다. 목록에는 같아 보이는
   항목이 둘 생기고 필터·그룹이 갈라지며, 나중에 열을 고치면(그때는 `normalizeOptions`를 거칩니다)
   `" 일반 "`이 사라져 그 값이 든 셀이 `not_in_choices`가 됩니다. 항목과 셀 값 모두 같은 규칙으로
   다듬습니다. 공백뿐인 값은 `isEmpty`가 먼저 걸러 NULL로 가므로 동작 변화는 없습니다.
4. **`select` 항목 조회가 행마다 선형 탐색.** 자동 추가가 행마다 `choices.includes(text)`로 항목
   배열을 훑었고, 항목은 가져오는 동안 계속 늘어나므로 비용이 행 수 × 항목 수가 됩니다. 자유 입력
   열을 `select` 열에 매핑하면 항목이 행 수만큼 늘어 Step 7의 30만 행 예산(8장, 60초)을 이 스캔
   하나가 넘깁니다. 열마다 Set 색인을 두어 조회를 O(1)로 바꿨습니다(저장되는 메타는 같습니다).
   측정(기존 테이블의 select 열에 서로 다른 값을 넣는 CSV): 5,000행 121 → 94 ms, 10,000행
   230 → 92 ms, 20,000행 540 → 155 ms. 수정 전은 배가 될 때마다 약 2.2배(제곱), 수정 후는
   선형입니다.
5. **창 질의 SQL 검사가 무작위 식별자와 충돌.** `buildWindowSQL: 값은 바인딩 …`이
   `!sql.includes('200')`으로 offset·limit 값이 SQL 문자열에 섞이지 않았는지 봤습니다. 물리
   식별자는 `t_/c_<8hex>`이고 16진수는 10진 숫자와 같은 글자를 쓰므로, 이 SQL에 들어가는 식별자
   6개(테이블 1 + 열 5) 중 하나가 `c_a200b3f1`처럼 나오면 단언이 깨집니다. 같은 방식으로 식별자
   6개를 20만 번 뽑아 잰 충돌 확률은 **0.88%**이고, 관측한 빈도(186회 중 2회)와 맞습니다.
   값이 문자열로 들어가지 않는다는 의도는 그대로 두고 인용된 식별자를 뺀 나머지에서만
   검사합니다(바로 위의 `assert.equal(sql, …)`이 `LIMIT ? OFFSET ?` 형태를 이미 통째로
   못박습니다). 이 파일만 300회 돌린 결과가 수정 전 1회 실패 → 수정 후 0회입니다.

**재현 테스트**

수정 전 빨강을 확인한 것:
- `infer.test.js`: `columnName: 상한 길이 헤더가 겹쳐도 접미사까지 상한 안에 든다`
- `pipeline.test.js`: `run: 상한 길이 헤더가 겹쳐도 새 테이블 가져오기가 성공한다`(수정 전
  `E_NAME_INVALID`), `run: select 자동 추가는 항목을 다듬어 같아 보이는 항목이 둘로 늘지 않는다`
- `test/unit/ui/dialogs/table.test.js`(새 파일): `nameValidator: 빈 이름·상한 초과·중복을 Worker보다
  먼저 잡는다`
- `query.test.js`: 5번은 확률적이라 한 번의 빨강을 만들 수 없습니다. 대신 같은 파일 300회 반복으로
  수정 전 1회 실패 → 수정 후 0회를 확인했고, 충돌 확률 0.88%를 따로 쟀습니다.

빨강을 만들지 못한 것:
- 4번(복잡도)은 시간 단언을 단위 테스트에 두지 않는다는 규약(CLAUDE.md 6) 때문에 빨강을 만들지
  않았습니다. 대신 결과를 못박는 `pipeline.test.js: run: select 항목이 많아도 자동 추가가 중복 없이
  한 번씩만 쌓인다`(서로 다른 값 4,000개 × 2회)를 더했고, 복잡도 근거는 위 측정치입니다.

**점검했지만 고치지 않은 것 (판단 근거와 함께)**

- **CSV 파서의 조각 경계 처리는 무작위 차동 검사로도 어긋나지 않았습니다.** `a`, `가`, `"`, `,`,
  `\n`, `\r`, `\r\n`, 빈 문자열, 공백, `""`, 탭을 섞어 만든 입력 20,000개를 조각 크기 1·2·3·5·7로
  나눠 파싱한 결과가 통째로 파싱한 결과와 모두 같았습니다(불일치 0건). `pendingLf`가 빈 조각에
  지워지는 경로도 살폈지만 그 뒤의 `\n`은 내용 없는 레코드라 `rowHasContent`가 걸러 결과가
  달라지지 않습니다.
- **`import.run`이 트랜잭션 중간에 이벤트 루프로 돌아가지만 다른 쓰기가 끼어들지 못합니다.**
  `import.run`·`db.snapshot`·`command.apply`가 모두 배타 op라 `assertNotBusy`가 `E_DB_BUSY`로
  막습니다(세션 B 점검 `11f3078`의 규칙이 그대로 듣습니다). `query.*`는 허용되지만 statement를
  무효화하지 않습니다.
- **`select` 항목 수에 상한이 없습니다.** 4번을 고쳐 시간은 선형이 됐지만, 30만 행을 select 열에
  넣으면 `_jdr_columns.options` JSON이 수 MB가 되고 스키마를 읽을 때마다 파싱됩니다(20,000행에서
  168,907바이트 실측). 상한은 설계 결정이라 Step 10(성능·하드닝)의 판단으로 남깁니다.
- **`plan()`은 새 테이블의 열 이름 중복·길이를 검사하지 않고 `addColumn`에 맡깁니다.** 트랜잭션
  안이라 롤백은 됩니다. 대화상자가 중복을, 이번 수정이 길이를 먼저 잡으므로 UI를 거치면 닿지
  않습니다. Worker를 직접 부르는 경로에서만 늦은 실패가 남습니다.
- **`decodeHead`의 `try/catch`는 사실상 죽은 코드입니다.** `fatal` 없이 디코딩하므로 던지지 않고,
  잘못된 인코딩 이름은 `TextDecoder` 생성자에서 던집니다. 동작에는 문제가 없어 두었습니다.
- **XLSX의 `error_cells`·`merged` 경고는 헤더 앞 행과 가져오지 않는 범위까지 셉니다.** 경고 숫자가
  조금 커질 뿐 가져오는 값에는 영향이 없습니다.
- **강등 재시도가 `select` 열의 항목을 앞선(롤백된) 시도에서 이어받습니다.** 지금은 닿지 않는
  경로입니다. `plan()`이 기존 테이블에 `text` 정책을 거부하고, 새 테이블에는 항목을 알 수 없어
  `select`를 만들 수 없어서(`addColumn`이 항목 1개 이상을 요구) 강등과 `select`가 같은 실행에
  함께 있을 수 없습니다. Step 10에서 새 테이블의 select를 열면 같이 봐야 합니다.

**검증 결과**

- [x] `npm run check`: eslint 0건, prettier 통과, tsc 0오류, 단위 테스트 **302개 통과**(세션 F 297 +
      신규 5). 시작할 때 본 1건 실패는 5번으로 원인을 찾아 고쳤습니다.
- [x] `npm run build && npm run verify`: `verify OK`, 외부 참조 0건(허용 vendor URL 리터럴 160건),
      vendor 체크섬 6개 일치, 두 변형 CSP 외 동일.
- [x] `npm run test:e2e`: Chromium `file://`에서 **52개 통과**(세션 F와 같은 수. E2E는 더하지
      않았습니다).
- [x] 7.1 grep: `innerHTML`·`insertAdjacentHTML` 0건, 모드 문자열 허용 위치 밖 0건, `src/import`의
      SQL 템플릿 리터럴은 `INSERT INTO ${quoteIdent(tableId)} …` 하나뿐이고 값은 전부 바인딩.
- [x] 새 오류 코드 없음, 새 RPC op 없음. i18n `validate.nameTooLong`을 ko·en에 같이 더했고 키 동일을
      단위 테스트가 강제합니다.
- [x] 설계 결정 변경 없음(`DESIGN.md` 수정 없음).

**산출물 크기 (`verify` 출력)**

- `dist/jdrdatabase.html` 3,707,254 bytes (3.54 MiB / 예산 6 MiB). 세션 F(3,706,784) 대비
  **+470 bytes**(i18n 문구 1개와 Set 색인).
- `dist/tauri/index.html` 3,707,062 bytes (CSP 메타 줄만 다름을 `verify`가 확인).

**미확인 (후속 세션에서 이어받음)**

- ~~**`view.spec.js`의 `편집 중 머리글 클릭(정렬) …`이 CI에서 드물게 실패합니다(원인 미확인).**~~
  **해소됨 — 아래 「세션 F 점검 후속」 절 참고(`6423b64`). 테스트 경합이었고 데이터 유실이 아닙니다.**
  세션 F의 헤드 `9b78bd0`에서도 같은 테스트·같은 줄(`view.spec.js:426`)이 같은 방식으로
  실패했으므로(run #37) 이 점검이 들여온 것이 아니고, 세션 F가 "E2E 52개 통과"로 적은 것은
  로컬 결과이며 그 커밋의 push CI는 빨강이었습니다. 실패 모습은 편집 값이 DB에 닿지 않고 옛
  값(`이름1`)이 남는 것입니다. 지금까지 관측: `9b78bd0` push 빨강 / PR 초록, `3c9f3b5` push
  빨강 / PR 초록(그 push를 재실행하니 초록), `80780ff` push 빨강 / PR 초록. push 3/3 빨강,
  PR 3/3 초록이지만 재실행이 초록이었으므로 이벤트 종류 자체의 차이로 보지는 않습니다. 워크플로는 두 이벤트가 같고 PR의
  병합 커밋 트리도 브랜치 헤드와 같아 push·PR 차이는 우연으로 봅니다.

  재현을 다섯 가지로 시도했지만 모두 실패했습니다(로컬 55회 이상 전부 초록): 단독 반복 30회,
  CPU 부하 4개를 건 채 25회, `command.apply`를 600 ms 늦춘 채, `query.row`를 400 ms 늦춘 채,
  CDP `Emulation.setCPUThrottlingRate` 12배로 8회. 확정 값과 토스트를 찍어 봐도 언제나
  `머리글클릭확정`이고 토스트는 없었습니다.

  코드를 읽어 확인한 것: 머리글 `pointerdown`은 리사이저일 때만 `preventDefault`하므로 포인터를
  누르는 순간 편집기 입력에서 포커스가 떠나 `blur`가 먼저 나고, `onBlur` → `editor.commit('blur')`
  → `applyCellEdit`이 같은 동기 구간에서 시작됩니다. 다만 `applyCellEdit`은 쓰기 전에
  `readOld`(`query.row`) 왕복을 한 번 하므로 그 사이에 `toggleSort`의 재마운트가 끼어듭니다.
  이 구간이 의심스럽지만 위 다섯 가지로 그 순서를 뒤집지 못했습니다. 테스트의
  `expect(...).toBeHidden()`은 확정이 끝나야 참이 되므로(성공이면 `teardown()`, 실패면 되돌린 뒤
  `teardown()`) 단순한 "질의가 너무 빨랐다" 종류의 경합은 아닙니다.

  **가설(검증하지 못함)**: 실패 값이 예외나 토스트 없이 정확히 옛 값 `이름1`이라는 점이
  눈에 걸립니다. `applyCellEdit`은 `old.value === input.newValue`면 아무것도 쓰지 않고 `true`를
  돌려주므로, 편집기 입력이 `fill` 뒤 어떤 이유로 옛 값으로 되돌아가 있으면 확정이 "성공"하고
  DB는 그대로이며 토스트도 나지 않습니다. `inline.open`은 `current`가 있으면 `teardown()` 후
  필드를 다시 만들므로, 늦게 도착한 `openEditor`가 한 번 더 열면 입력한 글자가 사라집니다
  (`d8fb1df` 이후 낡은 블록은 `query.row`를 기다렸다가 엽니다). 확인하려면 `fill` 직후
  머리글을 누르기 전에 입력 값을 한 번 단언하고, `inline.open` 호출 횟수를 세어 보면 됩니다.

  **다음 세션에 넘기는 것**: 확정이 되돌려진 것인지(그러면 `edit.reverted` 토스트가 있어야
  합니다), `blur`가 나지 않은 것인지, 아니면 위 가설처럼 입력이 옛 값으로 되돌아간 것인지를
  가르는 것이 먼저입니다. CI의
  `playwright-report` 아티팩트(`test-results/…/error-context.md`)에 실패 시점의 페이지 상태가
  있으니 그것부터 보면 됩니다. 값이 조용히 사라지는 경로라면 7.2의 1순위(데이터 유실)입니다.
  추측으로 테스트만 무르게 고치면 진짜 유실을 덮을 수 있어 이번에는 손대지 않았습니다.
- 5번과 같은 종류(무작위 식별자와 문자열 검사의 충돌)가 다른 테스트에 더 있는지는 전수로 보지
  않았습니다. `grep -rn "includes('" test/unit`으로 훑어 SQL 문자열을 숫자·짧은 문자열로 검사하는
  다른 자리는 찾지 못했지만, 확률이 낮으면 이번처럼 오래 숨습니다.
- 세션 F의 미확인 목록은 이 점검에서 줄이지 못했고 그대로 남습니다: SheetJS 0.20.3 갱신(CVE 2건),
  8장 환경에서의 가져오기 시간, 가져오기 실행 중 취소 버튼 클릭과 "취소하는 중…" 문구, 100 MB
  넘는 xlsx의 UI 문구와 메모리 경고 문구, 실제 파일 선택기와 인라인 전송 모드, Firefox·Safari의
  `TextDecoderStream('euc-kr')`·`Blob.stream()`·SheetJS, 가져오기 대화상자의 키보드만 조작·스크린
  리더. 세션 E 점검·D 점검에서 이어진 항목도 그대로입니다.
- 이번에 더한 `validate.nameTooLong` 문구가 실제 대화상자에서 어떻게 보이는지는 단위 테스트로만
  확인했고 E2E·수동 확인은 하지 않았습니다.
- `test/perf/*`는 이번에 다시 돌리지 않았습니다(고친 곳이 렌더·창 질의 핫 경로가 아닙니다).
  select 항목 조회의 측정치는 위 4번의 Node 벤치마크이며 `perf-baseline.json`에는 넣지 않았습니다.

### 세션 F 점검 후속 (간헐 실패 E2E 원인 규명) — 2026-09-21

세션 F 점검이 "미확인"으로 남긴 `view.spec.js`의 `편집 중 머리글 클릭(정렬) …` 간헐 실패를
CI에서 증거를 모아 규명하고 고쳤습니다. 다른 변경은 없습니다.

커밋: `33321c6` → `d166e09` → `c7d914c` → `634819f`(모두 임시 진단) → `6423b64`(수정, 진단 제거).

**판정: 테스트 경합입니다. 데이터 유실이 아닙니다.**

CI에서 실패한 인스턴스가 남긴 증거입니다.

```
{"immediate":"이름1","later":"머리글클릭확정",
 "blurs":[…,{"at":1596,"cls":"jdr-editor__field","value":"머리글클릭확정"}],
 "toasts":[]}
```

- 편집기 필드의 `blur`가 **올바른 값**으로 발생했습니다 → "blur 미발생"도 "입력이 옛 값으로
  되돌아감"도 아닙니다.
- `edit.reverted` 토스트가 **0건**입니다 → `applyCellEdit`이 false를 돌려준 것도 아닙니다.
- 2초 뒤 DB 값이 `머리글클릭확정`입니다 → **확정은 됐고 늦게 도착했을 뿐입니다.**

**원인.** 검사가 `expect(.jdr-editor).toBeHidden()`을 확정 완료의 신호로 썼는데, 편집기는 두
경로로 닫힙니다. `inline.commit()`은 `onCommit`이 끝난 뒤 `teardown()`을 부르지만(이건 확정
완료입니다), `hooks.onReset()` → `inline.cancel()` → `teardown()`은 정렬이 그리드를 다시
마운트할 때 **진행 중인 확정과 무관하게 즉시** 닫습니다. 느린 기계에서는 두 번째가 먼저 이기고,
검사는 `applyCellEdit`의 `query.row` → `command.apply` 왕복이 끝나기 전에 DB를 읽습니다.

**제품 동작은 정상입니다.** `commit()`이 `await` 전에 `const raw = field.value`로 값을 잡아
두므로 편집기가 먼저 닫혀도 쓰는 값은 그대로입니다. 사용자 관점의 흠은 확정이 도착하기 전 짧은
순간 그리드에 옛 값이 보일 수 있다는 것뿐입니다.

**수정.** 값이 닿을 때까지 기다리도록 `expect.poll`로 바꿨습니다(순 변경 6줄 추가·2줄 삭제).
원래 의도("확정보다 재마운트가 앞서면 입력이 조용히 사라진다"를 고정)는 그대로입니다. 확정이
아예 일어나지 않는 회귀는 값이 끝내 닿지 않아 시간 초과로 잡히며, `onBlur`를 무력화해 넣은
회귀로 빨강을 확인했습니다.

**규명 과정에서 배운 것 (같은 종류의 조사에 쓸 수 있음)**

- 로컬에서는 끝내 재현하지 못했습니다(단독 반복, CPU 부하, `command.apply`·`query.row` 지연,
  CDP 12배 스로틀까지 55회 이상 전부 초록). CI 러너에서만 납니다.
- **관측이 경합을 숨깁니다.** 처음 넣은 탐침은 `seed()`와 `dblclick()` 사이에 `page.evaluate`
  왕복을 하나 넣었는데, 그것만으로 표본 24개가 전부 초록이었습니다. 경합 구간이 그만큼 좁습니다.
  결국 관측을 `beforeEach`의 `addInitScript`(blur 캡처 리스너 + 토스트 상자 하나만 보는
  MutationObserver)로 옮기고, 실패할 때만 증거를 읽도록 해서 성공 경로에 비용이 0이 되게 한 뒤에야
  잡혔습니다.
- 빈도가 낮을 때는 **같은 본문을 여러 번 등록해** 한 실행의 표본을 늘리는 것이 효율적입니다
  (8번 등록하니 한 실행에서 바로 잡혔습니다).

**검증 결과**

- [x] `npm run check`: 단위 테스트 302개 통과(변화 없음).
- [x] `npm run build && npm run verify`: `verify OK`, 3,707,254 bytes로 세션 F 점검과 같습니다
      (E2E 파일만 고쳤으므로 산출물은 그대로입니다).
- [x] `npm run test:e2e`: 52개 통과.
- [x] 회귀 확인: `onBlur`를 무력화하면 이 검사가 실패합니다(수정 뒤에도 회귀를 잡습니다).
- [x] 임시 진단 흔적 0건(`grep -n 'DIAG\|__jdrBlur\|__jdrToasts\|임시 진단' test/e2e/`).

**CI 재확인 (수정 뒤)**

수정 커밋 `6423b64`의 헤드에서 **8회 연속 초록**입니다(push·PR 각 1회 + 재실행 3라운드 × 2회).
수정 전 관측 빈도는 실행당 약 37%(8회 중 3회 빨강)였으므로, 8회 연속 초록이 우연일 확률은
약 2.5%입니다. 빈도가 낮은 간헐 실패라 "완전히 사라졌다"고 단정하지는 않지만, 원인을 증거로
특정하고 그 원인을 없앤 수정이므로 재발하면 같은 자리가 아닐 것으로 봅니다.

**미확인**

- 이 브랜치에서 관측한 CI 빨강은 전부 이 검사 하나였습니다(`9b78bd0`, `3c9f3b5`, `80780ff`,
  `634819f`). 다른 간헐 실패가 숨어 있는지는 전수로 확인할 수 없습니다.
- 세션 F 점검의 나머지 미확인 항목(SheetJS 0.20.3 갱신, 브라우저별 실측 등)은 그대로입니다.

### 세션 G (Step 9) — 2026-09-21

커밋: `26bf92c` docs(design) 착수 전 내보내기 조각 스트림·gzip·자동 저장·백업 복원 확정 → `9d6c49a` feat(export) Step 9 CSV·XLSX 내보내기, .db.gz 저장, 백업 복원, 자동 저장, 클라우드 안내 → 이 기록.

시작 상태: 원격이 강제 갱신되어 있어 로컬 브랜치를 원격 `6a27c2f`로 맞춘 뒤 `npm run check`(302개)가 초록임을 확인하고 시작했습니다. 세션 F 점검·후속의 미확인 항목은 아래 "미확인"에 이어받았습니다.

**설계 변경 (코드보다 먼저 DESIGN.md v0.9에 반영, 리뷰어 확인 필요)**

- **내보내기는 Worker가 조각으로 흘려보낸다.** `export.stream` `{ tableId, viewSpec, format, options? }` op 하나가 뷰 순서로 5,000행씩 읽어(정렬·필터·검색이 없는 뷰는 `WHERE "id" > ? ORDER BY "id"` 키셋, 있으면 `OFFSET`) CSV 조각을 만들 때마다 새 메시지 종류 `{ id, chunk }`(transfer)로 메인에 보내고, 끝나면 `{ rows, bytes, blobCells }`를 돌려줍니다. 메인은 조각을 바이트 싱크(`filesystem.openSink`: FSA `createWritable()` / 다운로드 폴백)에 차례로 쓰고, 취소·실패는 `abort()`로 파일을 남기지 않습니다. 6장 프로토콜에 조각 이벤트를 더했고 `db/client.js`에 `onChunk`, `db/worker.js`의 `HandlerContext`에 `chunk`를 더했습니다. 역압은 두지 않습니다(메인이 들고 있을 수 있는 상한이 DB 크기이고 DB는 이미 메모리에 있습니다).
- **`export.stream`은 배타 op입니다.** 읽기지만 페이지 사이에서 이벤트 루프로 돌아오므로 쓰기가 끼어들면 앞뒤 페이지가 다른 상태를 봅니다. 행 수 캐시는 무효화하지 않습니다(읽기 집합).
- **gzip 저장은 스냅샷 전에 지원을 확인합니다.** 순서는 지원 확인 → `db.snapshot`(revision+1) → gzip → 기존 파일 백업 → 쓰기. 지원 확인이 뒤에 있으면 파일에는 아무것도 쓰이지 않았는데 revision만 오른 DB가 남습니다. 열기는 매직 `1f 8b`로 판별하고 압축 해제 뒤 크기로 `warnFileBytes`·`maxFileBytes`를 다시 검사합니다(압축 파일은 작아 보입니다). "저장"은 현재 파일의 형식을 유지하고(`state.file.gzip`), 폴백(다운로드) 경로에서는 설정의 "압축 저장"이 제안 이름을 `.db.gz`로 만듭니다.
- **자동 저장은 기본 꺼짐으로 확정(9장 미확정 해소).** 정본 핸들이 있고 dirty일 때만 시도하고, 다운로드 폴백으로는 자동 저장하지 않습니다. 저장 뮤텍스(`state.saving`) 아래에서 사용자 저장은 `file.saveBusy`로 알리고 자동 저장은 조용히 다음 틱으로 미룹니다. `E_DB_BUSY`(가져오기·내보내기 진행 중)도 자동 저장에서는 알리지 않습니다.
- **백업 복원은 바이트 그대로 새 파일로.** IDB `backups[db_id]`를 `pickSaveAs('backup-<이름>')`로 고른 곳에 씁니다(압축 여부도 그대로. 열린 DB는 건드리지 않음). 백업 생략(200 MB 초과)·`E_QUOTA`·그 밖의 실패는 `state.backupNote`로 상태바에 남고 다음 저장 성공이 지웁니다. 데스크톱 `.bak`은 Step 11에서 채우며 그 전에는 `E_UNSUPPORTED`.
- **새 오류 코드 없음.** 취소는 `E_IMPORT_CANCELLED`(7장 설명에 내보내기 추가), XLSX 행 상한 1,048,575 초과는 `E_FILE_TOO_LARGE`(`detail.format = 'xlsx'`, 7장 설명 갱신), gzip 미지원은 기존 `E_GZIP_UNSUPPORTED`.
- 3.1에 `export/rows.js`(페이지 이터레이터), `app/settings.js`(IDB settings 읽기·쓰기), `ui/dialogs/export.js`·`settings.js`, `docs/cloud-sync.md`.

**Step 9 완료 기준**
- [x] 왕복 테스트(내보낸 CSV를 다시 가져오면 타입·값이 동일: 날짜, 불리언, NULL, 따옴표 포함 텍스트): `test/unit/export/csv.test.js` "왕복: …"(text·longtext·integer·real·boolean·date·datetime·select 8열, 따옴표·쉼표·CRLF가 든 텍스트, NULL 행, 2^53−1, 3e2 → `run()`으로 다시 가져와 타입 동일·값 동일. select는 새 테이블에서 text로 받고, 기존 select 열에 넣으면 항목이 자동으로 채워짐) + 수식 주입 방지를 끈 왕복(`=1+1`, `-x`) + E2E `export.spec.js`(`types.csv`를 가져온 테이블을 CSV로 내려받아 다시 가져오면 8열의 타입·행이 동일). XLSX도 같은 왕복(`xlsx.test.js`: 날짜·일시·불리언·NULL·따옴표 텍스트가 Step 8 어댑터로 같은 타입·값으로 돌아옴, `preview`의 추론도 원본 타입과 같음 + E2E).
- [x] `.db.gz` 저장 → 열기 왕복: `store.test.js`(설정 켜고 다운로드 → 이름 `database.db.gz`·매직·`file.gzip` → 새 DB → 다시 열면 같은 db_id·revision·데이터, "저장"이 형식 유지) + E2E `export.spec.js`(설정 대화상자에서 압축 저장을 켜고 저장 → 내려받은 파일이 `1f 8b`로 시작 → `<input type="file">`로 열면 같은 db_id·revision 1·행 3개·`saved_by`가 바꾼 기기 이름). `CompressionStream`·`DecompressionStream`의 `file://` 가용성을 이 검사로 실측해 지원 매트릭스에 적었습니다.
- [x] `docs/cloud-sync.md`: "PC A에서 저장 → 동기화 완료 확인 → 탭 닫기 → PC B 동기화 확인 → 열기" 절차, 경고 7종(오래된 파일, 저널 복구, 다른 버전 위의 기록, 다른 탭, 새 스키마, 원본 변경(데스크톱), 저널 정지 배너)의 뜻과 권하는 행동, 직전 저장본, 자동 저장, 권장 사항. README에서 링크.
- Step 9 예외 처리 대응(어디서 확인했는지):
  - 구분자·개행·따옴표 인용, BOM 기본: 단위(`quoteField`, `exportCsv` 바이트 검사) + E2E(BOM 있음·없음).
  - 수식 주입 방지 옵션(기본 켜짐): 단위(`=`,`+`,`-`,`@` 네 글자, 텍스트 계열만, 숫자 `-42`는 그대로) + E2E(대화상자 기본 체크).
  - 취소·실패 시 파일을 남기지 않음: 단위(`readPages`가 페이지 사이에서 `E_IMPORT_CANCELLED`, `store.exportTable`이 실패·취소에 싱크 `abort()`; FSA 경로의 `abort()`는 헤드리스에서 미확인).
  - XLSX 행 수 경고·거부: 단위(`count(*)`를 가짜로 넘겨 `E_FILE_TOO_LARGE`·`detail.format`), 대화상자 문구는 코드 경로만.
  - BLOB 값: 단위(`cellText`·`cellObject`가 빈 값, `blobCells` 집계). 외부 테이블 실데이터로는 미확인.
  - gzip 미지원: `store.test.js`(저장은 스냅샷 전에 멈춰 revision 그대로, 열기 거부). 손상 gzip은 `E_FILE_CORRUPT`(`filesystem.test.js`·`store.test.js`).
  - 저장 뮤텍스: `store.test.js`(쓰기를 붙잡은 채 두 번째 저장 → `file.saveBusy`, 자동 저장은 조용히 false).
  - 백업 용량 부족: `store.test.js`(`backups` put이 `E_QUOTA`를 던져도 저장되고 `backupNote = 'quota'`, 다음 저장 성공이 지움). 상태바 표시는 코드 경로만.
  - 백업 복원 중 쓰기 실패: 코드 경로만(`fs.write`가 던지면 `E_FILE_WRITE` 토스트, DB·정본 그대로).
- 자동 저장 타이머: `autosave.test.js`(dirty 뒤 간격, 미룸이면 같은 간격 뒤 재시도, 저장되면 쉼, 겹쳐 잡지 않음, 사용자 저장이 먼저 끝나면 틱 삭제, 간격 0, dispose, `save`가 던져도 재시도, 저장 중 들어온 dirty를 잃지 않음). 실제 타이머로 30초 뒤 저장되는 시나리오는 헤드리스(핸들 없음)에서 미확인.
- 설정: `settings.test.js`(기기 이름 생성·저장, 정규화, IDB 없음) + E2E(기기 이름·압축 저장이 새로고침 뒤에도 유지, 빈 이름 거부, 취소 시 미반영).

**검증 결과**
- [x] `npm run check`: eslint 0건, prettier 통과, tsc 0오류, 단위 테스트 **332개 통과**(세션 F 점검 후속 302 + 30). 새 파일: `test/unit/export/csv.test.js` 8, `xlsx.test.js` 4, `test/unit/app/settings.test.js` 4, `test/unit/io/filesystem.test.js` 2. 기존 파일에 `store.test.js` 9, `autosave.test.js` 2, `rpc.test.js` 1.
- [x] `npm run build && npm run verify`: `verify OK`, 외부 참조 0건(허용 vendor URL 리터럴 160건), vendor 체크섬 6개 일치, 두 변형 CSP 외 동일.
- [x] `npm run test:e2e`: Chromium `file://`에서 **57개 통과**(52 + `export.spec.js` 5).
- [x] 7.1 grep: `innerHTML` 0건, 모드 문자열 허용 위치 밖 0건, `src/export`의 SQL 템플릿 리터럴은 `rows.js`의 두 문장뿐이고 식별자는 `quoteIdent`, 뷰 조각은 `buildViewClauses`, 값(`lastId`·`limit`·`offset`·필터 값)은 전부 바인딩.
- [x] 새 오류 코드 없음. 새 RPC op 1개(`export.stream`)는 6장 표, `db/worker.js` OpMap·핸들러·배타 집합·읽기 집합, `db/client.js`, `rpc.test.js`에 함께 반영. i18n ko/en 키 동일(단위 테스트). 문구 53개 추가, 코드에 리터럴 문구 없음.
- [x] `docs/support-matrix.md`: `CompressionStream`/`DecompressionStream` 행을 실측으로 바꾸고, 비ASCII `<a download>` 이름과 조각 다운로드 왕복 행을 더했습니다.
- [ ] `npm run test:perf`: 돌리지 않았습니다(내보내기는 렌더·창 질의 핫 경로를 바꾸지 않습니다). 30만 행 내보내기 시간은 아래 미확인.

**산출물 크기 (`verify` 출력)**
- `dist/jdrdatabase.html` 3,739,528 bytes (3.57 MiB / 예산 6 MiB). 세션 F 점검 후속(3,707,254) 대비 +32,274 bytes(내보내기 모듈·대화상자 2개·문구).
- `dist/tauri/index.html` 3,739,336 bytes.

**점검했지만 고치지 않은 것 (판단 근거와 함께)**
- **헤드리스 Chromium은 비ASCII 이름의 `<a download>`를 `download`로 보고합니다.** `download.suggestedFilename()`이 `원본.csv` 대신 `download`였습니다. 앱이 주는 이름은 `a.download`에 그대로 들어가고 ASCII 이름(`src.csv`, `database.db.gz`)은 유지되므로 앱의 문제가 아니라 헤드리스의 동작으로 보고, E2E는 ASCII 테이블 이름으로 검사합니다. 실제 브라우저에서 한글 이름이 유지되는지는 미확인(지원 매트릭스).
- **XLSX 날짜는 로컬 시각으로 씁니다.** SheetJS는 일련번호를 로컬 시각으로 만들고 Step 8 어댑터도 로컬 시각 부품으로 읽으므로, 같은 기기에서의 왕복은 같습니다. 시간대가 다른 PC에서 열어도 엑셀의 날짜는 시간대가 없는 값이라 같은 날짜로 보이지만, 일광 절약 시간 전환 시각에 걸친 `datetime`은 SheetJS 쪽 변환에서 1시간 어긋날 수 있습니다(픽스처로 재지 않음).
- **`select` 열은 CSV로 다시 가져올 때 text가 됩니다.** 새 테이블의 타입 선택지에 select가 없기 때문이며(세션 F의 판단), 값은 같습니다. 왕복 테스트가 이를 그대로 검사합니다.
- **내보내기에 역압이 없습니다.** FSA 싱크의 `write`가 느리면 조각이 메인 메모리에 쌓입니다. 상한은 DB 크기(이미 메모리에 있음)라 두었고, 필요하면 Worker가 `chunk` 확인 응답을 기다리게 바꿀 수 있습니다(RPC 형식 변경).
- **폴백 다운로드 싱크는 조각을 모두 모아 Blob 하나로 만듭니다.** 300 MB CSV면 그만큼의 조각이 메인에 머무릅니다. Blob은 조각 배열을 복사 없이 감싸므로 두 배가 되지는 않습니다.
- **자동 저장은 dirty 전환 때만 틱을 잡습니다.** 이미 dirty인 동안의 추가 편집은 틱을 다시 잡지 않으므로(디바운스가 아님) 계속 편집해도 간격마다 저장됩니다. 저장이 실패하면(`E_FILE_WRITE` 등) 간격마다 토스트가 반복될 수 있는데, 데이터 안전에 관한 알림이라 그대로 두었습니다(설정에서 끄면 멈춥니다).
- **내보내기 버튼은 읽기 전용 상태에서도 켜져 있습니다.** 내보내기는 읽기라 다른 탭이 점유한 DB나 새 스키마 파일도 내보낼 수 있습니다.
- **`export.stream` 진행률의 `total`은 `query.count`입니다.** 필터가 있는 30만 행 뷰에서 `count(*)`가 한 번 더 도는 비용(35 ms 수준)은 받아들였습니다.

**미확인 (후속 세션에서 이어받음)**
- 30만 행 × 20열 테이블의 CSV·XLSX 내보내기 시간과 메모리(8장에는 예산이 없지만 Step 10의 측정 항목으로 권합니다). XLSX 10만 행 경고 문구와 1,048,575행 거부 문구의 실제 표시.
- FSA 경로의 내보내기(`showSaveFilePicker` → `createWritable()` 싱크의 순서 쓰기, 실패·취소 시 `abort()`)와 `.db.gz` 종류 제안(`accept: { 'application/gzip': ['.gz'] }`가 실제 선택기에서 받아들여지는지), 백업 복원의 FSA 경로, 자동 저장이 실제 타이머로 정본 핸들에 쓰는 시나리오. 모두 헤드리스에서 파일 선택기를 자동화할 수 없어 코드 경로만 있습니다(Chrome/Edge 데스크톱에서 손으로 확인).
- 실제 브라우저에서 한글 파일 이름의 `<a download>`(위 "점검했지만 고치지 않은 것").
- 내보내기 실행 중 실제 취소 버튼 클릭과 "취소하는 중…" 문구(픽스처가 작아 누를 틈이 없음. 취소 뒤 파일이 만들어지지 않는 것은 단위·스토어 테스트로만).
- Firefox·Safari의 `CompressionStream`(Safari 16.4+, Firefox 113+로 알려져 있으나 실측 없음)과 다운로드 싱크. 데스크톱 WebView의 `CompressionStream`(R8).
- 외부(비STRICT) 테이블의 BLOB 값 내보내기 실데이터, 백업 복원 중 쓰기 실패 문구, 백업 용량 부족의 상태바 표시(코드 경로만).
- 내보내기·설정 대화상자의 키보드만 조작·스크린 리더(포커스 트랩은 `dialog.js`).
- 세션 F 점검·후속의 미확인 목록(SheetJS 0.20.3 갱신(CVE 2건), 8장 환경의 가져오기 시간, 가져오기 취소 버튼 클릭, 100 MB 넘는 xlsx 문구, 실제 파일 선택기·인라인 전송, Firefox·Safari의 `TextDecoderStream('euc-kr')`·SheetJS, 가져오기 대화상자 접근성, 다른 간헐 실패의 존재 여부)과 세션 E 점검·D 점검에서 이어진 항목은 그대로 남습니다.

### 세션 G 점검 (세션 G 산출물 코드 점검) — 2026-09-21

세션 G의 `5189700`을 원격 최신으로 맞춘 뒤 전체 파이프라인을 재현하고(`check` 332개, `build`, `verify`, `test:e2e` 57개 모두 초록) 코드를 점검했습니다. 초록인 상태에서 드러나지 않은 문제 3건을 재현 테스트와 함께 고쳤습니다. 셋 다 Step 9가 넓히거나 자동화한 저장 경로에 있고, 첫 번째는 미저장 변경이 조용히 사라지는 데이터 유실입니다. 새 기능은 없고 세션 H 이후를 앞당겨 구현하지 않았습니다.

커밋: `d0099e1` → `208c0e7` → `f631c46` → 이 기록 (문제 하나당 커밋 하나).

**고친 문제**

| # | 문제 | 커밋 |
|---|---|---|
| 1 | 스냅샷 뒤에 들어온 편집이 "저장됨" 표시 아래에서 저널도 없이 사라짐 | `d0099e1` |
| 2 | 미저장 변경이 남은 열기·저장 뒤에 자동 저장 타이머가 쉼 | `208c0e7` |
| 3 | 백업하지 않는 저장이 지난 백업 실패 표시를 지우지 않음 | `f631c46` |

1. **저장 중에 들어온 편집이 사라집니다(데이터 유실).** `writeSnapshot`은 `db.snapshot`으로 바이트를 받은 뒤 gzip 압축 → 기존 파일 읽기(백업) → `fs.write` 순으로 진행하는데, 이 셋은 모두 await이고 그동안 **Worker는 비어 있습니다.** `db.snapshot`만 배타 op라서 스냅샷이 끝난 순간부터 쓰기 op가 다시 통과하므로, 그 창에서 셀을 고치면 편집은 메모리 DB에 적용되고 저널에도 들어갑니다. 그런데 쓰기가 끝나면 `setSaved`가 **조건 없이** `state.dirty = false`와 `autosave.clear()`를 실행했습니다. 결과는 방금 쓴 파일에 없는 변경이 저널에서도 지워지고 화면은 "저장됨"이 되는 것입니다. `beforeunload` 경고도 dirty를 보므로 뜨지 않고, 탭이 죽으면 복구할 기록이 없습니다.

   창의 크기가 Step 9에서 커졌습니다. 압축 저장을 켜면 DB 전체의 gzip이 창 안에 들어오고, 백업 읽기는 기존 파일 전체(최대 200 MB)를 읽습니다. 더 중요한 것은 **자동 저장**입니다. 사용자가 Ctrl+S를 누르지 않아도 30초~5분마다 이 창이 열리므로, "저장을 누른 직후에 타이핑하지 않는다"는 습관으로 피할 수 없습니다.

   스냅샷 직후부터 `setSaved`까지를 저장 창으로 보고 그 사이의 변경을 모으게 했습니다. 창 안에 변경이 있었으면 dirty를 유지하고, 저널은 비운 뒤 **새 baseRevision(= 방금 쓴 파일의 revision) 위에 그 변경만 다시 넣습니다.** 저널에 남길 수 없는 변경(가져오기, 저널 상한 초과)이 들어왔으면 정지와 "지금 저장하세요" 배너도 되돌립니다. 창 밖에서는 종전과 똑같이 비웁니다.

2. **저널을 복구한 열기와 1번의 저장 뒤에 자동 저장이 쉽니다.** 타이머를 `'file:dirty'` → `markDirty()`, `'file:saved'`·`'file:opened'` → `markClean()`으로 묶었는데, 뒤의 두 이벤트는 "미저장 변경이 없다"는 뜻이 아닙니다. `openPicked`는 revision 판정과 저널 재생(재생은 `'file:dirty'`를 보냅니다)을 **마친 뒤에** `'file:opened'`를 보내므로, 복구한 변경이 그대로 남아 있는데도 타이머가 꺼졌습니다. 1번을 고친 뒤의 저장도 dirty인 채로 끝날 수 있어 같은 자리에 걸립니다. 두 경우 모두 다음 편집이 올 때까지 자동 저장이 한 번도 시도되지 않습니다(그 편집이 `markDirty()`로 타이머를 다시 잡습니다).

   두 이벤트에서 스토어의 dirty를 읽어 타이머를 그대로 맞추게 했습니다.

3. **상태바의 백업 실패 표시가 지워지지 않습니다.** `backupNote`를 `'none'`으로 되돌리는 곳이 `backupBefore`에서 IDB `put`이 성공한 직후 한 곳뿐이었습니다. 그래서 백업 단계를 건너뛰는 저장 — 다운로드 폴백(덮어쓸 원본이 없음), 첫 저장(기존 파일이 0바이트), IDB가 없는 환경 — 은 성공해도 표시를 그대로 두었고, 한 번 붙은 "저장 전 백업 생략"·"백업을 만들지 못했습니다"가 그 뒤 성공한 저장에도 상태바에 남았습니다. `DESIGN.md` 9장과 `docs/cloud-sync.md`가 적은 "다음 저장 성공이 지운다"와 다릅니다. 백업 단계에 들어갈 때 표시를 먼저 비우고 이번 저장의 결과만 남기도록, 다운로드 폴백도 같은 자리에서 비우도록 바꿨습니다.

**재현 테스트 (1·3번은 수정 전 빨강 확인)**

- `test/unit/app/store.test.js`: `저장 중에 들어온 편집은 dirty로 남고 저널에 새 baseRevision으로 다시 들어간다`(1번. `fs.write`를 붙잡아 둔 사이에 `command.apply` + `recordCommand`를 넣고, 저장 뒤 `dirty === true`와 저널 1건·`baseRevision === 2`를 확인. 수정 전에는 `dirty === false`, 저널 0건)
- `test/unit/app/store.test.js`: `저장 중에 저널이 멈추면 저장 뒤에도 dirty와 정지가 남는다`(1번의 가져오기 경로. 창 안에서 저널이 멈추면 저장이 정지를 풀지 않는지)
- `test/unit/app/store.test.js`: `backupNote: 백업하지 않는 저장(다운로드 폴백)도 지난 실패 표시를 지운다`(3번)
- 2번은 `main.js`의 이벤트 배선이라 단위 테스트가 닿지 않습니다(아래 미확인).

**점검했지만 고치지 않은 것 (판단 근거와 함께)**

- **`exportXlsx`가 SheetJS의 출력 버퍼를 한 번 더 복사합니다.** `XLSX.write(wb, { type: 'array' })`가 돌려주는 ArrayBuffer는 그 자리에서 만들어진 것이고 뒤에 쓰는 데가 없으므로 `new Uint8Array(written)`로 감싸 그대로 transfer해도 됩니다. 지금은 같은 크기의 버퍼를 새로 잡아 복사하므로 XLSX 경고선(10만 행) 근처에서 통합 문서 크기만큼의 메모리가 잠깐 두 배가 됩니다. 한 줄이지만 상수 배수의 메모리이고 측정 항목이 있는 곳이라 성능을 맡은 세션 H(Step 10)에서 내보내기 시간·메모리 측정과 함께 보는 것이 맞습니다(`CLAUDE.md` 9장).
- **내보내기 대화상자의 `columnCount()`가 열마다 `Set`을 새로 만듭니다.** `table.columns.filter((c) => … !new Set(viewSpec().hidden).has(c.id))`가 콜백 안에서 `viewSpec()`과 `new Set`을 부릅니다. 대화상자를 그릴 때와 뷰 적용 체크박스를 누를 때만 도는 코드라 열 수만큼의 작은 할당이고, 핫 경로가 아닙니다.
- **`export.stream`은 배타 op라 내보내는 동안 편집이 막힙니다.** 30만 행 CSV면 수 초 동안 쓰기 op가 `E_DB_BUSY`로 돌아옵니다. 가져오기와 같은 성질이고 세션 G가 설계로 정한 것(페이지 사이에서 이벤트 루프로 돌아오므로 쓰기가 끼어들면 앞뒤 페이지가 다른 상태를 봅니다)이라 그대로 둡니다. 읽기(`query.window`)는 막히지 않아 스크롤은 됩니다.
- **저장 창에서 파일을 열면 상태가 섞일 수 있습니다.** `openPicked`가 저장 중에 끝나면 `setOpened`가 세운 새 DB의 상태 위에 `setSaved`가 옛 DB의 파일 이름·메타를 덮어씁니다. 1번의 수정은 이 경로를 넓히지도 좁히지도 않습니다(dirty 한 칸이 더 걸릴 뿐입니다). 저장 중에 열기를 막는 것이 옳아 보이지만 `state.saving`을 읽는 UI 게이트를 새로 만드는 일이라 이번 점검의 범위를 넘습니다. 아래 미확인으로 남깁니다.
- **`restoreBackup`은 `db_id`가 비어 있으면 빈 키로 IDB를 읽습니다.** 결과가 없어 `backup.none`으로 끝나므로 동작은 맞습니다. 새 DB에는 항상 `db_id`가 있어 닿기 어려운 경로입니다.

**검증 결과**

- [x] `npm run check`: eslint 0건, prettier 통과, tsc 0오류, 단위 테스트 **335개 통과**(세션 G 332 + 신규 3).
- [x] `npm run build && npm run verify`: `verify OK`, 외부 참조 0건(허용 vendor URL 리터럴 160건), vendor 체크섬 6개 일치, 두 변형 CSP 외 동일.
- [x] `npm run test:e2e`: Chromium `file://`에서 **57개 통과**(세션 G와 같음. 이번 수정은 기존 E2E가 지나는 저장·열기 경로에 있습니다).
- [ ] `npm run test:perf`: **미확인.** 이번 수정은 렌더·창 질의 핫 경로에 닿지 않습니다(1·3번은 `setSaved`·`backupBefore`의 상태 처리, 2번은 이벤트 배선뿐입니다). 30만 행 픽스처 재생성 비용에 견주어 재측정하지 않았습니다.
- [x] 7.1 grep: `innerHTML` 0건, 모드 문자열 허용 위치 밖 0건. 새로 더한 SQL 없음.
- [x] 새 오류 코드 없음. 새 RPC op 없음. i18n 키 변화 없음.
- [x] `DESIGN.md` 갱신이 같은 커밋(`d0099e1`)에 포함: 3.4절 "저장(브라우저 모드)"에 스냅샷과 쓰기 사이의 변경을 어떻게 다루는지와 그 이유.

**산출물 크기 (`verify` 출력)**

- `dist/jdrdatabase.html` 3,740,050 bytes (3.57 MiB / 예산 6 MiB). 세션 G(3,739,528) 대비 **+522 bytes**(`setSaved`의 재기록 분기와 주석).
- `dist/tauri/index.html` 3,739,858 bytes (CSP 메타 줄만 다름을 `verify`가 확인).

**미확인 (세션 G에서 이어받아 그대로 남음 + 이번에 생긴 것)**

- 1번의 재현은 가짜 파일 시스템에서 `fs.write`를 붙잡아 만든 것입니다. **실제 브라우저에서 저장 중에 타이핑해 재현하지는 못했습니다**(헤드리스에서 파일 선택기를 자동화할 수 없어 저장이 다운로드 폴백으로 끝나고, 그 경로는 창이 짧습니다). 실제 FSA 핸들·큰 파일에서 창이 얼마나 긴지도 재지 않았습니다.
- 2번은 `main.js`의 이벤트 배선이라 단위 테스트가 없습니다. 자동 저장 타이머 자체는 `autosave.test.js`가 덮지만, "저널을 복구한 열기 뒤에 실제로 간격마다 저장된다"는 실제 타이머와 정본 핸들이 있어야 해 **미확인**입니다(세션 G의 같은 항목과 같은 자리).
- 저장 중에 파일 열기가 겹치는 경로(위 "고치지 않은 것")의 실제 결과.
- `exportXlsx`의 여분 복사를 없앴을 때의 메모리 차이(세션 H에서 측정과 함께).
- 세션 G의 미확인 목록(30만 행 내보내기 시간·메모리, FSA 경로의 내보내기·백업 복원·자동 저장, 한글 파일 이름의 `<a download>`, 내보내기 취소 버튼 클릭, Firefox·Safari의 `CompressionStream`, 외부 테이블 BLOB 내보내기, 내보내기·설정 대화상자 접근성)과 세션 F 점검·후속, 세션 E 점검·D 점검에서 이어진 항목은 그대로 남습니다.

### 세션 H (Step 10) — 2026-09-21

커밋: `444f1e2` docs(design) 착수 전 확정 → `78c0e06` fix(app) 오류 주입·Worker 종료 잠금·E_MEM → `955ed9d` fix(a11y) → `a227225` perf(export) XLSX 여분 복사 제거 → `77793ca` test(conventions) → `a576132` perf(db) NOCOPY 스냅샷 → `983e012` test(perf) 성능 자동화 → `f665505` test(e2e) http://localhost → `7679b38` ci(release) → `567c2b1` docs(readme) → `f0bed80` fix(test) → `f540c27` 이 기록 → CI 기준선 채우기와 그 과정의 수정 `15cfcbe`(기준선) → `e414ef0`(잡음 바닥) → `6386eac`(짧은 검색어 중앙값) → `cb18b84`(러너 속도 보정) → `b2db460`(보정 포함 기준선) → `af414a4`(픽스처 페이지 캐시) → 이 기록의 마지막 갱신.

시작 상태: 원격이 강제 갱신되어 있어 로컬 브랜치를 원격 `0fe52ab`로 맞춘 뒤 `npm run check`(335개)가 초록임을 확인하고 시작했습니다. 세션 G 점검의 미확인 항목은 아래 "미확인"에 이어받았습니다.

**설계 변경 (코드보다 먼저 DESIGN.md v0.10에 반영, 리뷰어 확인 필요)**

- **성능 판정을 둘로 나눕니다.** 로컬(`npm run test:perf`)은 8장의 절대 예산으로, CI의 `perf` 잡(`JDR_PERF_COMPARE=1`)은 같은 러너에서 잰 기준선 `test/perf/perf-baseline.json` 대비 30% 회귀를 실패로 봅니다(CLAUDE.md 6장의 기준선 경로를 `test/e2e`에서 `test/perf`로 옮김). 각 spec은 `report.js`의 `record()`로 측정값을 남기고 `global-teardown.js`가 요약과 비교를 합니다. 8장 표에 측정 방법(앱 시작 마크, 스냅샷 왕복, 렌더러 RSS)과 CSV 내보내기 항목(예산 없음)을 더했습니다.
- **Worker가 기동 뒤에 죽으면 앱을 잠급니다(7장 `E_ENV_NO_WORKER`).** client는 대기 중인 호출뿐 아니라 그 뒤의 모든 호출을 즉시 거부하고(`onFatal`), main.js는 저널 상태(복구 가능 / 정지로 잃음 / IDB 없음 / 변경 없음)를 정확히 알립니다. wasm 폴백은 없습니다.
- **`SQLITE_NOMEM`은 `E_MEM`입니다(7장).** 직렬화의 NOMEM은 메시지로 판별하고, 롤백 실패가 원래 코드를 가리지 않습니다.
- **저장 스냅샷은 `SQLITE_SERIALIZE_NOCOPY`(D-02).** deserialize로 연 DB는 wasm 힙의 파일 바이트를 JS로 한 번만 복사합니다. 측정 중 발견해 설계에 반영했습니다(아래).
- 3.1에 `test/unit/conventions.test.js`, `test/e2e/page-url.js`·`a11y.spec.js`·`fault.spec.js`, `test/perf/report.js`·`global-teardown.js`·`perf-baseline.json`·`process-memory.js`·`app.perf.spec.js`·`memory.perf.spec.js`, `scripts/serve-dist.mjs`, `.github/workflows/release.yml`.

**Step 10 완료 기준**

- [x] 8장 예산 전 항목 통과(`npm run test:perf`, 7개 spec 전부 초록. 이 환경: 4코어, Chromium 141 headless, 30만 행 × 20열 314 MB 픽스처):

  | 항목 | 예산 | 실측 |
  |---|---|---|
  | 앱 시작(빈 DB) | 1.5초 | 348 ms(3회 중앙값. 첫 실행 438 ms) |
  | 300 MB 파일 열기 | 5초 | 1,891 ms |
  | 스크롤 프레임 렌더 | 16 ms | p95 1.1 ms, 최대 2.7 ms(211 프레임) |
  | 창 질의(200행) | 50 ms | 최대 17.4 ms(51회) |
  | 셀 편집 반영 | 30 ms | 최대 1.6 ms(5회) |
  | 정렬 변경(인덱스 없음) | 1초 | 정수 91 ms, 텍스트 99 ms |
  | trigram 검색 | 200 ms | 59 ms(한글 30 ms). 인덱스 생성 39.5초(기록만) |
  | LIKE 폴백(Step 6 기준) | 1초 | 825 ms, 짧은 검색어(`멜`) 998 ms — **예산 경계** |
  | 300 MB 저장 | 5초 + 디스크 | `db.snapshot` 왕복 242 ms, 도구 모음 저장 → 다운로드 1,255 ms |
  | 150 MB CSV 가져오기 | 60초 | 209 MB 30만 행 18.0초(미리보기 135 ms). XLSX 5만 행 5.9초 |
  | 산출물 크기 | 6 MB | 3,744,207 bytes |
  | 최대 힙(300 MB DB 저장 시점) | 1.2 GB | 렌더러 RSS 최대 1,150,251,008 bytes(1.07 GiB. 대기 173 MB, 열린 뒤 841 MB) |
  | 30만 행 CSV 내보내기 | 없음 | 14.9초, 306 MB |

  **NOCOPY 전에는 저장 시점 RSS가 1,468,014,592 bytes(1.37 GiB)로 예산을 넘었고 스냅샷이 2,902 ms였습니다.** `sqlite3_js_db_export`가 wasm 안에 314 MB 사본을 만든 뒤 JS로 복사하고, wasm 메모리는 줄어들지 않아 그대로 최대값에 남았습니다. `a576132`가 memdb의 NOCOPY 포인터에서 바로 복사하도록 바꾼 뒤 1.15 GB·242 ms입니다(단위: 왕복·쓰기 뒤 스냅샷·반복 스냅샷 동일).
- [x] 메모리 프로파일(`memory.perf.spec.js`): 2만 행 DB 열기 → 5천 행 CSV 가져오기 → 저장 → 새로 만들기 6사이클. GC 뒤 메인 JS 힙 7.6 → 7.8 MB(사이클 2→6 +0.2 MB, 상한 10 MB), 렌더러 RSS 299 → 295 MB(−3.5 MB, 상한 15%). 다운로드 Blob URL이 10초 뒤에 해제되므로 그 뒤에 잽니다(그 전에 재면 +65 MB로 누수처럼 보였음).
- [x] 오류 주입 4종(각 재현 테스트):
  - Worker 강제 종료: E2E `fault.spec.js`(Worker 인스턴스에 `ErrorEvent` + `terminate()` → 잠금 화면·저널 안내 → 저장 클릭이 5초 안에 `E_ENV_NO_WORKER`로 끝남 → 새로 고침 → 저널 복구 → 테이블 복원. 변경 없는 경우의 문구도) + `rpc.test.js`(죽은 뒤 호출 즉시 거부, `onFatal` 1회, 늦은 구독 즉시 알림). **고친 것**: 죽은 Worker에 보낸 새 요청이 영원히 매달리던 문제.
  - IDB 열기 실패: E2E(`indexedDB` getter가 던짐 → 상태바 안내 → 새 테이블·다운로드 저장, 페이지 오류 0).
  - 파일 쓰기 중 예외: E2E(가짜 FSA 핸들의 `write()`가 던짐 → `E_FILE_WRITE` 토스트에 "기존 파일은 그대로", dirty·저널 유지 → 다음 저장이 성공하고 revision 2) + `store.test.js`(`E_FILE_WRITE`·`E_MEM` 주입).
  - wasm 메모리 한계: `engine-wasm.test.js`가 10 MB 블롭으로 약 2.09 GB까지 채워 실측(약 6초). **고친 것**: 삽입 실패가 `E_DB_QUERY "rollback failed after error"`로, 직렬화 실패(`SQLITE_NOMEM`, 결과 코드 1)가 일반 질의 오류로 가려지던 문제. 지금은 둘 다 `E_MEM`이고 롤백 뒤 DB는 계속 쓸 수 있습니다.
- [x] Playwright axe 검사 critical 0건(serious도 0건): `a11y.spec.js`가 빈 앱, 테이블 만들기·열 추가·정렬·필터·내보내기·설정·가져오기(미리보기·결과) 대화상자, 그리드, 장문·인라인 편집기에서 WCAG 2.1 A·AA 규칙으로 검사. 실행 출력에 moderate·minor 항목도 찍히지 않았습니다. **고친 것**(처음 실측: critical 3종, serious 2종, moderate 1, minor 2): 인라인 편집기가 `role="grid"` 안에 있어 필수 자식 규칙을 깨뜨림(오버레이로 이동, 편집기 위 휠은 스크롤러로 전달), 가져오기 열 매핑의 입력·선택과 인라인 편집 입력에 이름 없음, 사이드바 listbox/option 안의 버튼(nested-interactive), dirty 표시의 잘못된 `aria-label`(깨끗할 때도 읽힘), 도구 모음 `<header role="toolbar">`가 랜드마크를 잃음, 사이드바 머리글의 `hidden`이 `display: flex`에 덮임(열 없는 상태에서 "…의 열" 머리글이 보이던 실제 버그). 그리드 ARIA(`aria-rowcount` 21·`aria-colcount` 5·활성 셀 `aria-selected`·`aria-rowindex/colindex`), 키보드 포커스 외곽선(2 px), 대화상자 포커스 트랩(Tab 순환·Shift+Tab·Esc 뒤 여는 요소로 복귀)은 같은 spec이 직접 확인.
- [x] `dist/jdrdatabase.html` 6 MB 이하: 3,744,207 bytes.
- 보안 점검: `conventions.test.js`가 `innerHTML`·`insertAdjacentHTML`·`document.write` 0건, 모드 문자열 허용 위치, Worker 쪽 SQL 템플릿 리터럴의 값 삽입 없음, 오류 코드 ↔ i18n, 6장 표 ↔ OpMap(문서에만 있는 op는 `db.save`뿐)을 고정. CSP는 `verify`, CSV 수식 주입 옵션은 세션 G의 단위·E2E 그대로.
- 지원 매트릭스: Chromium 141 `http://localhost`에서 E2E 65개 전부 통과(`JDR_E2E_HTTP=1`). Firefox·WebKit은 아래 미확인.
- 세션 G 점검이 남긴 `exportXlsx` 여분 복사 제거(`a227225`).

**검증 결과**

- [x] `npm run check`: eslint 0건, prettier 통과, tsc 0오류, 단위 테스트 **344개 통과**(세션 G 점검 335 + `conventions.test.js` 5 + `engine-wasm.test.js` 2 + `store.test.js` 2). `rpc.test.js`의 Worker 사망 테스트는 확장.
- [x] `npm run build && npm run verify`: `verify OK`, 외부 참조 0건(허용 vendor URL 리터럴 160건), vendor 체크섬 6개 일치, 두 변형 CSP 외 동일.
- [x] `npm run test:e2e`: Chromium `file://`에서 **65개 통과**(57 + `fault.spec.js` 4 + `a11y.spec.js` 4). `JDR_E2E_HTTP=1`로도 65개 통과.
- [x] `npm run test:perf`: 7개 spec 통과(위 표). 로컬 요약은 `test-results/perf/summary.json`.
- [x] 7.1 grep은 `conventions.test.js`가 대신합니다(0건). 새 오류 코드·RPC op 없음. i18n 키 6개 추가(`lock.engineStopped*`), ko/en 동일.
- [x] `DESIGN.md` v0.10 갱신이 `444f1e2`(착수 전)와 `a576132`(NOCOPY)에 포함. `CLAUDE.md` 6장 기준선 경로 갱신.

**산출물 크기 (`verify` 출력)**

- `dist/jdrdatabase.html` 3,744,207 bytes (3.57 MiB / 예산 6 MiB). 세션 G 점검(3,740,050) 대비 **+4,157 bytes**(잠금 문구 6개, client 죽음 처리, NOCOPY 내보내기, 그리드 오버레이, 접근성 속성).
- `dist/tauri/index.html` 3,744,015 bytes.

**점검했지만 고치지 않은 것 (판단 근거와 함께)**

- **LIKE 짧은 검색어가 998 ms로 예산(1초) 경계입니다.** 두 글자 `멜`은 trigram이 안 되어 LIKE 폴백이 30만 행 × 텍스트·장문 열을 훑습니다. 세션 E가 정한 대로 인덱스를 켜면 200 ms 아래이고(같은 spec), 8장 표의 항목은 trigram이라 예산 위반은 아닙니다. CI 기준선에서는 30% 여유가 있습니다.
- **열린 뒤 RSS 841 MB는 파일 버퍼 사본 때문입니다.** 메인이 읽은 314 MB를 transfer로 Worker에 넘기고 deserialize가 wasm 힙에 다시 복사하므로, GC 전까지 사본이 둘입니다. `File`을 Worker로 넘겨 조각으로 wasm에 직접 넣으면 300 MB를 더 줄일 수 있지만 `db.open`의 인자 형식이 바뀌어(6장) 이번 세션에 넣지 않았습니다. 예산 안이라 R2에 메모만 남깁니다.
- **Worker의 JS 힙은 재지 않습니다.** 전용 Worker에는 Playwright CDP 세션을 붙일 수 없어 RSS(프로세스 전체)로만 봅니다. sql.js 쪽 statement 캐시 누수는 RSS가 평평한 것으로 간접 확인했습니다.
- **가져오기 대화상자의 ARIA 이름에 열 머리글(사용자 데이터)을 씁니다.** 속성 값이지 마크업이 아니므로 5.5의 `textContent` 규칙과 어긋나지 않습니다.
- **CI perf 잡은 기준선이 빌 때 회귀를 판정하지 않습니다.** 첫 실행(run 35613225320)은 24개 항목을 건너뛰고 통과했고, 그 summary를 기준선으로 넣은 뒤부터 비교합니다(아래 미확인).

**미확인 (후속 세션에서 이어받음)**

- ~~`test/perf/perf-baseline.json`이 비어 있습니다.~~ 푸시 `f540c27`의 CI `perf` 잡(run 35613225320, ubuntu-latest)이 7개 spec을 통과했고 그 summary를 기준선에 옮겨 적었습니다(후속 커밋). 러너 실측: 앱 시작 327 ms, 300 MB 열기 909 ms, 렌더 p95 1.3 ms, 창 질의 최대 34.1 ms, 셀 편집 1.3 ms, 스냅샷 135 ms, 저장 시점 RSS 877 MB, CSV 가져오기 18.0초, XLSX 5.9초, CSV 내보내기 20.1초, LIKE 731 ms(짧은 검색어 716 ms), trigram 51 ms, 정렬 74~79 ms, 메모리 사이클 끝 RSS 300 MB — 8장 절대 예산도 전부 안입니다. 기준선을 채운 커밋 `15cfcbe`의 CI(run 35613909207)는 24개 항목을 비교했고 `app-300k.editMaxMs: 1.9 > 1.3 × 1.3`으로 실패했습니다. 1~2 ms 측정의 0.6 ms 차이는 타이머 해상도 수준이라 회귀가 아니므로, 비율에 잡음 바닥(ms 5, bytes 16 MiB)을 더해 둘 다 넘어야 회귀로 보게 고쳤습니다(후속 커밋, DESIGN.md 8장). 그 커밋의 CI 결과는 아래 미확인.
- 잡음 바닥을 더한 커밋 `e414ef0`의 CI(run 35614563258)는 `search.likeShortMs: 967.9 > 716.3 × 1.3 + 5`로 실패했습니다. 같은 코드로 713·716·968 ms가 나오는 항목이라(로컬도 959~998) 한 번 재는 값으로는 30% 규칙이 흔들립니다. 서로 다른 무일치 두 글자 검색어 3개의 중앙값으로 재도록 바꾸고(행 수 캐시가 같은 검색어를 다시 재지 않으므로), 그 항목의 기준선은 비운 뒤 다음 CI 실행 값으로 채웁니다(후속 커밋). 그 커밋 `6386eac`의 CI(run 35615323286)는 23개 항목 비교로 "회귀 없음"이었지만, 이번엔 빠른 기계에 배정되어 LIKE 532 ms·정렬 45 ms·인덱스 21.8초로 첫 실행(731·74·34.8초)보다 1.4배 빨랐습니다. 기계 차이가 30%를 넘으므로 단일 실행 기준선은 어느 쪽에서 재도 흔들립니다. 실행 시작 때 같은 wasm 엔진으로 고정 작업(`calibrate.js`)을 재어 그 비로 기대값을 보정하도록 하고(DESIGN.md 8장), 기준선은 보정값과 측정값을 같은 실행에서 통째로 다시 채웁니다(후속 커밋). 보정 커밋의 CI(run 35616156607, 보정값 559 ms)는 7개 spec 통과·24개 건너뜀이었고, 그 summary(보정값 포함)를 기준선으로 옮겨 적었습니다(후속 커밋). 기준선 커밋 `b2db460`의 CI(run 35616775733)는 느린 기계(보정 비 1.33)에 배정됐고 23개 항목은 보정된 기준 안이었지만 `grid.openMs: 1927 > 893 × 1.33 × 1.3 + 5`로 실패했습니다. 앞 네 실행이 892~909 ms였던 값이 두 배가 된 것은 CPU가 아니라 디스크입니다(actions/cache에서 막 복원한 314 MB 픽스처의 첫 읽기가 콜드). 8장의 열기·가져오기 시간은 앱 처리 시간이므로, perf spec이 픽스처를 먼저 한 번 읽어 페이지 캐시에 올린 뒤 재도록 했습니다(`fixture.js`의 `warmCache`, 후속 커밋). 그 커밋 `af414a4`의 CI(run 35617483274)는 느린 기계(보정 비 1.38, 보정값 774 ms)에 배정됐는데도 24개 항목 전부 보정된 기준 안으로 "회귀 없음"이었습니다. 이로써 CI perf 잡은 빠른 기계(run 35616156607)와 느린 기계(run 35617483274) 양쪽에서 초록입니다. 다만 기준선 실행 하나와 확인 실행 하나뿐이므로, 다음 세션들의 푸시에서 실제 코드 변경 없이 빨강이 나오면 그 항목의 잡음 원인(디스크·기계 종류)을 적고 측정 방식을 고치는 것이지 기준선을 올리는 것이 아닙니다.
- 실제 브라우저에서의 Worker 사망(탭 OOM은 렌더러 전체를 죽이므로 `error` 이벤트 경로와 다를 수 있음), 실제 FSA 핸들의 쓰기 실패(디스크 부족·권한 회수), 두 경우의 문구.
- Firefox·Safari(WebKit): Playwright 브라우저 다운로드가 이 환경의 송신 정책(403)에 막혀 설치하지 못했습니다. `docs/support-matrix.md`에 손으로 확인하는 절차를 적었습니다. `https://` 원점도 미확인.
- 스크린 리더(NVDA·VoiceOver)의 실제 읽기(axe는 정적 검사), 실제 한글 IME, 한글 파일 이름의 `<a download>`, 저장 중 파일 열기(세션 G 점검), SheetJS 0.20.3 갱신(CVE 2건), 실제 파일 선택기·자동 저장 타이머·백업 복원의 FSA 경로 등 세션 G 점검·F 점검·E 점검·D 점검에서 이어진 항목은 그대로 남습니다.
- 30만 행 내보내기의 메모리(시간은 14.9초로 쟀지만 RSS 최대값은 저장 시점만 쟀음), XLSX 내보내기 30만 행(행 상한 경고 문구 포함).

### 세션 H 점검 (세션 H 산출물 코드 점검) — 2026-09-21

시작 상태: 로컬 클론이 얕은(depth 50) 상태라 원격과 갈라진 것처럼 보였습니다(공통 조상 없음). `git fetch --unshallow` 뒤 원격 `d8f8e13`으로 fast-forward(96 커밋)했고, 그 상태에서 `npm run check`(346개)·`build`·`verify`·`test:e2e`(65개)가 모두 초록임을 확인하고 시작했습니다. 세션 H의 미확인 항목은 아래 "미확인"에 이어받았습니다.

세션 H가 초록인 상태에서 드러나지 않은 문제 7건을 고쳤습니다(1~4번은 재현 테스트와 함께, 5~7번은 CI가 드러냈습니다). 새 기능은 없고 세션 I(Step 11)를 앞당겨 구현하지 않았습니다.

커밋: `add6303` → `968103d` → `4ca05fb` → `3d082c4` → (기록) → `5ff91c2` → (기록) → `9b3115d` → `5a17849` (문제 하나당 커밋 하나).

6·7번은 판정 방식의 변경이라 작성자에게 방향을 물어 확인받고 진행했습니다(지연 항목은 절대 예산으로만, 중복 실행 제거).

**고친 문제**

| # | 문제 | 커밋 |
|---|---|---|
| 1 | 트랜잭션이 열린 채로 `snapshot()`이 파일을 내보냄 | `add6303` |
| 2 | 편집기 위의 휠이 `deltaMode`를 무시(줄 단위가 3 px) | `968103d` |
| 3 | 성능 기준선 비교가 CPU 속도 보정을 메모리 항목에도 적용 | `4ca05fb` |
| 4 | 정적 서버의 루트 검사가 형제 디렉터리를 통과시킴 | `3d082c4` |
| 5 | 프레임 렌더 최대값이 회귀 비교에 들어가 같은 코드에서 빨강 | `5ff91c2` |
| 6 | 브라우저 쪽 지연 항목 전반이 같은 코드에서 흔들려 판정이 성립하지 않음 | `9b3115d` |
| 7 | 같은 커밋에 워크플로가 두 번 돌아 CI 시간·빨강 확률이 두 배 | `5a17849` |

1. **트랜잭션이 열린 채로 `snapshot()`이 파일을 내보냄.** `snapshot()`의 "트랜잭션 안에서는 거부"는 엔진이 스스로 세는 `txDepth`만 봤습니다. 이 장부는 sqlite의 실제 상태와 어긋날 수 있습니다. `transaction()`의 본문이 실패하고 이어지는 ROLLBACK까지 실패하면 `finally`가 `txDepth`를 0으로 되돌리지만 sqlite에는 트랜잭션이 남습니다. 세션 H가 롤백 실패를 원래 오류의 `detail`로 내리면서(`a576132`의 앞 커밋 `78c0e06`) 이 상태는 오류 코드로도 구분되지 않게 됐습니다. 그 상태에서 저장을 누르면 커밋되지 않은 페이지가 섞인 이미지가 사용자의 원본 파일을 덮어씁니다(7.2의 1순위). `sqlite3_get_autocommit()`으로 sqlite에게 직접 물어 거부합니다.
2. **편집기 위의 휠이 `deltaMode`를 무시.** 세션 H가 접근성(`aria-required-children`) 때문에 인라인 편집기를 캔버스에서 스크롤러 밖 오버레이로 옮기면서, 편집기 위의 휠을 앱이 직접 스크롤러에 넘기게 됐습니다(`onOverlayWheel`). `deltaY`를 픽셀로 가정했지만 단위는 `deltaMode`가 정합니다. 크로미움의 트랙패드·휠은 픽셀(0)이라 로컬·CI에서 드러나지 않고, 파이어폭스의 마우스 휠은 줄 단위(1)로 `deltaY` 3을 보냅니다. 편집 중 휠 한 칸이 행 세 개(96 px)가 아니라 3 px 움직입니다. 줄은 행 높이로, 쪽(2)은 보이는 높이·너비로 바꿉니다.
3. **성능 기준선 비교가 CPU 속도 보정을 메모리 항목에도 적용.** `calibrate.js`의 보정값은 고정된 CPU 작업 시간이므로 메모리에는 뜻이 없는데, `compareWithBaseline`이 그 비를 `…Bytes` 항목에도 곱했습니다. 커밋된 기준선으로 확인하면 양쪽으로 틀립니다. 빠른 기계(비 0.70)에서는 코드가 그대로여서 측정값이 기준선과 똑같은 `memory.rssLastBytes` 318,459,904가 "43% 회귀"로 빨강이 되고(318,459,904 × 0.70 × 1.3 + 16 MiB = 306,575,728), 느린 기계(비 1.38. 세션 H의 run 35617483274가 실제로 배정받은 값)에서는 저장 시점 최대 RSS 1.40 GB가 8장 예산 1.2 GB를 넘겨도 "회귀 없음"으로 통과합니다. 세션 H가 남긴 "코드 변경 없이 빨강이 나오면 측정 방식을 고치는 것"에 해당합니다. 바이트 항목은 보정 없이 견줍니다.
4. **정적 서버의 루트 검사가 형제 디렉터리를 통과시킴.** `serve-dist.mjs`의 `file.startsWith(ROOT)`는 접두사 비교라 `<ROOT>-backup` 같은 형제 디렉터리를 루트 안으로 봅니다. `..`는 `path.normalize`가 이미 접어 없애므로 실제 탈출 경로는 그 이름뿐이고 서버는 127.0.0.1에만 묶인 테스트 도구지만, 경계에 구분자를 붙여 맞게 둡니다.
5. **프레임 렌더 최대값이 회귀 비교에 들어가 같은 코드에서 빨강.** 위 3번을 푸시한 `b856d4b`의 CI는 초록이었지만, 그 뒤 기록만 11줄 고친 문서 커밋 `7bfab44`의 CI `perf` 잡이 `grid.renderMaxMs: 10.6 > 2.5 × 1.51 × 1.3 + 5 (180% 회귀)`로 실패했습니다. 코드가 전혀 바뀌지 않았으므로 회귀가 아니라 측정 방식의 문제입니다. `renderMaxMs`는 프레임 200여 개의 **최대값**, 곧 표본 하나짜리 바깥값이라 GC·스케줄러가 한 번만 끼어들어도 몇 배가 되고 기계 속도로 보정되지도 않습니다. 같은 코드에서 2.5 → 4.8 → 10.6 ms로 움직이는 동안 같은 실행의 p95는 0.9 → 1.3 ms였습니다. 8장의 "스크롤 프레임 렌더 16 ms 이하"를 실제로 판정하는 값도 p95입니다(spec의 `budget(p95, …)`. 최대값에는 budget 단언이 애초에 없습니다). 세션 H가 `record()`의 `metrics`에 최대값을 함께 넣으면서, 판정에 쓰지 않는 값에 30% 규칙만 걸린 상태였습니다. 최대값을 `info`로 옮겨 요약·로그에는 남기되 비교에서는 뺐습니다. **기준선은 올리지 않았고** `grid.renderMaxMs` 항목만 지워 비교 항목이 24개에서 23개가 됩니다.
6. **브라우저 쪽 지연 항목 전반이 같은 코드에서 흔들려 판정이 성립하지 않음.** 5번을 푸시한 뒤 기록만 고친 문서 커밋 `4c7ecd1`에서 이번엔 `app.readyMs: 490 > 279.5 × 1.29 × 1.3 + 5 (36% 회귀)`로 빨강이 났고, **같은 커밋의 재실행은 초록**이었습니다. 항목 하나씩의 문제가 아니었습니다. 앱 코드가 같은 실행들의 기준선 대비 배수를 보면, 실패한 실행에서 브라우저 쪽 짧은 지연만 튀고 CPU 처리량 항목은 그대로입니다.

   | 항목 | 기준선 `cb18b84` | `b856d4b` | `21506d6` | `4c7ecd1` ✗ |
   |---|---|---|---|---|
   | 보정 비(`calibrate.js`) | 1.00x | 1.33x | 0.95x | **1.29x** |
   | `editMaxMs` | 1.00x | 1.00x | 1.23x | **3.92x** |
   | `renderP95Ms` | 1.00x | 1.44x | 1.56x | **2.56x** |
   | `readyMs` | 1.00x | 1.13x | 1.08x | **1.75x** |
   | `snapshotMs` | 1.00x | 0.63x | 0.99x | **1.59x** |
   | `queryMaxMs` | 1.00x | 1.09x | 1.04x | **1.47x** |
   | `likeMs` | 1.00x | 1.07x | 1.02x | 1.22x |
   | `importMs` | 1.00x | 1.36x | 1.07x | 1.22x |

   `calibrate.js`는 Node의 wasm 엔진에서 10만 행 삽입 + LIKE 5회, 곧 **지속적인 단일 스레드 CPU 처리량**을 잽니다. 처리량 항목은 이 작업과 성질이 같아 보정이 맞지만, 짧은 지연은 I/O·GC·프로세스 경합에 훨씬 크게 흔들려 같은 비로 보정되지 않습니다. `readyMs`만 터진 것은 그것만 나빠져서가 아니라 잡음 바닥(5 ms)이 흡수하지 못할 만큼 크기가 큰 유일한 지연 항목이기 때문입니다(`editMaxMs`는 3.92배인데도 1.3 × 1.29 × 1.3 + 5 = 7.2 ms 안이라 통과).

   판정 대상을 `report.js`의 `GATED_METRICS`로 명시했습니다. 바이트 항목과 수 초 이상 이어지는 wasm CPU 작업(가져오기, 인덱스 만들기, CSV 내보내기, LIKE)만 비교하고, 브라우저 쪽 1초 미만 지연(앱 시작, 프레임, 셀 편집 왕복, 창 질의, 스냅샷, 파일 열기)은 8장의 절대 예산으로만 봅니다. 수치는 요약과 `[perf] 기록만` 줄에 그대로 남습니다. **기준선은 올리지 않았고** 판정하지 않는 13개 항목을 파일에서 지워 10개가 남습니다. 관측된 네 실행(보정 비 0.95·1.29·1.33·1.51)을 이 규칙으로 다시 돌리면 전부 회귀 없음이고, 가져오기 50%·메모리 40% 회귀는 그대로 잡힙니다(단위 테스트).
7. **같은 커밋에 워크플로가 두 번 돎.** `on: push: branches: ['**']`와 `pull_request`가 함께 걸려 있어 PR이 열린 작업 브랜치에 푸시할 때마다 같은 SHA에 워크플로가 두 번 돌았습니다(`check-build-e2e` 2개 + `perf` 2개). CI 시간이 두 배이고 perf가 독립 시행 두 번이라 잡음으로 빨강이 날 확률도 두 배입니다. 실제로 `4c7ecd1`에서는 한쪽 perf만 빨강이었습니다. v1 구현은 PR이 열린 작업 브랜치 하나에서 진행하므로 `pull_request` 하나로 덮이고, `push`는 기본 브랜치에만 겁니다.

**재현 테스트**

수정 전 빨강을 확인한 것:
- `engine-wasm.test.js`: `snapshot: 장부와 어긋나게 트랜잭션이 열려 있으면 파일을 내보내지 않는다` — 같은 어긋남을 진단용 `exec('BEGIN')`으로 만듭니다(BEGIN은 `sqlite3_stmt_readonly`가 참이라 "트랜잭션 밖 쓰기" 검사를 통과하므로 장부를 올리지 않고 트랜잭션만 엽니다). 수정 전에는 16,384 바이트짜리 이미지가 그대로 나왔습니다.
- `e2e/edit.spec.js`: `편집기는 세로 스크롤에도 칸을 따라가고, 편집기 위의 휠은 줄 단위여도 스크롤러에 전해진다` — `deltaMode=1, deltaY=3` 휠에서 수정 전 3 px을 확인했습니다.
- `unit/perf/report.test.js`: `compareWithBaseline: 러너 속도 보정은 시간 항목에만 적용한다` — 위 두 경우를 커밋된 기준선 값으로 고정합니다.

새로 덮은 것(수정 전에도 초록이지만 빈자리였던 것):
- 위 E2E의 세로 스크롤 추적. 세션 H가 편집기를 오버레이로 옮긴 뒤로 세로 위치도 `cellRect`가 계산하는데(전에는 캔버스 안이라 저절로 따라갔습니다) 기존 테스트(`편집기는 고정 열에서도 셀을 따라간다`)는 가로 스크롤만 덮고 있었습니다. 계산 자체는 맞아 처음부터 초록이었습니다.

**검증 결과**

- [x] `npm run check`: eslint 0건, prettier 통과, tsc 0오류, 단위 테스트 **349개 통과**(세션 H 346 + `engine-wasm.test.js` 1 + `report.test.js` 2).
- [x] `npm run build && npm run verify`: `verify OK`, 외부 참조 0건(허용 vendor URL 리터럴 160건), vendor 체크섬 6개 일치, 두 변형 CSP 외 동일.
- [x] `npm run test:e2e`: Chromium `file://`에서 **66개 통과**(65 + 위 1개).
- [x] `npm run test:perf`: **로컬은 돌리지 않았고 CI가 대신 확인했습니다**(5번은 그 CI가 드러낸 문제입니다). 1번은 `snapshot()` 진입의 `sqlite3_get_autocommit` 한 번, 2번은 휠 핸들러(렌더 경로 아님), 3번은 판정 코드 자체이고 측정에 닿지 않아, 30만 행 314 MB 픽스처 재생성 비용에 견주어 로컬 재측정은 하지 않았습니다. 푸시 `b856d4b`의 CI `perf` 잡(run 35620645508)이 7개 spec을 통과하고 24개 항목을 비교해 "회귀 없음"이었습니다(아래 미확인 절의 표). 8장 절대 예산도 그 실행의 `[perf:budget]` 줄에서 전부 안입니다.
- [x] 7.1 grep은 `conventions.test.js`가 대신합니다(0건). 새 오류 코드·RPC op 없음. i18n 변화 없음.
- [x] `DESIGN.md` 8장에 "보정은 시간 항목에만" 규칙을 적었습니다(`4ca05fb`에 포함). 다른 D-항목 변경 없음.

**산출물 크기 (`verify` 출력)**

- `dist/jdrdatabase.html` 3,744,475 bytes (3.57 MiB / 예산 6 MiB). 세션 H(3,744,207) 대비 **+268 bytes**(snapshot 가드와 휠 단위 변환).
- `dist/tauri/index.html` 3,744,283 bytes.

**점검했지만 고치지 않은 것 (판단 근거와 함께)**

- **롤백이 실패한 뒤 엔진이 계속 쓰이는 것 자체는 그대로입니다.** 1번은 그 상태에서 파일을 덮어쓰는 것만 막습니다. `txDepth`를 sqlite의 실제 상태와 맞추거나 엔진을 잠그는 것이 더 낫지만, 롤백 실패를 결정적으로 주입할 방법이 없어 재현 테스트를 붙일 수 없습니다(세션 H의 wasm 메모리 한계 테스트에서도 롤백은 성공했습니다). 저장이 막히면 사용자는 다른 경로(내보내기)로 데이터를 꺼낼 수 있고 오류 문구는 원본이 그대로임을 말합니다.
- **오버레이는 가로 스크롤 막대 자리까지 덮습니다.** `bottom: 0`이 스크롤러의 `offsetHeight` 기준이라, 마지막으로 보이는 행을 편집하면 편집기가 막대 위에 걸칠 수 있습니다. `pointer-events: none`이라 막대 조작은 막히지 않고, 세션 H가 잰 접근성·E2E에도 걸리지 않습니다.
- **`exportNoCopy`의 포인터·크기 처리는 상류 `memdb.c`와 맞습니다.** memdb가 아닌 DB에서는 `pOut`이 0이고 `nOut`은 양수로 오므로(비NOCOPY 경로의 크기 계산) 두 조건을 모두 보는 지금 코드가 맞습니다. `heap8u()`를 `scopedAlloc` 뒤에 읽는 순서(메모리 증가 시 버퍼 분리)도 맞습니다.
- **`toQueryError`의 `/SQLITE_NOMEM/` 문자열 판별.** sqlite 오류 메시지에만 닿고 사용자 데이터가 섞일 경로(물리 식별자는 앱이 만드는 `t_`·`c_`)가 없어 오판 가능성이 낮습니다.
- **`src/i18n/en.js`는 `t()`가 쓰지 않습니다.** 테스트만 import하므로 번들에는 들어가지 않습니다(크기 영향 없음). v1이 한국어 전용이라는 결정 그대로입니다.

**미확인 (세션 H에서 이어받아 그대로 남음 + 이번에 생긴 것)**

- `npm run test:perf`를 **이 환경(로컬)에서는** 돌리지 않았습니다. CI 러너에서는 아래와 같이 돌았으므로, 남은 것은 8장 표의 측정 환경(4코어 노트북)에서의 절대 예산 재확인뿐입니다.
- ~~3번의 고친 판정 규칙이 실제 CI `perf` 잡에서 어떻게 나오는지는 다음 푸시의 실행으로 확인합니다.~~ 푸시 `b856d4b`의 CI `perf` 잡(run 35620645508)이 7개 spec 통과, **24개 항목 비교·건너뜀 0개·회귀 없음**이었습니다. 마침 느린 기계(보정 비 1.33, 보정값 742 / 기준선 559 ms)에 배정되어 이번 수정이 노리던 경우를 그대로 밟았습니다. 바이트 세 항목은 보정 없이 견주고도 모두 통과합니다.

  | 항목 | 이번 측정 | 수정 후 한계 | 수정 전 한계(비 1.33) |
  |---|---|---|---|
  | `app-300k.peakRssBytes` | 867,135,488 | 1,129,969,254 (여유 23%) | 1,497,322,627 |
  | `memory.rssLastBytes` | 337,326,080 | 430,775,091 (여유 22%) | 567,394,390 |
  | `memory.heapLastBytes` | 7,781,452 | 26,913,425 (여유 71%) | 30,258,374 |

  수정 전 한계는 8장의 절대 예산(저장 시점 최대 힙 1.2 GB)보다 높습니다(1.39 GB). 즉 느린 기계에 배정되면 예산을 깨는 메모리 회귀가 CI를 그대로 통과했을 값이고, 수정 뒤에는 한계가 예산 아래(1.05 GB)로 들어옵니다. 기준선 파일 자체는 건드리지 않았습니다.
- ~~6·7번을 푸시한 뒤의 CI `perf`·`check-build-e2e` 결과는 **미확인**입니다.~~ 푸시 `0d08fa1`의 CI(run 35663238616)에서 둘 다 초록입니다.
  - 7번: 같은 SHA의 체크가 **4개에서 2개로** 줄었습니다(`check-build-e2e` 1 + `perf` 1).
  - 6번: perf 잡이 7개 spec 통과, `러너 속도 비 1.43(보정 801 / 559 ms), 10개 항목, 건너뜀 0개` → `회귀 없음`, 그리고 `[perf] 기록만(기준선 비교 안 함) 13개`가 찍혔습니다. **보정 비 1.43은 지금까지 배정받은 러너 중 가장 느린 축**입니다(빨강이 났던 실행이 1.29·1.51). 판정 대상이 모두 그 안이고, 판정하지 않는 13개의 수치는 요약과 `[perf:budget]` 줄에 그대로 남습니다.

  이로써 이번 세션의 perf 수정은 보정 비 0.95·1.29·1.33·1.43 네 종류의 기계에서 초록입니다.
- ~~5번을 푸시한 뒤의 CI `perf` 결과는 **미확인**입니다.~~ 푸시 `21506d6`의 CI `perf` 잡(run 35622434102)이 7개 spec 통과, **23개 항목 비교·건너뜀 0개·회귀 없음**이었습니다. 이번에는 기준선과 비슷한 속도의 기계(보정 비 0.95, 보정값 533 / 559 ms)에 배정됐습니다. `renderP95Ms`는 1.4(기준선 0.9, 한계 6.1)로 통과했고, 같은 실행의 `renderMaxMs`는 참고값으로만 남습니다.

  이로써 이번 세션의 두 수정은 보정 비 0.95·1.33·1.51 세 종류의 기계에서 확인됐습니다. 바이트 세 항목은 어느 기계에서도 보정 없이 기준선과 바로 견주어 통과합니다(이번 실행: `peakRssBytes` 850,980,864 / `rssLastBytes` 314,535,936 / `heapLastBytes` 7,807,084 — 셋 다 기준선과 같은 수준).

  지금까지 관찰된 "코드 변경 없는 빨강"의 원인은 기계 속도(3번)와 표본 하나짜리 바깥값(5번) 두 가지뿐이고, 남은 시간 항목들은 세 실행 모두 보정된 기준 안이었습니다. 다음 세션들의 푸시에서 또 코드 변경 없이 빨강이 나오면 같은 식으로 그 항목의 잡음 원인을 적고 측정 방식을 고치는 것이지 기준선을 올리는 것이 아닙니다.
- 2번의 파이어폭스 실측은 여전히 불가합니다(Playwright 브라우저 다운로드 403). 크로미움에서 합성 `WheelEvent`로만 확인했습니다.
- 세션 H의 미확인 목록(실제 브라우저에서의 Worker 사망·FSA 쓰기 실패, Firefox·Safari와 `https://` 원점, 스크린 리더·실제 한글 IME, 30만 행 내보내기 메모리·XLSX 30만 행, SheetJS 0.20.3 갱신(CVE 2건), 저장 중 파일 열기 등 세션 G 점검·F 점검·E 점검·D 점검에서 이어진 항목)은 그대로 남습니다.

### 세션 I (Step 11) — 2026-09-21

커밋: `145c738` docs(design) 착수 전 확정 → `6b1f19a` feat(native) 러스트 코어 → `a68ee57` feat(native) JS 엔진·브리지·db.save·test:native → `e962954` feat(app) 데스크톱 열기·저장·복구·백업·내보내기 → feat(desktop) 타우리 앱 크레이트·엔진 프로토콜·데스크톱 E2E·CI·문서(이 기록 포함).

시작 상태: 원격이 강제 갱신되어 있어 로컬 브랜치를 원격 `91a2858`로 맞춘 뒤 `npm run check`(349개)가 초록임을 확인하고 시작했습니다. 이 실행 환경에는 Rust stable(1.94), WebKitGTK 2.52 개발 라이브러리, `WebKitWebDriver`, `Xvfb`, `tauri-driver`를 설치할 수 있어 러스트 워크스페이스 전체 빌드와 Linux 데스크톱 E2E까지 실측했습니다. 세션 H 점검의 미확인 항목은 아래 "미확인"에 이어받았습니다.

**설계 변경 (코드보다 먼저 DESIGN.md v0.11에 반영, 리뷰어 확인 필요)**

- **네이티브 엔진의 동기 호출.** 엔진 인터페이스의 `exec`·`run`은 동기이고 `query.js`·`tables.js`·`schema.js`가 반환값을 바로 쓰므로, Worker의 네이티브 구현은 러스트 호출을 동기적으로 기다려야 합니다. 착수 전 확정은 `SharedArrayBuffer`+`Atomics.wait`로 메인의 브리지를 기다리는 중계(COOP/COEP 헤더 전제)였는데, **실측 결과 WebKitGTK는 `app.security.headers`로 COOP/COEP를 내도 `tauri://localhost` 문서가 `crossOriginIsolated`가 아니고 `SharedArrayBuffer`가 없었습니다**(tauri-driver 세션에서 `E_NATIVE_IPC` 잠금 화면 확인). 그래서 앱이 `jdr` 커스텀 프로토콜(`register_asynchronous_uri_scheme_protocol`)을 등록하고 Worker가 `jdr://localhost/call`에 **동기 XHR**(`exec`·`run`)과 fetch(그 밖)로 직접 요청하는 경로를 기본으로 바꿨습니다(타우리 자체 IPC가 `ipc://` 프로토콜에 fetch하는 것과 같은 방식. text/plain 본문이라 CORS 사전 요청이 없고, 토큰은 프로세스마다 새로 만들어 질의 문자열로 보냅니다). 공유 버퍼 중계는 폴백이자 Node 테스트 경로로 남겼습니다(D-15, 3.2 그림, Step 11 주요 함수).
- **러스트 크레이트 둘(D-12).** `src-tauri/core`(`jdr-core`)는 타우리에 의존하지 않아 WebView·GTK 없이 `cargo test`가 돌고, 표준 입출력 하네스 `jdr-ipc-stdio`로 같은 명령을 노출해 Node의 `npm run test:native`가 실제 rusqlite 엔진에 대해 Step 1 적합성 테스트를 돌립니다. fs 플러그인은 쓰지 않고(바이트 이동은 러스트 `std::fs`), 대화상자는 러스트 명령 `pick_open`·`pick_save`가 dialog 플러그인을 감쌉니다. `@tauri-apps/api`는 런타임 의존이라 쓰지 않고 `window.__TAURI_INTERNALS__`를 직접 부릅니다.
- **작업 사본 dirty 판정(D-15).** 사본 키는 `db_id`(메타 없는 파일은 경로 해시), 쓰기 op 뒤 Worker가 `_jdr_meta.dirty = 1`, `db.save` 성공 뒤 0. 남은 dirty 사본은 다시 열 때 revision 비교로 복구/버리기를 묻고, 재사용한 사본은 사본을 만들 때의 원본 상태와 비교해 그 사이 바뀐 원본을 덮어쓰지 않습니다(`E_ORIGINAL_CHANGED`). 새 DB를 "다른 이름으로 저장"한 사본은 `new-*` 폴더에 남으므로 원본 경로(`meta.json`)로도 찾습니다. 실패한 `db.save`는 올린 revision·saved_at·saved_by를 되돌립니다(그대로 두면 사본 revision이 파일보다 앞서 복구 판정이 어긋납니다. 실제 엔진 테스트가 드러냄).
- 6장: `db.open`의 native 인자(`originalPath`·`discardWorkcopy`·`workcopyKey`)와 `workcopy` 결과, `db.save`의 인자·결과, `db.close`의 `discardWorkcopy`, `engine.init`의 `native`. 3.1: `src-tauri/`(앱: `commands.rs`·`protocol.rs`, 코어: `db.rs`·`save.rs`·`sink.rs`·`workcopy.rs`·`error.rs`·`value.rs`·`bin/jdr-ipc-stdio.rs`), `test/native/`, `test/desktop/`, `docs/desktop.md`, `.github/workflows/desktop.yml`. CLAUDE.md: `test:native`·`test:desktop`·`cargo test --workspace` 명령, 디렉터리·의존성·테스트 규약, Worker 쪽 러스트 호출 위치.

**Step 11 완료 기준**

- [x] `cargo test`(코어 19개 + 앱 크레이트 컴파일): `PRAGMA compile_options`에 `ENABLE_FTS5`(rusqlite 0.40 `bundled`, SQLite 3.53.2), 저장 원자성(`VACUUM INTO` 실패 주입: 없는 폴더 아래 임시 경로 → 원본·`.bak` 바이트 동일, 임시 파일 없음 / rename 실패 주입 → 원본을 `.bak`에서 원복하고 임시 파일 경로를 detail로), `run_batch` 원자성(1만 행 중 5,001번째 실패 → 0행, 바깥 트랜잭션 안에서는 SAVEPOINT), 다른 스레드의 `interrupt`로 20억 행 재귀 질의 중단(`E_IMPORT_CANCELLED`, 200 ms 뒤 호출 → 즉시 종료, 커넥션 재사용 가능), 한글·공백 경로 왕복(`한글 폴더/데이터 베이스 (1).db`, 저장 → `.bak` → 복원 → 다시 열기). 그 밖에 원본 변경 감지·`force`, 다른 이름으로 저장, dirty 사본 복구·버리기·경로로 찾기·원본 상태 비교, 새 DB 임시 사본 목록·정리·키로 열기, 비SQLite·손상·외부 파일, 경로 싱크, JSON 값·base64. `cargo fmt --check`·`cargo clippy --workspace --all-targets -- -D warnings` 0건.
- [x] Step 1 엔진 적합성 테스트를 네이티브 엔진에 대해 통과: `npm run test:native` **26개**(적합성 19 + 큰 응답 버퍼 재수신 1 + 사본 저장 왕복 1 + 데스크톱 스토어 흐름 5). `engine-contract.js`를 wasm과 공유하며(`engine-contract.test.js`는 wasm만 부른다), worker_threads 스레드의 브리지(`io/ipc-bridge.js`)가 `jdr-ipc-stdio` 프로세스를 잇고 메인 스레드의 엔진이 `Atomics.wait`로 기다립니다. tauri-driver 환경에서는 아래 E2E가 Worker 안의 같은 엔진으로 `SELECT 1`·FTS5 trigram 한글 부분 일치를 확인했습니다.
- [x] 데스크톱 E2E(tauri-driver): **Linux(WebKitGTK 2.52, Xvfb)에서 통과.** `test/desktop/run.mjs`가 테스트 변형(`dist/test/tauri/index.html`)을 담은 디버그 바이너리를 만들고 WebDriver 프로토콜을 fetch로 직접 말합니다. 검사: 상태바 "데스크톱 모드 · SQLite 3.53.2", IndexedDB·BroadcastChannel 사용 가능, Worker 전송, `SELECT 1`, FTS5, 새 테이블 → 훅으로 경로 주입 → 다른 이름으로 저장(revision 1) → 편집 → 저장(`.bak`, revision 2) → 새로 만들기 → 다시 열기(2행) → `.bak` 복원 → 원본 변경 감지 대화상자에서 "취소"(파일 그대로). 파일 대화상자는 `__jdrTest.setPickedPath`로 대신합니다. **Windows는 미확인**(CI `desktop` 잡은 세 OS에서 빌드까지만, E2E는 Linux만).
- [ ] ~~**5 GB 픽스처 성능(미확인).**~~ → 세션 L에서 측정(`test/desktop/perf.mjs`, 결과는 세션 L 절). 열기 2초·창 질의 50 ms·저장 1.5배는 재지 않았습니다. 이 환경의 디스크 예산과 시간으로 500만 행 픽스처(약 5 GB)를 만들 수 없었고, 데스크톱 성능 spec(`test/perf`의 데스크톱 판)도 이번 세션에 넣지 않았습니다. 후속 세션(I-2)에서 `gen-fixture.mjs --rows 5000000 --db`로 만든 파일을 `test:desktop`에 넣어 8장 데스크톱 표를 채워야 합니다.
- [x] `verify.mjs`가 브라우저·타우리 산출물이 CSP 태그 외 동일함을 확인: `verify OK`(두 변형 192바이트 차이 = CSP 메타 줄).
- [x] `docs/desktop.md`: 브라우저 모드와의 차이(상한·열기·저장·백업·미저장 변경), 작업 사본 위치(OS별 앱 데이터 폴더, WAL 부속 파일), 저장 절차와 `.bak`, 클라우드 폴더 사용, 미저장 변경 복구, 빌드·검사 명령, 구조.

**검증 결과**

- [x] `npm run check`: eslint 0건, prettier 통과, tsc 0오류, 단위 테스트 **356개**(세션 H 점검 349 + 브리지·전송 형식 6 + `db.save` wasm 거부 1, `selectEngine('native')` 검사 갱신).
- [x] `npm run build && npm run verify`: `verify OK`, 외부 참조 0건(허용 vendor URL 리터럴 160건), vendor 체크섬 6개 일치.
- [x] `npm run test:e2e`: Chromium `file://`에서 **66개 통과**(브라우저 모드 회귀 없음. 세션 H 점검 65 + a11y 1은 세션 H 점검 이후의 값).
- [x] `npm run test:native`: 26개 통과(실제 rusqlite 엔진).
- [x] `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`: 19개 통과(앱 크레이트는 테스트 0개, 컴파일·클리피 통과).
- [x] `npm run test:desktop`(Linux, Xvfb): 통과(위 완료 기준).
- [x] 7.1 grep은 `conventions.test.js`가 대신합니다(0건. 모드 문자열 허용 위치에 `engine-native.js` 포함, `db.save`가 6장 표와 OpMap 양쪽에 있음). 새 오류 코드 없음(`E_NATIVE_IPC`·`E_DISK_FULL`·`E_FILE_LOCKED`·`E_ORIGINAL_CHANGED`는 이미 있었음). i18n 키 17개 추가(`status.mode.native`, `lock.nativeIpc`, `confirm.originalChanged.*`, `confirm.workcopy.*`, `file.workcopyPendingFor`, `file.workcopyMismatch`, `file.savedBackup`), ko/en 동일.
- [x] `DESIGN.md` v0.11 갱신이 `145c738`(착수 전)과 마지막 커밋(실측 뒤 전송 경로 변경)에 포함. `CLAUDE.md` 3·4·5.8·6·7.1장 갱신.

**산출물 크기 (`verify` 출력)**

- `dist/jdrdatabase.html` 3,775,531 bytes (3.60 MiB / 예산 6 MiB). 세션 H 점검(3,744,207) 대비 **+31,324 bytes**(네이티브 엔진·엔진 프로토콜 호출자·브리지·데스크톱 저장 경로·문구).
- `dist/tauri/index.html` 3,775,339 bytes.
- 데스크톱 디버그 바이너리(Linux, 테스트 변형 포함) 244 MB. 릴리스 번들 크기는 CI에서 확인.

**점검했지만 고치지 않은 것 (판단 근거와 함께)**

- **데스크톱 모드의 대화상자는 러스트가 엽니다.** JS는 `pick_open`·`pick_save` 앱 명령만 부르므로 dialog 플러그인의 JS 권한(`dialog:default`)을 capabilities에 주지 않았습니다. 앱 명령은 타우리 2에서 별도 권한 없이 허용됩니다.
- **`app.security.headers`의 COOP/COEP는 남겨 두었습니다.** WebKitGTK에서는 효과가 없었지만 WebView2 등 다른 WebView에서 폴백 경로(공유 버퍼 중계)를 열어 줄 수 있고, 헤더가 있어도 프로토콜 경로가 먼저입니다.
- **`engine.exec`(진단·테스트 전용)는 사본을 dirty로 만들지 않습니다.** 검사 질의가 dirty 표식을 올리면 다음 실행에서 복구를 잘못 제안했습니다(실제 엔진 테스트가 드러냄).
- **긴 `exec`(수백만 행 `count(*)`) 도중 취소는 없습니다.** Worker가 동기 XHR로 멈춰 있어 취소 메시지를 받을 수 없고, wasm 모드도 문장 도중 취소는 없습니다(D-15). 러스트 `interrupt` 명령은 있으므로 메인이 직접 부르는 취소는 후속에서 붙일 수 있습니다.
- **네이티브 모드는 `PRAGMA integrity_check`를 열 때 돌리지 않습니다.** 5 GB 파일에서 분 단위가 걸리고 8장의 "열기 2초"를 지킬 수 없습니다. 헤더와 `sqlite_master` 읽기로 SQLite 파일임은 확인하고, 손상은 첫 읽기에서 `E_FILE_CORRUPT`·`E_DB_QUERY`로 드러납니다.

**미확인 (후속 세션에서 이어받음)**

- ~~5 GB 픽스처의 데스크톱 성능 예산(8장 데스크톱 표 6개 항목)과 최대 상주 메모리. 위 완료 기준 참고.~~ → 세션 L에서 측정.
- Windows(WebView2)·macOS(WKWebView)에서의 데스크톱 모드 전부: `http://jdr.localhost/call` 형태의 프로토콜에 대한 Worker 동기 XHR, 파일 대화상자, `sink_write` raw 본문, single-instance, WebView별 IndexedDB·CompressionStream. CI `desktop` 잡(세 OS)의 첫 실행 결과도 미확인입니다(이 푸시가 첫 실행).
- 실제 파일 대화상자(`pick_open`·`pick_save`)와 내보내기 경로 싱크(`sink_write`)의 WebView 실측(E2E는 훅으로 경로를 넣고, 싱크는 Node `test:native`의 JSON 경로로만 검사).
- CI에서의 `tauri build`(릴리스 번들) 성공 여부와 번들 크기.
- 세션 H 점검이 남긴 항목(실제 브라우저의 Worker 사망·FSA 쓰기 실패, Firefox·Safari와 `https://` 원점, 스크린 리더·실제 한글 IME, 30만 행 내보내기 메모리·XLSX 30만 행, SheetJS 0.20.3 갱신(CVE 2건), 저장 중 파일 열기 등)은 그대로 남습니다.

### 세션 I 점검 (세션 I 산출물 코드 점검) — 2026-09-22

커밋: `c2377f0` fix(ci) 데스크톱 잡 순서 → `96575e1` fix(sink) 내보내기 교체 → `362ad2a` fix(save) 부모 폴더 동기화 → `bebb4e2` fix(save) 뒷정리 실패 → `49904f7` fix(store) 저장 뮤텍스 → `3cc0cde` test(workcopy) 핫 WAL → `19fabd8` docs(design) → `be6d15a` fix(desktop) 프로토콜 토큰 → `ab44bdf` docs(session) → `40e12be` fix(ci) CRLF → `ecdbbac` fix(save) Windows sync.

시작 상태: 로컬 클론이 얕아(depth 50) 원격과 공통 조상이 없는 것처럼 보였습니다(세션 H 점검과 같은 자리). `git fetch --unshallow` 뒤 원격 `36a9e38`으로 맞췄고, 그 상태에서 `npm run check`(356개)가 초록임을 확인하고 시작했습니다. 이 환경에 Rust stable 1.94, WebKitGTK 2.52 개발 라이브러리, `WebKitWebDriver`, `Xvfb`, `tauri-driver` 2.0.6을 설치할 수 있어 러스트 워크스페이스와 Linux 데스크톱 E2E까지 실측했습니다.

**이어받은 미확인 항목의 결과**

- **CI `desktop` 잡(세 OS)의 첫 실행: 세 잡 모두 실패했습니다**(run 35670312597). 원인은 하나이고 아래 1번에서 고쳤습니다. `check-build-e2e`와 `perf`는 같은 커밋에서 초록이었습니다.

**고친 것**

1. **CI `desktop` 잡이 프런트엔드 산출물보다 먼저 러스트를 검사했습니다**(`c2377f0`). 앱 크레이트의 `tauri::generate_context!()`는 컴파일 시점에 `frontendDist`(`../dist/tauri`)를 읽습니다. 워크플로는 `npm ci` 바로 뒤에 `cargo clippy --all-targets`·`cargo test`를 돌렸고 그때 `dist/tauri`가 없어 프로크 매크로가 패닉했습니다(`The frontendDist configuration is set to "../dist/tauri" but this path doesn't exist`). 세 OS 잡이 전부 이 자리에서 죽었습니다. `npm run build`·`npm run verify`를 러스트 검사 앞으로 옮기고 순서의 이유를 주석으로 남겼습니다.
2. **내보내기 교체가 실패하면 이미 있던 파일이 사라졌습니다**(`96575e1`, 데이터 유실). `sink_close`는 대상이 있으면 `remove_file`로 먼저 지우고 rename했습니다. 그 사이에 rename이 실패하면(잠금·권한·동기화 클라이언트) 내보낸 파일도 없고 원래 파일도 없습니다. `fs::rename`은 대상이 있어도 한 번에 갈아 끼우므로(Unix `rename(2)`, Windows `MoveFileEx` + `MOVEFILE_REPLACE_EXISTING`) `remove_file`을 뺐습니다. 재현 테스트를 먼저 넣었고(임시 파일을 미리 치워 교체를 실패시킴) 고치기 전에는 대상 파일을 읽지 못했습니다.
3. **저장이 부모 폴더를 동기화하지 않았습니다**(`362ad2a`). `save_to`는 임시 파일을 `sync_all`하지만 rename 두 번이 바꾸는 것은 디렉터리 항목입니다. 마지막 rename 뒤 `sync_dir(&parent)`를 부릅니다. 여기까지 왔으면 파일은 제자리이므로 동기화 실패는 저장을 되돌리지 않고, 폴더를 파일로 열 수 없는 Windows에서는 아무것도 하지 않습니다.
4. **파일을 바꾼 뒤의 뒷정리 실패를 저장 실패로 돌려줬습니다**(`bebb4e2`). rename이 끝난 뒤의 `file_stamp`·`update_meta_original`에 `?`가 붙어 있었습니다. `db.save`는 실패를 "파일이 그대로다"로 읽고 올려 둔 `revision`·`saved_at`·`saved_by`를 되돌리므로, 사본 revision이 방금 쓴 파일보다 뒤처져 다음 열기의 복구 판정(D-15)이 어긋납니다. 뒷정리를 최선 노력으로 바꾸고, 상태를 읽지 못하면 다음 저장이 `E_ORIGINAL_CHANGED`로 사용자에게 묻도록(조용히 덮어쓰지 않도록) 틀었습니다. 주입 지점 `FailPoint::PostRename`과 재현 테스트를 함께 넣었습니다.
5. **원본 변경을 되물은 뒤 다시 저장하는 동안 저장 뮤텍스가 풀렸습니다**(`49904f7`). `saveNative`는 `catch` 안에서 `return saveNative(..., { force: true })`로 다시 저장했고, `return`이 `try`/`finally` 안이라 `finally`가 다시 저장이 **시작되자마자** 돌아 `state.saving`을 내렸습니다. 몇 GB 저장이 도는 내내 저장 중 표시가 꺼져 있고 자동 저장이 뮤텍스를 그냥 통과합니다(Worker의 `E_DB_BUSY`가 막지만 그건 마지막 방어선입니다). 저장 한 번(`saveNativeOnce`)과 되묻기·다시 저장(`saveNative`)을 나눴습니다. 저장 성공 알림 시점의 `state.saving`을 보는 검사를 넣었고, 고치기 전에는 거짓이었습니다.
6. **엔진 프로토콜 토큰을 시각·pid에서 유도했습니다**(`be6d15a`). 토큰은 `random_suffix()` 두 번, 즉 `(나노초, 카운터, pid)`의 FNV-1a 해시였습니다. 시작 시각을 초 단위로만 알아도 후보가 10^9 남짓이고 두 조각이 독립도 아닙니다. 이 프로토콜은 `Backend::call` 전부로 이어지고 `sink_open`은 임의 경로에 씁니다. `RandomState`(프로세스마다 OS 난수로 seed)에서 만드는 `random_token()`을 따로 뒀습니다. 크레이트는 늘지 않습니다(D-12). 임시 파일 이름은 겹치지만 않으면 되므로 `random_suffix()` 그대로입니다.

7. **Windows 체크아웃의 CRLF가 vendor 체크섬과 산출물 크기를 바꿨습니다**(`40e12be`). 1번을 고치자 Windows 잡이 더 진행해 `npm run verify`에서 `체크섬 불일치: vendor/sqlite3.mjs`로 죽었습니다. `.gitattributes`가 없어 텍스트 파일이 CRLF로 체크아웃되고, vendor 파일의 SHA-256이 `vendor/CHECKSUMS`와 어긋나며 CSS도 한 줄에 1바이트씩 늘어납니다(Windows 19.2 KB / Linux 18.1 KB). 작업 트리를 LF로 고정하되, 바이트가 곧 검사 대상인 `vendor/**`와 `test/fixtures/**`는 변환에서 뺐습니다 — `mixed-newlines.csv`의 CRLF/LF 혼재가 파서 검사의 입력이라 `eol=lf`를 걸면 그 검사가 무의미해집니다(CLAUDE.md 6장). `git add --renormalize .`이 아무것도 바꾸지 않으므로 저장소 안의 blob은 이미 전부 LF이고 이 파일은 Windows 체크아웃에만 영향을 줍니다.
8. **Windows에서 모든 저장이 sync 단계에서 거부됐습니다**(`ecdbbac`, 7번을 고치자 드러남). `save_to`는 `VACUUM INTO`가 만든 임시 파일을 `fs::File::open`(읽기 전용)으로 열어 `sync_all`을 불렀습니다. Windows의 `FlushFileBuffers`는 핸들에 쓰기 권한을 요구하므로 ERROR_ACCESS_DENIED(5)로 실패하고 저장이 `E_FILE_PERMISSION`으로 끝납니다. Windows 러너에서 `cargo test -p jdr-core --test save`의 6개가 전부 이 오류로 죽었습니다(run 35687879010). `OpenOptions::new().write(true)`로 엽니다. Unix의 `fsync`는 읽기 전용 fd도 받으므로 이 회귀를 잡는 검사는 Windows CI 자체입니다. 데스크톱 저장 전체가 Windows에서 동작하지 않던 것이므로 세션 I 산출물의 가장 큰 결함이었습니다.

**검사·문서**

- `3cc0cde` 핫 WAL이 남은 dirty 사본을 기동 정리가 지우지 않는지 검사했습니다. 기존 검사는 `close(false)`로 비정상 종료를 흉내 냈지만 그것은 깨끗한 닫기라 WAL이 체크포인트됩니다. 커넥션을 닫지 않은 채 사본 폴더를 복사해(`-shm` 없이) 실제 크래시 상태를 만들었고, 현재 구현이 통과함을 확인해 검사로 붙잡아 뒀습니다(폴더가 쓰기 가능하면 읽기 전용 커넥션도 WAL을 복구합니다).
- `failed_sink_close_keeps_the_existing_target`의 실패 주입은 열려 있는 임시 파일을 지우는 방식이라 `#[cfg(unix)]`로 묶었습니다(Windows는 공유 모드에 삭제가 없어 열린 파일을 지울 수 없습니다). 고친 쪽과 정상 경로 검사는 두 플랫폼이 같습니다.
- `19fabd8` "다른 이름으로 저장"은 그 경로에 파일이 이미 있으면 `.bak`으로 옮긴 뒤 씁니다. DESIGN.md Step 11과 6장 표는 "검사·`.bak` 없이 새 파일"이라고 적혀 있었습니다. 코드 쪽이 옳아(rename 실패 때 되돌릴 것이 있어야 하고, 덮어쓰기를 고른 파일도 1세대는 남는 편이 D-04에 맞습니다) 문서를 코드에 맞췄습니다. 3.1절 `filesystem.js` 목록에 `listWorkcopies`·`removeWorkcopy`·`openPathSink`·`baseName`을, `save_to` 절차에 부모 폴더 동기화를 넣었습니다.

**고치지 않고 남긴 것 (판단과 근거)**

- **데스크톱 모드의 열기·저장에 진행률이 없습니다.** 러스트 `open`은 64 MB마다, `save_to`는 단계마다 진행률을 내지만, 기본 경로인 엔진 프로토콜(`jdr://localhost/call`)에는 진행률 채널이 없고(DESIGN.md 3.2도 `engine_call`의 채널을 "메인 스레드의 파일 명령용"으로 적었습니다) `worker.js`의 `db.open`·`db.save` 핸들러도 `ctx.progress`를 받지 않습니다. 5 GB 파일에서 두 작업은 이 앱에서 가장 긴 작업이라 `CLAUDE.md` 5.4("1초 이상 걸릴 수 있는 op는 progress")와 어긋납니다. 프로토콜에 진행률을 얹는 것은 D-15 변경이라 이 세션에서 하지 않았습니다. 후속 제안: 러스트에 `progress_poll(callId)` 명령을 두고 메인이 `engine_call`로 주기적으로 읽거나, 프로토콜 응답을 스트리밍으로 바꿉니다.
- **시작 복구는 원본 없는 dirty 사본을 하나만 제안합니다.** `recoverWorkcopies`의 `dirty.find(...)`는 `opened_at` 내림차순의 첫 항목이고, 저장한 적 없는 사본이 둘 이상 남으면 나머지는 dirty라 `purge_clean`이 지우지도 않고 UI로 닿을 길도 없습니다. 앱 데이터 폴더에 영구히 쌓입니다. 사본 관리 화면이 없는 v1에서는 목록을 보여 주는 UI가 필요해 설계 변경이므로 남깁니다.
- **외부 파일에 핫 WAL이 있으면 커밋된 데이터가 사본에 오지 않습니다.** `copy_original`은 `current.db` 본체만 복사하고 `remove_sidecars`가 사본의 `-wal`을 지웁니다. 다른 프로그램이 체크포인트하지 않은 WAL을 남긴 SQLite 파일을 열면, `inspect_original`(읽기 전용 열기)은 WAL까지 보지만 사본은 보지 못해 둘이 어긋나고, 그 상태로 저장하면 WAL에만 있던 커밋이 사라집니다. 앱이 저장한 파일은 `VACUUM INTO` 결과라 WAL이 없어 해당하지 않습니다. 고치려면 사본을 만들 때 `-wal`·`-shm`도 함께 가져가야 하는데, 여러 파일을 원자적으로 복사할 수 없어 다른 프로그램이 쓰는 중이면 일관성이 깨집니다. 원본을 체크포인트하는 쪽은 `CLAUDE.md` 5.9("원본을 바꾸는 코드는 `save.rs` 한 곳")에 걸립니다. 설계 판단이 필요해 남깁니다.
- **`src-tauri/src/lib.rs`의 `run()`이 `.expect()`를 씁니다.** `CLAUDE.md` 5.9의 문자 그대로는 위반이지만 프로세스 진입점이고, 반환 오류로 바꿔 `process::exit`해도 진단이 나아지지 않습니다(패닉 훅은 `setup()` 안에서 붙으므로 어느 쪽이든 이 오류는 `panic.log`에 남지 않습니다). 규약의 예외로 볼지 리뷰어 판단을 구합니다.
- **`io/ipc-bridge.js`의 `writeSync`가 던지면 Worker가 영원히 기다립니다.** `handleSync`의 `try`는 `invoke`만 감싸고, 버퍼가 `SharedArrayBuffer`가 아니면 `writeSync`가 던져 `Atomics.wait`를 깨우지 못합니다. 메시지는 같은 앱의 Worker에서만 오므로 실제로 일어나지 않고, 공유 버퍼 중계는 지금 폴백 경로입니다. 관측만 적습니다.

**검증 (이 환경에서 실제로 돌린 것)**

- [x] `npm run check`: 단위 **356개** 통과(lint·prettier·`tsc --strict` 포함).
- [x] `npm run build` → `npm run verify`: 통과. `dist/jdrdatabase.html` **3,775,673 bytes**(3.60 MiB / 예산 6 MiB), 세션 I의 3,775,531 bytes에서 **+142 bytes**. 외부 참조 0, vendor 체크섬 OK, 타우리 변형과 CSP 태그만 다름.
- [x] `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`: 통과.
- [x] `cargo test --workspace`: **23개** 통과(세션 I의 19개 + 이번 3개 + 토큰 1개).
- [x] `npm run test:native`: **26개** 통과(실제 rusqlite 엔진에 대한 Step 1 적합성 + 데스크톱 스토어 흐름).
- [x] `npm run test:e2e`: 브라우저 **66개** 통과.
- [x] CI `desktop` 잡 수정의 로컬 재현: WebKitGTK 2.52 개발 라이브러리를 설치한 뒤 `npm run build` 없이 돌린 `cargo clippy --workspace --all-targets`는 CI와 같은 프로크 매크로 패닉으로 죽고, `npm run build` 뒤에는 통과합니다.
- [x] **CI 다섯 잡 전부 초록**(푸시 `ecdbbac`, run 35688664051·35688664082): `check-build-e2e`, `perf`, `desktop (ubuntu-latest)`, `desktop (macos-latest)`, `desktop (windows-latest)`. 세션 I가 남긴 "CI `desktop` 잡 첫 실행 미확인"이 이로써 해소됩니다.
- [x] **세 OS의 러스트 검사·타우리 빌드·릴리스 번들**: 세 잡 모두 `cargo fmt --check`·`clippy -D warnings`·`cargo test --workspace`·`npm run test:native`·`tauri build --debug`·`tauri build`가 끝까지 돌았고 설치본이 나왔습니다 — macOS `jdrdatabase_0.1.0_aarch64.dmg`(업로드 3,498,989 bytes), Windows `jdrdatabase_0.1.0_x64_en-US.msi` + `jdrdatabase_0.1.0_x64-setup.exe`(업로드 6,941,302 bytes), Linux는 `.deb`·`.AppImage`·`.rpm`. 세션 I의 "CI에서의 `tauri build` 성공 여부와 번들 크기" 미확인도 해소됩니다.
- [x] **CI Linux 데스크톱 E2E**: `desktop (ubuntu-latest, true)` 잡이 `cargo install tauri-driver` 뒤 `xvfb-run npm run test:desktop`까지 통과했습니다. 로컬 실측과 같은 결과입니다.
- [x] `npm run test:desktop`(tauri-driver 2.0.6 + WebKitGTK 2.52 + Xvfb): **Linux 통과**. 상태바 "데스크톱 모드 · SQLite 3.53.2", Worker의 `SELECT 1`·FTS5 trigram, 다른 이름으로 저장(revision 1) → 편집 → 저장(`.bak`, revision 2) → 다시 열기 → `.bak` 복원 → 원본 변경 대화상자 취소까지 세션 I와 같은 시나리오가 그대로 통과합니다(이번 수정 5번이 닿는 경로입니다). `crossOriginIsolated=false`·`SharedArrayBuffer` 없음도 다시 확인됐습니다(D-15의 프로토콜 경로 전제).

**미확인 (후속 세션에서 이어받음)**

- ~~이 푸시의 CI `desktop` 잡 결과.~~ 위 검증 절에 적었습니다. 세 OS 전부 초록이고 설치본까지 나왔습니다.
- ~~5 GB 픽스처의 데스크톱 성능 예산(8장 데스크톱 표 6개 항목)과 최대 상주 메모리.~~ → 세션 L에서 측정. 세션 I에서 이어받아 그대로 남습니다(이 환경의 디스크·시간 예산으로 500만 행 픽스처를 만들지 못했습니다).
- **Windows(WebView2)·macOS(WKWebView)에서 앱이 실제로 도는 것**은 여전히 미확인입니다. 이번에 확인된 것은 러스트 쪽(`cargo test`가 저장·사본·싱크를 세 OS에서 검증)과 빌드·번들까지이고, WebView 안에서 도는 부분 — `http://jdr.localhost/call`에 대한 Worker 동기 XHR, 파일 대화상자, `sink_write` raw 본문, single-instance, WebView별 IndexedDB·CompressionStream — 은 데스크톱 E2E가 Linux에서만 돌기 때문에 확인되지 않습니다. 8번(Windows의 `sync_all`)이 러스트 단위 테스트에서만 드러난 것처럼, WebView 쪽에도 같은 종류의 플랫폼 차이가 남아 있을 수 있습니다. Windows E2E는 Microsoft Edge Driver로 붙일 수 있으므로 후속 세션에서 `desktop` 잡의 `e2e` 행렬 값을 Windows에도 켜는 것을 제안합니다.
- 실제 파일 대화상자(`pick_open`·`pick_save`)의 WebView 실측. E2E는 `__jdrTest.setPickedPath`로 경로를 넣습니다.
- 위 "고치지 않고 남긴 것"의 다섯 항목(열기·저장 진행률, 남은 dirty 사본 접근, 외부 파일의 핫 WAL, `run()`의 `expect`, `writeSync` 예외)은 판단이 필요한 채로 남습니다.
- 세션 I와 세션 H 점검이 남긴 항목(실제 브라우저의 Worker 사망·FSA 쓰기 실패, Firefox·Safari와 `https://` 원점, 스크린 리더·실제 한글 IME, 30만 행 내보내기 메모리·XLSX 30만 행, SheetJS 0.20.3 갱신(CVE 2건), 저장 중 파일 열기 등)은 그대로 남습니다.

### 세션 J (누적 미수정 항목 정리) — 2026-09-22

커밋: `0b1b3fe` fix(values) → `1ec4eed` fix(worker) → `41c4276` fix(dialog) → `83d43e5` fix(editor) → `71a123b` fix(engine) → `ca14465` fix(i18n) → `391564d` feat(tables) → `717bc2a` fix(store) → `12c6a6b` fix(workcopy) → `7f4e0a5` feat(search) → `0dbddeb` feat(settings) → `87309a5` feat(desktop) → `af20952` docs(design).

이 세션은 특정 Step이 아니라 **앞선 세션들이 "점검했지만 고치지 않은 것"으로 남긴 항목**을 정리했습니다(`CLAUDE.md` 9장의 범위 한정에 대한 예외를 사용자가 이 세션에 한해 허용). 시작 상태: 원격 `9141a2f`와 같았고 `npm run check`(356개)가 초록이었습니다.

**A. 확정된 버그 5건 (재현 테스트를 먼저 넣어 빨강을 확인한 뒤 고침)**

1. **숫자 검증이 쉼표를 모두 지웠습니다**(`0b1b3fe`). `validateInteger`·`validateReal`이 `replace(/,/g, '')`로 전부 지워 `1,2`가 12로 조용히 저장됐습니다. 천 단위 패턴(`^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$`)일 때만 지우도록 좁혔습니다. 세션 B 점검이 "Step 7에서 로케일 판단과 함께"로 남긴 것인데 세션 F가 하지 않았고, 가져오기가 이 경로를 그대로 탑니다.
2. **`command.apply`가 외부 테이블의 데이터 커맨드를 막지 않았습니다**(`1ec4eed`). 스키마 op만 `requireStrict`를 지나고 데이터 커맨드에는 방어가 없었습니다. 저널 재생은 막지 않도록 `replay: true`를 두어 그 항목만 건너뛰고(`skipped: 'external_table'`) 스토어가 한 번 안내합니다 — 복구 전체가 한 항목 때문에 멈추면 그게 더 큰 손실입니다. 세션 D 점검이 "재현 테스트를 쓸 수 없고 저널 재생과의 상호작용을 확인하지 않아" 남긴 항목입니다.
3. **밀려난 대화상자의 Promise가 끝나지 않았습니다**(`41c4276`). 호출자 영구 대기 + `document` keydown 리스너 누수. 닫기 함수를 모듈 스코프에 들고 있다가 취소 값으로 끝냅니다. 세션 B 점검이 "두 개를 동시에 열 경로를 못 찾아" 남긴 것인데 그 뒤 대화상자가 다섯 갈래로 늘었습니다.
4. **확정을 기다리는 사이에 연 편집기가 닫혔습니다**(`83d43e5`). `await` 뒤 `if (ok) teardown()`이 새로 열린 편집기를 닫았습니다. 진입 시 `current`를 잡아 대조합니다. 세션 E 점검이 "Step 5부터 있던 구조이고 범위 밖"으로 남긴 항목입니다.
5. **롤백 실패 뒤 `txDepth`가 sqlite의 실제 상태와 어긋났습니다**(`71a123b`). **여기서 원래 계획을 바꿨습니다.** 지시문은 "롤백 실패면 엔진을 잠그라"였는데, 세션 H가 실측한 SQLITE_NOMEM 경로는 롤백이 실패로 오지만 DB가 계속 쓸 수 있었고 그 검사가 지금도 그것을 단언합니다. 무조건 잠그면 복구 가능한 상황을 죽은 세션으로 만듭니다. 그래서 `sqlite3_get_autocommit`으로 갈랐습니다 — 트랜잭션이 남지 않았으면 `txDepth`만 맞추고 계속, 남았으면 `E_ENGINE_LOCKED`로 잠급니다. 세션 H 점검이 제안한 두 방향("실제 상태와 맞추거나 잠그거나")을 조건에 따라 둘 다 씁니다.

**B. 설계 변경 7건 (DESIGN.md를 먼저 고치고 사유를 적은 뒤 코드)**

6. **데스크톱 열기·저장 진행률**(`87309a5`). 5 GB 파일이면 사본 복사가 수십 초, 저장은 그보다 깁니다. 러스트는 이미 보고하지만 엔진 프로토콜(동기 XHR)에 채널이 없어 Worker까지 오지 못했습니다. **프로토콜을 바꾸지 않고 폴링 주체를 메인으로 옮겼습니다** — Worker가 멈춰 있어도 메인은 자유롭다는 D-15의 성질을 그대로 씁니다. 코어가 마지막 보고를 들고(`Backend::last_progress`), 새 명령 `progress_peek`(커넥션 뮤텍스를 잡지 않음)을 메인이 500 ms마다 읽어 상태바에 그립니다. RPC 프로토콜(6장)은 그대로입니다.
7. **"버리고 계속"이 실제로 버리지 않는 것**(`ca14465`). 동작이 데이터 안전 쪽이라 유지하고 문구를 맞췄습니다.
8. **복구를 기다리는 작업 사본 목록**(`0dbddeb`). 시작 복구는 가장 최근 것 하나만 제안하고 나머지는 dirty라 자동 정리도 안 돼 앱 데이터 폴더에 영영 쌓입니다. 설정 대화상자에 목록(이름·크기·시각 + 열기/버리기)을 뒀습니다. 러스트 명령은 이미 있어 UI와 스토어 메서드만 더했습니다.
9. **외부 파일의 핫 WAL**(`12c6a6b`). 본체만 복사하고 사본의 `-wal`을 지워, 다른 프로그램이 체크포인트 없이 죽인 파일의 마지막 커밋이 사라졌습니다. `-wal`·`-journal`을 함께 복사합니다(`-shm`은 SQLite가 다시 만듭니다). 다중 파일 복사의 일관성 위험은 본체 하나만 복사하는 지금도 이미 있어 새 위험이 아니고, WAL을 버리는 것은 확실한 손실입니다.
10. **`select` 항목 수 상한 1,000**(`391564d`). 넘으면 거부하고 "텍스트로 가져오세요"로 안내합니다.
11. **인덱스가 오래되었을 때 알림**(`7f4e0a5`). 자동 재생성은 열 추가를 30만 행에서 수십 초짜리로 만들어 하지 않고, FTS 가상 테이블의 실제 열 집합(`pragma_table_info`)과 지금 검색 대상 열을 비교해 `TableInfo.ftsStale`로 싣고 도구 모음이 "검색 인덱스 (오래됨)"으로 보여 줍니다. **메타 스키마는 바꾸지 않았습니다** — 가상 테이블 자신이 열 집합을 들고 있습니다.
12. **저장 중 파일 열기 차단**(`717bc2a`). 열기 네 경로가 `state.saving`을 봅니다.

**하지 않은 것 (지시대로, 다시 검토하지 않음)**

- SheetJS 이중 번들(~900 KB) 제거: 산출물 3.61 MiB / 예산 6 MiB.
- 정렬·필터 창 질의의 인덱스 자동 생성: `af20952`에서 DESIGN R6에 **v2**로 표시하고, v1에서 이미 끝난 것(FTS 생성의 진행률·취소)과 갈라 적었습니다.

**조건부 항목: SheetJS 0.18.12 → 0.20.3 (CVE 2건) — 여전히 불가이며 원인을 더 좁혔습니다**

세션 F는 "CDN이 프록시에 막혀서"로 적었지만, 이번에 확인한 결과 **네트워크만의 문제가 아닙니다**.

- `cdn.sheetjs.com`: 프록시가 `CONNECT tunnel failed, response 403`으로 막습니다(변화 없음).
- npm 레지스트리 `xlsx`: `0.18.5`에서 멈춰 있습니다(변화 없음).
- GitHub 미러 `SheetJS/sheetjs`: `raw.githubusercontent.com`은 **닿습니다**(200). 그런데 `master`의 `package.json`이 아직 **0.18.12**이고 `v0.19.3`·`v0.20.2`·`v0.20.3` 태그는 전부 404입니다. SheetJS가 그 버전에서 GitHub 배포를 멈추고 자체 서버로 옮겼기 때문입니다.

즉 **지금 닿을 수 있는 경로에는 0.18.12가 최신이고**, 프록시 정책이 바뀌어 `cdn.sheetjs.com`이 열려야만 갱신할 수 있습니다. 두 CVE의 경로는 그대로 "사용자가 악성 xlsx를 직접 골라 가져올 때"이고 파서는 Worker 안에서만 돌아 DOM에 닿지 않습니다.

**검증 (이 환경에서 실제로 돌린 것)**

- [x] `npm run check`: 단위 **362개** 통과(세션 I 점검 356 + 신규 6). lint·prettier·`tsc --strict` 포함.
- [x] `npm run build` → `npm run verify`: 통과. `dist/jdrdatabase.html` **3,783,864 bytes**(3.61 MiB / 예산 6 MiB), 세션 I 점검의 3,775,673 bytes에서 **+8,191 bytes**. 외부 참조 0, vendor 체크섬 OK, 타우리 변형과 CSP 태그만 다름.
- [x] `npm run test:e2e`: 브라우저 **68개** 통과(세션 I 점검 66 + 신규 2 — 대화상자 겹침, 확정 중 새 편집기).
- [x] `cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`: 통과.
- [x] `cargo test --workspace`: **25개** 통과(세션 I 점검 23 + 신규 2 — 외부 핫 WAL, `progress_peek`).
- [x] `npm run test:native`: **28개** 통과(세션 I 점검 26 + 신규 2 — 작업 사본 목록, 진행률 폴링 실패).
- [x] 빨강 → 초록 확인: A1·A2·A5·B9·B11은 고치기 전 단위/러스트 테스트가 실패하는 것을 확인했고, A3·A4는 E2E가 각각 "첫 Promise 대기 시간 초과"·"새 편집기 `toBeVisible` 실패"로 빨강이었습니다.
- [x] `npm run test:desktop`(tauri-driver 2.0.6 + WebKitGTK 2.52 + Xvfb): **Linux 통과.** 세션 I 점검과 같은 시나리오(상태바, Worker의 `SELECT 1`·FTS5, 다른 이름으로 저장 → 편집 → 저장(`.bak`) → 다시 열기 → `.bak` 복원 → 원본 변경 취소)가 그대로 지납니다. 9번(사본에 `-wal` 동반)과 6번(진행률 폴링)이 닿는 경로입니다.

**미확인 (후속 세션에서 이어받음)**

- ~~이 푸시의 CI 결과.~~ **다섯 잡 전부 초록입니다**(푸시 `543abd8`, run 35704913953·35704913974). 세 OS의 `cargo test`가 9번(작업 사본에 `-wal` 동반)을 통과했고 Linux 데스크톱 E2E와 세 OS 설치본도 그대로입니다.

  첫 푸시(`0e2c11f`)에서는 **macOS와 Windows가 같은 자리에서 빨강**이었습니다. 앱 코드가 아니라 이 세션이 새로 넣은 `progress_peek` 검사가 배경 스레드로 1 ms마다 샘플링하는 방식이라, 빠른 기계에서 2,000행 배치가 첫 샘플보다 먼저 끝났습니다. 세션 F 점검 후속이 같은 종류의 간헐 실패로 고생한 전례가 있어 재실행으로 넘기지 않고, 보고 콜백 안에서 읽도록 다시 써 타이밍 의존을 없앴습니다(`543abd8`). 보고 횟수(500행마다 네 번)까지 단언할 수 있게 되어 검사가 더 강해졌습니다.
- **진행률 표시의 실제 모습.** 폴링 주기(500 ms)와 상태바 문구는 5 GB 파일에서 보지 못했습니다. 이 환경의 픽스처는 폴링이 한 번도 돌기 전에 끝납니다. 러스트 쪽 `progress_peek`은 4,000행 `run_batch`가 도는 동안 다른 스레드가 읽는 것을 검사로 확인했고, JS 쪽은 "폴링이 실패해도 작업은 된다"까지만 검사합니다.
- ~~**설정 대화상자의 작업 사본 목록 UI.**~~ → 세션 L에서 데스크톱 E2E로 해소(그 과정에서 데이터 유실 버그 수정). 스토어 메서드는 `test:native`가 덮지만(둘 이상 남은 사본을 모두 열고 버리는 것), 대화상자에 실제로 그려지는 모습과 키보드 조작은 데스크톱 E2E에 넣지 않았습니다.
- ~~**"인덱스가 오래됨" 배지의 실제 표시.**~~ → 세션 L에서 E2E로 해소. `ftsStale` 판정은 단위 테스트가 덮지만 도구 모음 버튼·툴팁은 코드 경로만입니다.
- ~~**SheetJS 0.20.3**(위 조건부 항목).~~ → 세션 L에서 갱신(`6651617`). 프록시가 `cdn.sheetjs.com`을 열어야 가능합니다.
- 5 GB 픽스처의 데스크톱 성능 예산, Windows·macOS의 WebView 실측, 그리고 세션 I 점검이 남긴 나머지 항목은 그대로입니다.
- **이 세션이 손대지 않은 "점검했지만 고치지 않은 것"**: 사용자와 합의한 대로 받아들인 트레이드오프(고정 열 뒤 스크롤, `selectAll`의 활성 셀, `clearRange` 그룹 수, 내보내기 역압, `export.stream` 배타, 자동 저장 실패 토스트, 읽기 전용에서도 내보내기, `engine.exec` 비배타, 네이티브 `integrity_check` 생략, `NULLS LAST`의 빈 문자열, `views.list` 실패 삼킴, `restoreBackup`의 빈 `db_id`, 오버레이가 스크롤 막대를 덮음, `run()`의 `expect`, `writeSync` 예외, 평문 `.xlsx`, UTF-16 추정, `decodeHead`의 죽은 `try/catch`, XLSX 날짜 로컬 시각, `plan()`의 늦은 이름 검사, 머리글 정렬의 마우스 전용)는 각 세션 절에 근거와 함께 그대로 남아 있습니다.

### 세션 K (CI 유지보수) — 2026-09-22

커밋: `33314ce` ci(workflows) → `d2b3b1a` docs(claude) → 이 커밋 docs(session).

시작 상태: 로컬 클론이 얕아(depth 50) 원격 브랜치보다 **144 커밋 뒤처져** 있었고, 얕은 히스토리 탓에 원격과 갈라진 것처럼 보였습니다. `git fetch --unshallow` 뒤 원격 `a73eaa4`로 fast-forward 했습니다(force-push 없음). 그 상태에서 `npm run check`(362개)가 초록임을 확인하고 시작했습니다. 이 세션은 `DESIGN.md` 5.0의 Step을 구현하지 않고, CI 소모와 불필요한 빨강을 줄이는 유지보수만 합니다.

**한 일**

1. **`concurrency`를 두 워크플로에 추가했습니다**(`33314ce`). group은 `${{ github.workflow }}-${{ github.ref }}`, `cancel-in-progress`는 `${{ github.event_name == 'pull_request' }}`입니다. 세션마다 이어 푸시하는 브랜치라 앞 실행이 끝까지 도는 동안 새 실행이 또 시작돼 러너 시간을 두 번 썼습니다. `main` 푸시 실행은 릴리스와 perf 기준선의 근거로 남아야 하므로 취소 대상에서 뺐습니다.

2. **`changes` 잡을 앞세워 문서 전용 푸시에서 `perf`·`desktop`을 건너뜁니다**(`33314ce`). `paths-ignore`를 쓰지 않은 이유가 핵심입니다 — 워크플로가 아예 돌지 않으면 required check가 영영 pending으로 남아 병합이 막힙니다. 워크플로는 늘 돌리고 잡 수준 `if`로 건너뛰면 **skipped로 보고되어 required check를 만족**합니다. `ci.yml`의 `check-build-e2e`는 조건 없이 늘 돕니다. 서드파티 액션을 새로 넣지 않고 `git diff`로만 판정합니다.

   판정 범위를 **이번 푸시의 증분**으로 잡았습니다. v1 구현은 PR 하나를 세션마다 이어 푸시하므로(`CLAUDE.md` 8장) PR 전체 diff(`base...head`)에는 늘 코드가 들어 있어, 그것으로 판정하면 이 브랜치에서는 문서 전용 커밋이 **영영 건너뛰어지지 않습니다**. 그래서 `pull_request`의 `synchronize`가 주는 `before..after`를 먼저 보고, PR을 연 첫 실행과 force-push 뒤(=`before`가 사라진 경우)에는 PR 전체로, 그것도 안 되면 "전부 실행"으로 내려갑니다. `push`는 `before..sha`를 봅니다. 범위를 정할 수 없을 때 건너뛰지 않는 쪽으로 내려가는 것이 안전한 방향입니다.

3. **`CLAUDE.md` 9장에 세션 인계 문서를 읽는 방법을 적었습니다**(`d2b3b1a`). 기존 문구는 "`docs/sessions.md`의 마지막 절에서 미확인 항목을 이어받는다"였는데, 미확인 항목은 세션 D부터 누적으로 이월되어 직전 절만 읽으면 앞 세션 것이 빠집니다. 1,466줄을 통독하는 대신 `grep -n 미확인 docs/sessions.md`로 줄 번호를 모아 필요한 맥락만 읽도록 적고, 같은 취지로 이 파일 머리말도 고쳤습니다. 파일은 쪼개지 않았고, `CLAUDE.md` 2장의 `DESIGN.md` 필독 범위(D-01 ~ D-15)는 그대로 뒀습니다.

4. **`CLAUDE.md` 3장의 `test:perf` 설명을 고쳤습니다**(`d2b3b1a`). "(CI 밖에서 실행)"이 `ci.yml`의 `perf` 잡, 그리고 6장의 "CI에서는 기준선 대비 30% 회귀"와 어긋났습니다. perf를 CI에서 계속 돌리는 것이 의도이므로 3장 쪽을 맞췄습니다.

**검증 (이 환경에서 실제로 돌린 것)**

- [x] `npm run check`: 단위 **362개** 통과(세션 J와 같음. 이 세션은 런타임 코드를 건드리지 않습니다).
- [x] `npm run build` → `npm run verify`: 통과. `dist/jdrdatabase.html` **3,783,864 bytes**(3.61 MiB / 예산 6 MiB)로 세션 J와 **변화 없음**.
- [x] `npm run test:e2e`: 브라우저 **68개** 통과.
- [x] **판정 스크립트를 로컬에서 떼어 돌렸습니다.** 워크플로 YAML에서 `filter` 스텝의 `run`만 꺼내 환경 변수를 바꿔 가며 15가지 입력을 넣었습니다. PR synchronize(문서 전용 → `code=false`, 코드 → `true`), force-push와 PR 첫 실행의 폴백(PR 전체가 코드면 `true`), 양쪽 다 불명(`true`), `push`의 문서 전용·코드·첫 푸시(zeros → `true`), 그리고 경로 경계(루트 `README.md`만 → `false`, `docs/a/b/c.md` → `false`, `docs/` + 코드 혼합 → `true`, `src/README.md` → `true`, 루트 `docs.md` → `true`, 이름에 공백이 든 파일 → `true`). 폴백은 전부 "건너뛰지 않는" 쪽입니다.
- [x] YAML 파싱과 잡 구조: `ci.yml`은 `changes`·`check-build-e2e`·`perf`, `desktop.yml`은 `changes`·`desktop`이고 `check-build-e2e`에는 `needs`·`if`가 **없음**을 확인했습니다.

**CI 실측 — 코드 푸시(`d2b3b1a`)**

- [x] **`ci` run 35720458939 초록.** `changes`가 `synchronize`의 증분 `a73eaa4..d2b3b1a`를 골라 `.github/workflows/ci.yml`·`.github/workflows/desktop.yml`·`CLAUDE.md`를 찍고 `code=true`를 냈습니다(잡 전체 **5초**). `check-build-e2e` 통과, **`perf`가 건너뛰지 않고 실제로 돌아** 7개 spec 통과·10개 항목 비교·건너뜀 0개·**회귀 없음**(3.1분, 픽스처 캐시 적중).
- [x] **`desktop` run 35720458940 초록.** `changes`(5초) 뒤 세 OS가 모두 돌았습니다 — `cargo fmt`·`clippy -D warnings`·`cargo test`·`test:native`·`tauri build --debug`·릴리스 번들, Linux는 tauri-driver 데스크톱 E2E까지.
- 즉 **코드 커밋에서는 두 잡이 정상 실행된다**가 실측으로 확인됐습니다.

**미확인 (후속에서 이어받음)**

- ~~문서 전용 커밋에서 `perf`·`desktop`이 skipped로 보고되는지는 이 커밋이 그 실측입니다.~~ **확인됐습니다**(푸시 `a067bd9`, `docs/sessions.md` 한 파일). `changes`가 바뀐 파일로 `docs/sessions.md`만 찍고 `code=false`를 냈고, `ci` run 35721772843의 **`perf`가 skipped**, `desktop` run 35721772867의 **`desktop`이 skipped**입니다. 두 run의 결론은 그대로 **success**라 required check가 pending으로 남지 않습니다. `check-build-e2e`는 조건 없이 돌아 통과했습니다.

  아낀 시간: `desktop` run이 **8분 35초 → 8초**(세 OS 러스트 빌드·타우리 번들·데스크톱 E2E가 통째로 빠짐), `ci` run은 `perf`(3.1분, 별도 러너)가 빠지고 `check-build-e2e`만 남아 3분 56초입니다. `changes` 잡 자체의 비용은 잡당 5~8초입니다.
- **`concurrency`의 실제 취소 동작은 미확인입니다.** 설정이 붙은 것과 group 값은 확인했지만, "PR 실행 중에 새 푸시가 오면 앞 실행이 cancelled 된다"와 "`main` 푸시 실행은 취소되지 않는다"를 실제로 보려면 앞 실행이 도는 중에 겹쳐 푸시해야 합니다. CI 소모를 줄이려는 세션에서 그것만을 위해 겹쳐 푸시하지 않았습니다. 다음 세션이 자연스럽게 연속 푸시를 하면 그때 확인됩니다. → 세션 L: PR 쪽은 확인(`45b462d`의 run 35807661515·35807661516이 다음 푸시에 `cancelled`). `main` 푸시 실행이 취소되지 않는 것은 여전히 미확인.
- **`push`(main) 경로는 미확인입니다.** 이 브랜치의 실행은 전부 `pull_request` 이벤트라, `github.event.before`를 쓰는 갈래와 `cancel-in-progress: false`는 병합 때 처음 돕니다. 로컬에서 같은 입력으로 스크립트를 돌려 본 것까지입니다.
- 세션 J와 그 앞 세션들의 미확인 목록(SheetJS 0.20.3 갱신, Windows·macOS WebView 실측, 5 GB 픽스처 데스크톱 성능, 실제 한글 IME·스크린 리더, Firefox·Safari 등)은 이 세션이 줄이지 못했고 그대로 남습니다.

### 세션 L (누적 미확인 항목 정리) — 2026-09-23

커밋: `6651617` chore(vendor) SheetJS 0.20.3 → `cbf728c` fix(export) → `0013d9b` build(verify) → `45b462d` fix(import) → `f94574b` test(e2e) 두 탭 → `d40dc54` test(e2e) 인덱스 배지 → `b3f74a9` fix(store) 열린 작업 사본 → `62eb535` test(desktop) 작업 사본 목록 → `1f0580d` ci(desktop) Windows E2E → `d2477be` refactor(test) → `0b936ae` fix(test) npx.cmd → `59b0788` ci(desktop) 진단 → `39708f6` test(desktop) 5 GB 성능 → `402daf7` ci(desktop) Windows E2E 되돌림 → `31c1279` fix(perf) 메모리 최고 수위 → `d98dd27` test(perf) 기준선 → 이 커밋 docs(session).

시작 상태: 로컬 클론이 얕아(depth 50) 문서 세 개만 있는 옛 커밋에 머물러 있었습니다. `git fetch --unshallow` 뒤 원격 `dfae864`로 fast-forward 했고(force-push 없음), 그 상태에서 `npm run check`(362개)·`build`·`verify`·`test:e2e`(68개)가 모두 초록임을 확인하고 시작했습니다. 이 세션은 `DESIGN.md` 5.0의 Step을 구현하지 않고, 사용자와 고른 누적 미확인 항목(SheetJS 갱신, 두 탭, 인덱스 배지, `E_MEM`, 작업 사본 목록 UI, Windows WebView2, 5 GB 픽스처, concurrency 취소)만 다룹니다.

**한 일**

1. **SheetJS CE 0.18.12 → 0.20.3**(`6651617`, 단독 vendor 커밋). `cdn.sheetjs.com`은 이 환경에서 여전히 `CONNECT 403`이라 저장소 소유자가 받아 전달한 `xlsx.full.min.js`·`types/index.d.ts`를 넣었습니다. `XLSX.version`이 `0.20.3`이고 `fetch`·`XMLHttpRequest`·`importScripts`·`eval`이 없는 것을 확인했습니다. `LICENSE.sheetjs`는 0.18.12와 같은 Apache-2.0 전문·저작권 고지라 바꾸지 않았습니다. 교체로 드러난 것:
   - **XLSX 내보내기가 빈 통합 문서를 썼습니다**(`cbf728c`). 0.18은 행 배열 자체가 dense 시트였고 0.20은 행을 `!data`에 둡니다. 배열을 그대로 넘기면 sparse 시트로 읽혀 헤더까지 빠집니다. "내보낸 xlsx를 다시 가져오면 같다" 왕복 검사가 빨강인 것을 본 뒤 고쳤습니다. 행 수만 보는 검사는 빈 시트에서도 통과했습니다.
   - **기존 배포본(0.18.12)은 1904 날짜 체계 파일의 날짜를 4년 1일 앞당겨 가져왔습니다**(`45b462d`). 0.18.12는 `cellDates` 읽기와 쓰기가 모두 1904 보정을 빼먹었고, 픽스처도 같은 0.18로 만들어 두 오류가 서로 상쇄돼 검사가 초록이었습니다. 옛 `date1904.xlsx`는 1904 체계 일련번호 45296(= 2028-01-06, 엑셀의 표시와 SheetJS의 `w`도 `1/6/28`)을 담고 있었습니다. 0.20.3으로 다시 만든 픽스처는 ECMA-376 정의대로 43834를 담고(XML에서 직접 확인), 0.18.12로 읽으면 2020-01-04가 되어 기존 단언이 빨강입니다.
   - **일련번호 60(달력에 없는 1900-02-29)**: 0.20.3은 이것을 1900-02-28로 옮기지 않고 숫자 셀로 줍니다. 설계(Step 8 "SheetJS에 위임")대로 앱 코드는 바꾸지 않았고, 그 칸이 든 열은 `text`로 추론되며 사용자가 `date`로 지정하면 그 칸은 보고서에 변환 실패로 남는다(날짜를 만들어 내지 않는다)는 것을 단위·E2E에 못박았습니다. `DESIGN.md` Step 8 예외 처리에 두 동작을 적었습니다.
   - `verify`: Apple Numbers 쓰기 템플릿의 하이퍼링크 자리표시자 `https://sheetjs.com/` 문자열 하나만 허용 목록에 더했습니다(`0013d9b`). 요청을 만들지 않고 앱은 `bookType: 'xlsx'`만 씁니다.

2. **두 탭 동시 열기 E2E**(`f94574b`). 같은 컨텍스트의 두 페이지(원점이 같아 BroadcastChannel·IndexedDB를 실제로 공유)로 검사합니다. 뒤 탭은 읽기 전용·안내 토스트·저장 버튼 잠김, 앞 탭을 닫으면 잠금이 남지 않고, 새로 고친 탭은 자기 자신을 다른 탭으로 보지 않습니다. `held` 응답을 끊은 빌드에서 `"otherTab"` 대신 `"none"`으로 빨강인 것을 확인했습니다.

3. **"인덱스가 오래됨" 배지 E2E**(`d40dc54`). 인덱스를 만든 뒤 열을 추가하면 버튼이 "검색 인덱스 (오래됨)"과 안내 툴팁을 보이고, 툴팁대로 껐다가 다시 만들면 풀립니다. 판정을 늘 `false`로 만든 빌드에서 빨강인 것을 확인했습니다.

4. **작업 사본 목록에서 데이터 유실 버그를 찾아 고쳤습니다**(`b3f74a9`). 설정 → 작업 사본 목록에서 "열기"를 누르면 대화상자가 열린 채 그 행이 남았고, 같은 행의 "버리기"를 누르면 러스트 `remove_workcopy`가 열린 DB를 닫고 폴더를 지웠습니다. 화면은 복구한 변경이 열려 있다고 보여 주지만 모든 질의·저장이 `E_DB_QUERY(database is not open)`로 실패했고 복구한 변경은 디스크에서 사라졌습니다(데스크톱 E2E로 재현, `workcopies/`가 빈 것 확인). dirty 사본이 있는 파일을 일반 열기로 복구한 뒤 설정을 열어도 같은 행이 나왔습니다. 스토어의 모든 `db.open`을 `openDb` 하나로 모아 열린 사본의 키를 기억하고, `listWorkcopies`는 그 사본을 빼고 `discardWorkcopy`는 거부합니다. 설정 대화상자는 열기에 성공한 행을 뺍니다. `test:native`(실제 rusqlite)에 재현 테스트를 넣어 빨강을 본 뒤 고쳤습니다. 기존 "dirty 사본이 둘 이상" 테스트는 스토어를 거치지 않는 닫기(앱 종료 흉내) 뒤 같은 스토어를 다음 실행처럼 썼는데, 실제 재시작처럼 새 스토어로 보게 바꿨습니다.

5. **작업 사본 목록 UI 데스크톱 E2E**(`62eb535`). WebDriver 세션을 지우면 tauri-driver가 앱을 저장 없이 끝내므로 dirty 사본을 실제로 남길 수 있습니다. 세 번의 앱 실행으로: (1) 기존 시나리오 끝(원본 변경으로 저장 취소)에서 끝내 사본을 남기고, (2) 시작 안내("…작업 사본에 남아 있습니다")를 확인한 뒤 새 파일을 저장·편집한 채 끝내고, (3) 설정에 두 사본이 보이고, 하나는 포커스 + Enter(WebDriver Actions)로 버리고, 다른 하나는 열면 행이 빠지고 변경이 복구되며, 저장 뒤에는 이 실행의 사본이 목록에 남지 않습니다.

6. **Windows WebView2 데스크톱 E2E는 켜려다 되돌렸습니다**(`1f0580d` → `0b936ae` → `59b0788` → `402daf7`). 세 번의 CI에서 차례로:
   - `run.mjs`가 `npx.cmd`를 셸 없이 띄워 빌드 단계에서 `status null`로 멈췄습니다(Windows Node 20의 CVE-2024-27980 수정). tauri CLI의 `tauri.js`를 Node로 직접 부르게 고쳤습니다.
   - 레지스트리에서 WebView2 런타임 버전을 읽어 같은 버전의 Edge Driver를 받는 단계가 동작했습니다(런타임·드라이버 모두 152.0.4191.66).
   - 그러나 세션 생성이 60초 뒤 `DevToolsActivePort file doesn't exist`로 실패했습니다. 실패 시 진단 단계(run 35809985584): **테스트 앱은 Windows에서 뜨고 15초 뒤에도 살아 있습니다**(WebView2 프로세스 6개). 그런데 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9222`로 띄워도 포트가 열리지 않습니다. wry 0.55.1은 WebView2 환경을 만들 때 브라우저 인자(기본 `--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection`)와 데이터 폴더를 늘 API로 지정하므로(`webview2/mod.rs:294-327`), Edge Driver가 환경 변수로 주는 원격 디버깅 인자·데이터 폴더가 적용되지 않는 것으로 보입니다.
   - 고치려면 창을 설정 대신 코드로 만들어 표준 WebView2 환경 변수를 앱이 받아 넘겨야 합니다. 데스크톱 셸의 기동 경로를 바꾸는 일이고 Windows에서는 CI 왕복으로만 확인할 수 있어 이번에는 하지 않았습니다. 한 번도 통과한 적 없는 새 잡을 켜 두면 PR CI가 빨갛게 남으므로 이 세션이 켠 matrix 값만 되돌렸습니다(기존 검사를 끈 것이 아닙니다). Edge Driver 단계와 실패 진단은 `e2e` 값에 묶여 있어 다시 켜면 그대로 돕니다. `DESIGN.md`·`docs/desktop.md`의 문구도 실제 상태(Linux만)로 맞췄습니다.

7. **5 GB 데스크톱 성능 측정**(`d2477be` 도우미 분리 → `39708f6` `test/desktop/perf.mjs`). 사용: `node test/desktop/perf.mjs <경로>`(Linux는 `xvfb-run`으로 감쌈).
   - **픽스처**: `gen-fixture --rows 5000000 --db`로는 만들 수 없습니다(wasm 엔진이 DB 전체를 메모리에 둠). 스크립트가 30만 행 기반 DB(wasm)를 만든 뒤 앱 안에서(rusqlite) `INSERT … SELECT`로 500만 행까지 늘려 저장합니다. 결과 5,242,847,232 bytes, 500만 행 × 20열(8장 규격). 측정 뒤에는 저장 전 파일(`.bak`)을 원본 자리로 되돌려 같은 픽스처를 재사용합니다(되돌리기 전에는 측정마다 3,000행씩 늘었습니다).
   - **측정 방식에서 바로잡은 것**: 러스트 `open_ms`는 열기 시작부터라 사본 복사를 포함합니다(`core/src/db.rs:224`). 복사를 빼고 판정합니다. 복사·저장의 기준은 원본을 캐시에 올린 뒤 잰 "복사 + fsync"입니다(앱의 복사·저장은 `sync_all`로 끝남). 식은 캐시의 기준은 실행마다 2배 넘게 흔들렸고 그 복사가 캐시를 데워 사본 복사만 빨라 보였습니다. `run_batch`의 장문은 픽스처와 같은 분포(`gen-fixture`의 `longCell`)를 씁니다. 처음에 넣은 약 960자 장문(셀당 약 2.9 KB)으로는 129~170 ms였습니다. 바이너리는 **릴리스 프로필**로 잽니다. 디버그 프로필은 번들 SQLite(C)를 최적화 없이 컴파일해 저장·질의가 제품과 다릅니다.
   - **결과(릴리스, 이 컨테이너의 Linux VM·ext4, 세 번)**:

     | 항목 | 예산 | 실행 1 | 실행 2 | 실행 3 | 판정 |
     |---|---|---|---|---|---|
     | 열기(사본 복사 제외) | 2초 | 2 ms | 2 ms | 3 ms | 통과 |
     | 작업 사본 복사 | 복사+fsync의 1.2배 | 9.6초(1.54배) | 13.7초(3.03배) | 10.4초(2.44배) | **초과** |
     | 창 질의(끝부분 200행) | 50 ms | 9 ms | 10 ms | 7 ms | 통과 |
     | `run_batch` 1,000행(장문 2열) | 100 ms | 33 ms | 29 ms | 27 ms | 통과 |
     | 5 GB 저장 | 복사+fsync의 1.5배 | 5.8초(0.93배) | 5.6초(1.24배) | 6.8초(1.91배) | **경계**(3번 중 2번 통과) |
     | 최대 상주 메모리(앱 프로세스) | 500 MB | 269 MB | 269 MB | 269 MB | 통과 |

     기준 "복사 + fsync"는 3.6~6.3초로 흔들렸고, 저장의 절대 시간은 5.6~6.8초로 안정적이었습니다. WebKitWebProcess는 따로 약 285 MB입니다. 끝부분 창 질의의 **첫 호출**은 벽시계로 약 0.75~0.84초인데, `query.window`가 행 수를 함께 세기 때문입니다(500만 행 `COUNT(*)`, 이후 캐시). `DESIGN.md` 1장이 "남는 상한"으로 적은 count 지연 그 자체입니다.
   - **작업 사본 복사가 넘는 원인**: `workcopy.rs`의 `copy_original`은 64 MB마다 진행률을 보고하려고 8 MB 버퍼로 읽고 씁니다. 같은 5 GB 파일로 러스트의 세 방식을 직접 비교했습니다(릴리스, 끝에 `sync_all`): 8 MB 루프 6.1~20.2초, **64 MB씩 끊은 `std::io::copy` 3.1~3.7초**(Linux에서 `copy_file_range`를 씀, 조각 사이에서 진행률 보고 가능), `std::fs::copy` 4.0~4.5초. `dd bs=8M conv=fsync`도 9~21초(`cp` + `sync`는 3.3~4.4초)로 같은 경향입니다. 아래 "고치지 않은 것"에 제안을 적었습니다.

8. **`E_MEM`을 실제 Chromium(141 headless)에서 실측했습니다**(커밋하지 않은 스크래치 스크립트. 세션 H가 적은 대로 2 GB 채우기는 상시 E2E에 넣지 않습니다). Worker 모드에서 10 MB `zeroblob`을 199개(약 1.99 GB) 넣자 `SQLITE_NOMEM` → `E_MEM`이 났고 탭은 죽지 않았습니다. 트랜잭션은 롤백되고 DB는 계속 쓸 수 있으며(199행 조회), 잠금 없이 dirty가 남습니다. 이 상태에서 저장(다운로드 폴백)을 누르면 스냅샷 직렬화가 `SQLITE_NOMEM`으로 실패하고 1초 안에 "메모리가 부족합니다. 작업을 중단했습니다. 저장한 뒤 앱을 다시 시작하세요. (E_MEM)" 토스트가 뜨며, dirty·revision이 그대로이고 앱은 계속 쓸 수 있습니다. 문구의 문제는 아래 "고치지 않은 것"에 적었습니다.

9. **CI `perf`의 메모리 측정을 고쳤습니다**(`31c1279`). `402daf7`의 `perf` 잡(run 35810754630)이 `app-300k.peakRssBytes` 1,163,759,616으로 기준선(856,301,568) 대비 36% 회귀라며 빨강이었습니다. 이 값은 `db.snapshot` RPC 동안 렌더러 RSS를 100 ms 간격으로 표본한 최대값인데, 스냅샷(130~200 ms)의 짧은 봉우리(직렬화 바이트 + transfer, 약 +300 MB)를 표본이 잡는지에 따라 달라집니다(CI에서 표본 2개일 때 857 MB, 3개일 때 1,164 MB). 코드 원인이 아닌 것은 로컬에서 확인했습니다. 통과했던 `d40dc54`와 HEAD가 같은 조건에서 1.031~1.045 GB와 1.043~1.051 GB였고(모두 표본 3개), 이 경로(Worker 직접 RPC)는 그 사이의 변경(스토어·설정 대화상자)을 지나지 않습니다. 기준선을 올리지 않고 측정을 고쳤습니다. 작업 직전에 렌더러의 `/proc/<pid>/clear_refs`로 최고 수위를 되돌리고 작업 뒤 `VmHWM`을 읽습니다(로컬 세 번 1,158,275,072~1,158,664,192 bytes, 흔들림 0.4 MB 안). 키는 `saveHwmBytes`로 바꿨고, 그 푸시의 CI(run 35811610414, 새 키는 건너뜀·회귀 없음)가 잰 1,163,780,096 bytes를 기준선에 넣었습니다(`d98dd27`. 바이트 항목은 보정하지 않으므로 시간 항목과 보정값의 짝은 그대로). **진짜 봉우리는 약 1.16 GB로, 8장 절대 예산(1.2 GiB)의 여유가 약 10%뿐입니다.** 지금까지의 857 MB는 봉우리를 놓친 값이었습니다.

10. **`concurrency` 취소를 실측했습니다.** 01:48:46에 `d40dc54`를 푸시하자 앞 커밋 `45b462d`의 `ci` run 35807661515와 `desktop` run 35807661516이 01:49:09~11에 `cancelled`로 끝났습니다.

**검증 (이 환경에서 실제로 돌린 것)**

- [x] `npm run check`: 단위 **362개** 통과(개수 변화 없음. SheetJS·1904·일련번호 60 단언은 기존 테스트 안에서 바뀜). lint·prettier·`tsc --strict` 포함.
- [x] `npm run build` → `npm run verify`: 통과. `dist/jdrdatabase.html` **3,858,000 bytes**(3.68 MiB / 예산 6 MiB), 세션 K의 3,783,864 bytes에서 **+74,136 bytes**(SheetJS 0.20.3이 메인·Worker 번들에 각각 약 36 KB 더 큼). 외부 참조 0, vendor 체크섬 OK.
- [x] `npm run test:e2e`: **70개** 통과(68 + 두 탭 + 인덱스 배지).
- [x] `npm run test:native`: **29개** 통과(28 + 열린 작업 사본). 수정 전 빨강 확인.
- [x] `npm run test:desktop`(tauri-driver 2.0.6 + WebKitGTK + Xvfb): **Linux 통과**, 세 번의 앱 실행 시나리오 포함.
- [x] `cargo fmt --check`: 통과(러스트 코드는 바꾸지 않음).
- [x] CI: SheetJS 커밋을 포함한 `d40dc54`에서 `ci`(run 35807837716: check·build·e2e·perf)와 `desktop`(run 35807837601: 세 OS)이 초록. `62eb535`까지 담은 `1f0580d`·`0b936ae`·`59b0788`의 `desktop` Linux·macOS 잡이 초록(Windows는 위 6번). `402daf7`의 `perf`는 위 9번의 이유로 빨강이었고, 측정을 고친 `31c1279`에서 `check-build-e2e`·`perf`가 초록(run 35811610414).
- [x] `CLAUDE.md` 7.1: `innerHTML`에 사용자 데이터가 닿는 곳을 더하지 않았고(설정 목록은 `textContent`), 모드 문자열 비교를 더하지 않았으며, `src/db`·`src/import`에 SQL 문자열 연결을 더하지 않았습니다.

**이어받은 미확인 항목의 결과**

- SheetJS 0.20.3 갱신(CVE-2023-30533, CVE-2024-22363): **해소**(위 1번). 파일이 공식 배포본과 바이트 단위로 같은지는 공식 해시를 받을 수 없어 대조하지 못했습니다(아래 미확인).
- 두 탭 동시 열기의 실제 브라우저 시나리오: **해소**(Chromium, 위 2번).
- "인덱스가 오래됨" 배지의 실제 표시: **해소**(위 3번).
- 설정 대화상자의 작업 사본 목록 UI: **해소**(Linux WebKitGTK, 위 5번). 그 과정에서 데이터 유실 버그를 고쳤습니다(위 4번).
- 메모리 부족(`E_MEM`) 경로: **Chromium에서 해소**(위 8번). 삽입·저장 두 경로 모두 `E_MEM`, 롤백, 잠금 없음, 계속 사용 가능.
- `concurrency`의 실제 취소 동작: **해소**(위 10번).
- 5 GB 픽스처의 데스크톱 성능 예산: **측정함**(위 7번). 여섯 항목 중 넷 통과, 작업 사본 복사 초과, 저장 경계. Linux만.
- Windows(WebView2) 실측: **부분**. 앱이 Windows에서 뜨고 살아 있는 것은 처음 확인했습니다. E2E는 위 6번의 이유로 돌지 않습니다.

**점검했지만 고치지 않은 것**

- **작업 사본 복사가 예산의 1.5~3배**(위 7번). 제안: Linux에서 `copy_original`을 64 MB씩 끊은 `std::io::copy`(`(&src).take(64 MB)`)로 바꾸면 진행률 보고를 유지한 채 3~4초로 내려갑니다(같은 파일로 실측). Windows·macOS의 `std::io::copy`는 커널 복사를 쓰지 않고 작은 버퍼로 내려가므로 지금 루프를 두어야 하고(`cfg(target_os = "linux")`), 그 두 OS의 5 GB 복사 시간은 따로 재야 합니다. 러스트 코어의 복사 경로를 플랫폼마다 나누는 일이라 사용자 확인 뒤에 합니다.
- **`E_MEM` 안내 문구가 저장 실패일 때 모순입니다.** "저장한 뒤 앱을 다시 시작하세요"는 삽입 실패에는 맞지만, 저장 자체가 `E_MEM`으로 실패했을 때도 같은 문구가 떠 방금 실패한 일을 다시 하라고 안내합니다. 또 wasm의 `maxFileBytes`(1.5 GB) 검사는 열기·가져오기·붙여넣기에만 걸려 있어, 편집을 쌓으면 저장할 수 없는 크기(약 2 GB)까지 경고 없이 커집니다. 어떤 안내가 맞을지(최근 변경 되돌리기, 데이터 삭제, 데스크톱 앱 권유 등)는 문구·UX를 정하는 일이라 남깁니다.
- **Windows E2E의 WebView2 인자**(위 6번). 다음 단계 제안: 앱이 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`·`WEBVIEW2_USER_DATA_FOLDER`가 있으면 그 값을 wry의 `additional_browser_args`(기본 인자와 합쳐)·데이터 폴더로 넘기게 창을 코드로 만든다. 그 전에 빈 Tauri 2 템플릿으로 같은 러너에서 tauri-driver가 붙는지 먼저 보면 원인을 확정할 수 있습니다.
- **`docs/desktop.md`의 "구조" 절이 설계와 어긋납니다.** Worker가 `SharedArrayBuffer`·`Atomics.wait`로 메인에 넘긴다고 적혀 있지만, 세션 I 이후 기본 경로는 엔진 프로토콜(`jdr://localhost/call`)에 대한 동기 XHR이고 공유 버퍼 중계는 폴백입니다(`DESIGN.md` D-15). 문서만의 문제라 이번 범위에 넣지 않았습니다.

**미확인 (후속에서 이어받음)**

- **Windows(WebView2)의 데스크톱 E2E**: 위 6번의 WebView2 인자 문제로 세션을 만들지 못합니다. Windows에서 WebView 안의 동작(엔진 프로토콜 `http://jdr.localhost/call`에 대한 Worker 동기 XHR, 저장·`.bak`·복원, 작업 사본 목록)은 여전히 **미확인**입니다.
- **작업 사본 복사 예산 초과와 저장의 경계 판정**: 위 제안을 적용할지 결정이 필요합니다. 성능은 이 컨테이너의 Linux VM(ext4)에서만 쟀고, 8장의 측정 환경(4코어 노트북)·Windows·macOS에서는 **미확인**입니다(macOS APFS의 `fs::copy`는 클론이라 결과가 크게 다를 수 있습니다).
- **SheetJS 파일 무결성**: 공식 배포본의 해시와 대조하지 못했습니다(**미확인**). `cdn.sheetjs.com`에 닿는 환경에서 `sha256sum`을 `vendor/CHECKSUMS`의 값과 견주면 끝납니다.
- **`E_MEM`의 다른 브라우저**: Firefox·Safari에서 NOMEM보다 탭 종료가 먼저 오는지는 **미확인**입니다(Chromium은 약 2 GB에서 NOMEM이 먼저였습니다).
- ~~**이 기록을 담은 푸시(기준선 `d98dd27` 포함)의 CI 결과**: **미확인**(이 커밋 뒤에 확인해 적습니다).~~ → `e4f22cf`에서 **다섯 잡 전부 초록**: `ci` run 35812017973(`check-build-e2e`, `perf`는 10개 항목 비교·건너뜀 0개·회귀 없음으로 새 `saveHwmBytes` 기준선까지 판정), `desktop` run 35812018006(Linux 데스크톱 E2E 포함 세 OS).
- `push`(main) 경로: 병합 때 처음 돕니다(세션 K의 항목 그대로, **미확인**).
- 이번에 고르지 않은 항목(30만 행 내보내기 메모리, File System Access 실측, 한글 파일 이름의 `<a download>`, Firefox·Safari, macOS WKWebView, 스크린 리더·실제 한글 IME 등)은 세션 K까지의 목록 그대로 **미확인**입니다.
