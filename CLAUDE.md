# jdrdatabase 개발 규약

구글 드라이브 폴더의 마크다운 노트를 표·보드·캘린더·갤러리 뷰로 다루는 개인용 단일 HTML 웹앱. 설계의 근거와 단계별 계획은 `docs/DESIGN.md`에 있고, 이 파일은 작업할 때마다 지켜야 하는 것만 담는다. 두 문서가 어긋나면 이 파일을 고쳐 설계도에 맞춘다.

## 저장소 구조

```text
index.html                     개발용 진입점. src/*.js를 <script src>로 직접 로드
src/parser.js                  순수 함수. 프론트매터·태그·링크·인라인 필드·태스크 추출
src/query.js                   순수 함수. 필터·정렬·그룹·타입 추론·DQL 파서
src/drive.js                   Google Drive API 클라이언트 (fetch 기반, gapi 미사용)
src/cache.js                   IndexedDB 래퍼
src/store.js                   메모리 인덱스와 이벤트
src/sync.js                    전체 스캔·증분 동기화·오프라인 큐
src/notes.js                   노트 열기·저장·필드 갱신·생성·이름 변경·삭제의 단일 진입점
src/views/                     table, board, calendar, gallery, view-editor
src/import.js                  스프레드시트 가져오기와 CSV 내보내기
src/ui.js                      레이아웃, 상태 표시, 명령 팔레트, 오류 배너
src/app.js                     부팅 순서
src/worker.js                  파싱 Worker 본문. 빌드 시 Blob 문자열로 인라인
scripts/build.mjs              src/*.js를 인라인해 dist/index.html 생성
scripts/serve.mjs              http://localhost:8080 정적 서버 (Node 내장 http만 사용)
tests/*.test.mjs               node --test로 실행하는 단위 테스트
tests/fixtures/vault/          파서 예외 케이스 실제 파일
docs/DESIGN.md                 설계도
REVIEW.md                      제3자 점검 체크리스트
.github/workflows/release.yml  main 푸시 시 빌드 후 latest 릴리스에 dist/index.html 첨부
dist/                          빌드 결과. 커밋하지 않음
```

## 환경과 도구

- npm 의존성, 번들러, 트랜스파일러를 쓰지 않는다. `package.json`을 만들지 않는다.
- 외부 라이브러리는 cdnjs의 UMD 빌드를 `<script src>`로 로드한다. 버전을 고정하고 SRI `integrity`를 붙인다. 현재 허용 목록: `js-yaml`, `marked`, `dompurify`, `xlsx`(SheetJS). 추가하려면 `docs/DESIGN.md`의 ADR-12에 근거를 먼저 적는다.
- 브라우저 전용 코드다. Node에서 실행되는 것은 `scripts/`와 `tests/`뿐이다.
- `src/parser.js`와 `src/query.js`는 DOM, `fetch`, 전역 상태에 의존하지 않는 순수 함수만 둔다. Worker와 Node 테스트에서 그대로 로드되기 때문이다.
- 사용자에게 보이는 문자열은 `JDR.i18n.ko` 테이블에 두고 한국어를 기본으로 한다. 코드 식별자와 주석은 영어로 쓴다.
- 로컬 실행은 `node scripts/serve.mjs`로 연다. `file://`로 열면 OAuth가 동작하지 않는다.

## 깨면 안 되는 불변 조건

각 항목의 근거는 `docs/DESIGN.md`의 해당 절에 있다.

