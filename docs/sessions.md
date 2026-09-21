# 세션별 검증 기록

`DESIGN.md` 5.0의 세션 묶음(A~I)과 그 사이의 점검 세션이 무엇을 검증했고 무엇을 검증하지 못했는지를 쌓는 파일이다. 세션을 끝낼 때마다 절을 하나 더하고, 그 절에 해당 Step의 "완료 기준"을 항목별로 옮겨 적어 각각 어떻게 확인했는지 적는다. 확인하지 못한 것은 **미확인**으로 표시한다(`CLAUDE.md` 7.1·7.3·9장).

다음 세션은 이 파일의 마지막 절에서 "미확인" 항목을 이어받는다. 병합 전에는 모든 절의 미확인 항목이 해소됐는지 확인한다.

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
| H | 10 (성능·하드닝·접근성) | 대기 |
| I | 11 (타우리 셸·네이티브 엔진) | 대기 |

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
- [x] 픽스처(날짜·시간·불리언·수식·병합·오류 셀·빈 헤더·1904 체계): `test/fixtures/import/basic.xlsx`(시트 "데이터": 빈·중복 헤더, 날짜·시각·불리언·수식(`f`+계산값)·`#N/A`·`#REF!`·병합 A4:B5·선행 0 우편번호·실수·일련번호 60/61; 시트 "둘째": 헤더가 3행), `date1904.xlsx`, `encrypted.xlsx`(CFB에 `EncryptedPackage`·`EncryptionInfo` 스트림). `xlsx.test.js` 5개 + `pipeline.test.js` 2개 + E2E 2개. **1900 윤년 버그는 SheetJS가 일련번호 60을 `1900-02-28`, 61을 `1900-03-01`로 돌려줍니다**(위임한 대로 두고 검사로 못박음). 1904 통합 문서의 같은 날짜가 같은 문자열로 읽힙니다. 손상은 잘린 zip(`E_XLSX_CORRUPT`)으로 검사했고, **빈 입력과 평문은 SheetJS가 CSV로 읽어 던지지 않습니다**(형식은 확장자로 정하므로 실사용에서는 `.xlsx`로 이름만 바꾼 CSV가 표로 읽힙니다).
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
