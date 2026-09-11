# jdrdatabase 설계도

구글 드라이브를 저장소로 사용하고, Obsidian + Dataview + Projects 조합의 핵심 기능(프론트매터 기반 노트, 쿼리 가능한 표/보드/캘린더 뷰, 위키링크·백링크)을 단일 HTML 파일로 제공하는 개인용 웹앱의 단계별 설계 문서입니다.

문서 구성

1. 실현 가능성 판정
2. 핵심 설계 결정 (ADR)
3. 데이터 모델
4. 모듈 및 주요 함수 구성
5. 단계별 구현 계획 (Step 0 ~ Step 10)
6. 공통 예외 처리 목록
7. 테스트 전략
8. 알려진 한계와 위험

---

## 1. 실현 가능성 판정

### 1.1 Obsidian + Dataview + Projects 대체 가능 여부

가능합니다. 다만 "동일한 기능"을 그대로 복제하는 것이 아니라, 아래 표의 범위로 구현하는 것을 목표로 합니다.

| Obsidian 측 기능 | 웹앱 구현 방식 | 지원 수준 |
|---|---|---|
| 마크다운 노트 + YAML 프론트매터 | Drive 폴더의 `.md` 파일을 그대로 읽고 씀. 파일 형식을 바꾸지 않으므로 Obsidian과 병행 사용 가능 | 완전 |
| 위키링크 `[[노트]]`, 백링크 | 파일 스캔 시 링크 인덱스 구축. 이름 기준 해석, 미해석 링크 표시 | 완전 |
| 태그 (`tags:` 및 본문 `#tag`) | 파서에서 두 출처를 합쳐 인덱스 | 완전 |
| Dataview 인라인 필드 `키:: 값` | 본문 파싱으로 읽기 전용 메타데이터 제공 | 읽기 전용 |
| Dataview 쿼리 (TABLE / LIST / TASK) | JSON 뷰 정의를 기본으로 하고, DQL 부분집합을 JSON으로 컴파일 | 부분집합 |
| Dataview JS (`dv.pages()`) | 미지원. 필요 시 `JDR.query()` API를 콘솔에서 사용 | 미지원 |
| Projects 표 뷰 (인라인 편집) | 가상 스크롤 표 + 셀 편집 시 프론트매터만 재작성 | 완전 |
| Projects 보드 / 캘린더 / 갤러리 | 동일 인덱스를 다른 렌더러로 출력. 드래그로 필드 갱신 | 완전 |
| 그래프 뷰, 캔버스, 플러그인 생태계 | 범위 밖 | 미지원 |

성능 목표는 노트 3,000개, 노트 하나에 본문 20만 자까지 표 조작이 지연 없이 동작하는 것입니다. 이를 위해 본문은 표에 절대 올리지 않고, 메타데이터·미리보기·통계만 메모리 인덱스에 두며, 본문은 IndexedDB에 캐시했다가 편집기가 열릴 때만 로드합니다.

### 1.2 브라우저 전용 구현의 제약 (사전에 알아야 할 것)

- `file://`로 연 HTML에서는 Google OAuth가 동작하지 않습니다. GitHub Pages 같은 `https` 오리진, 개발 중에는 `http://localhost`가 필요합니다.
- 브라우저용 OAuth(Google Identity Services 토큰 모델)는 리프레시 토큰을 주지 않습니다. 액세스 토큰은 1시간 만료이며, 만료 시 `prompt: ''`로 무음 재발급을 시도하고 실패하면 재로그인을 요구합니다.
- 사용자가 지정한 기존 폴더를 읽으려면 `https://www.googleapis.com/auth/drive` 범위가 필요합니다. 이는 제한 범위이므로 개인용 앱은 OAuth 동의 화면을 "테스트" 상태로 두고 본인 계정을 테스트 사용자로 등록해 사용합니다.
- Drive는 같은 폴더에 같은 이름의 파일을 여러 개 허용합니다. Obsidian은 허용하지 않으므로 이 경우를 별도로 처리해야 합니다.
- CDN 라이브러리에 의존합니다. 오프라인에서 최초 로드는 불가하며, 배포 시 버전 고정과 SRI 해시를 사용합니다.

### 1.3 구글 스프레드시트 변환 기능

가능합니다. 두 경로를 제공합니다.

- 경로 A: Sheets API v4로 스프레드시트를 직접 읽음. `spreadsheets.readonly` 범위를 점진적 동의(incremental authorization)로 추가 요청.
- 경로 B: 사용자가 CSV / XLSX 파일을 로컬에서 선택하여 SheetJS로 파싱. 추가 OAuth 범위가 필요 없고, Sheets에서 "다운로드"만 하면 되므로 첫 구현은 이 경로로 시작.

변환 규칙은 "행 하나 = 노트 하나"가 기본이며, 제목 열·본문 열·프론트매터 열을 사용자가 매핑 마법사에서 지정합니다. 상세 설계는 Step 9에 있습니다.

---

## 2. 핵심 설계 결정 (ADR)

각 항목은 결정 / 근거 / 대안과 기각 사유 순서로 적습니다.

### ADR-1. 파일 형식은 Obsidian 호환 마크다운 그대로 유지

- 결정: 노트는 `.md` 파일이고, 메타데이터는 파일 상단 YAML 프론트매터입니다. 앱 전용 형식을 만들지 않습니다.
- 근거: Google Drive 데스크톱 동기화를 통해 같은 폴더를 Obsidian 볼트로 열 수 있어야 합니다. 데이터 소유권과 이탈 가능성을 보장합니다.
- 기각 대안: JSON 사이드카 파일에 메타데이터를 두는 방식. Obsidian과 메타데이터가 어긋나므로 기각.

### ADR-2. 앱 설정과 뷰 정의는 볼트 안의 `.jdr/` 폴더에 저장

- 결정: 뷰 정의(`.jdr/views.json`), 컬럼 타입 재정의, 가져오기 로그를 Drive의 볼트 폴더 하위 `.jdr/`에 둡니다.
- 근거: 여러 기기에서 같은 뷰를 보게 하려면 설정도 Drive에 있어야 합니다. Obsidian은 점(.)으로 시작하는 폴더를 무시하므로 충돌이 없습니다.
- 기각 대안: `localStorage`. 기기 간 공유가 안 되어 기각. 단, 마지막으로 연 뷰·창 크기 같은 기기별 편의 정보는 `localStorage`에 둡니다.

### ADR-3. 메모리에는 인덱스만, 본문은 IndexedDB

- 결정: 메모리 인덱스 레코드는 파일 ID, 경로, 프론트매터, 태그, 링크, 글자 수, 미리보기 200자, `modifiedTime`만 가집니다. 본문 전문은 IndexedDB `bodies` 저장소에 캐시하고 편집기·전문 검색이 필요할 때만 읽습니다.
- 근거: 3,000개 × 20만 자 = 최대 6억 자를 메모리에 올릴 수 없습니다. 표 렌더링이 본문 크기와 무관해야 합니다.

### ADR-4. 동기화는 `modifiedTime` 기반 증분 + Drive Changes API

- 결정: 최초에는 폴더 트리를 재귀로 전체 목록화합니다. 이후에는 `changes.list`로 변경분만 받아 캐시와 비교하고, 캐시의 `modifiedTime`과 다른 파일만 다시 다운로드합니다. 삭제는 Changes API의 `removed` 항목과 주기적 전체 재목록화(기본 30분)로 감지합니다.
- 근거: 파일 1개당 요청 1개인 다운로드를 최소화해야 합니다. Changes API는 삭제와 이동을 알려줍니다.
- 주의: 시간 비교는 서버가 준 문자열끼리만 비교합니다. 로컬 시계는 절대 사용하지 않습니다(시계 오차 문제).

