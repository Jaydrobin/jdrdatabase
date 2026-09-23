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

/// 교체가 실패해도 이미 있던 파일은 살아 있어야 한다(`save.rs`의 `.bak` 원복과 같은 약속).
/// 대상을 먼저 지우고 rename하면, 그 사이에 실패했을 때 내보낸 파일도 원래 파일도 없다.
///
/// 실패 주입이 "열려 있는 임시 파일 지우기"라 Unix에서만 돈다. Windows는 공유 모드에 삭제가 없어
/// 열린 파일을 지울 수 없다. 고친 쪽(`remove_file` 없이 rename 하나로 교체)은 두 플랫폼이 같고,
/// 정상 경로는 위 검사가 두 플랫폼에서 덮는다.
#[cfg(unix)]
#[test]
fn failed_sink_close_keeps_the_existing_target() {
    let tmp = TempDir::new("sink 교체 실패");
    let b = Backend::new(tmp.join("app"));
    let target = tmp.join("기존.csv");
    std::fs::write(&target, "소중한 기존 내용".as_bytes()).unwrap();
    let id = ok(&b, "sink_open", json!({ "path": target.to_string_lossy() }))
        .as_u64()
        .unwrap();
    ok(&b, "sink_write", json!({ "id": id, "bytes": "새 내용" }));

    // 교체 실패를 주입한다: 임시 파일을 미리 치운다(잠금·권한·동기화 클라이언트가 rename을 막는 경우를 대신한다).
    let leftover = std::fs::read_dir(&tmp.path)
        .unwrap()
        .flatten()
        .map(|e| e.path())
        .find(|p| p.to_string_lossy().contains(".tmp-"))
        .expect("임시 파일");
    std::fs::remove_file(&leftover).unwrap();

    let err = call(&b, "sink_close", json!({ "id": id })).unwrap_err();
    assert_eq!(err.code, Code::FileWrite);
    assert_eq!(
        std::fs::read(&target).unwrap(),
        "소중한 기존 내용".as_bytes(),
        "교체가 실패하면 이미 있던 파일은 그대로여야 한다"
    );
}
