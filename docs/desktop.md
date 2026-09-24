# 데스크톱 앱(타우리) 안내

같은 소스로 빌드하는 타우리 데스크톱 앱은 브라우저 모드와 화면·조작이 같고, 데이터베이스 엔진만 러스트의 네이티브 SQLite(rusqlite)로 바뀐다(`DESIGN.md` D-15). 파일 크기 상한이 사라지고 저장 방식이 달라지므로 아래 차이를 알아 두면 된다.

## 브라우저 모드와의 차이

| 항목 | 브라우저 모드 | 데스크톱 모드 |
|---|---|---|
| 파일 크기 상한 | 700 MB 경고, 1.5 GB 거부(wasm 메모리) | 없음(디스크 용량). 남는 상한은 수백만 행에서의 질의·인덱스 시간뿐 |
| 열기 | 파일을 통째로 메모리에 읽는다 | 원본을 **작업 사본**으로 복사한 뒤 그 사본을 연다. 원본은 저장 전까지 바뀌지 않는다 |
| 저장 | 메모리 DB를 통째로 파일에 쓴다(`createWritable` 또는 다운로드) | 사본을 `VACUUM INTO`로 임시 파일에 쓰고 원본 자리에 원자적으로 바꿔 넣는다. 저장 시간은 파일 크기에 비례한다 |
| 직전 저장본 | IndexedDB 백업(200 MB 이하). 설정에서 모두 지울 수 있다 | `<원본>.bak` 파일(저장마다 1세대 회전) |
| 데이터베이스 정리 | 삭제한 열을 지우고 파일의 빈 공간도 줄인다(`VACUUM`) | 삭제한 열만 지운다. 저장(`VACUUM INTO`)이 빈 공간을 이미 없애므로 삭제한 열이 없으면 할 일이 없다 |
| 미저장 변경 | IndexedDB 저널(커맨드 기록) | 작업 사본 자체에 남는다. 비정상 종료 뒤 같은 파일을 열면 복구를 묻는다 |
| 상태바 | "Worker 모드" | "데스크톱 모드" |

## 작업 사본 위치

앱 데이터 폴더의 `workcopies/<키>/current.db`다. 키는 파일의 `db_id`이고, 다른 도구가 만든 SQLite 파일(메타 없음)은 경로 해시(`p-…`), 저장한 적 없는 새 데이터베이스는 `new-…`다. 같은 폴더의 `meta.json`에 원본 경로와 열 때 본 원본의 시각·크기가 있다.

| OS | 앱 데이터 폴더 |
|---|---|
| Windows | `%APPDATA%\io.github.jaydrobin.jdrdatabase` |
| macOS | `~/Library/Application Support/io.github.jaydrobin.jdrdatabase` |
| Linux | `~/.local/share/io.github.jaydrobin.jdrdatabase` |

사본은 WAL 모드로 열리므로 같은 폴더에 `current.db-wal`·`current.db-shm`이 생긴다. 이 파일들은 클라우드 폴더가 아니라 앱 데이터 폴더에 있으므로 동기화되지 않는다. 저장이 끝난 깨끗한 사본은 닫을 때 지우고, 앱을 시작할 때도 지운다. 미저장 변경이 있는(dirty) 사본만 남긴다.

남은 dirty 사본은 "설정…" → "복구를 기다리는 작업 사본"에 나온다. 하나씩 열거나 버릴 수 있고, "모두 버리기"는 목록의 사본을 한 번에 지운다(그 안의 저장하지 않은 변경도 함께 사라진다). 지금 열린 데이터베이스의 사본은 목록에 없으므로 버려지지 않는다. 한 사본을 지우지 못하면(다른 프로그램이 파일을 잡고 있는 경우 등) 그 사본만 목록에 원인과 함께 남고 나머지는 지워진다. 어느 경우에도 원본 파일은 바뀌지 않는다.

## 저장 절차와 `.bak`

1. 원본의 수정 시각·크기가 열 때(또는 마지막 저장 때)와 같은지 확인한다. 다르면 **"원본 파일이 바뀌었습니다"** 대화상자가 뜬다(다른 PC에서 저장한 파일이 동기화된 경우). 덮어쓰기 / 다른 이름으로 저장 / 취소 가운데 고른다. 덮어쓰면 바뀐 원본은 `.bak`으로 남는다.
2. 사본의 WAL을 정리하고 `VACUUM INTO`로 `<원본>.tmp-<임의>` 파일을 만든다. 디스크가 부족하면 여기서 멈추고 원본·`.bak`은 그대로다.
3. 기존 원본을 `<원본>.bak`으로 옮긴다(이전 `.bak`은 지운다).
4. 임시 파일을 원본 이름으로 바꾼다. 이 단계가 실패하면(클라우드 클라이언트의 잠금 등) 원본을 `.bak`에서 되돌려 놓고 임시 파일 경로를 알려 준다. 그 파일을 "다른 이름으로 저장"하거나 잠금이 풀린 뒤 다시 저장하면 된다.

설정 대화상자의 "직전 저장본"은 `.bak`을 새 이름으로 복사한다. 열린 데이터베이스와 원본은 바뀌지 않는다.

