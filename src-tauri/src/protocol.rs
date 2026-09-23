//! 엔진 프로토콜 `jdr://localhost/call`(Windows는 `http://jdr.localhost/call`): Worker의 네이티브 엔진이 동기 XHR·fetch로
//! 코어 명령을 부른다(D-15). 요청은 `POST` + 본문 `{ "cmd", "args" }`(text/plain이라 CORS 사전 요청이 없다), 토큰은
//! 질의 문자열 `t`. 응답은 `{ "ok": true, "result" }` 또는 `{ "ok": false, "error" }`이며 CORS 헤더를 단다
//! (문서 원점 `tauri://localhost`와 다른 원점이다. 타우리의 `ipc://` 프로토콜과 같은 방식).
//! 긴 명령(5 GB 저장)이 WebView 스레드를 막지 않도록 별도 스레드에서 실행하고 비동기 응답기로 답한다.

use crate::IpcToken;
use jdr_core::error::{AppError, Code};
use jdr_core::Backend;
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::Arc;
use tauri::http::{header, Method, Request, Response, StatusCode};
use tauri::{Manager, Runtime, UriSchemeContext, UriSchemeResponder};

#[derive(Deserialize)]
struct CallBody {
    cmd: String,
    #[serde(default)]
    args: Value,
}

fn response(status: StatusCode, body: Vec<u8>) -> Response<Vec<u8>> {
    let mut builder = Response::builder()
        .status(status)
        .header(header::CONTENT_TYPE, "application/json")
        .header(header::ACCESS_CONTROL_ALLOW_ORIGIN, "*")
        .header(header::ACCESS_CONTROL_ALLOW_METHODS, "POST, OPTIONS")
        .header(header::ACCESS_CONTROL_ALLOW_HEADERS, "content-type")
        .header(header::CACHE_CONTROL, "no-store");
    if status == StatusCode::NO_CONTENT {
        builder = builder.header(header::CONTENT_LENGTH, "0");
    }
    builder.body(body).unwrap_or_else(|_| {
        // 헤더 값이 모두 상수이므로 실패하지 않는다. 그래도 빈 500으로 답해 요청이 매달리지 않게 한다.
        let mut fallback = Response::new(Vec::new());
        *fallback.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
        fallback
    })
}

fn error_body(err: AppError) -> Vec<u8> {
    serde_json::to_vec(&json!({ "ok": false, "error": err })).unwrap_or_default()
}

fn query_token(request: &Request<Vec<u8>>) -> Option<String> {
    let query = request.uri().query()?;
    query
        .split('&')
        .find_map(|pair| pair.strip_prefix("t=").map(str::to_string))
}

/// `register_asynchronous_uri_scheme_protocol("jdr", protocol::handle)`
pub fn handle<R: Runtime>(
    ctx: UriSchemeContext<'_, R>,
    request: Request<Vec<u8>>,
    responder: UriSchemeResponder,
) {
    if request.method() == Method::OPTIONS {
        responder.respond(response(StatusCode::NO_CONTENT, Vec::new()));
        return;
    }
    let app = ctx.app_handle();
    let expected = app.state::<IpcToken>().0.clone();
    if request.method() != Method::POST || !request.uri().path().ends_with("/call") {
        responder.respond(response(
            StatusCode::NOT_FOUND,
            error_body(AppError::new(
                Code::NativeIpc,
                "unknown engine protocol route",
            )),
        ));
        return;
    }
    if query_token(&request).as_deref() != Some(expected.as_str()) {
        responder.respond(response(
            StatusCode::FORBIDDEN,
            error_body(AppError::new(
                Code::NativeIpc,
                "engine protocol token mismatch",
            )),
        ));
        return;
    }
    let body: CallBody = match serde_json::from_slice(request.body()) {
        Ok(body) => body,
        Err(err) => {
            responder.respond(response(
                StatusCode::BAD_REQUEST,
                error_body(AppError::new(
                    Code::NativeIpc,
                    format!("bad engine protocol body: {err}"),
                )),
            ));
            return;
        }
    };
    let backend: Arc<Backend> = Arc::clone(&app.state::<Arc<Backend>>());
    // 동기 XHR이 기다리는 동안 다른 요청(취소 등)도 들어올 수 있으므로 요청마다 스레드를 쓴다. 커넥션 뮤텍스가 순서를 정한다.
    std::thread::spawn(move || {
        let result = backend.call(&body.cmd, body.args, &|_| {});
        let payload = match result {
            Ok(value) => serde_json::to_vec(&json!({ "ok": true, "result": value }))
                .unwrap_or_else(|e| error_body(AppError::new(Code::NativeIpc, e.to_string()))),
            Err(err) => error_body(err),
        };
        responder.respond(response(StatusCode::OK, payload));
    });
}
