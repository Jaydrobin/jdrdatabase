# jdrdatabase
A standalone, single-file HTML database web app inspired by local/desktop NocoDB, featuring an Excel-like spreadsheet UI capable of querying and editing hundreds of thousands of records containing extensive, long-form text.

## Documents

- [DESIGN.md](DESIGN.md): 타당성 검토(단일 HTML, 단일 SQLite 파일 클라우드 왕복, CSV/XLSX 가져오기), 핵심 설계 결정, 데이터 모델, 단계별 구현 계획, 예외 처리 카탈로그, 성능 예산
- [CLAUDE.md](CLAUDE.md): 작성 규약, 테스트 규약, 코드 점검 체크리스트, Git 규약
- [docs/support-matrix.md](docs/support-matrix.md): 브라우저·WebView API 가용성 실측표
- [docs/cloud-sync.md](docs/cloud-sync.md): 클라우드 동기화 폴더에서 여러 PC를 오가는 절차와 경고 메시지의 뜻

## Development

Node.js 20 이상. 런타임 의존성은 없고 `devDependencies`만 설치한다.

```
npm ci
npm run check        # lint + typecheck + unit
npm run build        # dist/jdrdatabase.html, dist/tauri/index.html
npm run verify       # 산출물 검증
npm run test:e2e     # 테스트 빌드(dist/test/jdrdatabase.html)를 file://로 열어 Playwright 실행
```