- 서버에 파일 본문을 쓰는 코드는 `JDR.Notes.save` 하나뿐이다. 다른 모듈은 이를 우회하지 않는다. (§6.2)
- 저장 직전에 서버의 `modifiedTime`을 다시 읽어 편집 시작 시점과 비교한다. 다르면 저장하지 않고 충돌 흐름으로 보낸다. (ADR-5)
- 프론트매터를 편집할 때 첫 `---` 블록만 교체하고 본문 바이트는 그대로 둔다. BOM과 줄바꿈 종류도 원문을 유지한다. (ADR-6)
- YAML은 `js-yaml`의 `CORE_SCHEMA`로만 파싱·직렬화한다. `DEFAULT_SCHEMA`는 날짜를 `Date` 객체로 바꾸므로 쓰지 않는다. (ADR-7)
- 시간 비교는 서버가 준 `modifiedTime` 문자열끼리만 한다. 로컬 시계를 쓰지 않는다. (ADR-4)
- 캐시는 서버의 사본이다. 캐시가 서버를 덮어쓰는 경로는 오프라인 큐뿐이며, 큐 재생 시에도 충돌 검사를 거친다. (§6.2)
- 본문이 비어 있지 않던 파일에 빈 문자열이나 `undefined`를 쓰려 하면 저장을 거부한다. 프론트매터를 재직렬화한 뒤 다시 파싱해 원래 객체와 다르면 저장을 거부한다. (§6.2)
- Drive 요청은 볼트 루트 폴더 하위만 대상으로 한다. `JDR.Drive`는 루트 ID 밖의 경로를 요청하지 않는다. (§8)
- 렌더된 HTML은 `DOMPurify`를 거친다. 허용 스킴은 `http`, `https`, `mailto`뿐이다. 외부 링크는 새 탭에서 `rel="noopener noreferrer"`로 연다. (Step 7)
- 삭제는 항상 휴지통 이동이다. 영구 삭제 API를 호출하지 않는다. (Step 6)
- 정규식은 입력 길이에 선형인 패턴만 쓴다. 20만 자 본문이 테스트에 포함된다. (Step 4)

## 오류 처리

- 오류 타입은 `AuthError`, `NetworkError`, `ApiError(status, reason)`, `ConflictError`, `ParseError`, `QuotaError`만 쓴다.
- 모든 오류는 `JDR.UI.reportError(err, { context })`로 모은다. `console.error`만 하고 삼키지 않는다.
- 401은 토큰 갱신 후 1회 재시도, 429와 403의 속도 제한과 5xx는 지수 백오프 최대 5회, 그 외 4xx는 재시도하지 않는다. (§6.1)
- 파싱 오류가 있는 노트도 인덱스에 남긴다. `fmError`를 채우고 `fm`은 빈 객체로 둔다. 본문은 정상 표시한다.

## 테스트

- 커밋 전에 `node --test tests/`가 통과해야 한다.
- `src/parser.js`, `src/query.js`, `sanitizeFileName`, `patchFrontmatter`, `planImport`의 변경은 테스트를 함께 바꾼다.
- 파서 예외 케이스는 `tests/fixtures/vault/`에 실제 파일로 둔다. BOM, CRLF, 닫히지 않은 프론트매터, 배열 프론트매터, 깨진 YAML, 코드 블록 안의 태그와 링크가 포함되어야 한다.
- 성능 회귀는 `?bench=1` 모드로 확인한다. 기준은 `docs/DESIGN.md` §7에 있다.

## 브랜치, 커밋, PR

- `main`에 직접 커밋하지 않는다. 작업 브랜치에서 PR을 열고 병합한다.
- 커밋 메시지는 영어 명령문 제목 한 줄과, 필요하면 빈 줄 뒤 본문으로 쓴다.
- `dist/`는 커밋하지 않는다. `.gitignore`에 있다.
- 앱 소스가 바뀐 PR이 `main`에 병합되면 릴리스 워크플로가 `latest` 릴리스를 갱신한다. 빌드를 따로 실행할 필요는 없다.
- 설계 결정을 바꾸는 변경은 코드보다 먼저 `docs/DESIGN.md`의 ADR을 고친다.

## 단계 완료 시 갱신할 것

`docs/DESIGN.md`의 각 단계가 끝날 때 다음을 같은 PR에 포함한다.

- 이 파일의 "환경과 도구"에 새로 생긴 실행 방법이나 규칙
- `REVIEW.md`의 해당 단계 절에 점검 항목과 코드 위치
- 새 순수 함수의 테스트

## 문서 스타일

- 문서는 한국어로 쓴다. 코드 블록과 인라인 코드에서 한 줄에 해당하는 명령, 경로, URL은 줄을 나누지 않는다.
- 설계도의 구조(목표 / 작업 항목 / 예외 처리 / 완료 기준)를 다른 문서에서도 유지한다.