### ADR-5. 쓰기 충돌은 저장 직전 `modifiedTime` 재확인으로 감지

- 결정: 저장 전에 `files.get?fields=modifiedTime`을 호출해 편집을 시작할 때의 값과 비교합니다. 다르면 저장을 중단하고 "서버 버전 / 내 버전 / 둘 다 보관(사본 생성)" 세 선택지를 제시합니다.
- 근거: Drive API v3의 `files.update`는 조건부 요청(If-Match)을 지원하지 않습니다. 확인 후 저장 사이에 극히 짧은 경쟁 구간이 남지만 개인용 앱에서는 허용 가능한 수준입니다.

### ADR-6. 프론트매터 편집은 프론트매터 블록만 교체, 본문 바이트는 손대지 않음

- 결정: 표에서 셀을 편집하면 파일의 첫 `---` 블록만 새로 직렬화해서 바꾸고, 그 아래 본문은 원문 그대로 이어 붙입니다. 줄바꿈 종류(CRLF/LF)와 BOM도 원문을 유지합니다.
- 근거: 사용자가 모르는 사이에 본문이 바뀌면 안 됩니다.
- 알려진 손실: 프론트매터 안의 YAML 주석과 원래의 따옴표 스타일은 재직렬화 시 사라집니다. Step 6에서 단순 스칼라 값은 해당 줄만 문자열 치환하는 최적화로 완화합니다.

### ADR-7. YAML 파싱은 `js-yaml`의 `CORE_SCHEMA`

- 결정: `DEFAULT_SCHEMA`가 아닌 `CORE_SCHEMA`를 씁니다.
- 근거: `DEFAULT_SCHEMA`는 `2026-09-12`를 `Date` 객체로 바꿉니다. 이후 재직렬화하면 `2026-09-12T00:00:00.000Z`로 변해 Obsidian과 어긋납니다. 날짜·링크·목록 등의 타입 판정은 앱의 컬럼 타입 추론기가 문자열을 보고 따로 수행합니다.

### ADR-8. 뷰 정의의 정본은 JSON, DQL은 그 위의 편의 문법

- 결정: 필터·정렬·그룹·컬럼을 JSON 객체로 정의하고 UI에서 편집합니다. Dataview 쿼리 언어(DQL)의 부분집합은 이 JSON으로 컴파일되는 텍스트 입력 방식으로 Step 8에서 추가합니다.
- 근거: Projects 플러그인의 사용 방식(클릭으로 뷰 구성)이 주 사용 경로입니다. DQL 전체 구현은 비용이 크고 JS 표현식 평가는 보안·복잡도 문제가 있습니다.

### ADR-9. 파일 이름이 곧 제목

- 결정: Obsidian과 동일하게 `파일명.md`의 파일명이 노트 제목입니다. 프론트매터 `title`은 표시용 재정의로만 사용합니다. 제목 변경은 Drive `files.update`로 이름을 바꾸는 것입니다.
- 근거: 위키링크 해석 규칙이 Obsidian과 같아야 합니다.

### ADR-10. 개발 구조는 다중 파일, 배포는 단일 파일

- 결정: 개발 중에는 `index.html` + `src/*.js`로 나누어 작성하고, 20줄 정도의 인라이너 스크립트(`scripts/build.mjs`)가 `dist/index.html` 하나로 합칩니다. npm 의존성이나 번들러는 쓰지 않습니다.
- 근거: 순수 함수(파서, 쿼리 엔진, 파일명 정규화)를 브라우저 없이 Node에서 테스트할 수 있어야 합니다. 배포물은 여전히 단일 HTML입니다.
- 기각 대안: 처음부터 단일 파일에 모두 작성. 테스트 불가와 3,000줄 이상의 파일 편집 부담으로 기각.

### ADR-11. 무거운 파싱은 Web Worker에서 수행

- 결정: 프론트매터·태그·링크 추출은 Worker에서 일괄 처리합니다. 단일 파일 배포를 위해 Worker 코드는 `Blob URL`로 생성합니다.
- 근거: 초기 동기화에서 수천 개 파일을 파싱할 때 UI가 멈추면 안 됩니다.

### ADR-12. 렌더링 라이브러리 선택

- 표: 직접 구현한 가상 스크롤. 외부 그리드 라이브러리는 컬럼 타입 편집기·그룹·인라인 편집 요구사항과 맞추기 어렵고 CSS 충돌이 잦습니다.
- 마크다운: `marked` + `DOMPurify`. 위키링크·태그·인라인 필드는 `marked` 확장으로 처리합니다.
- 편집기: 1차는 `<textarea>`. 20만 자도 브라우저 기본 텍스트 영역이 감당합니다. 구문 강조가 필요해지면 CodeMirror 6 CDN 빌드로 교체하되 인터페이스(`Editor.getValue / setValue / onChange`)를 미리 고정해 둡니다.
- 스프레드시트 파싱: SheetJS (`xlsx`) CDN 빌드.

---

## 3. 데이터 모델

### 3.1 노트 파일 규약

```markdown
---
title: 첫 번째 글
status: 진행중
date: 2026-09-12
tags: [아이디어, 메모]
related: "[[두 번째 글]]"
---
본문. 인라인 필드도 읽습니다.
우선순위:: 높음

- [ ] 할 일 항목
```

- 프론트매터는 파일 첫 줄이 정확히 `---`일 때만 인식합니다(BOM 허용).
- 닫는 `---` 또는 `...`이 없으면 프론트매터 없음으로 취급하고 파일 전체를 본문으로 봅니다.
- 위키링크 형태: `[[이름]]`, `[[이름|별칭]]`, `[[이름#제목]]`, `[[이름^블록]]`, 임베드 `![[이름]]`.
- 태그: `tags` 키(문자열 또는 배열), 본문의 `#태그`(코드 블록·인라인 코드·URL 내부 제외, `#`만 있는 경우 제외).

### 3.2 메모리 인덱스 레코드 (`NoteMeta`)

```js
{
  id: 'drive-file-id',
  name: '첫 번째 글',            // 확장자 제외 파일명
  path: '프로젝트/첫 번째 글.md', // 볼트 루트 기준 경로
  parentId: 'folder-id',
  modifiedTime: '2026-09-12T03:00:00.000Z',
  size: 12345,
  fm: { title: '첫 번째 글', status: '진행중', ... }, // 파싱된 프론트매터
  fmError: null,                 // YAML 오류 메시지 (있으면 fm은 {} )
  inline: { '우선순위': '높음' },
  tags: ['아이디어', '메모'],
  links: [{ target: '두 번째 글', alias: null, heading: null, resolvedId: 'id-or-null' }],
  tasks: [{ line: 8, done: false, text: '할 일 항목' }],
  chars: 18000,
  preview: '본문 앞 200자',
  lineEnding: '\n', hasBom: false
}
```

### 3.3 IndexedDB 스키마 (`jdr-cache`, 버전 1)

| 저장소 | 키 | 값 | 용도 |
|---|---|---|---|
| `meta` | `id` | `NoteMeta` | 재시작 시 즉시 표 표시 |
| `bodies` | `id` | `{ text, modifiedTime }` | 본문 캐시 |
| `folders` | `id` | `{ name, parentId, path }` | 경로 계산 |
| `sync` | `'state'` | `{ rootId, startPageToken, lastFullScan }` | 증분 동기화 상태 |
| `pending` | 자동 증가 | `{ id, op, payload, createdAt }` | 오프라인 쓰기 큐 |

스키마 변경 시 `onupgradeneeded`에서 버전별 마이그레이션을 수행하고, 실패하면 캐시를 통째로 비우고 전체 재동기화합니다. 캐시는 언제든 버려도 되는 데이터라는 원칙을 지킵니다.

### 3.4 뷰 정의 (`.jdr/views.json`)

