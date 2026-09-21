# jdrdatabase 설계 문서

| 항목 | 내용 |
|---|---|
| 문서 버전 | 0.8 (초안) |
| 작성일 | 2026-09-19 (0.2: 2026-09-20, 0.3: 2026-09-20 세션 A 실측 반영, 0.4: 2026-09-20 세션 B 커맨드 형식·메타 스키마 확정, 0.5: 2026-09-20 세션 C 창 질의 형식·성능 픽스처 규격 확정, 0.6: 2026-09-20 세션 D 데이터 커맨드·배치 문장·행 읽기 op 확정, 0.7: 2026-09-21 세션 E 뷰 스펙·필터·정렬 빌더·검색 인덱스 단계·뷰 op 확정, 0.8: 2026-09-21 세션 F 가져오기 파이프라인·op 인자·저널 정지 확정) |
| 대상 | 단일 HTML 파일로 배포되는 로컬 데이터베이스 관리 웹앱과, 같은 소스로 빌드하는 타우리(Tauri) 데스크톱 앱 |
| 관련 문서 | `CLAUDE.md` (작성 규약·코드 점검), `README.md` |

이 문서는 "NocoDB 데스크톱/로컬 구동" 방식, 즉 서버 없이 사용자의 PC에서 단독으로 동작하는 스프레드시트형 데이터베이스 관리 프로그램을 **단일 HTML 파일**로 구현하기 위한 설계도이다. 같은 소스에서 타우리 데스크톱 앱도 빌드하며, 데스크톱 앱에서는 DB 엔진이 네이티브 SQLite로 바뀌어 파일 크기 상한이 디스크 용량으로 확장된다(D-15). 0장에서 타당성 질문 세 가지에 답하고, 1장부터 실제 설계와 단계별 구현 계획을 기술한다.

---

## 0. 타당성 요약: 세 가지 질문에 대한 답

### Q1. 단일 HTML 웹앱으로 "수십만 자를 담을 수 있는 셀 수십만 건"을 조회·편집할 수 있는가?

**가능하다. 단, 아래 조건과 상한을 전제로 한다.**

- 브라우저 모드의 저장·질의 엔진은 SQLite 프로젝트가 배포하는 **공식 SQLite Wasm**(`@sqlite.org/sqlite-wasm`)을 사용한다. wasm 바이너리를 base64로 HTML에 인라인하므로 외부 파일이나 네트워크가 필요 없다. 데이터베이스 전체는 브라우저 메모리에 상주하고, 모든 질의는 Web Worker에서 실행되어 UI가 멈추지 않는다.
- 화면은 **가상 스크롤 그리드**로 구현한다. 수십만 행 중 화면에 보이는 수십 행만 DOM으로 만들고, 스크롤할 때 `LIMIT/OFFSET` 창 질의로 필요한 행만 가져온다.
- 장문 셀은 그리드에서 앞부분 256자만 `substr()`로 가져와 미리보기로 표시하고, 전문은 사용자가 편집기를 열 때만 로드한다. 따라서 셀 하나가 수십만 자라도 스크롤 성능에 영향을 주지 않는다.
- SQLite 자체의 문자열 상한은 기본 10억 바이트(`SQLITE_MAX_LENGTH`)이므로 수십만 자(UTF-8 한글 기준 수백 KB) 셀은 문제없이 저장된다.

**정직하게 밝혀야 할 상한 (브라우저 모드)**

| 항목 | 값 | 근거 |
|---|---|---|
| 설계상 DB 파일 상한 | 약 700 MB | 브라우저 탭당 실용 메모리 약 1.5–2 GB. 저장 시 `snapshot()`이 사본을 만들어 최대 2배가 필요 |
| 단일 ArrayBuffer 상한 | 2 GB | 파일 읽기·쓰기 경로가 하나의 버퍼를 사용 |
| 현실적 셀 수 | 수십만~수백만 셀 | 셀 30만 개 × 평균 2 KB = 600 MB → 가능 |
| 지원하지 않는 경우 | 모든 셀이 수십만 자 | 셀 30만 개 × 300 KB = 90 GB → 브라우저에서 불가 |

즉 "수십만 자를 담을 수 있는 셀"이 수십만 건 있는 것(대부분 짧고 일부만 긴 실제 데이터)은 지원 대상이고, "모든 셀이 수십만 자"인 데이터는 브라우저 모드의 지원 대상이 아니다. 상한 값은 엔진이 `capabilities()`로 보고하고, 앱은 파일을 열 때 그 값과 비교하여 경고·거부한다.

**데스크톱 모드에서는 이 상한이 사라진다.** 위 상한은 DB 전체가 WebView 메모리 안의 wasm 엔진에 상주하기 때문에 생긴다. 타우리 데스크톱 빌드(D-15)에서는 러스트 쪽 네이티브 SQLite가 디스크의 파일을 직접 열어 페이지 캐시만 메모리에 올리므로, 파일 크기 상한은 디스크 용량이 되고 남는 상한은 UI 쪽 것(수백만 행에서의 OFFSET·count 지연, FTS 인덱스 생성 시간)뿐이다. 타우리로 감싸기만 하고 wasm 엔진을 그대로 쓰면 WebView(WebView2, WKWebView, WebKitGTK)도 같은 wasm32 메모리 한계를 가지므로 상한은 그대로 남는다. 상한을 없애는 것은 셸이 아니라 엔진 교체이며, 그래서 엔진 원시 계층을 두 구현으로 나눈다.

### Q2. 데이터베이스를 단일 바이너리 파일로 두고 구글 드라이브로 여러 PC를 오가며 관리할 수 있는가?

**가능하다. 아래 방식으로 설계하면 안전하다.**

- 저장 형식은 **표준 SQLite 파일** 하나(예: `my-database.db`)이다. `sqlite3` CLI나 DB Browser for SQLite로도 열린다.
- 브라우저 모드에서 앱은 파일을 통째로 메모리에 읽고, 저장할 때 통째로 다시 쓴다. wasm 엔진이 메모리 내 DB이므로 WAL이나 journal 같은 부속 파일이 생기지 않는다. 클라우드 동기화가 부속 파일을 누락하여 DB가 깨지는 전형적인 문제가 원천적으로 없다.
- 저장은 File System Access API의 `createWritable()`로 수행한다. 이 API는 임시 파일에 쓴 뒤 `close()` 시점에 교체하므로 저장 도중 전원이 꺼져도 원본이 반쯤 덮어써지는 일이 없다.
- 데스크톱 모드에서는 네이티브 SQLite가 원본을 직접 쓰지 않고 앱 데이터 폴더의 작업 사본을 연다. 저장 시 `VACUUM INTO`로 만든 임시 파일을 원본 자리에 이름 교체하므로, 저널·WAL 부속 파일이 클라우드 폴더에 생기지 않고 저장의 원자성도 브라우저 모드와 같다(D-15).

**한계와 완화책**

- 동시 편집은 불가능하다. 구글 드라이브에는 파일 잠금이 없어서 두 PC가 각자 편집 후 업로드하면 한쪽이 "충돌 사본"이 되거나 마지막 저장이 이긴다. 이 앱은 "한 번에 한 PC에서만 편집하고, 다른 PC로 넘어가기 전에 저장·동기화를 완료한다"는 사용 규칙을 전제한다.
- 완화책으로 DB 안의 메타 테이블에 `db_id`, `revision`(저장마다 1 증가), `saved_at`, `saved_by`(기기 이름)를 기록하고, 각 기기의 IndexedDB에 "이 기기가 마지막으로 본 revision"을 남긴다. 파일을 열 때 두 값을 비교하여 되돌아간 파일(동기화가 덜 된 파일)이나 다른 revision 위에 남은 미저장 변경을 감지해 경고한다. 자동 병합은 하지 않는다.
- 파일 크기가 수백 MB이면 저장할 때마다 전체가 재업로드되어 느리다. 선택 기능으로 `CompressionStream`을 이용한 gzip 저장(`.db.gz`)을 둔다. 텍스트 위주의 SQLite 파일은 보통 3~5배 압축된다.

### Q3. xlsx·csv 파일을 이 앱의 데이터 형식으로 변환하는 기능을 구현할 수 있는가?

**가능하다.**

- CSV: 자체 스트리밍 파서를 구현한다. RFC 4180(따옴표, 따옴표 안의 개행·쉼표), BOM, 구분자 자동 감지(`,` `;` `\t` `|`), 인코딩 감지·선택(UTF-8, UTF-16, EUC-KR/CP949)을 지원한다. 파일을 조각 단위로 읽으므로 수백 MB CSV도 메모리를 한꺼번에 쓰지 않는다.
- XLSX: **SheetJS Community Edition**(Apache-2.0)을 인라인한다. 시트 선택, 헤더 행 지정, 엑셀 날짜 일련번호 변환, 수식은 계산된 값만 가져오기를 지원한다. XLSX는 파일 구조상 통째로 파싱해야 하므로 CSV보다 메모리 상한이 낮다(파일 기준 약 100 MB).
- 타입 추론: 상위 1,000행을 표본으로 `integer / real / boolean / date / datetime / text / longtext`를 추론하고, 사용자가 매핑 화면에서 열 이름·타입·건너뛰기를 수정한 뒤 가져온다. 변환에 실패한 값은 규칙에 따라 NULL 처리 또는 열 전체를 text로 강등하며, 결과 보고서에 남긴다.
- 대용량 처리: Worker 안에서 1,000행 단위 트랜잭션과 재사용 prepared statement로 삽입하고, 진행률과 취소를 지원한다.

---

## 1. 목표와 비목표

### 1.1 목표 (v1)

1. 브라우저에서 HTML 파일 하나를 열면 즉시 동작한다. 설치, 서버, 네트워크가 필요 없다.
2. 스프레드시트와 같은 그리드 UI로 테이블을 만들고, 열을 정의하고, 셀을 편집한다.
3. 수십만 행·수십만 셀 규모에서 스크롤·정렬·필터·검색이 체감상 즉시 반응한다.
4. 셀 하나에 수십만 자의 텍스트를 저장하고 편집할 수 있다.
5. 데이터는 표준 SQLite 파일 하나로 저장되며, 클라우드 드라이브로 옮겨 다른 PC에서 이어서 작업할 수 있다.
6. CSV·XLSX 가져오기와 CSV·XLSX 내보내기를 지원한다.
7. 실수로부터 보호한다: 되돌리기/다시 실행, 미저장 변경 복구, 저장 전 백업.
8. 같은 소스로 타우리 데스크톱 앱을 빌드한다. 데스크톱 앱에서는 DB 파일 크기 상한이 디스크 용량으로 확장되고, 파일 접근이 브라우저 API 가용성에 좌우되지 않는다.

### 1.2 비목표 (v1에서 하지 않는 것)

- 다중 사용자 동시 편집, 실시간 동기화, 서버 API
- 테이블 간 관계(링크 필드), 수식 필드, 자동화·웹훅
- 첨부 파일(이미지·바이너리) 필드
- 모바일 터치 최적화
- 브라우저 모드에서 브라우저 메모리를 넘는 규모(수 GB)의 파일. 이 규모는 데스크톱 모드가 담당한다
- 데스크톱 모드에서 원본 파일을 작업 사본 없이 직접 여는 방식, 그리고 CSV·XLSX 파서를 러스트로 옮기는 것(파서는 두 모드 모두 JS Worker)

---

## 2. 핵심 설계 결정 (ADR)

각 결정은 `D-번호`로 식별하며, 이후 장에서 이 번호로 참조한다. 결정을 바꿀 때는 이 표를 갱신하고 사유를 남긴다.

### D-01. 배포는 단일 HTML, 소스는 모듈로 분리하고 빌드로 인라인한다

- 소스는 `src/`의 ES 모듈로 작성하고 `build/build.mjs`가 JS·CSS·wasm(base64)·Worker 소스를 `dist/jdrdatabase.html` 하나로 합친다.
- 런타임 네트워크 요청은 0건이다. `<meta http-equiv="Content-Security-Policy">`로 `default-src 'none'; script-src 'unsafe-inline' 'wasm-unsafe-eval' blob:; worker-src blob:; style-src 'unsafe-inline'; img-src data:`를 선언하여 외부 자원 참조가 섞이면 실행 단계에서 드러나게 한다. `'wasm-unsafe-eval'`은 필수다. Chromium은 `script-src`가 선언된 문서에서 이 소스(또는 `'unsafe-eval'`) 없이는 `WebAssembly.instantiate`를 거부한다(세션 A 실측).
- 사유: 개발·테스트 편의와 단일 파일 배포를 양립시키기 위함이다. 소스를 직접 단일 파일로 쓰면 테스트와 코드 리뷰가 불가능해진다.
- 빌드는 같은 소스에서 두 변형을 만든다. `dist/jdrdatabase.html`(브라우저용, 메타 CSP 포함)과 `dist/tauri/index.html`(타우리용, 메타 CSP 없음). 타우리는 IPC를 위해 자체 CSP를 `tauri.conf.json`에서 주입하므로 메타 CSP와 충돌한다. 두 변형은 CSP 태그 유무만 다르고 나머지 바이트는 같아야 하며 `verify.mjs`가 이를 검사한다.

### D-02. 브라우저 모드의 저장 엔진은 공식 SQLite Wasm(`@sqlite.org/sqlite-wasm`)이며 Web Worker에서 실행한다

| 대안 | 탈락 사유 |
|---|---|
| 순수 JS 배열 + JSON 파일 | 수십만 건 정렬·검색·부분 로드가 비효율적이고 파일 포맷을 자작해야 한다 |
| IndexedDB 직접 사용 | 단일 파일 내보내기가 어렵고 질의 능력이 부족하다 |
| sql.js | 배포 빌드에 FTS5가 없다. 1.14.2의 `PRAGMA compile_options`에는 `ENABLE_FTS3`만 있고 `ENABLE_FTS5`가 없으며 `CREATE VIRTUAL TABLE ... USING fts5`가 `no such module: fts5`로 실패한다(세션 A 실측). D-07의 trigram 검색이 불가능하고 `sqlite3_interrupt`도 노출하지 않는다. FTS5를 넣으려면 emscripten 자체 빌드가 필요해 `vendor/`의 "상류 배포본 + 체크섬" 규칙과 맞지 않는다 |
| 공식 sqlite-wasm의 OPFS 영속화 | `file://` 오리진과 비격리 오리진에서는 OPFS VFS가 설치되지 않는다. 그래서 OPFS는 쓰지 않고 메모리 DB만 쓴다(아래) |

- 공식 배포본 `sqlite3.mjs` + `sqlite3.wasm`(SQLite 3.53.4)은 FTS5(trigram 토크나이저 포함), JSON, `sqlite3_interrupt`, `sqlite3_deserialize`, `sqlite3_js_db_export`를 포함한다. 실제 사용 버전의 `PRAGMA compile_options` 결과를 Step 1 테스트로 고정한다.
- ESM 배포본은 빌드가 esbuild로 Worker용 IIFE 번들에 접어 넣는다. 번들 안에서는 `import.meta.url`이 비어 있으므로 `sqlite3InitModule({ wasmBinary, locateFile: (name) => name })`처럼 base64를 디코딩한 ArrayBuffer와 파일 이름을 그대로 돌려주는 `locateFile`을 함께 넘긴다. 이렇게 하면 wasm·프록시 스크립트를 위한 별도 파일 요청이 일어나지 않는다. 단일 파일화가 복잡하다는 이전 판단은 이 조합으로 해소되었고, `file://`에서 연 문서의 Blob Worker 안에서 FTS5 trigram 질의가 동작함을 세션 A에서 실측했다.
- DB는 항상 메모리 DB다. 파일 열기는 바이트를 `sqlite3_deserialize`로 넘기고, 저장은 `sqlite3_js_db_export`로 바이트를 얻는다. OPFS VFS 설치 실패는 경고 로그로만 남고 동작에 영향이 없다.
- Worker는 `<script type="text/plain">` 블록의 소스를 Blob URL로 만들어 생성한다. Worker 생성이 막힌 환경에서는 같은 API를 메인 스레드에서 실행하는 인라인 전송 계층으로 자동 폴백한다(D-11 RPC 추상화 덕분에 비용이 낮다).
- 중요한 특성: `sqlite3_js_db_export`는 DB를 닫지 않으므로 export 자체가 prepared statement를 무효화하지는 않는다. 그래도 엔진 인터페이스의 `snapshot()`은 **statement 캐시를 비우고 PRAGMA를 다시 적용하는 계약**을 유지한다. 호출자가 특정 wasm 빌드의 동작에 기대지 않게 하기 위해서이며, `snapshot()` 바깥에서 export를 직접 부르는 코드는 두지 않는다.
- 이 결정은 브라우저 모드의 엔진 구현(`engine-wasm.js`)에 관한 것이다. 두 모드가 공유하는 엔진 인터페이스와 데스크톱 모드의 네이티브 구현은 D-15에서 정한다.

### D-03. 파일 포맷은 표준 SQLite 파일이고, 사용자 테이블·열의 물리 이름은 불투명 ID를 쓴다

- 사용자 테이블은 실제 SQLite 테이블 `t_<8hex>`, 열은 `c_<8hex>`로 만든다. 사용자에게 보이는 이름·타입·순서·너비는 메타 테이블(`_jdr_tables`, `_jdr_columns`)에 둔다.
- 메타의 `id`는 물리 이름 그 자체다. 앱이 만든 테이블·열은 `t_<8hex>`·`c_<8hex>`이고, 다른 도구가 만든 SQLite 파일을 등록(Step 2)하면 기존 테이블·열의 원래 이름이 그대로 `id`가 된다. 그런 테이블은 `_jdr_tables.strict = 0`으로 표시하고 v1에서는 읽기 전용으로 다룬다(R7).
- 사유: 이름 변경이 `ALTER TABLE` 없이 메타 갱신만으로 끝난다. 한글·공백·중복 이름 같은 식별자 문제가 사라진다. NocoDB의 메타 구조와 같은 방향이다.
- 대가: `sqlite3`로 직접 열면 이름이 불투명하다. 내보내기 시 표시 이름을 사용하고, "SQL 뷰 생성" 기능(표시 이름으로 `CREATE VIEW`)을 v1.1 후보로 둔다.
- 모든 사용자 테이블은 `STRICT` 테이블(SQLite 3.37+)로 만들어 열 타입이 섞여 정렬이 깨지는 문제를 막는다. 값 검증은 앱이 쓰기 전에 수행한다.
- 시스템 열: `id INTEGER PRIMARY KEY`(rowid 별칭), `_created_at TEXT`, `_updated_at TEXT`. 시스템 열은 사용자가 지울 수 없다.