"데이터베이스 정리…"로 삭제한 열을 지운 뒤 저장하면, 지운 열의 값은 새 원본에는 없고 `.bak`(정리 전에 마지막으로 저장한 파일)에는 남는다. `.bak`은 다음 저장 때 정리 뒤의 파일로 바뀐다. 그 전에 값을 없애려면 `.bak`을 직접 지운다. 클라우드 폴더라면 드라이브의 버전 기록에도 남는다(`docs/cloud-sync.md`).

## 클라우드 폴더 사용

원본 파일을 클라우드 동기화 폴더에 두어도 된다. 앱은 원본을 직접 열지 않으므로 클라우드 폴더에는 `-journal`·`-wal` 부속 파일이 생기지 않고, 저장할 때만 원본과 `.bak`이 바뀐다. 여러 PC를 오가는 절차는 `docs/cloud-sync.md`와 같다. 저장 직전에 원본이 바뀐 것을 발견하면 위 1번의 대화상자가 뜬다.

## 미저장 변경 복구

편집 중 앱이 비정상 종료되면 사본이 dirty 상태로 남는다.

- 같은 파일을 다시 열면 "저장되지 않은 변경 복구" 대화상자가 뜬다. 사본의 revision이 파일과 같으면 복구가 안전하다. 파일이 그 사이 다른 PC에서 저장되어 revision이 앞서 있으면 복구한 뒤 "다른 이름으로 저장"을 권한다(그대로 저장하면 원본 변경 대화상자가 뜬다).
- 저장한 적 없는 새 데이터베이스의 변경은 다음 실행 때 시작 화면에서 복구를 묻는다.
- 파일의 dirty 사본이 남아 있으면 시작 때 "…의 저장되지 않은 변경이 작업 사본에 남아 있습니다"라고 알린다.

## 빌드와 검사

```
npm run tauri:dev                     # 개발 실행(먼저 npm run build로 dist/tauri를 만든다)
npm run tauri:build                   # 설치본(src-tauri/target/release/bundle)
cargo test --manifest-path src-tauri/Cargo.toml --workspace   # 러스트 테스트(코어 + 앱)
npm run test:native                   # 실제 rusqlite 엔진에 대한 JS 엔진 적합성 테스트
npm run test:desktop                  # tauri-driver E2E(Linux: WebKitWebDriver + Xvfb, Windows: Edge Driver)
node test/desktop/perf.mjs <경로>       # 5 GB(500만 행) 데스크톱 성능. DESIGN.md 8장 데스크톱 표를 로컬에서 판정한다. 경로에 파일이 없으면 만든다(디스크는 그 크기의 약 3배)
```

필요한 것: Rust stable, Tauri 2 CLI(`devDependencies`의 `@tauri-apps/cli`), Linux는 `libwebkit2gtk-4.1-dev`·`libgtk-3-dev`(E2E는 `webkit2gtk-driver`·`xvfb`·`cargo install tauri-driver`), Windows는 WebView2(기본 설치), macOS는 Xcode 명령줄 도구. Windows 데스크톱 E2E는 WebView2 런타임과 같은 버전의 `msedgedriver.exe`를 `JDR_NATIVE_DRIVER`로 주고 `npm run test:desktop`을 돌린다(수동 실행하는 `desktop` 워크플로가 레지스트리에서 런타임 버전을 읽어 드라이버를 받는다). Edge Driver는 WebView2의 원격 디버깅을 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS` 같은 환경 변수로 켜는데, wry가 브라우저 인자와 데이터 폴더를 API로 정하므로 앱이 메인 창을 만들 때 그 값을 넘긴다(`src-tauri/src/lib.rs`의 `create_main_window`). macOS는 tauri-driver가 지원하지 않는다. WebKitGTK 개발 라이브러리가 없는 환경에서는 `cargo test --manifest-path src-tauri/Cargo.toml -p jdr-core`로 코어만 검사할 수 있다.

데스크톱 E2E는 파일 대화상자를 자동화할 수 없으므로 테스트 빌드의 훅(`window.__jdrTest.setPickedPath`)으로 경로를 넣는다. 테스트 빌드는 `npm run build -- --test`가 만드는 `dist/test/tauri/index.html`을 `tauri build --debug --no-bundle --config '{"build":{"frontendDist":"../dist/test/tauri"}}'`로 담아 만든다. 릴리스 빌드에는 훅이 없다.

## 구조

- `src-tauri/core`(`jdr-core`): 엔진·저장·작업 사본. 타우리에 의존하지 않아 어디서나 `cargo test`가 돈다. `jdr-ipc-stdio` 바이너리는 같은 명령을 표준 입출력 JSON 줄로 노출한다(`test:native`).
- `src-tauri`(앱): `engine_call`(코어 명령 + 진행률 채널), `pick_open`·`pick_save`(대화상자), `sink_write`(내보내기 조각), `app_info`. 플러그인은 dialog와 single-instance뿐이다.
- JS: Worker 안의 `db/engine-native.js`가 동기 SQL 호출을 `SharedArrayBuffer`와 `Atomics.wait`로 메인의 `io/ipc-bridge.js`에 넘기고, 브리지가 타우리 IPC로 러스트를 부른다. 그래서 `tauri.conf.json`은 `Cross-Origin-Opener-Policy`·`Cross-Origin-Embedder-Policy` 헤더를 낸다. `SharedArrayBuffer`를 쓸 수 없는 WebView에서는 앱이 `E_NATIVE_IPC`로 잠기며 wasm 엔진으로 내려가지 않는다(상한이 조용히 되돌아오는 것을 막기 위해, D-15).
