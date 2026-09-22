//! `#[tauri::command]` 래퍼. 코어의 `Backend::call`을 `spawn_blocking`에서 부르고 진행률은 `Channel`로 보낸다.
//! 파일 대화상자는 dialog 플러그인을 감싸 경로 문자열만 돌려준다(JS는 앱 명령만 부른다, D-15).

use jdr_core::error::{AppError, Code};
use jdr_core::Backend;
use serde::Serialize;
use serde_json::Value;
use std::sync::Arc;
use tauri::ipc::{Channel, InvokeBody, Request};
use tauri::{AppHandle, State};
use tauri_plugin_dialog::{DialogExt, FilePath};

type Shared = Arc<Backend>;

fn join_error(err: tauri::Error) -> AppError {
    AppError::new(Code::NativeIpc, format!("blocking task failed: {err}"))
}

/// 코어 명령 하나. `{ phase, done, total }` 진행률은 `progress` 채널로 보낸다(JS의 `invokeWithChannel`이 항상 만든다).
#[tauri::command]
pub async fn engine_call(
    state: State<'_, Shared>,
    cmd: String,
    args: Option<Value>,
    progress: Channel<Value>,
) -> Result<Value, AppError> {
    let backend = Arc::clone(&state);
    tauri::async_runtime::spawn_blocking(move || {
        let report = move |value: Value| {
            // 창이 닫혔으면 진행률을 받을 곳이 없을 뿐이다.
            let _ = progress.send(value);
        };
        backend.call(&cmd, args.unwrap_or(Value::Null), &report)
    })
    .await
    .map_err(join_error)?
}

fn path_string(path: Option<FilePath>) -> Option<String> {
    match path {
        Some(FilePath::Path(p)) => Some(p.to_string_lossy().into_owned()),
        Some(FilePath::Url(url)) => url
            .to_file_path()
            .ok()
            .map(|p| p.to_string_lossy().into_owned()),
        None => None,
    }
}

const DB_EXTENSIONS: [&str; 3] = ["db", "sqlite", "sqlite3"];

/// 열 파일을 고른다. 취소하면 null.
#[tauri::command]
pub async fn pick_open(app: AppHandle) -> Result<Option<String>, AppError> {
    let (tx, rx) = std::sync::mpsc::channel::<Option<FilePath>>();
    app.dialog()
        .file()
        .add_filter("SQLite database", &DB_EXTENSIONS)
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or(None))
        .await
        .map_err(join_error)?;
    Ok(path_string(picked))
}

/// 저장 경로를 고른다. `kind`는 db·csv·xlsx. 취소하면 null.
#[tauri::command]
pub async fn pick_save(
    app: AppHandle,
    suggested_name: String,
    kind: Option<String>,
) -> Result<Option<String>, AppError> {
    let (tx, rx) = std::sync::mpsc::channel::<Option<FilePath>>();
    let mut builder = app.dialog().file().set_file_name(&suggested_name);
    builder = match kind.as_deref() {
        Some("csv") => builder.add_filter("CSV", &["csv"]),
        Some("xlsx") => builder.add_filter("Excel workbook", &["xlsx"]),
        _ => builder.add_filter("SQLite database", &DB_EXTENSIONS),
    };
    builder.save_file(move |path| {
        let _ = tx.send(path);
    });
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv().unwrap_or(None))
        .await
        .map_err(join_error)?;
    Ok(path_string(picked))
}

/// 내보내기 조각. 본문은 raw 바이트, 싱크 id는 `jdr-sink` 헤더(`filesystem.openPathSink`).
#[tauri::command]
pub fn sink_write(state: State<'_, Shared>, request: Request<'_>) -> Result<u64, AppError> {
    let id = request
        .headers()
        .get("jdr-sink")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<u64>().ok())
        .ok_or_else(|| AppError::new(Code::FileWrite, "sink_write needs a jdr-sink header"))?;
    match request.body() {
        InvokeBody::Raw(bytes) => state.sink_write(id, bytes),
        InvokeBody::Json(_) => Err(AppError::new(
            Code::FileWrite,
            "sink_write expects a raw request body",
        )),
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AppInfo {
    pub version: String,
    pub app_data_dir: String,
    pub workcopies_dir: String,
    /// Worker의 엔진 프로토콜(`jdr://localhost/call`) 요청에 붙이는 토큰.
    pub ipc_token: String,
}

/// 앱 데이터 폴더·버전·엔진 프로토콜 토큰. 기동 때 `main.js`가 한 번 부른다.
#[tauri::command]
pub fn app_info(
    app: AppHandle,
    state: State<'_, Shared>,
    token: State<'_, crate::IpcToken>,
) -> Result<AppInfo, AppError> {
    Ok(AppInfo {
        version: app.package_info().version.to_string(),
        app_data_dir: state.app_data.to_string_lossy().into_owned(),
        workcopies_dir: jdr_core::workcopy::workcopies_root(&state.app_data)
            .to_string_lossy()
            .into_owned(),
        ipc_token: token.0.clone(),
    })
}