### D-04. 브라우저 모드의 영속화는 3중 구조: 정본 파일, 폴백 다운로드, 미저장 변경 저널

| 층 | 구현 | 역할 |
|---|---|---|
| 1. 정본 | File System Access API(`showOpenFilePicker`, `showSaveFilePicker`, `createWritable`). 파일 핸들을 IndexedDB에 저장해 다음 실행 때 "최근 파일"로 재개 | 사용자가 지정한 `.db` 파일 |
| 2. 폴백 | `<input type="file">` 읽기 + `<a download>` 쓰기 | Firefox, Safari, API가 막힌 환경 |
| 3. 저널 | 커맨드(D-08)를 IndexedDB `journal` 스토어에 순서대로 기록. 파일 저장 시 비움. 가져오기(Step 7·8)는 커맨드가 아니라 기록할 수 없으므로 그 뒤로는 저장할 때까지 기록을 멈추고 배너로 저장을 재촉한다 | 탭이 죽거나 저장을 잊었을 때 복구 |

- 저장 = `snapshot()` → `Uint8Array` → `writable.write()` → `close()`. `close()`에서 원자적으로 교체된다.
- 저장 직전에 기존 파일 바이트를 IndexedDB `backups` 스토어에 1세대 보관한다(파일이 200 MB 이하일 때). 그보다 크면 보관을 건너뛰고 사용자에게 알린다.
- IndexedDB는 기능 감지로 사용하며, 없어도(일부 브라우저의 `file://` 오리진) 1·2층만으로 동작해야 한다.
- 데스크톱 모드의 영속화(작업 사본, 네이티브 저장, `.bak` 백업)는 D-15를 따른다. `known_revisions`와 설정은 두 모드 모두 IndexedDB에 둔다.

### D-05. 그리드는 Canvas가 아니라 DOM 가상화로 그린다

- 사유: 텍스트 선택, 한글 IME 조합, 접근성 트리, 브라우저 기본 복사·붙여넣기를 그대로 쓸 수 있다. Canvas는 IME 처리와 접근성을 직접 구현해야 하는데 v1 범위에서 감당할 이유가 없다.
- 행 높이는 고정(기본 32 px). "줄바꿈 보기" 옵션도 고정 3줄 높이로 제한한다. 고정 높이여야 스크롤 위치에서 행 인덱스를 O(1)로 계산할 수 있다.
- 열 가상화도 함께 구현한다(열 수백 개 대응).
- 셀 미리보기는 `substr(col, 1, 256)`과 `length(col)`을 함께 가져온다. 256자를 넘으면 말줄임과 길이 배지를 표시한다.
- 편집기: 단문은 셀 위 인라인 `<input>`, `longtext`는 우측 사이드 패널의 `<textarea>`. 수십만 자 textarea는 브라우저가 문제없이 처리한다.
- 브라우저의 요소 높이 상한(Chromium 약 3,355만 px)을 넘는 경우(예: 100만 행 × 32 px = 3,200만 px, 경계 근접)에는 스크롤 스케일링(가상 높이를 1/k로 줄이고 스크롤 위치를 환산)을 적용한다.

### D-06. 데이터는 "창(window)" 단위로 가져오고 블록 캐시를 둔다

- 그리드는 `[첫 가시 행 - 버퍼, 마지막 가시 행 + 버퍼]` 범위를 `SELECT ... ORDER BY <사용자 정렬>, id LIMIT n OFFSET m`으로 요청한다.
- `OFFSET m`은 rowid b-tree의 잎 셀을 m개 걸어야 하므로 비용이 m에 비례한다. 세션 C 실측(30만 행, 장문 2열, 약 300 MB): OFFSET 0에서 10 ms, 15만에서 28 ms, 29만 9,800에서 50~60 ms로 8장 예산(50 ms)을 끝부분에서 넘는다. 그래서 정렬·필터가 없는 기본 뷰에서는 id가 빈틈없이 연속일 때(`max(id) - min(id) + 1 = count`, 가져오기·추가만 겪은 테이블) `WHERE id >= min + m ORDER BY id LIMIT n`으로 O(log n) 탐색을 쓴다(실측 7~12 ms). 행 삭제로 연속이 깨지면 OFFSET으로 돌아가며, 그 경우의 끝부분 지연은 R6의 대응(정렬 열 인덱스, keyset 페이징)으로 남긴다. 연속 판정에 쓰는 행 수는 Worker가 쓰기 op 일련번호와 함께 캐시한다(`count(*)`는 30만 행에서 35 ms). `min`·`max`는 따로 묻는다(한 문장에 둘을 넣으면 SQLite가 전체 스캔을 한다).
- 블록 크기 200행의 LRU 캐시(최대 50블록)를 두고, 편집·정렬·필터·가져오기 후에는 해당 테이블 캐시를 전부 무효화한다. 같은 테이블의 데이터 변경(편집·되돌리기)에 따른 무효화는 블록을 버리지 않고 낡은 것으로 표시해 다시 요청하며, 새 응답이 올 때까지 옛 행을 그대로 그린다(셀이 비었다 채워지는 깜빡임 방지). 테이블 전환은 블록을 버린다. 낡은 블록을 그리는 동안 화면의 값은 DB와 다를 수 있으므로, 그 값을 **읽어서 다시 쓰는** 경로(편집기 초기값)는 낡은 블록에서 열 때 `query.row`로 전문을 읽는다. 그리지만 하는 경로는 낡은 값을 그대로 쓴다.
- 총 행 수는 필터 조건을 포함한 `count(*)`로 필터 변경 시 1회만 계산한다.
- 정렬은 항상 `id`를 보조 키로 붙여 안정적으로 만든다.

### D-07. 검색은 FTS5 trigram을 테이블 단위로 옵트인하고, 없으면 LIKE로 처리한다

- 전문 검색이 필요한 테이블에 대해 사용자가 "검색 인덱스 만들기"를 켜면 FTS5 external-content 가상 테이블과 동기화 트리거를 만든다. 토크나이저는 `trigram`(SQLite 3.34+)을 사용해 한글 부분 일치를 지원한다.
- trigram은 3자 미만 질의를 처리하지 못하므로 그 경우와 인덱스가 없는 경우는 `LIKE '%q%'`로 폴백한다.
- 인덱스는 파일 크기와 가져오기 시간을 늘리므로 기본값은 꺼짐이다.
- 검색 대상 열은 물리 타입이 TEXT인 살아 있는 열(`text`·`longtext`·`date`·`datetime`·`select`)이다. FTS 인덱스와 LIKE 폴백이 같은 열 집합을 본다. 인덱스에 담기는 열 집합은 만드는 시점에 고정되며, 그 뒤 추가된 열은 인덱스를 지웠다 다시 만들어야 검색된다(v1은 자동으로 다시 만들지 않는다). 다른 도구가 만든 비STRICT 테이블(R7)에는 인덱스를 만들지 않고 LIKE만 쓴다.
- 물리 이름: FTS 테이블 `_jdr_fts_<테이블 id>`, 트리거 `_jdr_fts_<테이블 id>_ai`·`_ad`·`_au`. 갱신 트리거는 `AFTER UPDATE OF <인덱스 열>`이라 `_updated_at`만 바뀌는 갱신은 인덱스를 건드리지 않는다. 이 이름은 `db/schema.js`에만 문자열로 둔다. 메타 접두사 `_jdr_`를 쓰므로 사용자 테이블 목록에서 자동으로 빠진다.
- 질의는 사용자 입력 전체를 `"..."` 구절 하나로 감싸고 안의 `"`는 `""`로 이스케이프한다. trigram 토크나이저에서 구절 일치는 부분 문자열 일치이므로 LIKE 폴백과 결과 의미가 같다(ASCII 대소문자 무시도 같다).
- 인덱스 생성·삭제는 D-08 커맨드다(생성은 `{ index }` 단계를 포함). 저널에 기록되고 되돌릴 수 있으며, 되돌리기·다시 실행은 진행률 없이 실행된다.
- 테이블을 지우면 그 테이블의 인덱스도 같은 커맨드에서 지운다(`tables.drop`). `DROP TABLE`은 원본 테이블의 트리거만 없애고 FTS5 가상 테이블과 그림자 테이블(`_data`·`_idx`·`_docsize`·`_config`)은 남기는데, 메타 행이 사라지면 UI에 손잡이가 없어 그 뒤로는 지울 수 없고 파일만 계속 차지한다.

### D-08. 모든 변경은 커맨드 객체이며, 되돌리기·저널·붙여넣기가 이 위에서 동작한다

- 커맨드 = `{ type, tableId, do: Statement[], undo: Statement[], summary, irreversible? }`. Worker의 `applyCommand(cmd, direction)`가 `do` 또는 `undo` 목록을 하나의 트랜잭션으로 실행한다. 커맨드는 구조화 복제 가능한 값이어야 한다(저널에 그대로 기록하고 Worker 경계를 넘는다).
- `Statement`는 네 가지다. `{ sql, params? }`는 파라미터 바인딩된 문장 하나이고, `{ batch: { sql, paramsList } }`는 같은 문장을 파라미터 목록만큼 반복하는 단계(Worker가 `engine.runBatch()`로 실행. 붙여넣기·다중 편집·행 다중 삭제와 그 되돌리기가 쓴다. 목록 하나는 `runBatch` 상한(1만 건·64 MB) 안이어야 하며 커맨드 생성기가 그 단위로 나눈다), `{ convert: { table, from, to, type, policy } }`는 열 타입 변경(Step 3)의 "변환 복사" 단계다. 변환 복사는 값 검증(`values.coerce`)이 JS에 있고 10만 행 이상에서 진행률·취소가 필요하므로 SQL 한 문장으로 쓰지 않고 Worker가 5,000행씩 읽어 `runBatch`로 갱신한다. `{ index: { table, fts, columns } }`는 검색 인덱스(Step 6, D-07)의 초기 인덱싱 단계다. Worker가 원본 테이블을 id 순으로 5,000행씩(직렬화 크기가 16 MB를 넘으면 더 잘게) 읽어 FTS 테이블에 `runBatch`로 넣으며 진행률·취소는 변환 단계와 같다. 그 밖의 단계는 모두 `{ sql, params }`다. 사유: 커맨드를 순수 SQL 목록으로 두면 되돌리기·저널 재생·붙여넣기가 실행기 하나로 끝나고, 변환·인덱싱 단계만 예외로 두면 진행률·취소 요구를 충족하면서 형식은 하나로 유지된다.
- 스키마 커맨드(테이블·열 생성·이름 변경·순서·소프트 삭제·타입 변경)는 Worker의 `db/tables.js`가 만들고 즉시 적용한 뒤 커맨드 객체를 메인에 돌려준다(`schema.*` op). 메인은 그 객체를 히스토리와 저널에 그대로 넣는다. 데이터 커맨드(Step 5)는 메인의 `app/commands.js`가 만들어 `command.apply`로 보낸다. 데이터 커맨드는 물리 이름(테이블 `id`, 열 `id`)으로 SQL을 만들고 값은 모두 바인딩한다. 되돌리기에 필요한 옛 값(셀 값, `_updated_at`, 삭제할 행 전체)은 커맨드를 만들기 전에 `query.rows`·`query.row`로 읽어 커맨드 안에 넣는다. 그래야 되돌리기가 DB를 다시 읽지 않고도 "적용 → 되돌리기 → 덤프 동일"을 만족하고, 저널에 기록된 커맨드만으로 재생이 끝난다.
- 되돌리기·다시 실행도 저널에 기록한다. 저널 재생은 항상 `do` 방향이므로, 되돌리기는 `do`와 `undo`를 맞바꾼 역커맨드(`commands.invert`)를 기록하고 다시 실행은 원래 커맨드를 다시 기록한다. 재생 결과는 사용자가 마지막으로 본 상태와 같다.
- 새 행의 `id`는 커맨드를 만들 때 정한다(`query.stats`의 `maxId + 1`부터 연속). SQLite가 배정하게 두면 되돌리기가 지울 행과 다시 실행이 만들 행의 `id`를 알 수 없다. 행은 언제나 `id` 순서의 끝에 붙는다. 그리드가 `id` 순으로 그리므로 "중간에 삽입"은 다른 행의 `id`를 바꿔야 하는데, 그러면 앞선 커맨드의 되돌리기가 가리키는 행이 달라진다.
- 되돌리기의 물리 삭제 예외: 커맨드가 스스로 만든 물리 테이블·열은 그 커맨드의 `undo`가 `DROP TABLE`·`DROP COLUMN`으로 지운다(테이블 생성, 열 추가, 타입 변경이 만든 새 열). 그 안에는 사용자 데이터가 없거나(빈 테이블, 새 열) 원본 열에 그대로 남아 있으므로(타입 변경) 아래 소프트 삭제 규칙과 충돌하지 않으며, 이렇게 해야 "적용 → 되돌리기 → DB 덤프 동일"이 성립하고 다시 실행의 `ADD COLUMN`이 이름 충돌 없이 재실행된다.
- 테이블 삭제(`tables.drop`)는 `undo`가 비어 있고 `irreversible: true`다. UI가 되돌릴 수 없음을 확인받고 히스토리를 비운다. `do`는 검색 인덱스 삭제(D-07) → 메타 정리 → `DROP TABLE` 순서다.
- 메인 스레드는 undo/redo 스택(최대 200개)을 유지하고, 같은 커맨드를 저널(D-04)에 기록한다.
- 대량 붙여넣기·행 다중 삭제는 하나의 복합 커맨드다. 되돌리기용 스냅샷이 10,000행을 넘으면 사용자에게 "되돌릴 수 없는 작업"임을 확인받고 히스토리를 비운다.
- 열 삭제는 **소프트 삭제**다. `_jdr_columns.deleted_at`만 설정하고 물리 열은 남긴다. 되돌리기가 가능하고 비용이 0이다. 물리 `DROP COLUMN`은 "데이터베이스 정리(VACUUM)" 메뉴에서만 수행한다.
- 예외: 가져오기(Step 7·8)는 커맨드가 아니다. 수십만 행을 커맨드 객체로 만들면 저널·되돌리기 상한을 모두 넘고 재생에 원본 파일이 필요하기 때문이다. `import.run`이 트랜잭션 하나로 직접 삽입하고, 성공 뒤 메인이 되돌리기 스택을 비우고 저널 기록을 멈춘 채 "지금 저장하세요"를 띄운다(Step 7 "가져오기는 커맨드가 아니다").

### D-09. 가져오기는 파서·추론·매핑·삽입의 4단계 파이프라인이며 파서는 행 이터레이터로 통일한다

- 모든 파서는 `AsyncIterable<{ rowIndex, cells: (string|number|boolean|Date|null)[] }>`를 반환한다. CSV와 XLSX가 같은 추론·매핑·삽입 코드를 공유한다.
- 추론은 표본 1,000행으로 하고, 삽입 중 표본 밖의 값이 타입에 맞지 않으면 열 단위 규칙(NULL 처리 / text 강등 / 중단)에 따른다.
- 전 과정은 Worker에서 실행하고 진행률 이벤트를 보낸다. 취소하면 트랜잭션을 롤백하고 만들다 만 테이블을 지운다.

### D-10. 클라우드 왕복은 수동 프로토콜로 지원하고 자동 병합은 하지 않는다

- 메타에 `db_id`, `revision`, `saved_at`, `saved_by`를 기록한다.
- 기기별 IndexedDB `known_revisions[db_id]`와 비교하여 파일 열기 시 경고 조건을 판정한다(4.3절).
- 앱은 절대 파일을 자동으로 덮어쓰지 않는다. 저장은 사용자의 명시적 동작(단축키 포함) 또는 사용자가 켠 자동 저장에 의해서만 일어난다.

### D-11. 메인 스레드와 Worker는 요청·응답 RPC로만 통신한다

- 메시지 형식은 6장에 정의한다. 전송 가능한 값(구조화 복제 가능)만 넘긴다. 큰 바이너리는 transferable로 이동한다.
- 이 경계 덕분에 Worker 미지원 환경 폴백(D-02), 테스트에서 Worker 없이 Node로 Worker 코드를 실행하는 것이 가능하다.
- 데스크톱 모드에서 Worker 안의 엔진 호출은 메인 스레드를 거쳐 타우리 IPC로 전달된다(D-15). 이 중계는 `db/client.js`의 전송 계층이 아니라 엔진 구현 안에서 처리하므로 RPC 프로토콜은 두 모드에서 같다.

### D-12. 기술 스택은 프레임워크 없는 Vanilla JS + JSDoc 타입이다

| 영역 | 선택 |
|---|---|
| 언어 | JavaScript(ES2022, ESM). 타입은 JSDoc으로 쓰고 `tsc --checkJs --noEmit --strict`로 검사 |
| 빌드 | Node.js 20+, `build/build.mjs`. 모듈 그래프 검사는 자체 구현이고 번들링은 esbuild를 빌드 도구로만 호출한다(런타임 의존 금지) |
| 단위 테스트 | `node:test`. SQLite Wasm은 Node에서도 동작하므로 스키마·질의·파서·커맨드 로직을 Node에서 검증 |
| E2E | Playwright(Chromium). `dist/jdrdatabase.html`을 `file://`로 열어 실제 산출물을 검증. 데스크톱은 같은 시나리오를 tauri-driver(WebDriver)로 Windows·Linux에서 실행 |
| 린트·포맷 | ESLint(flat config) + Prettier. Rust는 rustfmt + clippy(`-D warnings`) |
| 서드파티 런타임(JS) | 공식 SQLite Wasm(`@sqlite.org/sqlite-wasm`), SheetJS CE 두 개만. `vendor/`에 버전 고정 파일과 LICENSE, SHA-256을 함께 커밋 |
| 데스크톱 셸 | Tauri 2 + Rust(stable). SQLite는 `rusqlite`(`bundled`). Rust 의존성은 `tauri`(플러그인 dialog, fs, single-instance 포함), `rusqlite`, `serde`, `serde_json`으로 제한. 단위 테스트는 `cargo test` |

