# jdrdatabase

A standalone, single-file HTML database web app inspired by local/desktop NocoDB, featuring an Excel-like spreadsheet UI capable of querying and editing hundreds of thousands of records containing extensive, long-form text.

서버 없이 브라우저에서 단독 동작하는 스프레드시트형 SQLite 데이터베이스 관리 앱. 배포 단위는 `dist/jdrdatabase.html` 파일 하나이며, 데이터는 표준 SQLite 파일(`.db`, 선택적으로 `.db.gz`)로 저장한다. 엔진은 브라우저 안의 SQLite Wasm이고 UI는 프레임워크 없는 Vanilla JS다.

## 사용

1. [Releases](../../releases)에서 `jdrdatabase.html`을 내려받아 브라우저로 연다(`file://`로 직접 열어도 되고, 아무 정적 서버에 두어도 된다). 네트워크 요청은 없다.
2. **새로 만들기** 또는 **열기…**로 SQLite 파일을 연다. 다른 도구가 만든 SQLite 파일도 확인 뒤 메타 정보를 추가해 열 수 있다.
3. 사이드바에서 테이블·열을 만들고, 그리드에서 셀을 편집한다(Enter로 편집, 장문 셀은 더블 클릭으로 사이드 패널, Ctrl+Z/Ctrl+Y로 되돌리기·다시 실행, TSV 붙여넣기).
4. **정렬…**·**필터…**·검색 상자로 보고 싶은 행만 보고, 뷰로 저장한다. 큰 테이블은 **검색 인덱스 만들기**(FTS5 trigram)로 부분 일치 검색을 빠르게 한다.
5. **가져오기…**로 CSV·TSV·XLSX를 새 테이블이나 기존 테이블에 넣고, **내보내기…**로 CSV·XLSX를 만든다.
6. **저장**(Ctrl+S)은 Chrome·Edge에서는 연 파일에 바로 쓰고(File System Access API), 다른 브라우저에서는 다운로드로 저장한다. 저장하지 않은 변경은 브라우저의 저널(IndexedDB)에 남아 탭이 닫혀도 다음에 복구를 제안한다.

클라우드 동기화 폴더에서 여러 PC를 오가는 절차와 경고 메시지의 뜻은 [docs/cloud-sync.md](docs/cloud-sync.md)에 있다.

### 지원 브라우저

Chrome·Edge 최신 2개 버전(권장. 파일에 바로 저장, 자동 저장 가능), Firefox·Safari 최신 버전(다운로드로 저장). 실측한 API 가용성은 [docs/support-matrix.md](docs/support-matrix.md)에 있다. 브라우저 모드의 파일 크기 상한은 1.5 GB(700 MB부터 경고)이며, 그 이상은 같은 소스로 빌드하는 타우리 데스크톱 앱이 네이티브 SQLite로 다룬다(상한 없음. [docs/desktop.md](docs/desktop.md), DESIGN.md D-15).

## Documents

- [DESIGN.md](DESIGN.md): 타당성 검토(단일 HTML, 단일 SQLite 파일 클라우드 왕복, CSV/XLSX 가져오기), 핵심 설계 결정, 데이터 모델, 단계별 구현 계획, 예외 처리 카탈로그, 성능 예산
- [CLAUDE.md](CLAUDE.md): 작성 규약, 테스트 규약, 코드 점검 체크리스트, Git 규약
- [docs/support-matrix.md](docs/support-matrix.md): 브라우저·WebView API 가용성 실측표
- [docs/cloud-sync.md](docs/cloud-sync.md): 클라우드 동기화 폴더에서 여러 PC를 오가는 절차와 경고 메시지의 뜻
- [docs/sessions.md](docs/sessions.md): 세션별 검증 기록과 미확인 항목

## Development

Node.js 20 이상. 런타임 의존성은 없고 `devDependencies`만 설치한다.

```
npm ci
npm run check        # lint + typecheck + unit
npm run build        # dist/jdrdatabase.html, dist/tauri/index.html
npm run verify       # 산출물 검증: 외부 참조 0건, 크기 예산, CSP, vendor 체크섬
npm run test:e2e     # 테스트 빌드(dist/test/jdrdatabase.html)를 file://로 열어 Playwright 실행
JDR_E2E_HTTP=1 npm run test:e2e   # 같은 검사를 http://localhost(정적 서버)에서
npm run test:perf    # 30만 행 픽스처를 만들어 DESIGN.md 8장의 성능 예산을 잰다(분 단위)
npm run test:native  # 러스트 코어(jdr-ipc-stdio)를 빌드해 실제 rusqlite 엔진에 대한 엔진 적합성 테스트(Rust 필요)
npm run test:desktop # tauri-driver E2E(Linux: WebKitWebDriver + Xvfb, Windows: Edge Driver)
npm run tauri:dev    # 데스크톱 앱 개발 실행
npm run tauri:build  # 데스크톱 설치본(src-tauri/target/release/bundle)
cargo test --manifest-path src-tauri/Cargo.toml --workspace   # 러스트 테스트(WebKitGTK 없는 환경은 -p jdr-core)
```

데스크톱 앱은 Rust stable과 Tauri 2 CLI(`devDependencies`)로 빌드한다. Linux는 `libwebkit2gtk-4.1-dev`·`libgtk-3-dev`가 필요하다. 작업 사본·`.bak`·저장 절차·클라우드 폴더 사용은 [docs/desktop.md](docs/desktop.md)에 있다.

성능 측정은 로컬에서는 8장의 절대 예산으로 판정하고, CI의 `perf` 잡은 같은 러너에서 잰 기준선(`test/perf/perf-baseline.json`) 대비 30% 이상 회귀를 실패로 본다. 측정값 요약은 `test-results/perf/summary.json`에 남는다.

릴리스는 `release` 워크플로가 만든다. `v*` 태그를 푸시하거나, Actions 탭의 `release` 워크플로에서 "Run workflow"로 버전(예: `1.2.0`)을 입력하면 실행한 커밋에 `v<버전>` 태그를 만든다. 워크플로는 검사·빌드·검증을 거친 브라우저용 `jdrdatabase.html`과 Windows·Linux·macOS에서 빌드한 데스크톱 설치본(`.msi`·설치 프로그램 `.exe`, `.deb`·`.AppImage`·`.rpm`, `.dmg`), 설치 없이 실행하는 Windows 포터블 실행 파일 `jdrdatabase-desktop.exe`를 한 GitHub 릴리스에 첨부하고, 첨부 파일 전부의 SHA-256을 `SHA256SUMS`에 적는다. 설치본의 버전은 릴리스 버전의 숫자 부분(`X.Y.Z`)이고, 버전에 `-rc.1` 같은 꼬리표가 붙으면 프리릴리스로 올린다. 데스크톱 파일은 코드 서명을 하지 않는다. `dist/`는 저장소에 커밋하지 않는다.