```json
{
  "version": 1,
  "views": [
    {
      "id": "v-2026-09-12-a1",
      "name": "진행 중 프로젝트",
      "type": "table",
      "source": { "folder": "프로젝트", "recursive": true, "tags": ["프로젝트"] },
      "filter": { "and": [ { "field": "status", "op": "neq", "value": "완료" } ] },
      "sort": [ { "field": "date", "dir": "desc" } ],
      "group": { "field": "status" },
      "columns": [
        { "field": "name", "width": 240 },
        { "field": "status", "type": "select", "options": ["대기", "진행중", "완료"] },
        { "field": "date", "type": "date" },
        { "field": "tags", "type": "tags" }
      ],
      "board": { "groupField": "status" },
      "calendar": { "dateField": "date" },
      "gallery": { "coverField": "cover", "previewLines": 3 }
    }
  ],
  "fieldTypes": { "date": "date", "priority": "number" }
}
```

필터 연산자: `eq, neq, contains, notContains, gt, gte, lt, lte, in, isEmpty, notEmpty, regex, linksTo, hasTag`.

필드 이름 예약어: `name, path, folder, tags, links, backlinks, chars, modifiedTime, created`(프론트매터에 있으면 그 값, 없으면 Drive `createdTime`). 프론트매터 키와 충돌하면 프론트매터를 우선하고 예약 값은 `$name`처럼 `$` 접두어로 접근합니다.

---

## 4. 모듈 및 주요 함수 구성

전역 네임스페이스 `JDR` 아래에 모듈을 둡니다. 화살표 왼쪽은 입력, 오른쪽은 출력입니다.

### 4.1 `JDR.Auth`

- `init({ clientId, scopes })` : GIS 토큰 클라이언트 생성.
- `signIn({ silent })` : `silent`가 참이면 `prompt: ''`, 아니면 동의 화면. 토큰과 만료 시각 반환.
- `getToken()` : 만료 60초 전이면 무음 갱신 후 반환. 실패 시 `AuthError('reauth')`.
- `requestScope(scope)` : 점진적 동의로 범위 추가(Step 9의 Sheets 범위).
- `signOut()` : `google.accounts.oauth2.revoke` 호출과 캐시 삭제 여부 선택.
- 상태 머신: `signedOut → signingIn → ready → expired → signedOut`. UI는 상태만 구독합니다.

### 4.2 `JDR.Drive` (fetch 기반 얇은 클라이언트, gapi 클라이언트 라이브러리 미사용)

- `request(path, { method, query, body, headers, raw })` : 토큰 첨부, JSON 처리, 오류 정규화, 재시도(§6.1).
- `listChildren(folderId, { pageToken })` : `q`에 `'{id}' in parents and trashed = false`, `fields`는 `nextPageToken, files(id,name,mimeType,modifiedTime,size,parents,shortcutDetails)`, `pageSize 1000`.
- `walkFolder(rootId, onBatch)` : BFS 재귀 목록화. 폴더·`.md` 파일만 수집, 나머지는 통계로만 보고.
- `getText(fileId)` : `alt=media`. 응답을 `text()`로 받고 BOM·줄바꿈을 그대로 보존.
- `batchGetText(ids)` : `multipart/mixed` 배치(최대 100개)로 본문 일괄 다운로드. 배치 실패 시 개별 요청으로 폴백.
- `updateText(fileId, text, { mimeType })` : `PATCH upload/drive/v3/files/{id}?uploadType=media`. 5MB 초과면 `uploadType=resumable`.
- `createText(parentId, name, text)` : `uploadType=multipart`로 메타데이터와 본문 동시 생성.
- `rename(fileId, name)`, `move(fileId, from, to)`, `trash(fileId)`.
- `getMeta(fileId, fields)` : 충돌 검사용.
- `getStartPageToken()`, `listChanges(pageToken)` : 증분 동기화.
- `ensureFolder(parentId, name)` : `.jdr/` 생성. 동일 이름 폴더가 이미 여러 개면 가장 오래된 것을 선택하고 경고.

### 4.3 `JDR.Cache` (IndexedDB 래퍼)

- `open()`, `getAllMeta()`, `putMeta(list)`, `deleteMeta(ids)`.
- `getBody(id)`, `putBody(id, text, modifiedTime)`.
- `getSync()`, `putSync(state)`.
- `enqueue(op)`, `dequeueAll()` : 오프라인 큐.
- `clear()` : 전체 삭제.
- 모든 함수는 `Promise`이며, IndexedDB를 열 수 없으면(시크릿 모드 등) 메모리 전용 폴백 객체를 반환하고 배너로 알립니다.

### 4.4 `JDR.Parser` (순수 함수, Worker와 메인 양쪽에서 로드)

- `splitFrontmatter(text) → { fmText, body, hasBom, lineEnding, fmRange }`.
- `parseFrontmatter(fmText) → { data, error }` : `CORE_SCHEMA`, 최상위가 객체가 아니면 오류로 취급.
- `serializeFrontmatter(data) → string` : `lineWidth: -1`, `noRefs: true`, 키 순서 유지.
- `patchFrontmatter(text, changes) → newText` : ADR-6의 규칙. 값이 단순 스칼라이고 원문에 `키: 값` 한 줄로 존재하면 그 줄만 치환, 아니면 블록 재직렬화.
- `extractTags(body, fm)`, `extractLinks(body, fm)`, `extractInlineFields(body)`, `extractTasks(body)`.
- `stripCode(body)` : 태그·링크 추출 전에 펜스 코드 블록과 인라인 코드를 같은 길이의 공백으로 치환(줄 번호 유지).
- `analyze(text, fileMeta) → NoteMeta` : 위 함수를 조합.
- `sanitizeFileName(title) → { name, changed }` : `\ / : * ? " < > |` 및 제어 문자 제거, 앞뒤 공백·점 제거, 200자 제한, 빈 문자열이면 `Untitled`.

### 4.5 `JDR.Store` (메모리 인덱스와 이벤트)

- `state = { notes: Map<id, NoteMeta>, folders: Map, byName: Map<lowerName, id[]>, backlinks: Map<id, Set<id>> }`.
- `upsert(metaList)`, `remove(ids)` : 인덱스와 `byName`, `backlinks`를 함께 갱신.
- `resolveLink(target, fromNote) → id | null` : 정확한 경로 → 파일명(대소문자 무시) 순. 후보가 여러 개면 같은 폴더 우선, 그래도 여러 개면 `null`과 경고.
- `on(event, handler)` : `notes:changed`, `sync:status`, `auth:changed`.
- `getFields() → { field: { count, types: Set } }` : 뷰 편집기의 컬럼 후보와 타입 추론 근거.

### 4.6 `JDR.Sync`

- `fullScan()` : `walkFolder` → 캐시와 `modifiedTime` 비교 → 변경분만 `batchGetText` → Worker 파싱 → `Store.upsert` → 캐시 저장. 캐시에만 있고 서버에 없는 항목은 삭제.
- `incremental()` : `listChanges` → 볼트 하위 항목만 필터 → 변경·삭제 반영. `pageToken`이 무효(410)이면 `fullScan`.
- `schedule()` : 창이 활성일 때 60초, 비활성일 때 5분 주기. `visibilitychange`와 `online` 이벤트로 즉시 실행.
- `flushPending()` : 오프라인 큐를 순서대로 재시도.
- 진행 상태 객체 `{ phase, done, total, errors[] }`를 `sync:status`로 발행.

### 4.7 `JDR.Query`