- 프레임워크를 쓰지 않는 사유: 가상 그리드는 어차피 직접 DOM을 제어해야 하고, 단일 파일 크기와 시작 시간을 아끼며, 의존성 수명 문제를 피한다.

### D-13. 브라우저·데스크톱 지원

- 1순위: Chromium 계열(Chrome, Edge) 최신 2개 버전. File System Access API로 완전한 경험.
- 2순위: Firefox, Safari 최신 버전. 다운로드 폴백으로 동작하되 "저장 시 파일이 다운로드 폴더에 생성됨"을 안내.
- `file://`로 직접 연 경우와 로컬 정적 서버로 연 경우 모두 지원한다. `file://`에서의 Worker(Blob URL), IndexedDB, File System Access API 가용성은 브라우저마다 다르므로 모두 기능 감지 후 폴백한다. Step 1·2에서 실측하여 지원 매트릭스를 README에 기록한다.
- 데스크톱: 타우리 2가 지원하는 Windows 10+(WebView2), macOS 11+(WKWebView), Linux(WebKitGTK 2.40+). WebView마다 IndexedDB·CompressionStream 가용성이 다르므로 브라우저와 같은 기능 감지를 적용한다. 파일 접근은 타우리 플러그인이 담당하므로 File System Access 가용성 문제는 데스크톱에 없다.

### D-14. UI 문자열은 한국어 기본이며 문자열 테이블로 분리한다

- `src/i18n/ko.js`가 기본, `en.js`는 키만 준비한다. 코드에 리터럴 UI 문자열을 쓰지 않는다.

### D-15. 엔진 백엔드를 이중화하고, 데스크톱 모드는 작업 사본 위에서 네이티브 SQLite를 쓴다

- 교체 지점은 엔진 원시 계층이다. `db/engine.js`는 인터페이스와 선택 로직만 가지고, 구현은 `db/engine-wasm.js`(SQLite Wasm, 브라우저 모드)와 `db/engine-native.js`(타우리 IPC → 러스트 rusqlite, 데스크톱 모드) 둘이다. `query.js`, `tables.js`, `search.js`, `import/*`, `export/*`는 엔진 인터페이스만 호출하므로 두 모드에서 같은 코드가 돈다.
- 엔진 인터페이스(Step 1에서 고정):

```js
init(opts)                     // wasm: { wasmBinary } / native: {}
capabilities()                 // { mode, maxFileBytes, warnFileBytes, persistence, cancellable, fts5 }
open(source)                   // wasm: bytes / native: { originalPath }
close()
exec(sql, params)              // 읽기. 결과 행 배열. 1만 행 초과 거부
run(sql, params)               // 쓰기 한 문장. { changes, lastId }
runBatch(sql, paramsList)      // 같은 문장을 파라미터 목록만큼 반복. 하나의 트랜잭션. 가져오기·붙여넣기 전용
transaction(fn)                // BEGIN / COMMIT / ROLLBACK
prepareCached(sql)             // wasm 전용 최적화. native는 no-op 핸들
snapshot()                     // wasm: Uint8Array(sqlite3_js_db_export) / native: E_UNSUPPORTED
saveTo(originalPath, expected) // native 전용. VACUUM INTO 임시 → 원자적 교체
interrupt()                    // 진행 중 문장 중단
```

- 모드 선택은 시작 시 타우리 전역 객체(`window.__TAURI_INTERNALS__`)의 존재로 판정한다. 판정은 `main.js` 한 곳에서만 하고 결과를 스토어에 둔다. 다른 모듈은 `capabilities()`를 읽고 모드 문자열을 비교하지 않는다.
- 상한은 엔진이 보고한다. wasm은 `warnFileBytes` 700 MB, `maxFileBytes` 1.5 GB이고 native는 둘 다 `Infinity`다. 파일 열기·가져오기·붙여넣기의 크기 검사는 모두 이 값을 기준으로 하며 UI 코드에 숫자를 두지 않는다.
- Worker 안에서는 타우리 invoke를 직접 쓸 수 없다. `engine-native.js`는 Worker에서 실행되면 메인 스레드에 `engine:call` 메시지로 호출을 위임하고, 메인의 `io/ipc-bridge.js`가 invoke로 러스트 명령을 부른 뒤 `engine:result`로 되돌린다. 왕복이 한 번 늘어나므로 가져오기·붙여넣기는 `runBatch`로 1,000행을 한 번에 보낸다. 창 질의(200행)는 왕복 1회라 영향이 없다.
- 작업 사본 모델. 데스크톱 모드는 사용자가 고른 원본 파일을 직접 열지 않는다. 앱 데이터 폴더 `workcopies/<db_id>/current.db`로 복사한 뒤 그 사본을 연다. 사유: (1) 네이티브 SQLite가 원본을 직접 쓰면 `-journal`·`-wal` 부속 파일이 클라우드 폴더에 생겨 D-10의 전제가 깨진다. (2) 클라우드 클라이언트가 열린 파일을 잠그거나 교체하는 일이 사본에는 일어나지 않는다. (3) "명시적 저장 전까지 원본은 바뀌지 않는다"는 브라우저 모드와 같은 의미가 유지된다.
- 저장은 `VACUUM INTO '<원본>.tmp-<랜덤>'` 후 원본 자리에 rename(같은 볼륨이므로 원자적)이다. rename 전에 기존 원본을 `<원본>.bak`으로 옮겨 1세대 백업을 남긴다(브라우저 모드의 IDB 백업에 해당). 저장 시간은 파일 크기에 비례하며, 클라우드 전체 업로드와 같은 차수다.
- 미저장 변경은 작업 사본 자체에 남는다. 브라우저 모드의 IDB 저널은 데스크톱 모드에서 쓰지 않는다. 다음 실행에서 같은 `db_id`의 작업 사본에 dirty 표식(`_jdr_meta.dirty = 1`, 커맨드 적용 시 설정하고 저장 성공 시 해제)이 있으면 4.3절의 저널 조건과 같은 판정으로 "저장되지 않은 변경 복구" 흐름에 들어간다.
- 원본이 열려 있는 동안 디스크에서 바뀌는 경우(다른 PC에서 동기화됨): 저장 직전에 원본의 mtime·크기를 열 때 값과 비교하고, 다르면 `E_ORIGINAL_CHANGED`로 저장을 멈추고 "덮어쓰기 / 다른 이름으로 저장 / 취소"를 묻는다.
- 러스트 쪽: 관리 상태의 `Mutex<Option<Connection>>` 하나. 긴 명령은 `spawn_blocking`에서 실행하고 진행률은 `tauri::ipc::Channel`로 보낸다. 취소는 `InterruptHandle::interrupt()`. 작업 사본에는 `PRAGMA journal_mode=WAL`을 적용해 읽기·쓰기 동시성을 얻고(사본은 클라우드 폴더 밖이라 부속 파일이 문제되지 않음), 저장 전 `wal_checkpoint(TRUNCATE)`를 실행한다. rusqlite `bundled` 빌드에 FTS5가 포함되는지는 Step 1의 wasm 검사와 같은 방식으로 `PRAGMA compile_options`를 `cargo test`에서 고정한다.
- 파일 대화상자와 경로 접근은 타우리 dialog·fs 플러그인을 쓰며, `io/filesystem.js`가 `capabilities()`에 따라 구현을 고른다. 브라우저 모드의 폴백 사다리(D-04)는 데스크톱 모드에 존재하지 않는다.
- 데스크톱 모드에서 IPC가 실패하면 wasm 엔진으로 폴백하지 않는다. 폴백하면 상한이 조용히 되돌아와 사용자가 큰 파일을 열다 실패하게 되므로, `E_NATIVE_IPC`로 앱을 잠그고 원인을 보여 준다.
- 하지 않는 것: 원본을 직접 여는 "직접 모드"는 v1에 없다(작업 사본 복사가 부담되는 수십 GB 파일은 v1.1에서 옵션으로 검토). CSV·XLSX 파서는 두 모드 모두 JS Worker에서 돌리며, 러스트 파서로 옮기는 것은 Step 11의 성능 측정 후 판단한다.

---

## 3. 아키텍처

### 3.1 모듈 구성

```
dist/jdrdatabase.html            ← 브라우저용 빌드 산출물 (배포 단위)
dist/tauri/index.html            ← 타우리용 변형 (메타 CSP 없음, 나머지 동일)

src/
  main.js                        부트스트랩: 기능 감지, 모드 판정(브라우저/데스크톱), Worker 기동, 초기 화면
  app/
    store.js                     앱 상태(열린 파일, 현재 테이블·뷰, 선택, dirty) + 이벤트 버스
    history.js                   undo/redo 스택, 저널 연동
    commands.js                  커맨드 생성 함수(셀 편집, 행 추가·삭제, 열 추가·변경·소프트삭제, 붙여넣기)
    revision.js                  revision 판정표(4.3)의 순수 함수
    shortcuts.js                 키보드 단축키 매핑
  ui/
    grid/
      grid.js                    가상 그리드 컨트롤러(뷰포트 계산, 행·열 풀, 스크롤)
      cells.js                   셀 렌더러(타입별 표시, 미리보기, 배지)
      cache.js                   블록 캐시(D-06): 200행 블록 LRU 50개, 테이블 단위 무효화
      selection.js               셀·범위·행 선택 모델(순수 상태, DOM 없음)
      clipboard.js               TSV 직렬화·파싱(순수 함수)과 복사·붙여넣기 계획
      editing.js                 편집 컨트롤러: 그리드 선택·편집기·클립보드·데이터 커맨드·히스토리를 잇는다
    editor/
      inline.js                  인라인 편집기(input, 타입별 검증, IME 처리)
      longtext.js                사이드 패널 장문 편집기
    dialogs/
      dialog.js                  모달 기반(포커스 트랩, Esc, 버튼 행). 다른 대화상자가 이 위에 만들어진다
      table.js column.js filter.js import.js export.js settings.js conflict.js
    toolbar.js sidebar.js statusbar.js toast.js
  io/
    filesystem.js                File System Access + 폴백 다운로드 + 타우리 dialog/fs 추상화
    ipc-bridge.js                메인 스레드에서 Worker의 engine:call 메시지를 타우리 invoke로 중계
    idb.js                       IndexedDB 래퍼(handles, journal, backups, known_revisions, settings)
    autosave.js                  저널 기록·복구, 자동 저장 타이머
    tablock.js                   BroadcastChannel로 같은 db_id를 연 다른 탭 감지(두 번째 탭은 읽기 전용)
  db/
    client.js                    RPC 클라이언트(메인 측), Worker/인라인 전송 선택
    worker.js                    Worker 진입점: RPC 디스패치
    engine.js                    엔진 인터페이스, 모드별 구현 선택, 공통 검증(1만 행 상한, 배치 크기)
    engine-wasm.js               SQLite Wasm 구현: 초기화, snapshot(export), statement 캐시, PRAGMA
    engine-native.js             타우리 구현: IPC 호출, Worker→메인 중계 클라이언트
    schema.js                    메타 테이블 DDL, 마이그레이션, 헤더·무결성 검사, 외부 파일 등록, 식별자 인용
    command.js                   커맨드 실행기(D-08): 문장 목록을 하나의 트랜잭션으로, 변환 단계는 청크·진행률·취소
    tables.js                    테이블·열 CRUD(메타 + DDL)를 커맨드로 만들어 적용
    query.js                     창 질의 빌더(정렬·필터·검색), count, 뷰 스펙 정규화·정리
    views.js                     뷰(_jdr_views) 저장·삭제를 커맨드로, 목록·불러오기
    values.js                    논리 타입 ↔ 저장값 변환·검증
    search.js                    FTS5 인덱스 생성·삭제·질의
  import/
    csv.js                       스트리밍 CSV 파서(인코딩·구분자 감지)
    xlsx.js                      SheetJS 어댑터
    infer.js                     타입 추론
    pipeline.js                  매핑 적용·트랜잭션 삽입·진행률·취소
  export/
    csv.js xlsx.js
  i18n/
    ko.js en.js index.js
  util/
    errors.js                    AppError, 오류 코드
    ids.js                       uuid, 물리 이름
    format.js                    숫자·날짜 표시
    bytes.js                     base64, 크기 계산
  styles/
    app.css grid.css editor.css dialogs.css
  types/
    build-constants.d.ts         빌드가 define으로 치환하는 컴파일 타임 상수(__JDR_TEST__, __JDR_VERSION__) 선언

vendor/
  sqlite3.mjs sqlite3.wasm sqlite3.d.mts LICENSE.sqlite-wasm CHECKSUMS
  xlsx.full.min.js xlsx.full.min.d.ts LICENSE.sheetjs

build/
  build.mjs                      단일 HTML 생성(브라우저·타우리·테스트 세 변형)
  verify.mjs                     산출물 검증(외부 참조 0건, 크기 예산, CSP, 두 변형의 동일성, vendor 체크섬)
  template.html                  산출물 템플릿(자리표시자: CSP_META, CSS, WORKER_JS, WASM_B64, MAIN_JS)

docs/
  sessions.md                    세션별 검증 기록(5.0의 A~I와 점검 세션). 세션마다 절 하나, 미확인 항목은 "미확인"으로 남긴다
  support-matrix.md              브라우저·WebView API 가용성 실측표(R1, R8). 미확인 항목은 "미확인"으로 남긴다

src-tauri/
  Cargo.toml tauri.conf.json build.rs
  src/
    main.rs                      타우리 진입점, 플러그인 등록(dialog, fs, single-instance)
    db.rs                        커넥션 상태, 명령: open/close/exec/run/run_batch/begin/commit/rollback/interrupt/capabilities
    save.rs                      VACUUM INTO, .bak 회전, 원자적 교체, mtime 검사
    workcopy.rs                  앱 데이터 폴더 경로, 작업 사본 복사·목록·정리
    error.rs                     AppError 직렬화(JS 오류 코드와 1:1), rusqlite 오류 매핑
  tests/                         cargo test(저장 원자성, 배치, 인터럽트, 한글 경로)

test/
  unit/                          node:test. db/helpers.js는 엔진 테스트 공용 도우미(wasm 로드)
  e2e/                           Playwright(브라우저), 같은 시나리오를 tauri-driver로 재사용
  perf/                          성능 측정(`npm run test:perf`, playwright.perf.config.js). 30만 행 픽스처를 만들어 8장 예산을 잰다. CI 밖에서 실행
  fixtures/                      CSV·XLSX·DB 표본. import/는 Step 7·8 파서 픽스처. generated/는 gen-fixture 산출물(커밋하지 않음)
scripts/
  gen-fixture.mjs                벤치마크용 대용량 CSV·DB 생성(`--db`는 wasm 엔진으로 표준 SQLite 파일을 만든다)
  gen-import-fixtures.mjs        test/fixtures/import/의 CSV·XLSX 픽스처를 다시 만든다(바이트가 고정된 생성기)
```

### 3.2 실행 시 구조

```
┌───────────────── Main thread ─────────────────┐
│ ui/*  ──이벤트──▶ app/store ──▶ app/history   │
│   ▲                  │               │        │
│   └───렌더────────────┘               ▼        │
│                              io/autosave(IDB) │
│                                               │
│ db/client ─── postMessage RPC ───────────────┐│
└──────────────────────────────────────────────┼┘
                                               ▼
┌───────────────── Worker ──────────────────────┐
│ db/worker ─▶ db/engine ─▶ engine-wasm(sqlite3) │
│           ─▶ db/query, tables, search, values │
│           ─▶ import/* (파서·추론·삽입)          │
└───────────────────────────────────────────────┘
        ▲ 파일 바이트(transfer)          │ snapshot 바이트(transfer)
        └──── io/filesystem ◀────────────┘
```

데스크톱 모드는 Worker와 RPC가 같고 엔진 구현만 바뀐다. Worker의 `engine-native`는 SQL 호출을 메인에 위임하고, 메인의 `ipc-bridge`가 러스트로 보낸다.

```
┌──────── Main thread ────────┐      ┌──────────── Worker ────────────┐
│ db/client ── RPC ───────────┼─────▶│ db/worker ─▶ db/engine         │
│ io/ipc-bridge ◀─engine:call─┼──────│           ─▶ engine-native     │
│      │        ─engine:result┼─────▶│           ─▶ query, import/*   │
└──────┼──────────────────────┘      └────────────────────────────────┘
       │ invoke / Channel(진행률)
       ▼
┌──────────────── Rust (src-tauri) ────────────────┐
│ db.rs ─▶ rusqlite ─▶ 작업 사본 current.db (WAL)   │
│ save.rs: VACUUM INTO tmp → 원본→.bak → tmp→원본    │
└──────────────────────────────────────────────────┘
```

### 3.3 대표 흐름

**스크롤**: 스크롤 이벤트 → `grid.computeRange()` → 캐시에 없는 블록만 `client.fetchWindow(tableId, viewSpec, offset, limit)` → Worker `query.buildWindowSQL()` 실행 → 행 배열 반환 → 캐시 저장 → 행 풀 재사용하여 렌더.

**셀 편집**: 인라인 편집기 확정 → `values.validate(type, raw)` → `commands.editCell()`이 커맨드 생성 → `history.push()` → `client.applyCommand()` → Worker 트랜잭션 실행 → 성공 시 캐시의 해당 행 갱신, 저널 기록, dirty 표시. 실패 시 히스토리에서 제거하고 토스트.

**저장(브라우저 모드)**: `Ctrl+S` → `client.call('db.snapshot')`(Worker가 `revision+1`, `saved_at`, `saved_by` 기록 후 `snapshot()`) → 바이트 transfer → 기존 파일 백업(IDB) → `filesystem.write()` → 성공 시 저널 비움, `known_revisions` 갱신, dirty 해제.

