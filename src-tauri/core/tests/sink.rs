//! 경로 싱크: 조각 쓰기 → 닫기에서 원자적 교체, abort는 파일을 남기지 않는다, 기존 파일 덮어쓰기.
mod common;

use common::*;
use jdr_core::error::Code;
use jdr_core::Backend;
use serde_json::json;

#[test]
fn sink_writes_chunks_and_replaces_target_on_close() {
    let tmp = TempDir::new("sink");
    let b = Backend::new(tmp.join("app"));
    let target = tmp.join("내보내기 (1).csv");
    std::fs::write(&target, b"old").unwrap();
    let id = ok(&b, "sink_open", json!({ "path": target.to_string_lossy() }))
        .as_u64()
        .unwrap();
    ok(
        &b,
        "sink_write",
        json!({ "id": id, "bytes": { "$blob": "AQID" } }),
    );
    ok(&b, "sink_write", json!({ "id": id, "bytes": "가나" }));
    assert_eq!(
        std::fs::read(&target).unwrap(),
        b"old",
        "닫기 전에는 대상이 그대로"
    );
    let info = ok(&b, "sink_close", json!({ "id": id }));
    assert_eq!(info["size"], 9);
    let mut expected = vec![1u8, 2, 3];
    expected.extend_from_slice("가나".as_bytes());
    assert_eq!(std::fs::read(&target).unwrap(), expected);
    let leftovers: Vec<_> = std::fs::read_dir(&tmp.path)
        .unwrap()
        .flatten()
        .filter(|e| e.file_name().to_string_lossy().contains(".tmp-"))
        .collect();
    assert!(leftovers.is_empty());

    let id = ok(&b, "sink_open", json!({ "path": target.to_string_lossy() }))
        .as_u64()
        .unwrap();
    ok(&b, "sink_write", json!({ "id": id, "bytes": "x" }));
    ok(&b, "sink_abort", json!({ "id": id }));
    assert_eq!(
        std::fs::read(&target).unwrap(),
        expected,
        "abort는 대상을 바꾸지 않는다"
    );
    assert_eq!(
        call(&b, "sink_close", json!({ "id": id }))
            .unwrap_err()
            .code,
        Code::FileWrite
    );
    let missing = tmp.join("없는 폴더/x.csv");
    assert_eq!(
        call(
            &b,
            "sink_open",
            json!({ "path": missing.to_string_lossy() })
        )
        .unwrap_err()
        .code,
        Code::FileWrite
    );
}