- `compileFilter(filterJson) → (note) => boolean`.
- `getValue(note, field)` : 프론트매터 → 인라인 필드 → 예약 필드 순으로 조회.
- `normalize(value, type)` : 타입별 비교값. 날짜는 `YYYY-MM-DD` 문자열 또는 ISO만 인식하고 그 외는 문자열 비교로 폴백.
- `run(view, notes) → { rows, groups }` : 소스 필터 → 필터 → 정렬(다중 키, 빈 값은 항상 마지막) → 그룹.
- `inferType(values) → 'number' | 'date' | 'boolean' | 'list' | 'link' | 'string'` : 표본 100개 중 90% 이상이 한 타입이면 채택.
- `parseDQL(text) → viewJson` (Step 8).

### 4.8 `JDR.Views`

- `Table` : `render(container, result, view)`, 가상 스크롤(행 높이 고정 32px, 버퍼 20행), 헤더 클릭 정렬, 컬럼 너비 드래그, 셀 편집기 팩토리 `editors[type]`.
- `Board` : 그룹 필드별 열, 카드 드래그 → `Notes.setField`.
- `Calendar` : 월 뷰, 날짜 필드가 없는 노트는 "날짜 없음" 트레이에 표시.
- `Gallery` : 카드 그리드, 커버 이미지는 Drive 이미지 파일이면 `thumbnailLink` 사용.
- `ViewEditor` : JSON을 직접 편집하지 않고 폼으로 편집. 저장 시 스키마 검증.

### 4.9 `JDR.Notes` (편집 작업의 단일 진입점)

- `open(id)` : 캐시 본문 → 없으면 다운로드. 편집 세션 `{ id, baseModifiedTime, text, dirty }` 생성.
- `save(session)` : 충돌 검사(ADR-5) → `updateText` → 새 `modifiedTime` 반영 → 재파싱 → `Store.upsert`.
- `setField(id, field, value)` : `patchFrontmatter` 후 `save`. 표·보드에서 사용.
- `create({ folderId, name, fm })` : 이름 정규화·중복 회피 → `createText`.
- `rename(id, newName)`, `trash(id)`.
- `autosave(session)` : 마지막 입력 후 2초 디바운스, 저장 중이면 완료 후 한 번 더 저장.

### 4.10 `JDR.Import` (Step 9)

- `readSheet(source) → { sheets: [{ name, rows: string[][] }] }` : `source`는 로컬 파일(SheetJS) 또는 스프레드시트 ID(Sheets API).
- `detectHeader(rows) → rowIndex` : 첫 번째로 비어 있지 않은 셀 비율이 80% 이상인 행.
- `buildMapping(headers) → mapping` : 기본값 추론(`제목/title/name` 열을 제목으로, 가장 긴 텍스트 열을 본문으로).
- `planImport(rows, mapping) → { notes: [{ name, fm, body, sourceRow }], warnings }` : 드라이런. 아무것도 쓰지 않음.
- `runImport(plan, { concurrency: 4, onProgress, signal })` : 생성. 중단·재개 가능.
- `exportCSV(viewResult)` : 역방향. 브라우저에서 CSV 다운로드.

### 4.11 `JDR.UI`

- 레이아웃: 좌측 사이드바(폴더 트리·뷰 목록) / 중앙 뷰 / 우측 편집 패널(접기 가능). 900px 이하에서는 편집 패널이 전체 화면 모달로 전환.
- 전역 상태 표시: 동기화 상태, 저장 상태(`저장됨 / 저장 중 / 오프라인 대기 / 충돌`), 오류 배너.
- 명령 팔레트(`Ctrl+K`): 노트 열기, 뷰 전환, 새 노트.
- 모든 사용자 노출 문자열은 `JDR.i18n.ko` 테이블에 두고 한국어를 기본으로 합니다.

---

## 5. 단계별 구현 계획

각 단계는 목표 / 산출물 / 작업 항목 / 예외 처리 / 완료 기준으로 구성됩니다. 앞 단계가 끝나야 다음 단계를 시작하되, Step 4의 파서는 Step 2와 병행 가능합니다.

### Step 0. 사전 준비와 저장소 구조

목표: 코드를 한 줄도 쓰기 전에 OAuth가 동작하는 환경을 확보합니다.

작업 항목:

1. Google Cloud 프로젝트 생성 → Drive API 활성화 → OAuth 동의 화면(외부, 테스트 상태, 본인 계정을 테스트 사용자로 등록) → 웹 애플리케이션 OAuth 클라이언트 ID 생성. 승인된 JavaScript 원본에 `http://localhost:8080`과 GitHub Pages 주소를 등록.
2. 저장소 구조 확정.

```text
index.html          개발용 진입점 (src/*.js를 <script src>로 로드)
src/parser.js       순수 함수
src/query.js        순수 함수
src/drive.js
src/cache.js
src/store.js
src/sync.js
src/notes.js
src/views/*.js
src/import.js
src/ui.js
src/app.js          부팅 순서
src/worker.js       Worker 본문 (build 시 Blob 문자열로 인라인)
scripts/build.mjs   dist/index.html 생성
scripts/serve.mjs   localhost:8080 정적 서버 (Node 내장 http만 사용)
tests/*.test.mjs    Node 기본 test runner (node --test)
dist/index.html     배포물 (커밋 대상)
```

3. `clientId`는 코드에 상수로 두지 않고 최초 실행 시 입력받아 `localStorage`에 저장. 배포 HTML에 개인 클라이언트 ID가 박히지 않게 하는 것이 목적이며, 저장소에는 예시 값만 둡니다.

예외 처리:

- `file://`로 열었을 때: `location.protocol`을 검사해 "로컬 서버 또는 https로 열어야 합니다"라는 안내 화면만 표시하고 OAuth 초기화를 시도하지 않습니다.
- CDN 스크립트 로드 실패: 각 `<script>`에 `onerror`를 걸어 어느 라이브러리가 실패했는지 배너에 표시합니다.

완료 기준: 빈 `index.html`에서 GIS 스크립트가 로드되고 콘솔에서 `google.accounts.oauth2`가 존재합니다.

### Step 1. 앱 골격과 인증

목표: 로그인·토큰 갱신·로그아웃이 안정적으로 동작하는 상태 머신을 만듭니다.

작업 항목:

1. `JDR.Auth` 구현. 토큰은 메모리에만 저장하고 `sessionStorage`에 만료 시각만 기록해 새로고침 시 무음 재발급을 먼저 시도합니다.
2. 부팅 순서(`app.js`): 환경 검사 → 캐시 열기 → 캐시된 인덱스로 UI 즉시 표시 → 무음 로그인 → 성공 시 증분 동기화 시작.
3. 공통 오류 타입 정의: `AuthError, NetworkError, ApiError(status, reason), ConflictError, ParseError, QuotaError`.

예외 처리:

- 무음 재발급 실패(`popup_closed`, `access_denied`, 쿠키 차단): 읽기 전용 모드로 캐시 데이터를 보여주고 상단에 "다시 로그인" 버튼을 표시. 편집은 잠급니다.
- 팝업 차단: GIS 오류 콜백에서 감지해 "팝업 허용 후 다시 시도"를 안내.
- 사용자가 요청한 범위 중 일부만 승인: `hasGrantedAllScopes`로 확인하고 부족한 범위를 명시해 재요청.
- 토큰 만료 중 저장 시도: `getToken()`이 먼저 갱신을 시도하고, 실패하면 저장을 오프라인 큐에 넣고 재로그인을 요구.

완료 기준: 새로고침 후 클릭 없이 로그인 상태가 복원되고, 1시간 후 자동 갱신되며, 개발자 도구에서 토큰을 지워도 다음 요청이 401을 받은 뒤 한 번 재시도해 성공합니다.

### Step 2. Drive 클라이언트와 폴더 스캔

목표: 볼트 폴더를 지정하고 그 안의 `.md` 파일 전체 목록과 본문을 가져옵니다.

작업 항목:

1. `JDR.Drive.request` 구현. 429 / 403(`rateLimitExceeded`, `userRateLimitExceeded`) / 5xx에 지수 백오프(1, 2, 4, 8, 16초 + 지터, 최대 5회). 401은 토큰 갱신 후 1회 재시도.
2. 볼트 폴더 선택 UI: 폴더 ID 직접 입력 또는 Drive URL 붙여넣기(`/folders/([\w-]+)` 추출). Picker API는 추가 API 키가 필요하므로 선택 사항으로 남깁니다.
3. `walkFolder`: 큐 기반 BFS, 폴더당 `pageSize 1000` 페이지네이션, 동시 요청 4개.
4. `batchGetText`: 100개 단위 배치. 응답 파싱은 경계 문자열 기반이며 개별 파트의 상태 코드를 확인.
5. 진행률 UI: "폴더 12/40 스캔, 파일 380/1,240 다운로드".

예외 처리:

- 확장자는 `.md`지만 `mimeType`이 `text/markdown`이 아닌 경우: 이름 기준으로 포함. 반대로 `.md`가 아닌 파일(`.txt`, `.canvas`, 이미지)은 목록에는 두되 노트로 파싱하지 않음.
- Google Docs 네이티브 문서(`application/vnd.google-apps.document`): 기본은 건너뛰고 통계에 표시. 옵션으로 `files.export?mimeType=text/markdown`을 이용한 읽기 전용 가져오기(편집 불가)를 Step 10에서 검토.
- 바로가기(`application/vnd.google-apps.shortcut`): `shortcutDetails.targetId`를 따라가되 순환 방지를 위해 방문 집합을 유지. 대상이 삭제됐으면 무시.
- 같은 폴더의 동명 파일: 두 파일 모두 인덱스에 두고 이름 뒤에 `(중복)` 배지를 표시. 위키링크 해석 시 `resolveLink`가 경고를 반환.
- 폴더 순환(공유 항목으로 인한 다중 부모): 방문한 폴더 ID 집합으로 차단.
- 공유 드라이브: 모든 목록·조회 요청에 `supportsAllDrives=true&includeItemsFromAllDrives=true`를 붙이고 `corpora`는 기본값 사용.
- 5MB 초과 파일: 다운로드는 하되 편집기에서 "대용량 파일, 저장 시 재개 가능 업로드 사용" 표시.
- 응답 본문이 UTF-8이 아닌 경우: `TextDecoder('utf-8', { fatal: true })`로 시도하고 실패 시 `fmError`에 "인코딩 오류"를 기록, 편집 잠금.
- 배치 요청 자체가 실패(413, 500): 개별 요청으로 폴백.

완료 기준: 1,000개 파일 볼트를 최초 스캔할 때 요청 수가 폴더 수 + 본문 배치 수(약 10) + 여유분 이내이고, 콘솔에 미처리 예외가 없습니다.

### Step 3. 로컬 캐시와 증분 동기화

목표: 두 번째 실행부터는 화면이 즉시 뜨고, 변경된 파일만 네트워크를 사용합니다.

작업 항목:

1. `JDR.Cache` 구현(§3.3).
2. `fullScan` 결과를 캐시에 저장하고 `startPageToken`을 기록.
3. `incremental` 구현: `changes.list(pageToken, fields=newStartPageToken,nextPageToken,changes(fileId,removed,file(id,name,mimeType,modifiedTime,parents,trashed)))`. 각 변경 항목이 볼트 하위인지는 `folders` 맵으로 부모 체인을 따라 판단.
4. 삭제 감지: `removed: true` 또는 `trashed: true` 또는 부모가 볼트 밖으로 이동한 경우 인덱스에서 제거.
5. 주기적 전체 재검증: `lastFullScan`이 30분 이상 지났으면 `fullScan`을 백그라운드로 실행해 캐시와 대조.

예외 처리:

- `pageToken` 만료(410) 또는 `startPageToken` 없음: 전체 스캔으로 폴백.
- 캐시의 `modifiedTime`이 서버보다 최신인 경우(다른 기기에서 되돌린 경우 등): 서버를 정본으로 보고 다시 다운로드. 절대 캐시로 서버를 덮어쓰지 않음.
- 동기화 중 사용자가 편집 중인 파일이 서버에서 바뀜: 편집 세션의 `baseModifiedTime`과 비교해 "서버에서 변경됨" 배지를 편집기에 표시하고 저장 시 ADR-5 충돌 흐름으로 유도. 편집 중 내용은 건드리지 않음.
- IndexedDB 용량 초과(`QuotaExceededError`): 본문 캐시(`bodies`)만 비우고 메타데이터는 유지. 이후 본문은 열 때마다 다운로드.
- 여러 탭 동시 실행: `BroadcastChannel('jdr')`로 한 탭만 동기화를 수행(리더 선출은 가장 먼저 `claim` 메시지를 보낸 탭). 다른 탭은 `notes:changed`를 수신해 인덱스만 갱신.
- 브라우저 오프라인: `navigator.onLine`이 거짓이면 동기화를 건너뛰고 상태 표시. 온라인 복귀 시 즉시 실행.

완료 기준: 앱을 다시 열었을 때 500ms 안에 캐시된 표가 보이고, 이후 Obsidian에서 파일 하나를 수정하면 60초 안에 표에 반영되며 네트워크 탭에 해당 파일의 다운로드만 추가로 보입니다.

### Step 4. 파서와 인덱스 (Worker)

목표: 프론트매터·태그·링크·인라인 필드·태스크를 정확하게 추출하고 대량 파싱이 UI를 막지 않게 합니다.

작업 항목:

1. `JDR.Parser` 순수 함수 구현과 `tests/parser.test.mjs`.
2. Worker 래퍼: `parseMany([{ id, text, fileMeta }]) → NoteMeta[]`. 500개 단위로 나누어 진행률 보고.
3. `JDR.Store` 구현. `byName`은 소문자·NFC 정규화 키.
4. 백링크 인덱스: `upsert` 시 이전 링크 집합과 새 링크 집합의 차이만 갱신.

예외 처리(파서가 반드시 통과해야 할 입력):

- BOM으로 시작하는 파일, CRLF 파일, 마지막 줄바꿈 없는 파일.
- `---`만 있고 닫히지 않은 프론트매터 → 프론트매터 없음.
- 프론트매터가 배열이거나 스칼라(`--- \n hello \n ---`) → `fmError`, `fm = {}`.
- 탭 들여쓰기, 중복 키, `: ` 없는 줄 등 YAML 오류 → `fmError`에 줄 번호 포함 메시지, 본문은 정상 표시, 표에서 해당 행에 경고 아이콘.
- `tags: 태그1, 태그2`(문자열) → 쉼표·공백 분리. `tags: "#태그"` → `#` 제거. 숫자 태그(`tags: [2026]`) → 문자열화.
- 값이 `[[링크]]`인 프론트매터 필드(`related: "[[노트]]"`, 배열 포함) → 링크로 인식해 `links`에 추가.
- 코드 블록 안의 `#`, `[[ ]]`, `키:: 값` → 무시. `~~~` 펜스와 `` ``` `` 펜스 모두 처리, 펜스가 닫히지 않으면 파일 끝까지 코드로 간주.
- URL 안의 `#fragment` → 태그 아님. `#1` 같은 숫자만인 태그는 Obsidian 규칙대로 태그 아님.
- 링크 대상이 `.md`를 포함(`[[노트.md]]`) → 확장자 제거 후 해석. 경로 포함(`[[폴더/노트]]`) → 경로 우선 해석.
- 인라인 필드 키에 공백·한글 허용. 값이 비어 있으면 무시. 같은 키가 여러 번이면 배열.
- 20만 자 본문: 정규식이 catastrophic backtracking을 일으키지 않도록 모든 정규식은 선형 패턴만 사용하고 테스트에 20만 자 케이스 포함.
- Worker 생성 실패(CSP 등): 메인 스레드에서 100개 단위로 `setTimeout` 분할 실행하는 폴백.