**저장(데스크톱 모드)**: `Ctrl+S` → `client.call('db.save', { originalPath })` → Worker가 메타를 같은 방식으로 기록하고 `engine.saveTo()` 호출 → `ipc-bridge` → 러스트 `save_to`: 원본 mtime·크기 검사 → `wal_checkpoint(TRUNCATE)` → `VACUUM INTO` 임시 파일 → 원본을 `.bak`으로 이동 → 임시 파일을 원본으로 rename → 작업 사본의 dirty 표식 해제 → 성공 시 `known_revisions` 갱신, dirty 해제. `store.save()`는 `capabilities().persistence`가 `snapshot`인지 `native`인지로 두 경로를 고른다.

---

## 4. 데이터 모델

### 4.1 메타 테이블

```sql
CREATE TABLE IF NOT EXISTS _jdr_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
-- keys: schema_version, db_id, revision, saved_at, saved_by, created_at, app_version,
--       dirty (데스크톱 모드 작업 사본 전용, D-15)

CREATE TABLE IF NOT EXISTS _jdr_tables (
  id TEXT PRIMARY KEY,            -- 물리 테이블 이름. 앱 생성 't_' || 8hex, 외부 파일 등록 시 원래 이름
  name TEXT NOT NULL,             -- 표시 이름
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  fts_enabled INTEGER NOT NULL DEFAULT 0,
  strict INTEGER NOT NULL DEFAULT 1   -- 0이면 다른 도구가 만든 비STRICT 테이블(Step 2 등록). v1은 읽기 전용
) STRICT;

CREATE TABLE IF NOT EXISTS _jdr_columns (
  id TEXT NOT NULL,               -- 물리 열 이름. 앱 생성 'c_' || 8hex, 외부 파일 등록 시 원래 이름
  table_id TEXT NOT NULL REFERENCES _jdr_tables(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  type TEXT NOT NULL,             -- 4.2 논리 타입
  position INTEGER NOT NULL,
  width INTEGER NOT NULL DEFAULT 160,
  options TEXT,                   -- JSON: select 항목, 숫자 소수 자릿수 등
  deleted_at TEXT,                -- 소프트 삭제 (D-08)
  PRIMARY KEY (table_id, id)      -- 외부 파일의 서로 다른 테이블이 같은 열 이름을 가질 수 있으므로 테이블 단위로 고유
) STRICT;

CREATE TABLE IF NOT EXISTS _jdr_views (
  id TEXT PRIMARY KEY,
  table_id TEXT NOT NULL REFERENCES _jdr_tables(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  spec TEXT NOT NULL              -- JSON: sort[], filter, hidden[], search, widths, frozen (Step 6)
) STRICT;
```

`schema_version`은 정수이며 `db/schema.js`의 마이그레이션 배열 길이와 같다. 앱보다 새로운 `schema_version`의 파일은 읽기 전용으로 열고 경고한다. 열 메타는 항상 `(table_id, id)`로 조회한다. 시스템 열(`id`, `_created_at`, `_updated_at`)은 `_jdr_columns`에 넣지 않는다.

### 4.2 논리 타입과 물리 저장

| 논리 타입 | STRICT 물리 타입 | 저장 규칙 | 표시·편집 |
|---|---|---|---|
| `text` | TEXT | 그대로. 앞뒤 공백 유지 | 인라인 input |
| `longtext` | TEXT | 그대로 | 사이드 패널 textarea, 그리드에는 256자 미리보기 |
| `integer` | INTEGER | 안전 정수 범위(±2^53) 검증 | 우측 정렬 |
| `real` | REAL | 유한 수만 허용 | 소수 자릿수 옵션 |
| `boolean` | INTEGER | 0/1 | 체크박스 |
| `date` | TEXT | `YYYY-MM-DD` | 날짜 입력 |
| `datetime` | TEXT | `YYYY-MM-DDTHH:mm:ss` (표준시 정보 없음, 스프레드시트 의미) | 날짜시간 입력 |
| `select` | TEXT | `options.choices` 중 하나. 없는 값은 편집 시 거부, 가져오기 시 자동 추가 | 드롭다운 |

- NULL은 모든 타입에서 "비어 있음"이다. 빈 문자열과 NULL을 구분하지 않고, 편집기에서 빈 값을 확정하면 NULL을 저장한다.
- 텍스트 정렬은 `COLLATE NOCASE`(ASCII만 대소문자 무시). 한글은 코드 포인트 순서가 가나다 순과 일치한다. 로케일 정렬은 v1 비목표.
- 타입 변경(`ALTER` 상당)은 "새 열 생성 → 변환 복사 → 옛 열 소프트 삭제"로 수행하며 하나의 커맨드로 되돌릴 수 있다.

### 4.3 revision 프로토콜 (D-10)

파일을 열 때:

| 조건 | 판정 | 조치 |
|---|---|---|
| `known[db_id]` 없음 | 이 기기에서 처음 여는 파일 | 정상 |
| `file.revision >= known.revision` | 정상 | `known` 갱신 |
| `file.revision < known.revision` | 이 기기에서 더 나중 버전을 저장한 적이 있음. 클라우드 동기화가 덜 된 파일일 가능성 | 경고 대화상자: "그대로 열기 / 취소" |
| 저널에 `db_id` 일치, `base_revision == file.revision` | 미저장 변경 존재 | "복구 / 버리기" 선택 |
| 저널에 `db_id` 일치, `base_revision != file.revision` | 다른 버전 위의 미저장 변경 | 경고 후 "버리기 / 별도 파일로 내보내기" |

데스크톱 모드에서는 "저널" 조건을 "dirty 표식이 있는 작업 사본"으로 읽는다. 작업 사본의 `_jdr_meta.revision`이 `base_revision` 역할을 하고, 원본 파일의 `revision`과 비교한다.

---

## 5. 단계별 구현 계획

Step은 설계·검증의 단위이고, 세션은 구현·검증의 단위다. Step 0~11을 아래 5.0의 세션 A~I로 묶어 순서대로 진행한다. 구현은 하나의 작업 브랜치와 그 브랜치의 PR 하나에서 이루어지며, 세션 하나는 Step 단위 커밋의 묶음으로 끝나 그 브랜치에 푸시된다. 세션의 결과는 푸시마다 도는 CI와 PR 설명의 세션별 검증 기록으로 확인한다. 묶음에 속한 모든 Step의 "완료 기준"이 충족되어야 다음 세션으로 간다. 단계 안의 세부 순서는 위에서 아래로 진행한다.

### 5.0 세션 구성

| 세션 | Step | 한 세션에 두는 이유 |
|---|---|---|
| A | 0 + 1 | 빌드 스크립트는 wasm 인라인과 Worker 기동이 있어야 검증된다. 엔진 인터페이스와 적합성 테스트를 이 세션에서 고정한다 |
| B | 2 + 3 | 파일 열기·저장의 E2E("테이블 생성 → 저장 → 재열기")가 테이블 생성을 필요로 한다. 둘 다 DB·메타 쪽 코드다 |
| C | 4 | 가상 그리드. 30만 행 픽스처로 프레임·질의 시간을 측정하며 고치는 루프가 완료 기준이다 |
| D | 5 | 편집기·IME·되돌리기·붙여넣기. 그 자체로 크다 |
| E | 6 | 정렬·필터·FTS·뷰. 질의 빌더 중심이라 편집과 섞지 않는다 |
| F | 7 + 8 | 추론·매핑·삽입 파이프라인을 공유한다. XLSX는 파서 어댑터만 더한다 |
| G | 9 | 내보내기·gzip·백업·클라우드 안내 |
| H | 10 | 성능·메모리·오류 주입·접근성 검증. 앞 세션의 결과를 새 컨텍스트에서 점검한다 |
| I | 11 | 타우리 셸과 네이티브 엔진. Rust 툴체인, 플랫폼 CI, tauri-driver |

묶음 기준:
1. 두 Step의 완료 기준이 서로를 필요로 하거나 같은 파일을 크게 공유하면 묶는다.
2. 성능 측정 루프가 완료 기준인 Step(4, 10, 11)은 혼자 둔다.
3. 툴체인이 다른 Step(11)은 혼자 둔다.
4. 묶은 Step이라도 커밋은 Step 단위로 나눈다. 리뷰어가 diff를 Step별로 볼 수 있어야 한다.

세션 절차:
- 시작: 작업 브랜치를 원격 최신으로 맞춘다. `CLAUDE.md` 2장 순서로 문서를 읽고, 그 상태에서 `npm run check`(세션 I는 `cargo test` 포함)가 초록인지 확인한다. 직전 세션이 PR 설명에 "미확인"으로 남긴 항목을 이어받는다.
- 진행: 같은 브랜치에서 세션을 동시에 두 개 돌리지 않는다. 한 세션이 끝나 푸시된 뒤에 다음 세션을 시작한다.
- 종료: Step 단위 커밋을 푸시하고, PR 설명에 세션 이름의 절을 추가해 묶음에 속한 모든 Step의 완료 기준을 항목별로 옮겨 적고 검증 결과를 표시한다. 검증하지 못한 항목은 "미확인"으로 남긴다.
- 세션 도중 컨텍스트가 부족해지면 완료된 Step까지만 커밋·푸시하고 PR 설명에 기록한 뒤, 남은 Step은 같은 세션 이름의 후속 세션(예: B-2)으로 이어 간다. 완료 기준을 낮추어 끝내지 않는다.

### Step 0. 저장소 골격과 빌드·테스트 기반

**목표**: 빈 앱이 단일 HTML로 빌드되고, 테스트·린트·타입 검사 명령이 동작한다.

**산출물**
- `package.json`(scripts: `build`, `verify`, `test`, `test:e2e`, `lint`, `typecheck`, `check`), `tsconfig.json`(`checkJs`, `strict`, `noEmit`), `eslint.config.js`, `.prettierrc`
- `build/build.mjs`, `build/verify.mjs`
- `src/main.js`, `src/styles/app.css`, `src/i18n/*`
- `test/unit/build.test.js`, `test/e2e/smoke.spec.js`
- `.github/workflows/ci.yml`(check + build + e2e)

**주요 함수**
- `build.mjs`: `readModuleGraph(entry)`, `inlineImports(graph)`(ESM import를 단일 스코프로 접는 자체 번들러이거나 esbuild 호출), `embedBase64(path)`, `renderTemplate({ css, mainJs, workerJs, wasmB64 })`, `writeDist()`
- `verify.mjs`: `assertNoExternalRefs(html)`(`http://`, `https://`, `src=`/`href=`에 외부 경로 없음), `assertSizeBudget(html, 6 * 1024 * 1024)`, `assertCsp(html)`

**예외 처리**
- 빌드 중 import 순환 감지 시 실패. 상대 경로가 `src/`·`vendor/` 밖을 가리키면 실패.
- `verify` 실패는 빌드 실패로 취급하고 CI에서 막는다.

**완료 기준**
- `npm run check`(lint + typecheck + unit) 통과, `npm run build && npm run verify` 통과
- Playwright가 `file://.../dist/jdrdatabase.html`을 열어 제목 텍스트를 확인

### Step 1. 엔진 인터페이스, wasm 엔진, RPC 계층

**목표**: 두 모드가 공유할 엔진 인터페이스(D-15)를 고정하고, 그 첫 구현인 SQLite Wasm 엔진이 Worker 안에서 기동하며, 메인에서 RPC로 SQL을 실행하고, 메모리 DB를 바이트로 내보내고 다시 연다.

**산출물**: `db/engine.js`, `db/engine-wasm.js`, `db/worker.js`, `db/client.js`, `util/errors.js`, `util/bytes.js`, `vendor/sqlite3.*`

**주요 함수**
- `engine.js`: D-15 인터페이스의 JSDoc `@typedef Engine`, `selectEngine(mode)`, 공통 검증 래퍼(결과 1만 행 상한, `runBatch` 파라미터 목록 1만 건 상한, 배치 직렬화 크기 64 MB 상한)
- `engine-wasm.js`: `init({ wasmBinary })`, `open(bytes?)`, `close()`, `exec(sql, params)`, `run(sql, params)`, `runBatch(sql, paramsList)`(하나의 트랜잭션에서 prepared statement를 bind → step → reset 반복), `prepareCached(sql)`, `transaction(fn)`, `snapshot()`(`sqlite3_js_db_export`를 감싸고 statement 캐시 무효화·PRAGMA 재적용 수행), `applyPragmas()`, `interrupt()`, `capabilities()` → `{ mode: 'wasm', warnFileBytes: 700 MB, maxFileBytes: 1.5 GB, persistence: 'snapshot' }`
- `client.createClient({ transport })`, `client.call(op, args, { transfer, onProgress, signal })`
- `worker.js`: `dispatch(msg)` → `handlers[op]`. 진행 이벤트 `{ id, progress: { done, total, phase } }`
- `createTransport()`: Worker 생성 시도 → 실패 시 `InlineTransport`(같은 스레드에서 `dispatch` 직접 호출)

**예외 처리**
- Worker 생성 실패(`SecurityError`, `file://` 제한): 인라인 전송으로 폴백하고 상태바에 "단일 스레드 모드" 표시.
- wasm 인스턴스화 실패(메모리 부족, 지원 안 되는 브라우저): 시작 화면에 원인과 지원 브라우저 안내를 표시하고 앱을 잠근다.
- export 이후 statement 캐시 무효화와 PRAGMA 재적용을 `snapshot()` 내부에서 반드시 수행한다(D-02). `snapshot()` 바깥에서 `sqlite3_js_db_export`를 직접 부르는 코드는 두지 않는다.
- `runBatch`의 파라미터 목록이 1만 건을 넘거나 직렬화 크기가 64 MB를 넘으면 `E_BATCH_TOO_LARGE`로 거부한다(호출자가 나눠 보내야 한다).
- `interrupt()`는 wasm 모드에서 `sqlite3_interrupt`를 부른다. 엔진이 단일 스레드 Worker 안에서 돌기 때문에 실행 중인 문장 도중에 호출될 수는 없고, `runBatch`가 행 사이에서 확인하는 취소 표식으로 동작한다. 표식은 배치 진입 시점이 아니라 그것을 본 배치가 지운다. 배치가 시작되기 직전에 들어온 취소도 첫 행 전에 멈추기 위해서다.
- `runBatch` 도중 한 행이라도 실패하면 전체를 롤백하고 실패한 파라미터 인덱스를 `detail`에 담아 던진다.
- RPC 타임아웃은 두지 않는다(대용량 작업은 수십 초가 정상). 대신 취소 신호(`signal`)를 지원하는 작업만 취소 가능하고, 그 외에는 진행률만 보고한다.
- 취소 메시지는 Worker의 태스크 큐로 들어오므로, 긴 작업은 청크 사이에서 이벤트 루프로 한 번 돌아와야 그 메시지를 받는다. 작업 안의 `await`가 모두 마이크로태스크면 작업이 끝난 뒤에야 취소가 배달되어 취소 버튼이 동작하지 않는다. 청크로 나눠 도는 작업(변환 복사, 가져오기)은 청크마다 태스크 한 번을 양보한다.
- 메시지 크기: 결과 행이 10,000행을 넘는 요청은 Worker가 `E_RESULT_TOO_LARGE`로 거부한다(창 질의만 허용, 전체 SELECT 금지).

**완료 기준**
- 단위 테스트: Node에서 `engine`을 초기화해 `PRAGMA compile_options`에 `ENABLE_FTS5`가 있고 `sqlite_version() >= 3.37`임을 고정한다.
- 왕복 테스트: 테이블 생성 → `snapshot()` → 새 엔진에 `open(bytes)` → 같은 데이터.
- 단위: `runBatch` 1만 행이 단일 트랜잭션으로 원자적(중간 행 실패 주입 시 0행 삽입).
- 단위: 인터페이스 적합성 테스트를 엔진 구현과 분리된 파일(`test/unit/db/engine-contract.test.js`)로 두어 Step 11의 네이티브 엔진이 같은 테스트를 통과하게 한다.
- E2E: Worker 모드와 인라인 모드 각각에서 `SELECT 1` 성공.

### Step 2. 파일 열기·저장·저널·백업

**목표**: 사용자가 새 DB를 만들고, `.db` 파일을 열고, 저장하고, 탭을 닫았다 열어도 미저장 변경을 복구할 수 있다.

**산출물**: `io/filesystem.js`, `io/idb.js`, `io/autosave.js`, `io/tablock.js`, `app/store.js`(파일 상태 부분), `app/revision.js`, `db/schema.js`(메타 DDL·마이그레이션·헤더·무결성·외부 등록), `db/command.js`(저널 재생이 쓰는 커맨드 실행기), `ui/toolbar.js`, `ui/statusbar.js`, `ui/toast.js`, `ui/dialogs/dialog.js`, `ui/dialogs/conflict.js`

**주요 함수**
- `filesystem.capabilities()` → `{ fsa: boolean, idb: boolean, native: boolean }`. `native`는 데스크톱 모드에서만 참이며, 그때 `pickOpen()`·`pickSaveAs()`는 타우리 dialog 플러그인을 호출해 경로 문자열을 돌려주고 `readAll()`·`write()`는 호출되지 않는다(바이트 이동은 러스트가 담당). 이 분기는 이 단계에서 인터페이스와 스텁만 두고 구현은 Step 11에서 채운다.
- `filesystem.pickOpen()`, `filesystem.pickSaveAs(suggestedName)`, `filesystem.readAll(handleOrFile)` → `Uint8Array`, `filesystem.write(handle, bytes)`, `filesystem.download(name, bytes)`
- `idb.open()`; 스토어 `handles`, `journal`, `backups`, `known_revisions`, `settings`
- `autosave.recordCommand(cmd)`, `autosave.clear()`, `autosave.recoverable(dbId)`, `autosave.replay(commands)`. 저널은 가장 최근에 편집한 DB 하나의 기록만 담는다(다른 `db_id`의 기록이 시작되면 이전 기록은 지운다). 저장한 적 없는 새 DB의 기록은 `fileName = null`로 남기고, 다음 시작 때 같은 `db_id`의 빈 DB를 만들어(`db.open { dbId }`) 재생을 제안한다.
- `store.openFile()`, `store.newDatabase()`, `store.save()`, `store.saveAs()`, `store.markDirty()`
- `revision.judge({ fileRevision, known, journal })` → 4.3 판정표의 한 행(`first` / `ok` / `behind` / `journal` / `journalMismatch`)
- `tablock.claim(dbId)` → 다른 탭이 같은 `db_id`를 쥐고 있으면 `{ heldElsewhere: true }`
- `schema.validateHeader(bytes)`(SQLite 매직 헤더 `SQLite format 3\0` 확인), `schema.integrityCheck()`, `schema.hasMeta()`, `schema.readMeta()`, `schema.migrate()`, `schema.adoptExternal()`(다른 도구가 만든 파일의 테이블을 `strict = 0`으로 등록), `schema.bumpRevision({ savedBy })`
- `command.applyCommand(engine, cmd, direction, ctx)`(D-08 실행기. Step 3의 스키마 커맨드와 Step 5의 데이터 커맨드가 같은 실행기를 쓴다)

