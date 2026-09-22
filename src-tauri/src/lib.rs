//! 타우리 데스크톱 셸(D-15, Step 11). 엔진·저장·작업 사본 로직은 `jdr-core`에 있고 이 크레이트는 그것을 IPC로 노출한다.
//! 플러그인은 dialog(파일 대화상자)와 single-instance(두 번째 실행을 첫 인스턴스로 포워딩)뿐이다(D-12).

mod commands;
mod protocol;

use jdr_core::Backend;
use std::io::Write;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;

/// Worker가 `jdr://localhost/call` 요청에 실어 보내는 토큰(프로세스마다 새로 만든다). 같은 앱의 문서만 알 수 있다.
/// 이 프로토콜은 `Backend::call` 전부(임의 경로 열기·쓰기 포함)로 이어지므로 토큰은 추측할 수 없어야 한다.
pub struct IpcToken(pub String);

/// 패닉을 앱 데이터 폴더의 `panic.log`에 남긴다(DESIGN.md Step 11 예외 처리). 창에는 다음 IPC 실패가 `E_NATIVE_IPC`로 드러난다.
fn install_panic_hook(app_data: PathBuf) {
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let path = app_data.join("panic.log");
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&path)
        {
            let _ = writeln!(file, "{} {info}", jdr_core::workcopy::now_ms());
        }
        previous(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            // 두 번째 인스턴스는 첫 인스턴스의 창을 앞으로 가져오는 것으로 끝난다(한 인스턴스 안의 다중 창은 v1에 없다).
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            std::fs::create_dir_all(&app_data)?;
            install_panic_hook(app_data.clone());
            let backend = Arc::new(Backend::new(&app_data));
            // 지난 실행이 남긴 깨끗한 사본은 지운다. dirty 사본은 복구 흐름(D-15)을 위해 남긴다.
            let _ = jdr_core::workcopy::purge_clean(&app_data, None);
            app.manage(backend);
            app.manage(IpcToken(jdr_core::workcopy::random_token()));
            Ok(())
        })
        // Worker 안의 네이티브 엔진이 동기 XHR로 부르는 엔진 프로토콜(D-15). 긴 명령은 별도 스레드에서 돈다.
        .register_asynchronous_uri_scheme_protocol("jdr", protocol::handle)
        .invoke_handler(tauri::generate_handler![
            commands::engine_call,
            commands::pick_open,
            commands::pick_save,
            commands::sink_write,
            commands::app_info,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