완료 기준: 테스트 스위트 통과. 3,000개 파일 파싱 중 메인 스레드 장기 작업(50ms 이상)이 발생하지 않습니다.

### Step 5. 표 뷰와 뷰 정의

목표: Projects의 표 뷰에 해당하는 화면을 완성하고 뷰를 저장·복원합니다.

작업 항목:

1. `JDR.Query` 필터·정렬·그룹 엔진과 `tests/query.test.mjs`.
2. 가상 스크롤 표. DOM 행은 화면에 보이는 수 + 버퍼만 유지. 그룹 헤더는 접기 가능한 고정 행.
3. 컬럼 타입 추론과 타입별 셀 렌더러: `string, number, date, boolean, list, tags, link, select, url`.
4. 뷰 편집기 폼: 소스(폴더·태그), 필터 조건 목록(추가·삭제), 정렬 키, 그룹 필드, 컬럼 선택·순서·너비.
5. `.jdr/views.json` 읽기·쓰기. 파일이 없으면 기본 뷰 "모든 노트" 생성.
6. 빠른 검색 입력(제목·태그 부분 일치, 입력 즉시 필터).

예외 처리:

- `views.json`이 손상되었거나 `version`이 미래 값: 읽기를 중단하고 기본 뷰로 실행, 파일은 `views.json.bak-<timestamp>`로 보존 후 새로 씀.
- 필터의 필드가 어떤 노트에도 없음: 오류가 아니라 빈 결과. 편집기에 "일치하는 필드 없음" 안내.
- 같은 필드에 타입이 섞임(어떤 노트는 숫자, 어떤 노트는 문자열): 추론 타입으로 정렬하되 변환 불가 값은 마지막에 문자열 순으로 배치. 셀에는 원래 값 표시.
- 날짜 형식 불일치(`2026.09.12`, `2026/9/12`, `12 Sep 2026`): `YYYY-MM-DD`와 ISO 8601만 날짜로 인식. 나머지는 문자열로 두고 셀에 점선 밑줄과 툴팁 "날짜로 인식되지 않음".
- 정규식 필터의 잘못된 패턴: 컴파일 시점에 `try/catch`로 잡아 조건 옆에 오류 표시, 해당 조건은 항상 거짓으로 평가.
- 그룹 필드가 배열(태그): 노트가 여러 그룹에 중복 표시됨을 UI에 명시. 계수는 그룹별.
- 컬럼 20개 이상 × 행 3,000개: 가로 가상화는 하지 않되 셀 렌더러가 문자열 결합만 하도록 유지. 성능 예산은 스크롤 프레임 16ms.
- 뷰 저장 시 `.jdr` 폴더 생성 권한 없음(읽기 전용 공유 폴더): 뷰를 `localStorage`에 저장하고 "이 볼트는 읽기 전용, 뷰는 이 기기에만 저장됨" 배너.

완료 기준: 3,000행 표에서 정렬·필터·스크롤이 지연 없이 동작하고, 뷰가 다른 브라우저에서 동일하게 복원됩니다.

### Step 6. 편집기와 저장

목표: 본문 편집, 자동 저장, 표에서의 인라인 프론트매터 편집, 노트 생성·이름 변경·삭제를 안전하게 처리합니다.

작업 항목:

1. `JDR.Notes` 구현(§4.9).
2. 편집 패널: 제목 입력(= 파일명), 프론트매터 폼(키·값 편집, 키 추가·삭제), 본문 `<textarea>`, 미리보기 토글.
3. 자동 저장 2초 디바운스 + `Ctrl+S` 즉시 저장 + 저장 상태 표시.
4. `beforeunload`에서 `dirty`면 이탈 경고. 페이지 숨김(`visibilitychange: hidden`) 시 즉시 저장 시도.
5. 표 셀 편집: 타입별 편집기(텍스트, 숫자, 날짜 피커, 체크박스, 셀렉트, 태그 입력). `Enter` 확정, `Esc` 취소. 확정 시 `Notes.setField`.
6. 새 노트: 현재 뷰의 소스 폴더에 생성하고, 뷰 필터가 `eq` 조건이면 그 값을 프론트매터 기본값으로 채움(Projects와 동일한 동작).
7. 삭제는 항상 휴지통 이동(`trashed: true`). 영구 삭제는 제공하지 않음.

예외 처리:

- 저장 충돌(ADR-5): 세 선택지 대화상자. "둘 다 보관"은 `이름 (충돌 2026-09-12 1530).md`로 내 버전을 새 파일로 생성하고 편집기는 서버 버전으로 교체.
- 저장 중 네트워크 실패: 오프라인 큐에 넣고 상태를 "오프라인 대기"로. 큐 재시도 시에도 충돌 검사를 수행.
- 같은 파일에 대한 저장 요청 중복: 파일별 프로미스 체인으로 직렬화. 자동 저장 중 사용자가 계속 타이핑하면 완료 후 한 번 더 저장.
- 제목 변경으로 파일명이 기존 파일과 충돌: 저장 전 `byName`으로 검사해 `이름 (2)`를 제안. 사용자가 거부하면 변경 취소.
- 파일명에 금지 문자 입력: `sanitizeFileName` 결과를 즉시 보여주고 원래 입력과 다르면 안내.
- 이름 변경 시 다른 노트의 위키링크: 기본 동작은 갱신하지 않고 백링크 개수를 경고로 표시("이 노트를 가리키는 링크 7개가 끊어집니다"). 자동 갱신은 Step 10의 선택 항목.
- 프론트매터 편집 중 YAML 오류가 있는 파일: 폼 편집을 잠그고 원문 텍스트 편집만 허용. 오류가 해결되면 폼을 다시 활성화.
- 프론트매터 값 타입 유지: 셀에서 `007`을 입력하면 문자열로, `7`은 숫자로, `true`는 불리언으로 저장하되 컬럼 타입이 `string`으로 고정되어 있으면 항상 따옴표 문자열로 직렬화.
- 5MB 초과 본문 저장: 재개 가능 업로드 사용. 중간 실패 시 세션 URI로 재개, 그래도 실패하면 오류 표시 후 내용은 편집기에 유지.
- 편집 패널을 연 채 인덱스가 갱신되어 해당 노트가 삭제됨: 편집기에 "서버에서 삭제됨" 표시, 저장하면 새 파일로 다시 생성할지 묻기.

완료 기준: 두 기기에서 같은 노트를 동시에 편집했을 때 어느 쪽의 내용도 소리 없이 사라지지 않습니다. 인라인 셀 편집 후 파일의 본문 바이트가 변하지 않았음을 테스트로 확인합니다.

### Step 7. 보드·캘린더·갤러리 뷰와 노트 미리보기

목표: Projects의 나머지 뷰와 Obsidian의 읽기 모드(위키링크 탐색·백링크)를 제공합니다.

작업 항목:

1. `Board`: 그룹 필드 값별 열. 값이 비어 있는 노트는 "미분류" 열. 드래그 드롭으로 필드 갱신, 열 안의 순서는 정렬 규칙을 따르며 저장하지 않음.
2. `Calendar`: 월 단위. 날짜 필드는 뷰 설정에서 선택. 노트 드래그로 날짜 변경.
3. `Gallery`: 카드. 커버는 프론트매터 필드 값이 Drive 이미지 파일명이면 `thumbnailLink`, URL이면 그대로 사용.
4. 마크다운 렌더러: `marked` 확장으로 위키링크를 앱 내 링크로, 태그를 필터 링크로, `키:: 값`을 정의 목록으로 렌더. 렌더 결과는 `DOMPurify`로 정화.
5. 백링크 패널과 "미해석 링크" 목록. 미해석 링크 클릭 시 해당 이름으로 새 노트 생성 제안.
6. 노트 간 이동 히스토리(뒤로/앞으로).