**예외 처리**
- SQLite 파일이 아님 / 손상: `E_FILE_NOT_SQLITE`, `E_FILE_CORRUPT`(`PRAGMA integrity_check` 실패). 열지 않고 안내.
- `_jdr_meta`가 없는 일반 SQLite 파일: `db.open`이 DB를 연 채 `unmanaged: true`를 돌려주고, UI가 "이 파일은 다른 도구가 만든 SQLite 파일입니다. 메타 정보를 추가하여 이 앱에서 관리하시겠습니까?"를 묻는다 → 승인 시 `schema.adopt`가 기존 테이블을 `_jdr_tables`에 등록(열 타입은 `text`로 추정, `strict = 0`으로 STRICT 아님을 표시, 읽기 전용). 거절 시 새 빈 DB로 돌아간다(열기 전 미저장 변경 확인을 이미 거쳤으므로 잃는 것은 없다).
- 파일 크기 상한: 엔진의 `capabilities().warnFileBytes` 초과 시 경고 후 계속, `maxFileBytes` 초과 시 거부(`E_FILE_TOO_LARGE`). wasm 엔진에서는 각각 700 MB, 1.5 GB이고 네이티브 엔진에서는 검사가 발생하지 않는다.
- 메모리 부족(`RangeError`, wasm `abort`): 열기·저장을 중단하고 "파일이 너무 큽니다" 안내. 저장 중이었으면 원본은 그대로임을 명시.
- 파일 핸들 권한 만료: `queryPermission` → `requestPermission` 순으로 재요청. 거부 시 "다른 이름으로 저장"으로 유도.
- 저장 도중 브라우저가 닫히는 경우: `createWritable`의 원자성으로 원본은 보존됨. `beforeunload`에서 dirty이면 이탈 확인.
- 저널 용량이 50 MB를 넘으면 기록을 멈추고 "지금 저장하세요" 배너를 띄운다.
- 두 탭이 같은 DB를 여는 경우: `BroadcastChannel`로 `db_id` 점유를 알리고, 두 번째 탭은 읽기 전용으로 연다.
- `revision` 판정(4.3절)에 따른 경고 대화상자.

**완료 기준**
- E2E(폴백 경로): 새 DB → 테이블 생성 → 다운로드된 파일을 `setInputFiles`로 다시 열기 → 데이터 동일.
- 단위: `validateHeader`, 마이그레이션(빈 파일 → 최신), revision 판정표 5개 조건.
- 손상 파일·비SQLite 파일 픽스처가 올바른 오류 코드로 거부됨.

### Step 3. 메타 스키마와 테이블·열 관리

**목표**: 테이블과 열을 만들고, 이름·타입·순서를 바꾸고, 소프트 삭제할 수 있다.

**산출물**: `db/schema.js`(물리 타입), `db/tables.js`, `db/values.js`, `db/command.js`(변환 단계), `util/ids.js`, `app/commands.js`(스키마 커맨드), `ui/sidebar.js`, `ui/dialogs/table.js`, `ui/dialogs/column.js`

**주요 함수**
- Worker 측 `db/tables.js`. 각 함수는 현재 메타를 읽어 D-08 커맨드를 만들고 `command.applyCommand`로 즉시 적용한 뒤 `{ cmd, ... }`를 돌려준다. RPC op `schema.*`와 1:1이다.
- `tables.create({ name })` → `{ tableId, cmd }`, `tables.rename()`, `tables.drop()`(물리 삭제, 되돌리기 불가 확인), `tables.list()`
- `tables.addColumn(tableId, { name, type, options })` → `{ columnId, columnCount, cmd }`, `tables.renameColumn()`, `tables.reorderColumns()`, `tables.softDeleteColumn()`, `tables.restoreColumn()`, `tables.changeColumnType()`(새 열 + 변환 복사)
- `values.validate(type, raw)` → `{ ok, value } | { ok: false, reason }`, `values.coerce(type, raw, policy)`, `values.toDisplay(type, value)`
- `ids.newTableId()`, `ids.newColumnId()`(`crypto.getRandomValues`, 충돌 시 재생성)
- `schema.physicalType(logicalType)`, `schema.quoteIdent(name)`

**예외 처리**
- 테이블 이름 중복·빈 이름: UI에서 거부(`E_NAME_INVALID`). 물리 이름은 항상 고유하므로 DB 제약에는 걸리지 않는다.
- 열 개수 상한: SQLite 기본 2,000열. 1,000열에서 경고.
- 타입 변경 중 변환 실패 값: 사용자가 미리 선택한 정책(NULL 처리 / 중단). 중단 시 트랜잭션 롤백으로 원상복구.
- `changeColumnType`이 대용량(10만 행 이상)일 때 진행률 표시, 취소 가능.
- 시스템 열(`id`, `_created_at`, `_updated_at`)에 대한 변경 요청은 `E_SYSTEM_COLUMN`으로 거부.

**완료 기준**
- 단위: 각 논리 타입의 `validate` 경계값(정수 2^53, 잘못된 날짜 `2026-02-30`, 빈 문자열 → NULL).
- 단위: 타입 변경 후 되돌리기로 완전 복원.
- E2E: 테이블 2개, 열 5개 만들고 저장·재열기.

### Step 4. 가상 그리드 (읽기 전용)

**목표**: 30만 행 테이블을 60 fps로 스크롤하고, 열 너비 조절·열 고정·행 번호가 동작한다.

**산출물**: `ui/grid/grid.js`, `ui/grid/cells.js`, `ui/grid/cache.js`, `db/query.js`(창 질의), `app/store.js`(뷰 상태), `util/format.js`, `styles/grid.css`, `scripts/gen-fixture.mjs`(`--db`)

**주요 함수**
- `grid.mount(container, { tableId, viewSpec })`, `grid.setRowCount(n)`, `grid.computeRange(scrollTop, viewportHeight)` → `{ start, end }`, `grid.render(range)`, `grid.invalidate()`, `grid.scrollToRow(i)`, `grid.scrollToCell(row, col)`
- `grid.applyTable(table)`: 테이블 목록을 다시 읽었을 때(`tables:changed`) 그리드 호스트가 먼저 부른다. 같은 테이블이고 보이는 열의 id 목록이 순서까지 같으면 메타만 갈아 끼우고 머리글을 다시 그린 뒤 `invalidate()`로 데이터만 버리고 `true`를 돌려준다(스크롤 위치·활성 셀·열 너비 유지). 열이 늘거나 줄거나 순서가 바뀌었으면 `false`이고 호스트가 `mount()`로 다시 연다. 이름 바꾸기·저널 재생처럼 열 구성이 그대로인 갱신에서 사용자가 보던 위치를 잃지 않게 하는 것이 목적이다
- 행 풀: `acquireRow()`, `releaseRow()`, 열 풀 동일
- `cells.render(el, column, value, meta)`(타입별), `cells.preview(text, length)`
- `query.buildWindowSQL(table, columns, viewSpec, { offset, limit })`, `query.count(table, viewSpec)`, `query.fetchRow(table, id)`(편집용 전문 로드)
- 블록 캐시: `cache.get(tableId, block)`, `cache.put()`, `cache.invalidate(tableId)`
- 뷰 상태(`app/store.js`): 테이블별 `{ widths, frozenColumns }`를 메모리에 둔다. 열 너비의 초기값은 `_jdr_columns.width`이고, 변경분을 파일에 남기는 것은 Step 6의 뷰 저장이 맡는다(Step 4에는 너비를 쓰는 RPC op가 없다).
- 창 질의 결과 형식은 6장 `query.window` 행을 따른다. 정렬은 항상 `id`를 보조 키로 붙이며(D-06), 사용자 정렬·필터는 Step 6의 `buildOrderBy`·`buildWhere`가 같은 빌더에 더한다. Step 4의 `viewSpec`은 `{ hidden }`만 해석한다.
- `query.denseFromId(engine, table, stats, offset)`: id가 연속이면 `OFFSET` 대신 쓸 시작 id(D-06). Worker의 `query.window` 핸들러가 행 수 캐시(쓰기 일련번호 기준)와 함께 부른다.

**예외 처리**
- 스크롤 중 도착한 응답이 이미 지나간 범위이면 버린다(요청에 순번 부여, 최신 순번만 렌더). 구현: 테이블 전환·무효화마다 세대 번호를 올리고, 이전 세대의 응답은 캐시에 넣지 않는다. 같은 세대의 응답은 블록 캐시에 넣고 현재 가시 범위만 다시 그린다(가시 범위 밖 블록은 캐시에만 남는다).
- 창 질의 실패(테이블이 삭제됨 등): 빈 상태로 그리고 사이드바로 복귀.
- 행 수 × 행 높이가 1,000만 px를 넘으면 스크롤 스케일링 활성화(D-05).
- 셀 값이 미리보기 길이를 넘는 경우 말줄임과 길이 배지. `length()`가 큰 값(100만 자 이상)도 그리드는 256자만 받는다.
- 열이 모두 소프트 삭제된 테이블: "열이 없습니다" 빈 상태.

**완료 기준**
- `scripts/gen-fixture.mjs --db`로 만든 30만 행 × 20열(그중 2열은 장문: 평균 약 200자, 0.1%는 100 KB 이상 텍스트) DB에서 스크롤 프레임당 렌더 16 ms 이하, 창 질의 50 ms 이하. 측정은 `npm run test:perf`(Playwright가 테스트 빌드를 `file://`로 열고 `performance.measure`의 `jdr:grid.render` 항목과 `query.window`의 `elapsedMs`를 읽는다). 픽스처 규격은 8장의 측정 환경(약 300 MB DB)에 맞춘 것이다. 2열 × 평균 5 KB × 30만 행은 약 3 GB로 wasm 엔진의 `maxFileBytes`(1.5 GB)를 넘어 브라우저 모드에서 열 수 없으므로, 장문 열의 평균은 수백 자로 두고 100 KB 이상 셀은 0.1%로 둔다(장문 셀의 미리보기·배지 경로는 이 0.1%로 충분히 검사된다).
- 단위: `computeRange` 경계(첫 행, 마지막 행, 뷰포트보다 적은 행 수).

### Step 5. 편집: 인라인·장문 편집기, 행 추가·삭제, 붙여넣기, 되돌리기

**목표**: 셀을 편집하고, 행을 넣고 지우고, 범위를 복사·붙여넣기하며, 모든 변경을 되돌릴 수 있다.

**산출물**: `ui/editor/inline.js`, `ui/editor/longtext.js`, `ui/grid/selection.js`, `ui/grid/clipboard.js`, `ui/grid/editing.js`, `app/history.js`, `app/commands.js`(데이터 커맨드), `app/shortcuts.js`, `styles/editor.css`, `db/query.js`(`query.rows`·`query.stats`)

**주요 함수**
- `inline.open(cell, { initialText })`, `inline.commit()`, `inline.cancel()`. `cell`은 그리드가 넘기는 `{ row, col, column, rect }`이고 편집기는 스크롤 영역 안에 그 좌표로 놓인다. 확정은 `values.validate`를 거쳐 실패하면 편집기를 닫지 않고 오류를 표시한다. 미리보기가 잘린 텍스트 셀과 낡은 블록(`cache.markStale` 뒤 아직 다시 읽지 않은 블록)의 셀은 `query.row`로 전문을 읽은 뒤 연다. 캐시 값으로 열면 그 값이 확정 시 그대로 저장돼 방금 되돌린 값이 다시 적용될 수 있다(D-06). 블록이 최신이면 왕복 없이 캐시에서 연다
- `longtext.open(rowId, colId)`(전문 로드), `longtext.save()`, 자동 저장 없음(명시적 확정). 그리드 오른쪽의 사이드 패널
- `selection.setActive()`, `selection.extendTo()`, `selection.getRange()`, `selection.selectRows()`. DOM 없는 순수 상태이며 그리드가 렌더 때 읽는다
- `clipboard.copy(range)` → TSV(`serializeTsv`), `clipboard.paste(text, anchor)` → `parseTsv` 후 복합 커맨드. 복사는 `navigator.clipboard.writeText`(범위의 전문은 `query.rows`로 읽는다), 붙여넣기는 그리드가 받는 `paste` 이벤트의 `clipboardData`다. Worker는 이를 `runBatch`로 실행한다
- `commands.editCell({ tableId, rowId, colId, oldValue, newValue, oldUpdatedAt, now })`, `commands.insertRows({ tableId, count, firstId, now })`, `commands.deleteRows({ tableId, rows })`(`rows`는 `query.rows`가 돌려준 스냅샷), `commands.deleteRowRange({ tableId, offset, count, clauses })`(스냅샷 상한을 넘는 삭제. `undo`가 비고 `irreversible`. `clauses`는 `query.buildViewClauses`의 결과로, 정렬·필터·검색이 있는 뷰에서 `offset`이 뷰 순서를 가리키게 한다 — Step 6), `commands.clearRowRange({ tableId, colIds, offset, count, now, clauses })`(스냅샷 상한을 넘는 범위 지우기. 같은 이유로 문장 하나이며 이미 모두 NULL인 행은 건드리지 않는다), `commands.bulkEdit({ tableId, edits, inserts, now })`(`edits[i] = { rowId, oldUpdatedAt, cells: [{ colId, oldValue, newValue }] }`, `inserts[i] = { id, cells }`), `commands.invert(cmd)`. 모두 순수 함수이며 옛 값은 호출자가 읽어 넘긴다(D-08). 배치 목록은 `commands.chunkParams`가 `runBatch` 상한 단위로 나눈다
- `history.push(cmd)`, `history.undo()`, `history.redo()`, `history.clear(reason)`. `history.apply(cmd)`는 `command.apply` → 스토어 기록 → `push`를 한 번에 한다. 스키마 op가 만든 커맨드는 스토어의 `onCommand` 알림으로 히스토리에 들어온다
- Worker: `applyCommand(cmd)`(`BEGIN` ... `COMMIT`, 실패 시 `ROLLBACK`), `_updated_at` 갱신 트리거 대신 커맨드가 명시적으로 갱신

**예외 처리**
- IME: `compositionstart` 중에는 Enter/Esc를 확정·취소로 처리하지 않는다(`event.isComposing` 검사). 셀에서 바로 타이핑을 시작하면 첫 글자를 편집기의 초기값으로 넘긴다.
- 편집 확정값 검증 실패(타입 불일치): 편집기를 닫지 않고 오류를 표시한다.
- 편집 중 다른 곳 클릭: 확정 시도 → 실패하면 원래 값으로 되돌리고 토스트.
- 붙여넣기 범위가 그리드 경계를 넘는 경우: 행은 자동 추가, 열은 넘치는 만큼 무시하고 안내.
- 붙여넣기 값이 열 타입에 맞지 않으면(정수 열에 문자 등) 붙여넣기 전체를 `E_VALUE_INVALID`로 거부하고 첫 번째 위치(행·열)를 알린다. 일부만 적용하면 사용자가 무엇이 들어갔는지 알 수 없다.
- 붙여넣기 셀 수 상한 100만 셀. 초과 시 거부(`E_PASTE_TOO_LARGE`)하고 CSV 가져오기를 안내.
- 되돌리기 스냅샷 상한 10,000행(D-08). 초과 삭제·지우기·붙여넣기는 확인 후 `undo`가 빈 `irreversible` 커맨드로 적용하고 히스토리를 비운다. 그때의 삭제는 `DELETE ... WHERE id IN (SELECT id ... ORDER BY id LIMIT ? OFFSET ?)` 한 문장이고, 지우기도 같은 부분 질의를 쓰는 `UPDATE ... SET c = NULL` 한 문장이다. 되돌릴 수 없는 작업은 옛 값을 읽지 않는다 — 읽으면 범위 전체(미리보기가 아니라 전문)가 메인 스레드로 올라와 8장의 목표 규모에서 탭이 죽는다. 붙여넣기만 덮어쓸 행의 id가 필요해 그 행들을 읽으며, 붙여넣는 셀 수 상한(100만)이 그 범위를 묶는다.
- 커맨드 실행 중 Worker 오류: 히스토리에서 제거, 캐시 무효화 후 재조회, 오류 토스트. 앱 상태와 DB 상태의 불일치를 남기지 않는다.
- 장문 편집기 열림 상태에서 그리드 행이 삭제됨: 편집기를 닫고 안내.
- 크기 예산: 장문 편집기 입력값이 5 MB를 넘으면 경고(저장은 허용).
- 읽기 전용 상태(다른 탭, 새 schema_version, 외부 테이블)에서는 편집기를 열지 않고 `file.readOnlyBlocked`를 알린다.

**완료 기준**
- 단위: 커맨드 do/undo 대칭성(모든 커맨드 타입에 대해 적용 → 되돌리기 → DB 덤프 동일).
- E2E: 한글 IME 시뮬레이션(Playwright `keyboard.insertText` + composition 이벤트)으로 셀 편집 확정.
- E2E: 1,000 × 20 TSV 붙여넣기 → 되돌리기 → 다시 실행.

### Step 6. 정렬·필터·검색과 뷰 저장

**목표**: 열 정렬(다중), 조건 필터(AND/OR 1단계), 전체 텍스트 검색, 뷰(정렬·필터·숨김 열·너비) 저장.

