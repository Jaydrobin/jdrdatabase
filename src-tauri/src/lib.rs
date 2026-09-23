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

/// wry가 WebView2에 늘 넘기는 기본 브라우저 인자(`webview2/mod.rs`). 인자를 직접 지정하면 wry는 이것을 빼므로 앞에 붙인다.
const WRY_DEFAULT_BROWSER_ARGS: &str =
    "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection";

/// 메인 창은 설정(`tauri.conf.json`의 `create: false`)이 아니라 여기서 만든다. Windows에서 WebView2의 표준 환경 변수를
/// 창에 넘기기 위해서다: wry는 브라우저 인자와 데이터 폴더를 늘 API로 지정하므로, Edge Driver(데스크톱 E2E)가
/// `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS`·`WEBVIEW2_USER_DATA_FOLDER`로 주는 원격 디버깅 설정이 적용되지 않았다
/// (세션 L: `DevToolsActivePort file doesn't exist`). 환경 변수가 없으면 설정 그대로 만든다.
fn create_main_window(app: &tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == "main")
        .cloned()
        .ok_or("tauri.conf.json has no window labelled main")?;
    let mut builder = tauri::WebviewWindowBuilder::from_config(app.handle(), &config)?;
    if cfg!(windows) {
        let overrides = webview2_overrides(
            std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").ok(),
            std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").map(PathBuf::from),
        );
        if let Some(args) = overrides.browser_args {
            builder = builder.additional_browser_args(&args);
        }
        if let Some(dir) = overrides.data_directory {
            builder = builder.data_directory(dir);
        }
    }
    builder.build()?;
    Ok(())
}

/// WebView2 환경 변수에서 창에 넘길 값.
#[derive(Debug, PartialEq)]
struct WebView2Overrides {
    browser_args: Option<String>,
    data_directory: Option<PathBuf>,
}

/// 환경 변수의 브라우저 인자는 wry 기본 인자 뒤에 붙이고, 데이터 폴더는 `WEBVIEW2_USER_DATA_FOLDER`나 인자 속
/// `--user-data-dir=`에서 받는다(WebView2의 데이터 폴더는 API가 정하므로 인자로만 주면 적용되지 않는다).
fn webview2_overrides(args: Option<String>, folder: Option<PathBuf>) -> WebView2Overrides {
    let args = args.map(|a| a.trim().to_string()).filter(|a| !a.is_empty());
    let from_args = args.as_deref().and_then(user_data_dir_arg);
    WebView2Overrides {
        browser_args: args.map(|a| format!("{WRY_DEFAULT_BROWSER_ARGS} {a}")),
        data_directory: folder.filter(|f| !f.as_os_str().is_empty()).or(from_args),
    }
}

/// `--user-data-dir=<경로>`의 경로. 따옴표로 감쌌으면 벗기고, 감싸지 않았으면 다음 ` --`까지 본다(경로에 공백 허용).
fn user_data_dir_arg(args: &str) -> Option<PathBuf> {
    const KEY: &str = "--user-data-dir=";
    let start = args.find(KEY)? + KEY.len();
    let rest = &args[start..];
    let value = if let Some(quoted) = rest.strip_prefix('"') {
        &quoted[..quoted.find('"')?]
    } else {
        rest.find(" --").map_or(rest, |end| &rest[..end]).trim_end()
    };
    (!value.is_empty()).then(|| PathBuf::from(value))
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
            create_main_window(app)?;
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn webview2_overrides_keep_wry_defaults_and_find_the_data_folder() {
        assert_eq!(
            webview2_overrides(None, None),
            WebView2Overrides {
                browser_args: None,
                data_directory: None
            }
        );
        assert_eq!(
            webview2_overrides(Some("  ".into()), Some(PathBuf::new())),
            WebView2Overrides {
                browser_args: None,
                data_directory: None
            }
        );
        let o = webview2_overrides(
            Some(
                "--remote-debugging-port=0 --user-data-dir=C:\\Temp\\scoped dir --no-first-run"
                    .into(),
            ),
            None,
        );
        assert_eq!(
            o.browser_args.as_deref(),
            Some("--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection --remote-debugging-port=0 --user-data-dir=C:\\Temp\\scoped dir --no-first-run")
        );
        assert_eq!(
            o.data_directory,
            Some(PathBuf::from("C:\\Temp\\scoped dir"))
        );
        // 환경 변수의 데이터 폴더가 인자보다 앞선다.
        let o = webview2_overrides(
            Some("--user-data-dir=\"C:\\a b\" --x".into()),
            Some(PathBuf::from("D:\\wd")),
        );
        assert_eq!(o.data_directory, Some(PathBuf::from("D:\\wd")));
        assert_eq!(
            user_data_dir_arg("--user-data-dir=\"C:\\a b\" --x"),
            Some(PathBuf::from("C:\\a b"))
        );
        assert_eq!(user_data_dir_arg("--remote-debugging-port=0"), None);
        assert_eq!(user_data_dir_arg("--user-data-dir="), None);
    }
}