예외 처리:

- 보드 드래그 중 저장 실패: 카드를 원래 열로 되돌리고 오류 표시.
- 그룹 필드 값이 배열인 노트를 보드에 표시: 첫 값의 열에만 표시하고 카드에 "+N" 표시. 드래그 시 첫 값만 교체.
- 캘린더 날짜 필드 값이 날짜로 인식되지 않는 노트: "날짜 없음" 트레이로.
- 이미지 임베드 `![[image.png]]`: 볼트 안의 이미지 파일을 `thumbnailLink` 또는 `alt=media` Blob URL로 표시. 토큰이 필요한 `alt=media`는 Blob으로 변환해 캐시(최대 50개 LRU).
- 렌더링 시간 초과(20만 자 마크다운): 미리보기는 앞 5만 자만 렌더하고 "더 보기" 버튼으로 이어서 렌더.
- 자기 자신을 임베드하거나 순환 임베드: 깊이 3 초과 시 링크만 표시.

완료 기준: 네 가지 뷰가 같은 뷰 정의를 공유하고, 한 뷰에서의 편집이 다른 뷰에 즉시 반영됩니다.

### Step 8. 쿼리 언어 (DQL 부분집합)

목표: 뷰 편집기 대신 텍스트로 뷰를 정의하고, 노트 본문 안의 쿼리 블록을 렌더합니다.

지원 문법:

```text
TABLE [WITHOUT ID] 필드[ AS 별칭], ...
LIST
TASK
FROM "폴더" | #태그 | [[노트]] | 조합(and, or, -)
WHERE 표현식     비교(=, !=, <, <=, >, >=), contains(), !, and, or, 괄호
SORT 필드 ASC|DESC, ...
GROUP BY 필드
LIMIT n
```

작업 항목:

1. 토크나이저·재귀 하강 파서 → 뷰 JSON. `tests/dql.test.mjs`에 Dataview 문서의 예제 20개를 포함.
2. 뷰 편집기에 "쿼리 모드" 탭. JSON ↔ DQL 상호 변환은 DQL → JSON 방향만 보장.
3. 노트 본문의 `` ```dataview `` 코드 블록을 미리보기에서 렌더. Obsidian에서 열어도 코드 블록으로만 보이므로 호환 유지.

예외 처리:

- 파싱 오류: 위치(줄, 열)와 기대 토큰을 표시. 뷰는 마지막 정상 정의를 유지.
- 지원하지 않는 함수나 `dataviewjs` 블록: "미지원" 안내 블록으로 렌더하고 오류로 처리하지 않음.
- `FROM`에 존재하지 않는 폴더: 빈 결과와 안내.
- 쿼리 실행 시간: 3,000개 노트 기준 50ms를 넘으면 결과를 그대로 보여주되 콘솔에 경고. 무한 루프는 문법상 불가.

완료 기준: 예제 20개가 Dataview와 같은 행 집합을 반환합니다(순서까지 동일).

### Step 9. 구글 스프레드시트 가져오기

목표: 기존 스프레드시트를 노트 파일 묶음으로 변환합니다. 데이터 손실 없이, 여러 번 실행해도 중복이 생기지 않게 합니다.

작업 항목:

1. 입력 소스 두 가지. 로컬 CSV/XLSX(SheetJS, `type: 'array'`, `raw: false`로 표시 문자열 유지)를 먼저 구현하고, Sheets API(`spreadsheets.get?fields=sheets.properties` → `values.get` with `valueRenderOption=FORMATTED_VALUE`)는 점진적 동의로 범위를 추가한 뒤 사용.
2. 마법사 4단계: 시트 선택 → 헤더 행 확인 → 열 매핑 → 미리보기(첫 5개 노트의 완성된 파일 텍스트)와 경고 목록 → 실행.
3. 열 매핑 종류: `제목`(필수, 1개), `본문`(0개 이상, 여러 개면 `## 열이름` 소제목으로 이어 붙임), `프론트매터`(키 이름 편집 가능, 타입 지정: 문자열·숫자·날짜·체크박스·목록(구분자 지정)·링크), `무시`.
4. 대상 폴더 선택과 파일명 규칙(`{제목}` 기본, `{번호}-{제목}` 옵션).
5. 멱등성: 생성한 파일의 `appProperties`에 `jdrImportId`(시트 ID + 시트 이름 해시)와 `jdrRow`(원본 행 번호)를 기록. 재실행 시 같은 키가 있으면 건너뛰거나 갱신(사용자 선택).
6. 실행: 동시 4개, 진행률, 중단 버튼, 결과 보고서(`.jdr/imports/<timestamp>.json`에 성공·실패·경고 저장).
7. 대안 모드 "시트 전체를 노트 하나의 마크다운 표로": 참조용 작은 시트를 위해 제공.
8. 역방향: 현재 뷰 결과를 CSV로 다운로드(`exportCSV`). UTF-8 BOM 포함으로 엑셀 호환.

예외 처리:

- 빈 헤더 셀: `열_N`. 중복 헤더: `이름_2`. YAML 키로 부적합한 문자(`:`, `#`, 선행 공백 등): 언더스코어로 치환하고 매핑 화면에 원래 이름 병기.
- 제목 열이 비어 있는 행: `행 N`을 제목으로 쓰거나 건너뛰기(기본: 건너뛰고 경고).
- 제목 중복: 같은 실행 안에서는 `(2)`, `(3)` 접미사. 대상 폴더에 이미 같은 이름이 있고 `jdrImportId`가 다르면 건너뛰고 경고.
- 파일명 금지 문자와 길이: `sanitizeFileName`. 변경된 이름은 프론트매터 `title`에 원문 보존.
- 셀 값의 줄바꿈: 프론트매터로 가면 블록 스칼라(`|`)로 직렬화, 본문으로 가면 그대로.
- 숫자로 보이는 문자열(전화번호 `010-1234`, 우편번호 `01234`): 타입을 "문자열"로 지정하면 따옴표로 감싸 보존. 자동 추론은 선행 0이 있으면 문자열 유지.
- 날짜: XLSX 시리얼 번호는 SheetJS `cellDates: true`로 `Date`를 받아 `YYYY-MM-DD`로. Sheets API는 `FORMATTED_VALUE`의 표시 문자열을 받되 로케일 형식(`2026. 9. 12`)을 `YYYY-MM-DD`로 정규화 시도, 실패하면 문자열 유지 + 경고.
- 수식 오류 값(`#REF!`, `#N/A`): 빈 값으로 처리하고 경고.
- 병합 셀: 첫 셀에만 값이 있음. "위 행 값 채우기" 옵션 제공.
- 1만 행 이상: 미리보기는 표본만, 실행은 500행 단위로 나누어 진행하며 각 단위 완료 시 보고서를 갱신해 브라우저가 닫혀도 재개 가능.
- 속도 제한(403 `rateLimitExceeded`, 429): 백오프 후 재시도, 3회 연속 실패 시 동시성을 1로 낮춤.
- 중간 실패: 실패 행 목록을 보고서에 남기고 "실패한 행만 재시도" 버튼 제공.
- 사용자가 탭을 닫음: `beforeunload` 경고. 재실행 시 `jdrImportId` + `jdrRow` 조회로 이미 만든 행은 건너뜀.
- 100MB 이상 XLSX: SheetJS 파싱이 메모리 초과할 수 있으므로 50MB 초과 시 CSV로 변환해 올리라는 안내.
- Sheets API 범위 미승인: 로컬 파일 경로로 안내.