**산출물**: `db/query.js`(뷰 스펙·필터·정렬 빌더), `db/search.js`, `db/views.js`, `ui/dialogs/filter.js`(정렬·필터 대화상자), `ui/toolbar.js`(검색 상자·정렬·필터·뷰·검색 인덱스), `ui/sidebar.js`(열 숨김·표시), `app/store.js`(테이블별 뷰 상태), `_jdr_views` 활용

**뷰 스펙**
- `viewSpec = { hidden?: string[], sort?: SortSpec[], filter?: FilterSpec | null, search?: string }`. `SortSpec = { colId, dir: 'asc' | 'desc' }`, `FilterSpec = { logic: 'and' | 'or', conditions: FilterCondition[] }`, `FilterCondition = { colId, op, value?, values? }`. 값은 UI에서 온 문자열이며 빌더가 열 타입으로 검증·변환한다. Worker의 `query.window`·`query.count`·`query.rows`가 같은 형식을 받아 같은 WHERE·ORDER BY를 붙이므로 그리드의 행 순번과 편집이 읽는 행이 어긋나지 않는다.
- 메인의 뷰 상태(`app/store.js`의 `TableViewState`)는 Step 4의 `{ widths, frozenColumns }`에 `{ hidden, sort, filter, search, viewId }`를 더한 것이고, 그리드에 넘기는 `viewSpec`은 이 중 `hidden`·`sort`·`filter`·`search`다. 정렬·필터·검색·숨김이 바뀌면 그리드는 다시 마운트되고(스크롤·선택 초기화), 너비·고정 열만 바뀌면 `applyView`로 배치만 고친다.
- 저장된 뷰(`_jdr_views.spec`)는 `{ sort, filter, hidden, search, widths, frozen }` JSON이다. 뷰 저장·삭제는 스키마 op처럼 Worker가 커맨드를 만들어 적용하고(`views.save`·`views.delete`) 메인이 히스토리·저널에 넣는다. 뷰 불러오기는 `views.list`가 돌려준 스펙을 메인의 뷰 상태에 적용하는 것이며 DB를 바꾸지 않는다.

**주요 함수**
- `query.buildWhere(filterSpec, columns)` → `{ sql, params }`(연산자: `=`, `!=`, `<`, `>`, `<=`, `>=`, `contains`, `starts`, `empty`, `not_empty`, `in`). 값은 항상 바인딩한다. 텍스트 계열 열(`text`·`longtext`·`select`)의 비교는 `COLLATE NOCASE`, `contains`·`starts`는 `LIKE ... ESCAPE '\'`(텍스트가 아닌 열은 `CAST(... AS TEXT)`), `!=`는 빈 값도 포함(`IS NOT`), `empty`는 `IS NULL OR = ''`, `in`은 `IN (?, ...)`. 살아 있지 않은 열을 가리키는 조건은 무시한다(스토어가 곧 뷰에서 지운다). 값이 열 타입에 맞지 않으면 `E_VALUE_INVALID`.
- `query.buildOrderBy(sortSpec, columns)` → SQL 조각. 타입에 맞는 정렬(숫자·불리언은 수치, 텍스트 계열은 `COLLATE NOCASE`, 날짜는 그대로), 빈 값은 항상 `NULLS LAST`, 마지막에 언제나 `"id"`. 살아 있지 않은 열은 무시한다.
- `query.buildSearchWhere(table, q)`: 인덱스가 있고 3자 이상이면 `search.query`, 아니면 `search.fallbackLike`. `query.buildViewClauses(table, viewSpec)` → `{ where, params, orderBy, sorted, filtered }`가 필터·검색·정렬을 합친다. 창 질의·행 수·`query.rows`·되돌릴 수 없는 범위 커맨드(`deleteRowRange`·`clearRowRange`의 `clauses`)가 이것을 쓴다. 정렬·필터·검색이 하나라도 있으면 D-06의 id 탐색 빠른 경로는 쓰지 않는다.
- `query.normalizeViewSpec(raw)`(Worker 경계를 넘어온 값의 형태 정리), `query.toggleSort(sort, colId, append)`(머리글 클릭: 없음 → 오름차순 → 내림차순 → 없음. `append`(Shift+클릭)면 다른 항목을 유지한다), `query.pruneViewSpec(spec, table)`(살아 있지 않은 열의 정렬·필터·숨김 항목 제거. 지운 것이 있으면 `changed: true`).
- `search.enable(engine, tableId, ctx)`(FTS5 external-content 테이블 + 트리거 생성 + 초기 인덱싱 진행률·취소), `search.disable(engine, tableId)`, `search.query(tableId, q)` → `"id" IN (SELECT rowid FROM fts WHERE fts MATCH ?)` 조각, `search.fallbackLike(columns, q)`, `search.searchableColumns(table)`. 생성·삭제는 커맨드를 돌려준다(RPC `search.enable`·`search.disable`).
- `views.save(engine, tableId, { name, spec, viewId? })` → `{ viewId, cmd }`, `views.remove(engine, viewId)` → `{ cmd }`, `views.list(engine, tableId)`, `views.load(engine, viewId)`.
- 스토어: `setSort`·`toggleSort`·`setFilter`·`setSearch`·`toggleHidden`·`clearFilters`·`applyView`·`saveView`·`deleteView`·`listViews`·`enableSearch`·`disableSearch`, `viewSpecOf(tableId)`. 테이블 목록을 다시 읽을 때와 뷰를 불러올 때 `pruneViewSpec`을 거친다.
- UI: 머리글 클릭이 정렬을 바꾸고(Shift+클릭은 보조 정렬 추가) `aria-sort`와 순번을 표시한다. 도구 모음의 표 도구 줄에 검색 상자(입력 300 ms 디바운스, 조합 중에는 반영하지 않음), 정렬·필터 대화상자(키보드로 다중 정렬·조건 편집), 뷰 선택·저장·삭제, 검색 인덱스 만들기·삭제(진행률·취소)가 있다. 열 숨김·표시는 사이드바의 열 항목에서 한다.

**예외 처리**
- 필터 값이 열 타입과 맞지 않으면(숫자 열에 문자) 필터 UI에서 거부(`values.validate`의 사유 문구). Worker의 빌더도 같은 검증을 하며 `E_VALUE_INVALID`.
- FTS 질의 문법 오류(따옴표 불균형 등): 사용자 입력을 항상 `"..."`로 감싸고 내부 따옴표를 이스케이프하여 구문 오류를 원천 차단.
- 3자 미만 검색어 또는 인덱스 없음 → LIKE 폴백. LIKE의 `%`, `_`, `\`는 `ESCAPE '\'`로 이스케이프.
- FTS 인덱스 생성 중 취소: 트랜잭션 롤백, `fts_enabled = 0`(커맨드 하나라 롤백이 트리거·FTS 테이블까지 되돌린다). 검색할 열이 없는 테이블, 이미 켜진 테이블, 비STRICT 테이블은 거부.
- 필터 결과 0건이면 빈 상태와 "필터 지우기" 버튼(필터와 검색을 함께 지운다).
- 정렬·필터·숨김 대상 열이 소프트 삭제되면 뷰에서 그 항목을 제거하고 안내. 저장된 뷰를 불러올 때도 같다.
- 정렬·필터·검색이 있는 뷰에서 행을 추가하면 새 행이 필터에 걸려 보이지 않을 수 있음을 안내한다(정렬만 있으면 빈 행은 `NULLS LAST`라 끝에 붙는다).
- 검색 인덱스가 있는 테이블의 되돌리기·다시 실행·저널 재생은 트리거가 인덱스를 따라 갱신하므로 별도 처리가 없다. 인덱스 생성 커맨드의 되돌리기(인덱스 삭제)와 다시 실행(재인덱싱)은 진행률 없이 실행된다.

**완료 기준**
- 단위: `buildWhere`가 항상 파라미터 바인딩을 쓰고 문자열 연결로 값을 넣지 않음(테스트가 `'` 포함 값을 넣어 확인).
- 30만 행에서 trigram 검색 200 ms 이하, 인덱스 없이 LIKE 1초 이하(`query.count`의 `elapsedMs`, `npm run test:perf`).
- E2E: 정렬·필터·검색 조합 후 뷰 저장 → 재열기 시 복원.

### Step 7. CSV 가져오기

**목표**: 수백 MB CSV를 새 테이블 또는 기존 테이블에 추가로 가져온다.

**산출물**: `import/csv.js`, `import/infer.js`, `import/pipeline.js`, `ui/dialogs/import.js`, `ui/toolbar.js`(가져오기 버튼과 숨은 파일 입력), `app/store.js`(`importPreview`·`importRun`), `io/autosave.js`(`suspend`)

**가져오기는 커맨드가 아니다 (D-08의 예외)**
- 30만 행 CSV를 커맨드 하나로 만들면 그 객체(수백 MB)가 저널 상한(50 MB)과 되돌리기 스냅샷 상한(1만 행)을 모두 넘고, 재생하려면 원본 파일이 다시 필요하다. 그래서 가져오기는 `import.run` op가 트랜잭션 하나로 직접 삽입하며 히스토리·저널에 들어가지 않는다.
- 성공한 뒤 메인은 (1) 되돌리기 스택을 비우고(앞선 `column.add`를 되돌리면 `DROP COLUMN`이 가져온 값을 지우므로), (2) 저널 기록을 멈추고(`autosave.suspend()`: 이후 커맨드도 기록하지 않고 재생 시 "뒤쪽 변경 일부는 남지 않았다"로 표시), (3) dirty로 표시하고 "지금 저장하세요" 배너를 띄운다. 저장이 성공하면 저널이 비워지며 기록이 다시 시작된다. 탭이 죽으면 가져오기와 그 뒤의 변경은 복구되지 않는다. 그 사실을 배너가 알린다.
- 가져오기 전체는 트랜잭션 하나다. 취소·오류·`abort` 정책은 롤백이므로 새 테이블이든 기존 테이블이든 DB는 시작 전과 같다. 청크마다 커밋하지 않는 이유: 기존 테이블에 "절반만 들어간" 상태는 사용자가 어디까지 들어갔는지 알 수 없고, 커맨드가 아니어서 되돌릴 수도 없다.

**주요 함수**
- `csv.detectEncoding(headBytes)` → `'utf-8' | 'utf-16le' | 'utf-16be' | 'euc-kr'`. BOM → BOM 없는 UTF-16(NUL 바이트가 홀수·짝수 위치에 몰림) → UTF-8 `fatal` 디코딩(`stream: true`라 끝에 잘린 다중 바이트는 오류가 아님) → EUC-KR 추정. 사용자 재지정 가능.
- `csv.detectDelimiter(headText)`: 후보 `,`·탭·`;`·`|`를 각각 상태 기계로 앞 20행까지 파싱해 행 간 필드 수 분산이 최소인 것. 동률이면 필드 수가 많은 쪽.
- `csv.createParser({ delimiter })` → `{ push(text): Record[], end(): { records, unterminatedQuote } }`. 필드 안/따옴표 안/따옴표 뒤 상태를 조각 사이에 유지하므로 조각 경계에 걸친 레코드는 다음 조각으로 이월된다. `\r`, `\n`, `\r\n`이 섞여도 되고 조각 경계에서 `\r\n`이 갈라져도 된다. 완전히 빈 줄은 레코드가 아니다. 레코드는 `{ rowIndex, cells: string[] }`이며 `rowIndex`는 파일 안의 레코드 순번(1부터, 헤더 포함)이다.
- `csv.parse(blob, { encoding, delimiter })` → `AsyncIterable<Record>`. `blob.stream().pipeThrough(new TextDecoderStream(encoding))`을 조각마다 `createParser`에 넣는다. BOM은 디코더가 뗀다. 소비자가 일찍 멈추면(`return()`) 스트림을 취소한다(미리보기는 앞 1,000레코드만 읽는다).
- `pipeline.openSource(file, options)` → `{ header: string[] | null, rows: AsyncIterable<Row>, total: number | null }`. CSV·XLSX의 차이를 여기서 흡수한다(`options.format`). `hasHeader`면 첫 레코드가 헤더다. `Row = { rowIndex, cells: (string | number | boolean | null)[] }`(D-09. XLSX 어댑터가 날짜를 문자열로 바꾸므로 Date는 오지 않는다). `total`은 XLSX처럼 행 수를 미리 알 때만 있다.
- `infer.sample(rows, 1000)` → `{ rows, exhausted }`. `infer.columnName(raw, index, taken)`: 비어 있으면 `열{index+1}`, 겹치면 ` (2)`, ` (3)` 접미사(i18n 키 `import.columnDefault`. Step 8의 규칙을 CSV에도 적용). `infer.column(values)` → `{ type, confidence, examples }`. 빈 값을 뺀 표본 전부가 맞는 첫 타입을 우선순위 boolean → integer → real → date → datetime → text로 고르되, 2,000자 초과가 하나라도 있으면 longtext, `0`으로 시작하는 두 자리 이상 숫자 문자열(우편번호)이 있으면 text, `date`는 시각 부분이 없는 값만(있으면 datetime). `confidence`는 표본 중 비어 있지 않은 값의 비율.
- `pipeline.run({ engine, file, options, mapping, target, policy, signal, progress })` → `{ report }`. 트랜잭션 하나 안에서: 새 테이블이면 `tables.create`·`addColumn`(D-08 커맨드를 즉시 적용하되 돌려주지 않는다. 롤백이 함께 되돌린다) → 행을 읽어 `values.validate`로 변환 → 1,000행 또는 직렬화 32 MB마다 `runBatch`(prepared statement 재사용, `_created_at`은 시작 시각 하나) → 청크 사이에서 취소 확인과 이벤트 루프 양보 → `progress({ phase: 'insert', done, total })`. 보고서 `{ tableId, inserted, skipped, nulled, errors[], demoted[] }`: `errors[i] = { rowIndex, column?, reason }`(앞 100건), `demoted`는 `text` 정책으로 강등한 열.
- `mapping.columns[i] = { source, name?, type?, columnId?, policy? }`. 새 테이블이면 `name`·`type`(추론 결과를 사용자가 고친 것), 기존 테이블이면 `columnId`(살아 있는 사용자 열). 목록에 없는 원본 열은 건너뛴다. `policy`가 없으면 op의 `policy`.
- 스토어: `importPreview(file, options, callOptions)`, `importRun(args, callOptions)`. 성공 시 위의 세 가지 처리 후 `import:done`을 낸다(히스토리가 이 이벤트로 스택을 비운다). 새 테이블이면 그 테이블을 고른다.
- UI: 도구 모음의 "가져오기…"가 숨은 `<input type="file" accept=".csv,.tsv,.txt,.xlsx">`를 연다(폴백 열기와 같은 방식이라 자동화 도구가 파일을 넣을 수 있다). 대화상자는 한 창에서 (1) 파싱 옵션(인코딩·구분자·헤더 / 시트·헤더 행) → (2) 미리보기 20행과 열마다 이름·타입·정책 → (3) 대상(새 테이블 이름 / 기존 테이블과 열 대응) → (4) 진행률·취소 → (5) 보고서를 보여 준다. 옵션을 바꾸면 `import.preview`를 다시 부른다. 실행 중에는 대화상자가 모달로 남아 그리드 편집을 막고(`import.run`은 배타 op라 Worker도 `E_DB_BUSY`로 거절한다), 취소 버튼이 `AbortSignal`을 당긴다.

**예외 처리**
- 인코딩 오판(깨진 문자(U+FFFD) 비율 1% 초과): 미리보기 결과의 `warnings`에 `encoding`으로 담고 대화상자가 `E_IMPORT_ENCODING` 문구로 인코딩 재선택을 유도한다. 실행 자체는 막지 않는다.
- 행마다 필드 수가 다른 경우: 부족한 필드는 NULL, 넘치는 필드는 버리고 보고서에 행 번호 기록(`reason: 'extra_fields'`). 표본에서 헤더보다 필드가 많은 행이 10%를 넘으면 `warnings`에 `ragged`를 담아 구분자 재감지를 제안한다.
- 따옴표가 끝나지 않은 채 파일이 끝남: 남은 텍스트를 마지막 필드로 처리하고 `warnings`에 `unterminated_quote`.
- 값 변환 실패 정책(열 단위): `null`(기본. NULL로 넣고 `nulled`와 `errors`에 기록), `text`(그 열의 타입을 text로 바꿔 처음부터 재시도. 새 테이블에서만 허용하며 기존 테이블에 주면 `E_DB_QUERY`), `abort`(`E_VALUE_INVALID`에 행 번호·열을 담고 롤백).
- 셀 값 길이 10 MB 초과: NULL로 넣고 `errors`에 `reason: 'too_long'`.
- 기존 테이블에 추가: 대상은 STRICT 테이블(R7의 외부 테이블은 거부)의 살아 있는 사용자 열이어야 한다. 매핑 UI는 헤더와 같은 이름의 열을 자동으로 잇고, 대응 없는 원본 열은 "건너뜀"이다. `select` 열에 없는 값은 4.2대로 `options.choices`에 자동 추가한다(`_jdr_columns.options` 갱신).
- 취소: `E_IMPORT_CANCELLED`. 트랜잭션 전체가 롤백되어 새 테이블은 사라지고 기존 테이블에는 한 행도 남지 않는다. 문구가 "가져오기 전 상태 그대로"임을 명시한다.
- 메모리: 파서는 조각 단위지만 wasm DB는 메모리에 있으므로 예상 결과 크기(파일 크기 × 1.2)가 `capabilities().warnFileBytes`에서 지금 DB 크기를 뺀 값을 넘으면 시작 전에 경고한다(숫자는 UI에 두지 않는다).
- 가져오기 도중에는 그리드 편집을 잠근다(모달 + 배타 op).
- 읽기 전용 상태(다른 탭, 새 스키마)에서는 시작하지 않는다.

**완료 기준**
- 단위 픽스처(`test/fixtures/import/`): 따옴표 안 개행·쉼표, BOM 있는 UTF-8, UTF-16LE, EUC-KR 바이트, 빈 줄, CRLF/LF 혼재, 필드 수 불일치, 32 KB 조각 경계에 걸친 따옴표 필드.
- 30만 행 × 20열 CSV(약 150 MB) 가져오기 60초 이하(Chromium, Worker 모드).
- 취소 후 DB에 잔여물이 없음을 확인하는 테스트(새 테이블·기존 테이블 모두 덤프 동일).

