//! 표준 입출력 JSON 줄 하네스(D-15). Node의 `npm run test:native`가 실제 엔진으로 적합성 테스트를 돌린다.
//!
//! 요청 `{ "id", "cmd", "args" }` 한 줄 → 진행률 `{ "id", "progress" }` 0줄 이상 → 응답 `{ "id", "ok", "result" | "error" }`.
//! `interrupt`는 읽기 스레드가 바로 처리해 긴 문장 도중에도 닿는다. 나머지는 순서대로 실행한다.
//! 첫 인자는 앱 데이터 폴더(작업 사본 위치)다.

use jdr_core::Backend;
use serde::Deserialize;
use serde_json::Value;
use std::io::{self, BufRead, Write};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;

#[derive(Deserialize)]
struct Request {
    id: u64,
    cmd: String,
    #[serde(default)]
    args: Value,
}

fn write_line(out: &Mutex<io::Stdout>, value: &Value) {
    let mut guard = out.lock().unwrap_or_else(|p| p.into_inner());
    // 출력 실패는 상대가 사라진 것이므로 조용히 끝낸다.
    let _ = serde_json::to_writer(&mut *guard, value);
    let _ = guard.write_all(b"\n");
    let _ = guard.flush();
}

fn main() {
    let app_data = std::env::args().nth(1).unwrap_or_else(|| {
        std::env::temp_dir()
            .join("jdr-ipc-stdio")
            .to_string_lossy()
            .into_owned()
    });
    if let Err(err) = std::fs::create_dir_all(&app_data) {
        eprintln!("cannot create app data dir {app_data}: {err}");
        std::process::exit(2);
    }
    let backend = Arc::new(Backend::new(&app_data));
    let out = Arc::new(Mutex::new(io::stdout()));
    let (tx, rx) = mpsc::channel::<Request>();

    let worker = {
        let backend = Arc::clone(&backend);
        let out = Arc::clone(&out);
        thread::spawn(move || {
            for req in rx {
                let id = req.id;
                let progress_out = Arc::clone(&out);
                let progress = move |p: Value| {
                    write_line(
                        &progress_out,
                        &serde_json::json!({ "id": id, "progress": p }),
                    );
                };
                let response = match backend.call(&req.cmd, req.args, &progress) {
                    Ok(result) => serde_json::json!({ "id": id, "ok": true, "result": result }),
                    Err(err) => serde_json::json!({ "id": id, "ok": false, "error": err }),
                };
                write_line(&out, &response);
            }
        })
    };

    let stdin = io::stdin();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let req: Request = match serde_json::from_str(&line) {
            Ok(req) => req,
            Err(err) => {
                write_line(
                    &out,
                    &serde_json::json!({ "id": 0, "ok": false, "error": { "code": "E_NATIVE_IPC", "message": format!("bad request line: {err}") } }),
                );
                continue;
            }
        };
        if req.cmd == "interrupt" {
            backend.interrupt();
            write_line(
                &out,
                &serde_json::json!({ "id": req.id, "ok": true, "result": null }),
            );
            continue;
        }
        if tx.send(req).is_err() {
            break;
        }
    }
    drop(tx);
    let _ = worker.join();
    let _ = backend.close(false);
}