완료 기준: 1,000행 시트가 손실 없이 1,000개 노트로 변환되고, 같은 시트로 재실행하면 새 파일이 0개 생성되며, 표 뷰에서 열이 프론트매터 필드로 그대로 보입니다.

### Step 10. 마무리: 검색, 오프라인, 단축키, 배포

작업 항목:

1. 전문 검색: Worker에서 IndexedDB `bodies`를 순회하며 부분 문자열 검색. 결과는 노트별 첫 일치 문맥 100자. 3,000개 × 평균 2만 자 기준 1초 이내를 목표로 하고, 넘으면 간단한 역색인(2-gram) 도입.
2. 오프라인: 캐시 데이터 읽기·편집을 허용하고 큐로 저장. 앱 자체는 CDN 의존 때문에 최초 로드가 필요함을 안내.
3. 단축키: `Ctrl+K` 팔레트, `Ctrl+N` 새 노트, `Ctrl+S` 저장, `Esc` 패널 닫기, 표에서 방향키 이동.
4. 선택 항목: 이름 변경 시 위키링크 자동 갱신(백링크 노트 각각에 대해 충돌 검사 후 저장, 하나라도 실패하면 보고서), Google Docs 읽기 전용 가져오기, CodeMirror 편집기.
5. 빌드: `scripts/build.mjs`가 `src/*.js`와 `worker.js`를 인라인해 `dist/index.html` 생성. CDN `<script>`에 SRI `integrity`와 고정 버전. `dist`를 GitHub Pages로 배포.
6. 문서: README에 GCP 설정 절차, 배포 절차, 알려진 한계.

예외 처리:

- 검색 중 사용자가 검색어를 바꿈: 이전 Worker 작업을 `AbortController`로 취소.
- 오프라인 큐 재생 시 충돌: 온라인 복귀 후 충돌 파일 목록을 한 번에 표시.
- SRI 불일치(CDN이 파일을 바꿈): 로드 실패로 취급하고 배너에 라이브러리명 표시. 배포 전 `scripts/build.mjs`가 해시를 다시 계산하는지 확인.

완료 기준: `dist/index.html` 하나를 GitHub Pages에 올려 모바일 브라우저에서 로그인·보기·편집이 동작합니다.

---

## 6. 공통 예외 처리 목록

단계와 무관하게 모든 모듈이 따르는 규칙입니다.

### 6.1 네트워크와 API

| 상황 | 처리 |
|---|---|
| 401 | 토큰 무음 갱신 후 1회 재시도. 실패 시 읽기 전용 모드 + 재로그인 요구 |
| 403 `rateLimitExceeded`, `userRateLimitExceeded`, 429 | 지수 백오프 최대 5회. 이후 `QuotaError`로 사용자에게 "잠시 후 다시 시도" |
| 403 `insufficientPermissions`, `appNotAuthorizedToFile` | 재시도 없음. 범위 재요청 안내 |
| 403 `storageQuotaExceeded` | 저장 실패를 명확히 표시, 편집 내용 유지 |
| 404 | 인덱스에서 제거하고 사용자가 열어 둔 편집기가 있으면 "삭제됨" 표시 |
| 5xx, 네트워크 오류, 타임아웃(30초) | 백오프 재시도. 쓰기 작업은 재시도 전 충돌 검사 반복 |
| 응답 JSON 파싱 실패 | `ApiError(status, 'badResponse')`. 원문 200자를 오류 상세에 첨부 |

모든 오류는 `JDR.UI.reportError(err, { context })`로 모여 배너와 콘솔에 기록되고, 최근 50건은 "문제 보고" 패널에서 복사할 수 있습니다.

### 6.2 데이터 무결성

- 파일 본문을 서버에 쓰는 코드는 `JDR.Notes.save` 하나뿐입니다. 다른 모듈은 이를 우회하지 않습니다.
- 쓰기 직전 `text`가 `undefined`나 빈 문자열인데 원본이 비어 있지 않았다면 저장을 거부하고 오류를 냅니다(버그로 인한 내용 소실 방지).
- 프론트매터 재직렬화 후 다시 파싱해 원래 객체와 깊은 비교가 일치하지 않으면 저장을 거부합니다.
- 캐시는 언제나 서버의 사본입니다. 캐시가 서버를 덮어쓰는 경로는 오프라인 큐뿐이며, 큐 재생 시에도 충돌 검사를 거칩니다.

### 6.3 브라우저 환경

- IndexedDB 불가: 메모리 캐시 폴백, 새로고침마다 전체 스캔 경고.
- `localStorage` 접근 예외(시크릿 모드): `try/catch`로 감싸고 기본값 사용.
- Worker 불가: 메인 스레드 분할 실행 폴백.
- 400px 너비: 표는 가로 스크롤 컨테이너, 편집기는 전체 화면.
- 뒤로 가기: `history.pushState`로 노트·뷰 상태를 URL 해시(`#view=<id>&note=<id>`)에 반영해 새로고침·공유 시 같은 화면 복원.

---

## 7. 테스트 전략

- 단위 테스트(`node --test tests/`): `parser`, `query`, `dql`, `sanitizeFileName`, `patchFrontmatter`, 가져오기 계획(`planImport`). 외부 의존성 없음. `js-yaml`은 테스트 실행 시 CDN에서 한 번 받아 `tests/vendor/`에 캐시.
- 픽스처: `tests/fixtures/vault/`에 위 예외 목록의 입력 파일들을 실제 파일로 둡니다(BOM, CRLF, 깨진 YAML, 20만 자 파일은 생성 스크립트로).
- 브라우저 통합 테스트(`tests/browser.html`): `JDR.Drive`를 가짜 구현으로 바꿔 동기화·충돌·오프라인 큐 시나리오를 재생. Playwright로 자동화 가능하지만 필수는 아님.
- 성능 회귀 검사: 3,000개 노트 가짜 볼트를 생성해 초기 파싱 시간, 표 정렬 시간, 스크롤 프레임 시간을 콘솔에 출력하는 `?bench=1` 모드.
- 수동 점검 목록(릴리스마다): 두 기기 동시 편집, 토큰 만료 후 저장, Obsidian에서 수정 → 웹앱 반영, 시트 재가져오기 중복 0건.

---

## 8. 알려진 한계와 위험

| 항목 | 내용 | 대응 |
|---|---|---|
| OAuth 테스트 상태 | 테스트 사용자 100명 제한, 동의 화면에 "확인되지 않은 앱" 경고 | 개인용이므로 수용. 공개 배포 시 검증 절차 필요 |
| `drive` 전체 범위 | 앱이 드라이브 전체를 읽을 수 있는 권한 | 코드가 볼트 폴더 밖을 요청하지 않도록 `Drive` 모듈에서 루트 ID 검사. Picker + `drive.file` 범위로 축소하는 방안은 폴더 하위 접근이 보장되지 않아 보류 |
| 조건부 쓰기 부재 | 충돌 검사와 쓰기 사이의 경쟁 구간 | 개인용에서는 허용. 충돌 시 데이터는 사본으로 보존되어 소실은 없음 |
| YAML 주석 소실 | 프론트매터 재직렬화 | 단순 스칼라는 줄 치환으로 완화, 문서화 |
| Dataview 완전 호환 불가 | 함수·JS 쿼리 미지원 | 부분집합 명시, 미지원 블록은 안내로 렌더 |
| CDN 의존 | 오프라인 최초 로드 불가, CDN 장애 | 버전 고정 + SRI, 필요 시 라이브러리 인라인 빌드 옵션 |
| Drive 동명 파일 | Obsidian과 모델 불일치 | 배지 표시, 링크 해석 경고 |
| 대용량 볼트(1만 개 이상) | 메모리 인덱스와 전체 재스캔 비용 | 목표 범위 밖. 폴더 단위 부분 로드는 후속 과제 |