### Step 8. XLSX 가져오기

**목표**: 엑셀·구글 스프레드시트에서 내려받은 `.xlsx`를 시트 단위로 가져온다.

**산출물**: `import/xlsx.js`, `vendor/xlsx.full.min.js`(+ `xlsx.full.min.d.ts`, `LICENSE.sheetjs`, `CHECKSUMS`), `ui/dialogs/import.js`(시트 선택 단계), `scripts/gen-import-fixtures.mjs`(픽스처 생성기), `test/fixtures/import/*.xlsx`

**주요 함수**
- `xlsx.listSheets(bytes)` → `[{ name, rows, cols }]`. `XLSX.read(bytes, { type: 'array', sheetRows: 1, dense: true })`로 시트마다 첫 행까지만 파싱하고 `!fullref`(잘리지 않은 범위)에서 행·열 수를 읽는다.
- `xlsx.parse(bytes, { sheet, headerRow })` → 행 이터레이터. `XLSX.read(bytes, { type: 'array', dense: true, cellDates: true, sheets: [sheet] })` 후 셀 타입을 `n` → 숫자, `s` → 문자열, `b` → 불리언, `d` → 날짜 문자열, `e` → NULL(+ 보고), 비어 있음 → NULL로 바꾼다. 수식 셀은 `v`(계산값)만 쓴다. `headerRow`(1부터)보다 앞의 행은 건너뛴다.
- 날짜: `cellDates`가 준 Date의 **로컬 시각 부품**(SheetJS는 일련번호를 로컬 시각으로 만든다)으로 `YYYY-MM-DD`(시각이 00:00:00) 또는 `YYYY-MM-DDTHH:mm:ss` 문자열을 만든다. 그래서 Step 7의 `infer`가 CSV와 같은 규칙으로 `date`/`datetime`을 판정하고, `values.validate`의 UTC 해석과 시간대 차이가 생기지 않는다.
- `xlsx.readWorkbook(bytes, opts)`: SheetJS 예외를 `E_XLSX_ENCRYPTED`(메시지에 `password`) / `E_XLSX_CORRUPT`(그 밖)로 바꾸는 유일한 자리. `XLSX_MAX_FILE_BYTES`(100 MB)를 넘는 입력은 `E_FILE_TOO_LARGE`(`detail.format = 'xlsx'`)로 거부한다.
- 추론·매핑·삽입은 Step 7의 `infer`·`pipeline`을 그대로 쓴다(`openSource`가 `options.format === 'xlsx'`에서 이 어댑터를 고른다). `import.preview`는 `sheets`와 고른 `sheet`를 함께 돌려주고, 대화상자가 시트를 바꾸면 미리보기를 다시 부른다.
- 번들: `xlsx.full.min.js`는 UMD라 esbuild가 CommonJS로 접어 Worker 번들에 넣는다(`import * as XLSX from '../../vendor/xlsx.full.min.js'`). 안의 OOXML 네임스페이스 URL 문자열(`http://schemas.openxmlformats.org/…` 등)은 네트워크 요청이 아니므로 `verify.mjs`가 접두사 목록으로 허용한다.

**예외 처리**
- 암호화된 통합 문서: `E_XLSX_ENCRYPTED`로 거부하고 안내.
- 파일 크기 상한 100 MB(전체를 메모리에 올려야 함). 초과 시 `E_FILE_TOO_LARGE`와 "CSV로 저장 후 가져오기" 안내.
- 병합 셀: 좌상단 값만 사용, 나머지는 NULL. `warnings`에 `merged`(범위 수)로 미리보기에 표시.
- 오류 셀(`#N/A`, `#REF!`): NULL 처리 후 보고서에 `reason: 'error_cell'`.
- 헤더 행이 비어 있거나 중복: `열1`, `열2` 자동 이름과 중복 접미사 `(2)`(Step 7의 `infer.columnName`).
- 1900 윤년 버그(1900-02-29)와 1904 날짜 체계(`Workbook.WBProps.date1904`): SheetJS 처리에 위임하되 픽스처로 검증.
- 숫자 서식이 텍스트인 열(예: 우편번호 `01234`): 추론이 integer로 판정하면 선행 0이 사라지므로, 표본에 선행 0 문자열이 있으면 text로 판정(Step 7의 `infer.column`).
- SheetJS 파싱 중 예외(손상 zip): `E_XLSX_CORRUPT`.

**완료 기준**
- 픽스처: 날짜·시간·불리언·수식·병합·오류 셀·빈 헤더·1904 체계.
- 5만 행 × 20열 xlsx 가져오기 20초 이하.

### Step 9. 내보내기, 백업, 압축 저장, 클라우드 사용 안내

**목표**: CSV·XLSX 내보내기, `.db.gz` 저장 옵션, 백업 복원, 클라우드 왕복 사용 설명.

**산출물**: `export/csv.js`, `export/xlsx.js`, `io/filesystem.js`(gzip), `ui/dialogs/export.js`, `ui/dialogs/settings.js`(기기 이름, 자동 저장), `docs/cloud-sync.md`

**주요 함수**
- `exportCsv(tableId, viewSpec?, { encoding: 'utf-8-bom' | 'utf-8', delimiter })`: 창 질의로 5,000행씩 스트리밍하여 `WritableStream`에 쓰기(전체를 문자열로 만들지 않음)
- `exportXlsx(tableId)`: 10만 행 초과 시 경고(SheetJS 쓰기는 메모리 상주). 100만 행은 XLSX 규격 상한.
- `filesystem.write(handle, bytes, { gzip })`: `new CompressionStream('gzip')`, 확장자 `.db.gz`. 열기 시 gzip 매직(`1f 8b`)으로 자동 판별
- `backups.restore()`: 직전 저장본(브라우저 모드는 IDB `backups`, 데스크톱 모드는 `.bak` 파일)을 새 이름으로 내보내기
- 자동 저장: dirty 후 N초(기본 꺼짐, 30초~5분)마다 `store.save()`. 정본 파일(핸들 또는 경로)이 있을 때만.

**예외 처리**
- 내보내기 대상 셀에 구분자·개행·따옴표 포함: RFC 4180 인용. 엑셀 호환을 위해 UTF-8 BOM 기본.
- 수식 주입 방지: `=`, `+`, `-`, `@`로 시작하는 텍스트는 CSV 내보내기 시 앞에 `'`를 붙이는 옵션(기본 켜짐).
- gzip 파일을 압축 미지원 브라우저에서 열기: `DecompressionStream` 부재 시 `E_GZIP_UNSUPPORTED`.
- 자동 저장과 사용자 저장이 겹침: 저장 뮤텍스. 진행 중이면 다음 틱으로 미룸.
- 백업 스토어 용량 부족(`QuotaExceededError`): 백업을 건너뛰고 저장은 진행하되 상태바에 표시.

**완료 기준**
- 왕복 테스트: 내보낸 CSV를 다시 가져오면 타입·값이 동일(날짜, 불리언, NULL, 따옴표 포함 텍스트).
- `.db.gz` 저장 → 열기 왕복.
- `docs/cloud-sync.md`에 "PC A에서 저장·동기화 완료 확인 → PC B에서 열기" 절차와 경고 메시지 의미를 기술.

### Step 10. 성능 검증, 하드닝, 접근성, 마무리

**목표**: 성능 예산(8장)을 측정으로 확인하고, 오류 경로를 점검하며, 키보드만으로 모든 기능을 쓸 수 있게 한다.

**산출물**: `test/e2e/perf.spec.js`, `docs/support-matrix.md`, README 갱신, 릴리스 빌드

**작업**
- 성능 트레이스 자동화: 30만 행 픽스처로 열기·스크롤·검색·저장·가져오기 시간을 CI에서 기록(회귀 감지, 임계 초과 시 실패).
- 메모리 프로파일: 열기 → 가져오기 → 저장 순으로 힙 스냅샷을 비교하여 누수 확인(캐시·행 풀·statement 캐시).
- 오류 주입 테스트: Worker 강제 종료, IDB 열기 실패, 파일 쓰기 중 예외, wasm 메모리 한계 근접.
- 접근성: 그리드에 `role="grid"`, `aria-rowcount`, `aria-colcount`, 활성 셀 `aria-selected`, 포커스 가시성, 대화상자 포커스 트랩, 명도 대비 4.5:1.
- 보안 점검: 셀 값은 항상 `textContent`로만 렌더링(`innerHTML` 금지), CSP 검증, CSV 수식 주입 옵션 확인.
- 지원 매트릭스 실측 기록(Chromium/Firefox/Safari × `file://`/`http://localhost`).

**완료 기준**
- 8장 예산 전 항목 통과.
- Playwright axe 검사에서 critical 0건.
- `dist/jdrdatabase.html` 6 MB 이하.

### Step 11. 타우리 데스크톱 셸과 네이티브 엔진

**목표**: 같은 소스에서 타우리 데스크톱 앱을 빌드하고, 데스크톱 모드에서는 rusqlite 네이티브 엔진과 작업 사본 모델(D-15)로 DB 파일 상한을 디스크 용량으로 확장한다.

**선행 조건**: Step 10까지 완료된 브라우저 경로. Step 1의 엔진 인터페이스와 적합성 테스트, Step 2의 `capabilities()` 기반 상한 검사가 이미 있어야 한다.

**산출물**: `src-tauri/` 전체, `db/engine-native.js`, `io/ipc-bridge.js`, `io/filesystem.js`(타우리 분기 구현), `build/build.mjs`(타우리 변형), `package.json` scripts `tauri:dev`·`tauri:build`, CI 매트릭스(Windows·macOS·Linux 빌드와 `cargo test`), `docs/desktop.md`

**주요 함수 (JS)**
- `engine-native.js`: 인터페이스 전체 구현. Worker 컨텍스트면 `bridgeCall(op, args, onProgress)`로 메인에 위임하고, 메인 컨텍스트(인라인 전송)면 `invoke`를 직접 호출. `capabilities()` → `{ mode: 'native', warnFileBytes: Infinity, maxFileBytes: Infinity, persistence: 'native' }`
- `ipc-bridge.js`: `attach(worker)`(Worker의 `engine:call` 수신 → `invoke` → `engine:result` 회신), `invokeWithChannel(cmd, args, onProgress)`, `detach()`
- `filesystem.js`: `pickOpen()`·`pickSaveAs()`의 타우리 dialog 분기, `capabilities().native = true`
- `store.save()`: `persistence === 'native'`이면 `client.call('db.save', { originalPath })`
- `main.js`: `detectMode()` → `'browser' | 'desktop'`, `selectEngine(mode)`

**주요 함수 (Rust)**
- `db.rs`: `open(original_path) -> OpenInfo`(작업 사본 준비 후 연결, 기존 사본의 dirty 여부 포함), `close()`, `exec(sql, params) -> Rows`, `run(sql, params) -> RunResult`, `run_batch(sql, params_list) -> usize`(단일 트랜잭션), `begin() / commit() / rollback()`, `interrupt()`, `capabilities()`
- `save.rs`: `save_to(original_path, expected_mtime, expected_len) -> SaveInfo`(mtime·크기 검사 → checkpoint → `VACUUM INTO` 임시 → 원본을 `.bak`으로 → 임시를 원본으로 rename → 임시 정리), `restore_backup(original_path)`
- `workcopy.rs`: `workcopy_path(db_id)`, `prepare(original_path) -> PathBuf`(복사, 남은 사본이 dirty면 그대로 두고 알림), `list()`, `purge(older_than)`
- `error.rs`: `AppError { code, message, detail }` + `serde::Serialize`. rusqlite 오류 매핑: `SQLITE_FULL` → `E_DISK_FULL`, `SQLITE_BUSY`·`SQLITE_LOCKED` → `E_FILE_LOCKED`, `SQLITE_INTERRUPT` → `E_IMPORT_CANCELLED`, 그 외 → `E_DB_QUERY`

**예외 처리**
- 타우리 전역 객체는 있으나 `invoke`가 실패(명령 미등록, 권한 설정 누락): `E_NATIVE_IPC`. 앱을 잠그고 원인을 표시한다. wasm으로 폴백하지 않는다(D-15).
- 작업 사본 복사 중 디스크 부족: `E_DISK_FULL`. 원본은 손대지 않았음을 명시.
- 저장 중 디스크 부족(`VACUUM INTO` 실패): 임시 파일 삭제, 원본과 `.bak` 그대로. `E_DISK_FULL`.
- rename 단계 실패(권한, 클라우드 클라이언트의 잠금): `E_FILE_LOCKED`. `.bak`으로 옮긴 원본이 있으면 되돌려 놓고, 임시 파일 경로를 알려 주며 "다른 이름으로 저장"을 유도.
- 원본이 열려 있는 동안 디스크에서 바뀜: `E_ORIGINAL_CHANGED`(D-15).
- 이전 실행의 작업 사본이 남아 있음(비정상 종료): dirty면 복구 흐름, 아니면 폐기 후 새로 복사.
- 원본 파일이 이동·삭제됨: 저장 시 `E_FILE_WRITE`, "다른 이름으로 저장".
- 두 번째 인스턴스 실행: single-instance 플러그인으로 첫 인스턴스에 포워딩. 한 인스턴스 안의 다중 창은 v1에 없다.
- IPC 페이로드: `run_batch` 한 번의 인자가 64 MB를 넘으면 JS 쪽 공통 검증(Step 1)이 배치를 쪼갠다(장문 셀 다량 붙여넣기).
- 러스트 패닉: panic hook에서 로그 파일에 기록하고 창에 오류를 표시. 커넥션 뮤텍스가 poison되면 `close` 후 재열기.
- WebView 차이: WKWebView에서 IndexedDB·CompressionStream이 없을 수 있으므로 기능 감지(D-13). `known_revisions`를 저장할 곳이 없으면 revision 경고를 건너뛰고 상태바에 표시.
- 경로: 유니코드·공백 포함 경로, UNC 경로를 `PathBuf`로만 다루고 문자열 결합 금지. 픽스처에 한글 경로 포함.
- 접근 범위: 타우리 fs 스코프를 사용자가 대화상자로 고른 경로와 앱 데이터 폴더로 제한.
- 가져오기·붙여넣기 중 `interrupt()`: 러스트가 현재 문장을 중단하고 트랜잭션을 롤백한 뒤 `E_IMPORT_CANCELLED`를 돌려준다. 브라우저 모드와 같은 결과 보고 형식을 유지.

**완료 기준**
- `cargo test`: `PRAGMA compile_options`에 `ENABLE_FTS5` 포함, 저장 원자성(`VACUUM INTO` 도중 실패 주입 시 원본 무손상), `run_batch` 원자성, `interrupt`로 긴 질의 중단, 한글 경로 왕복.
- Step 1의 엔진 적합성 테스트를 네이티브 엔진에 대해 tauri-driver 환경에서 통과.
- 데스크톱 E2E(tauri-driver, Windows·Linux): 브라우저 E2E와 같은 시나리오 파일을 실행하되 파일 대화상자는 테스트 훅으로 경로를 주입.
- 5 GB 픽스처(`gen-fixture.mjs`의 `--rows 5000000` 확장)로 열기(작업 사본 복사 제외) 2초 이하, 창 질의 50 ms 이하, 저장은 같은 크기 파일 복사 시간의 1.5배 이내.
- `verify.mjs`가 브라우저 산출물과 타우리 산출물이 CSP 태그 외 동일함을 확인.
- `docs/desktop.md`에 작업 사본 위치, `.bak` 파일, 클라우드 폴더 사용 절차, 브라우저 모드와의 차이(상한, 저널 대신 작업 사본)를 기술.

---

## 6. RPC 프로토콜 (D-11)

```js
// 요청 (main → worker)
{ id: 17, op: 'query.window', args: { tableId, viewSpec, offset, limit } }
// 응답
{ id: 17, ok: true, result: { rows: [...], seq } }
{ id: 17, ok: false, error: { code: 'E_DB_QUERY', message, detail } }
// 진행 이벤트 (응답 전에 0회 이상)
{ id: 17, progress: { phase: 'insert', done: 120000, total: 300000 } }
// 취소 (main → worker)
{ id: 17, cancel: true }
```

| op | 인자 | 결과 | 취소 |
|---|---|---|---|
| `engine.init` | wasm: `{ wasmBinary }` (transfer) / native: `{}` | `{ version, compileOptions, capabilities }` | 불가 |
| `engine.exec` | `{ sql, params }` | `{ columns, rows }`. 결과 열이 없는 문장은 `{ columns: [], rows: [] }`. 진단·테스트 전용(Step 1 E2E의 `SELECT 1`과 FTS5 trigram, `window.__jdrTest`). 한 문장을 트랜잭션 하나로 감싸 실행하므로 DDL도 보낼 수 있다. UI 코드는 이 op를 호출하지 않는다 | 불가 |
| `db.open` | wasm: `{ bytes?, dbId?, adoptExternal? }` (transfer) / native: `{ originalPath? }` | `{ meta, tables, unmanaged?, readOnly?, dirtyWorkcopy? }`. `bytes`가 없으면 새 빈 DB(마이그레이션 적용, `dbId`를 주면 그 값으로). `_jdr_meta`가 없는 파일은 `adoptExternal`이 아니면 `unmanaged: true`와 함께 열린 채로 둔다. 앱보다 새 `schema_version`은 `readOnly: true` | 불가 |
| `db.snapshot` | `{ bumpRevision, savedBy }` | `{ bytes, meta }` (transfer). `bumpRevision`이면 `revision + 1`, `saved_at`, `saved_by`를 먼저 기록하고 갱신된 meta를 함께 돌려준다. wasm 전용, native는 `E_UNSUPPORTED` | 불가 |
| `db.save` | `{ originalPath, bumpRevision, savedBy }` | `{ revision, savedAt }`. native 전용, wasm은 `E_UNSUPPORTED` | 불가 |
| `db.close` | | | |
| `schema.list` | | `{ tables }`(3장 `tables.list`) | |
| `schema.adopt` | | `{ meta, tables }`. `unmanaged`로 열린 파일에 메타를 만들고 기존 테이블을 등록 | 불가 |
| `schema.create` / `schema.rename` / `schema.drop` / `schema.addColumn` / `schema.renameColumn` / `schema.reorderColumns` / `schema.softDeleteColumn` / `schema.restoreColumn` / `schema.changeColumnType` | 3장 `tables` 함수와 1:1 | `{ cmd, ... }`. 적용된 D-08 커맨드를 돌려주어 메인이 히스토리·저널에 넣는다 | 타입 변경만 가능 |
| `query.window` | `{ tableId, viewSpec, offset, limit, seq }` | `{ rows, columnIds, seq, elapsedMs }`. `rows[i] = { id, cells, lengths }`이고 `cells[j]`는 `columnIds[j]` 열의 값(text·longtext는 `substr(1, 256)` 미리보기), `lengths[j]`는 미리보기가 잘렸을 때만 전체 문자 수, 아니면 null. `columnIds`는 소프트 삭제·숨김을 뺀 살아 있는 열의 표시 순서. `limit`은 1만 이하. `elapsedMs`는 Worker 측 질의 시간(8장 측정용) | 불가(짧음) |
| `query.count` | `{ tableId, viewSpec }` | `{ count, elapsedMs }`. 뷰 조건(필터·검색)을 포함한 행 수. Worker가 쓰기 일련번호와 뷰 조건을 키로 캐시한다 | |
| `query.row` | `{ tableId, rowId, colIds }` | `{ row }`. `row = { id, cells, createdAt, updatedAt }`(`cells`는 열 id → 전문 값, `createdAt`·`updatedAt`은 시스템 열)이고 없는 행이면 `row: null`. `colIds`를 비우면 살아 있는 열 전부 | |
| `query.rows` | `{ tableId, viewSpec, offset, limit, colIds? }` | `{ rows }`. 뷰 순서로 `offset`부터 `limit`개(1만 이하)의 전문 행(`query.row`와 같은 형태). `colIds`를 비우면 소프트 삭제된 열까지 물리 열 전부(행 삭제의 되돌리기 스냅샷용). 붙여넣기·다중 편집·행 삭제가 커맨드를 만들기 전에 옛 값을 읽는 데 쓴다 | 불가(짧음) |
| `query.stats` | `{ tableId }` | `{ count, minId, maxId }`. 빈 테이블이면 `minId`·`maxId`는 null. 행 추가 커맨드가 새 `id`를 정하는 데 쓴다 | |
| `command.apply` | `{ cmd, direction? }` | `{ affected, nulled? }`. `direction`은 `'do'`(기본) 또는 `'undo'`. `nulled`는 변환 단계가 NULL로 만든 값의 수. 저널 재생과 되돌리기가 쓴다 | 변환 단계가 있을 때만 |
| `search.enable` | `{ tableId }` | `{ cmd }`. FTS5 테이블·트리거 생성과 초기 인덱싱(`{ index }` 단계, `progress.phase = 'index'`)을 커맨드 하나로 적용하고 돌려준다. 검색할 열이 없거나 이미 켜져 있거나 비STRICT 테이블이면 `E_DB_QUERY` | 가능 |
| `search.disable` | `{ tableId }` | `{ cmd }`. 트리거·FTS 테이블 삭제. `undo`가 인덱스를 다시 만든다 | 불가 |
| `views.list` | `{ tableId }` | `{ views }`. `views[i] = { id, tableId, name, spec }`(`spec`은 파싱된 JSON) | |
| `views.save` | `{ tableId, name, spec, viewId? }` | `{ viewId, cmd }`. `viewId`가 있으면 그 뷰를 덮어쓰고(되돌리면 옛 이름·스펙), 없으면 새 뷰 | 불가 |
| `views.delete` | `{ viewId }` | `{ cmd }` | 불가 |
| `import.preview` | `{ file, options }`. `file`은 Blob(File)이며 구조화 복제로 넘긴다(메인은 바이트를 읽지 않는다). `options = { format: 'csv' \| 'xlsx', encoding?, delimiter?, hasHeader?, sheet?, headerRow? }`. 빠진 값은 Worker가 감지한다 | `{ format, encoding, delimiter, hasHeader, sheets?, sheet?, headerRow?, headers, sample, sampleRows, exhausted, inferred, warnings }`. `sample`은 앞 20행, `inferred[i] = { type, confidence, examples }`, `warnings[i] = { kind: 'encoding' \| 'ragged' \| 'unterminated_quote' \| 'merged' \| 'error_cells' \| 'empty_headers', count? }` | 가능 |
| `import.run` | `{ file, options, mapping, target, policy }`. `target = { kind: 'new', name } \| { kind: 'existing', tableId }`, `mapping = { columns: [{ source, name?, type?, columnId?, policy? }] }`, `policy = 'null' \| 'text' \| 'abort'`(열에 정책이 없을 때의 기본) | `{ report }`. `report = { tableId, inserted, skipped, nulled, errors[], demoted[] }`. 진행 이벤트 `{ phase: 'insert', done, total }`(`total`은 행 수를 미리 알 때만 0보다 큼). 커맨드를 돌려주지 않는다(Step 7 "가져오기는 커맨드가 아니다") | 가능(전체 롤백) |
| `export.stream` | `{ tableId, viewSpec, format, options }` | 조각 이벤트 `{ chunk }` 후 완료 | 가능 |

데스크톱 모드에서 Worker의 엔진 구현은 메인에 `engine:call` / `engine:result` 메시지로 SQL 호출을 위임한다. 이는 RPC와 별개의 내부 채널이며 위 표에 넣지 않는다. 형식은 `{ callId, op, args }` / `{ callId, ok, result | error }`이고 진행률은 `{ callId, progress }`다.

규칙: Worker는 상태를 "열린 DB 하나"만 가진다. `db.open` 중에 다른 요청이 오면 `E_DB_BUSY`. 쓰기 op(`command.apply`, `schema.*` 중 `schema.list` 외 전부, `views.save`·`views.delete`, `import.run`, `search.enable`·`search.disable`)와 `db.snapshot`·`db.close`는 서로 배타적이며 동시에 오면 `E_DB_BUSY`. `query.*`, `schema.list`, `views.list`, `import.preview`(파싱만 하고 DB는 읽기만 한다)는 언제나 허용된다(읽기).

`db.snapshot`·`db.close`가 배타인 이유: 둘 다 트랜잭션 상태를 전제로 한다(스냅샷은 트랜잭션 밖에서만 뜰 수 있고, 닫기는 연결을 없앤다). 쓰기 op는 청크 사이에서 이벤트 루프로 돌아오므로 그 틈에 저장 요청이 끼어들 수 있고, 끼어들면 중첩 SAVEPOINT 이름이 겹쳐 롤백이 깨진다. 파일에는 아무것도 쓰이지 않았는데 `revision`·`saved_by`만 올라간 DB가 남는 것이 최악이다. 긴 작업 중의 저장은 큐에 넣지 않고 거절하며, UI가 "작업이 끝난 뒤 다시 저장하세요"로 안내한다.

---

## 7. 공통 예외 처리 카탈로그

모든 오류는 `AppError { code, message, detail?, recoverable }`이다. UI는 `code`로 문구(i18n)와 다음 행동을 결정한다. 원인 예외는 `cause`에 보존한다.

| 코드 | 상황 | 복구 가능 | UI 행동 |
|---|---|---|---|
| `E_ENV_NO_WASM` | wasm 지원 없음 | 아니오 | 시작 화면에서 잠금, 지원 브라우저 안내 |
| `E_ENV_NO_WORKER` | Worker 생성 실패 | 예 | 인라인 모드로 계속, 상태바 표시 |
| `E_ENV_NO_IDB` | IndexedDB 사용 불가 | 예 | 저널·백업·최근 파일 비활성 안내 |
| `E_FILE_NOT_SQLITE` | 헤더 불일치 | 예 | 열기 취소 |
| `E_FILE_CORRUPT` | integrity_check 실패 | 예 | 열기 취소, sqlite3 `.recover` 안내 |
| `E_FILE_TOO_LARGE` | 엔진의 `maxFileBytes` 초과(wasm 1.5 GB, native 없음). XLSX 가져오기의 100 MB 상한(`detail.format = 'xlsx'`) | 예 | 열기 거부. XLSX는 CSV로 저장 후 가져오기 안내 |
| `E_FILE_NEWER_SCHEMA` | 앱보다 새 schema_version | 예 | 읽기 전용으로 열기 |
| `E_FILE_PERMISSION` | 핸들 권한 거부 | 예 | 다른 이름으로 저장 유도 |
| `E_FILE_WRITE` | 쓰기 실패 | 예 | 원본 보존 안내, 재시도·다운로드 대안 |
| `E_REVISION_BEHIND` | 4.3절 경고 조건 | 예 | 경고 대화상자 |
| `E_DB_QUERY` | SQL 실행 오류 | 예 | 토스트, 캐시 무효화 |
| `E_DB_BUSY` | 배타 작업 충돌 | 예 | "가져오기 진행 중" 안내 |
| `E_RESULT_TOO_LARGE` | 1만 행 초과 결과 | 아니오(버그) | 콘솔 오류, 개발 중 발견 대상 |
| `E_BATCH_TOO_LARGE` | `runBatch` 파라미터 1만 건 또는 직렬화 64 MB 초과 | 아니오(버그) | 콘솔 오류, 호출자가 나눠 보내야 함 |
| `E_MEM` | 메모리 부족 | 부분 | 작업 중단, 저장 유도 |
| `E_NAME_INVALID` | 빈·중복 이름 | 예 | 폼 오류 |
| `E_SYSTEM_COLUMN` | 시스템 열 변경 시도 | 예 | 거부 |
| `E_VALUE_INVALID` | 타입 검증 실패 | 예 | 편집기 유지 |
| `E_PASTE_TOO_LARGE` | 100만 셀 초과 | 예 | CSV 가져오기 안내 |
| `E_UNDO_LIMIT` | 되돌리기 스냅샷 초과 | 예 | 확인 후 히스토리 비움 |
| `E_IMPORT_ENCODING` | 깨진 문자 비율 초과(미리보기 `warnings`의 `encoding`. 던지지 않고 문구만 쓴다) | 예 | 인코딩 재선택 |
| `E_IMPORT_CANCELLED` | 사용자 취소(가져오기, 열 타입 변경, 검색 인덱스 생성) | 예 | 롤백 결과 안내(가져오기 전 상태 그대로) |
| `E_XLSX_ENCRYPTED` / `E_XLSX_CORRUPT` | 파일 문제 | 예 | 거부 |
| `E_GZIP_UNSUPPORTED` | 압축 스트림 없음 | 예 | 비압축 안내 |
| `E_QUOTA` | IDB 용량 초과 | 예 | 백업·저널 생략 안내 |
| `E_UNSUPPORTED` | 현재 엔진이 지원하지 않는 op(`db.snapshot`을 native에, `db.save`를 wasm에) | 아니오(버그) | 콘솔 오류 |
| `E_NATIVE_IPC` | 데스크톱 모드에서 타우리 IPC 실패 | 아니오 | 앱 잠금, 원인 표시. wasm 폴백 없음 |
| `E_DISK_FULL` | 작업 사본 복사·저장 중 디스크 부족 | 예 | 원본 무손상 안내, 공간 확보 후 재시도 |
| `E_FILE_LOCKED` | 원본 교체 실패(잠금·권한) | 예 | `.bak` 원복, 임시 파일 경로 안내, 다른 이름으로 저장 |
| `E_ORIGINAL_CHANGED` | 열린 뒤 원본이 디스크에서 바뀜 | 예 | 덮어쓰기 / 다른 이름으로 저장 / 취소 |
| `E_UNKNOWN` | 분류되지 않은 예외(아래 원칙 3) | 아니오 | 콘솔에 전체 스택, 저장 후 다시 시작 권고 |

원칙:
1. 데이터 유실 가능성이 있는 경로(저장, 삭제, 가져오기 취소)는 실패 시 **원본이 어떤 상태인지**를 메시지에 반드시 포함한다.
2. Worker에서 던진 오류는 직렬화하여 메인에서 같은 `AppError`로 복원한다.
3. 예상 못 한 예외(`E_UNKNOWN`)는 콘솔에 전체 스택을 남기고, 사용자에게는 "저장 후 다시 시작"을 권한다. 조용히 삼키지 않는다.

---

## 8. 성능 예산과 검증

측정 환경: Chromium 최신, 4코어 노트북, 30만 행 × 20열 픽스처(약 300 MB DB, 장문 열 2개).

| 항목 | 목표 | 측정 방법 |
|---|---|---|
| 앱 시작(빈 DB) | 1.5초 이하 | Playwright 첫 렌더 시간 |
| 300 MB 파일 열기 | 5초 이하 | `db.open` 응답 시간 |
| 스크롤 프레임 렌더 | 16 ms 이하 | 성능 트레이스 `render` 마크 |
| 창 질의(200행) | 50 ms 이하 | Worker 측 타이머 |
| 셀 편집 반영 | 30 ms 이하 | `command.apply` 왕복 |
| 정렬 변경(인덱스 없음) | 1초 이하 | `query.window` 첫 응답 |
| trigram 검색 | 200 ms 이하 | `query.count` |
| 300 MB 저장 | 5초 이하 + 디스크 시간 | `db.snapshot` + write |
| 150 MB CSV 가져오기 | 60초 이하 | `import.run` |
| 산출물 크기 | 6 MB 이하 | `verify.mjs` |
| 최대 힙(300 MB DB 저장 시점) | 1.2 GB 이하 | 힙 스냅샷 |

데스크톱 모드(Step 11)는 같은 UI 예산에 아래를 더한다. 측정 환경은 위와 같고, 픽스처는 500만 행 × 20열(약 5 GB DB)이다.

| 항목 | 목표 | 측정 방법 |
|---|---|---|
| 5 GB 파일 열기(작업 사본 복사 제외) | 2초 이하 | `db.open` 응답 시간 |
| 작업 사본 복사 | 같은 크기 파일 복사 시간의 1.2배 이내 | 러스트 측 타이머 |
| 창 질의(200행, 500만 행 테이블 끝부분) | 50 ms 이하 | 러스트 측 타이머 |
| `run_batch` 1,000행(장문 2열 포함) | 100 ms 이하 | IPC 왕복 |
| 5 GB 저장 | 같은 크기 파일 복사 시간의 1.5배 이내 | `db.save` |
| 최대 상주 메모리(5 GB DB) | 500 MB 이하 | OS 프로세스 측정 |

예산을 넘기면 원인을 기록하고 설계(D-05, D-06, D-15)를 재검토한다. 예산을 낮추는 것으로 해결하지 않는다.

---

## 9. 리스크와 미확정 사항

| # | 리스크 | 영향 | 대응 |
|---|---|---|---|
| R1 | `file://`에서 Blob Worker·IndexedDB·File System Access의 브라우저별 가용성 | 폴백 경로로만 동작할 수 있음 | Step 1·2에서 실측, 지원 매트릭스 문서화, 모든 기능 감지 후 폴백 |
| R2 | 브라우저 모드: wasm 메모리 성장 한계(`sqlite3.wasm`의 최대 메모리 2 GB, 브라우저 탭 한계). 데스크톱 모드: 작업 사본 복사와 `VACUUM INTO` 저장이 파일 크기에 비례하여 수십 GB에서 분 단위 | 브라우저: 대용량 파일 열기·저장 실패. 데스크톱: 열기·저장 대기 시간 | 브라우저: 엔진이 보고하는 경고·거부 상한, snapshot 시점 메모리 2배 예산 반영. 데스크톱: 진행률 표시, 수십 GB는 v1.1의 직접 모드 옵션으로 검토 |
| R3 | SheetJS CE 유지보수·배포 방식 변경 | XLSX 기능 의존성 | `vendor/`에 고정 버전 커밋, fflate + 자체 파서로 교체 가능한 어댑터 경계 유지 |
| R4 | 클라우드 충돌 사본으로 인한 사용자 혼란 | 편집 유실 | revision 경고, 백업 1세대, 사용 안내 문서 |
| R5 | 한글 로케일 정렬·대소문자 무시 요구 | 정렬 결과 기대 불일치 | v1은 코드 포인트 정렬로 한정하고 문서화. v1.1에서 `create_function` 기반 정렬 키 검토 |
| R6 | 브라우저 모드: 30만 행 끝부분에서 OFFSET 창 질의가 50~60 ms(세션 C 실측, id가 연속이면 id 탐색으로 회피, D-06), 100만 행 근처에서는 더 늘어남. 데스크톱 모드: 수백만~수천만 행에서 OFFSET·`count(*)`·FTS 인덱스 생성이 초 단위 이상 | 스크롤 끝부분과 필터 변경이 느림(행 삭제 뒤 id가 성기면 Step 4의 빠른 경로가 꺼짐), 검색 인덱스 생성이 오래 걸림 | 정렬 열 인덱스 자동 생성(사용자 옵션), keyset 페이징, `count(*)`는 비동기로 표시하고 완료 전에는 근사값, FTS 생성은 진행률과 취소 |
| R7 | STRICT 테이블이 아닌 외부 SQLite 파일 편집 | 타입 혼재 | "관리 대상 등록" 시 읽기 전용 기본, 변환 마법사는 v1.1 |
| R8 | WebView별 차이(WKWebView의 IndexedDB·CompressionStream, WebKitGTK 버전)와 tauri-driver의 macOS 미지원 | 데스크톱 기능 일부가 플랫폼별로 다르고 macOS E2E 자동화 불가 | 기능 감지, 지원 매트릭스에 데스크톱 열 추가, macOS는 수동 점검 목록 |
| R9 | rusqlite `bundled` 빌드의 컴파일 플래그(FTS5, `VACUUM INTO` 지원 버전)와 JS 쪽 SQLite 버전 불일치 | 같은 SQL이 한 모드에서만 실패 | 두 엔진의 `sqlite_version()`·`compile_options`를 테스트로 고정하고 차이를 문서화 |

미확정: 기본 파일 확장자를 `.db`로 할지 `.jdr.db`로 할지(현재 `.db`). 자동 저장의 기본 켜짐 여부(현재 꺼짐).
