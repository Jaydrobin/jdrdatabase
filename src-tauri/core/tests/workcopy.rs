//! 작업 사본: dirty 사본 복구 판정, 버리기, 새 DB 사본, 목록·정리, 비SQLite 파일 거부(D-15).
mod common;

use common::*;
use jdr_core::db::OpenArgs;
use jdr_core::error::Code;
use jdr_core::value::SqlValue;
use jdr_core::Backend;
use serde_json::json;

#[test]
fn dirty_workcopy_survives_close_and_is_offered_on_reopen() {
    let tmp = TempDir::new("dirty");
    let original = tmp.join("원본.db");
    make_original(&original, "db-d", 7, 2);
    let b = Backend::new(tmp.join("app"));
    let first = open_original(&b, &original);
    assert!(!first.dirty);
    let workcopy = std::path::PathBuf::from(&first.workcopy_path);
    run_tx(&b, "INSERT INTO t (s) VALUES ('미저장')", None);
    mark_dirty(&b);
    // 비정상 종료를 흉내 낸다: discard 없이 닫는다(dirty 사본은 남는다).
    b.close(false).unwrap();
    assert!(workcopy.is_file());

    let second = open_original(&b, &original);
    assert!(second.dirty, "남은 dirty 사본을 그대로 연다");
    assert_eq!(second.workcopy_revision, Some(7));
    assert_eq!(second.original_revision, Some(7));
    assert_eq!(
        b.exec("SELECT count(*) FROM t", None).unwrap().rows,
        vec![vec![SqlValue::Integer(3)]]
    );

    // 버리기: 다시 복사한다.
    let third = b
        .open(
            OpenArgs {
                original_path: Some(original.to_string_lossy().into_owned()),
                discard_workcopy: true,
                workcopy_key: None,
            },
            &|_| {},
        )
        .unwrap();
    assert!(!third.dirty);
    assert_eq!(
        b.exec("SELECT count(*) FROM t", None).unwrap().rows,
        vec![vec![SqlValue::Integer(2)]]
    );
    assert_ne!(
        meta_value(&workcopy, "dirty").as_deref(),
        Some("1"),
        "새 사본은 dirty가 아니다"
    );
    // 깨끗한 사본은 닫을 때 지운다.
    b.close(false).unwrap();
    assert!(!workcopy.exists());
}

#[test]
fn dirty_flag_in_original_file_is_ignored_for_fresh_copies() {
    let tmp = TempDir::new("stale-dirty");
    let original = tmp.join("a.db");
    make_original(&original, "db-s", 1, 1);
    {
        let conn = rusqlite::Connection::open(&original).unwrap();
        conn.execute("INSERT INTO _jdr_meta VALUES ('dirty', '1')", [])
            .unwrap();
    }
    let b = Backend::new(tmp.join("app"));
    let info = open_original(&b, &original);
    assert!(!info.dirty);
    assert_eq!(
        b.exec("SELECT value FROM _jdr_meta WHERE key = 'dirty'", None)
            .unwrap()
            .rows,
        vec![vec![SqlValue::Text("0".into())]]
    );
}

#[test]
fn new_database_uses_temp_workcopy_and_lists_dirty_ones() {
    let tmp = TempDir::new("new");
    let app = tmp.join("app");
    let b = Backend::new(&app);
    let info = b.open(OpenArgs::default(), &|_| {}).unwrap();
    assert!(info.original_path.is_none());
    assert!(info.workcopy_key.starts_with("new-"));
    run_tx(
        &b,
        "CREATE TABLE _jdr_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
        None,
    );
    run_tx(
        &b,
        "INSERT INTO _jdr_meta VALUES ('revision', '0'), ('dirty', '1')",
        None,
    );
    b.close(false).unwrap();
    let listed = ok(&b, "list_workcopies", json!({}));
    let entries = listed.as_array().unwrap();
    assert_eq!(entries.len(), 1);
    assert_eq!(entries[0]["dirty"], true);
    assert_eq!(entries[0]["key"], info.workcopy_key);
    // 키로 다시 열어 복구한다.
    let reopened = b
        .open(
            OpenArgs {
                original_path: None,
                discard_workcopy: false,
                workcopy_key: Some(info.workcopy_key.clone()),
            },
            &|_| {},
        )
        .unwrap();
    assert!(reopened.dirty);
    assert_eq!(reopened.workcopy_revision, Some(0));
    b.close(true).unwrap();
    assert!(ok(&b, "list_workcopies", json!({}))
        .as_array()
        .unwrap()
        .is_empty());
    // 정리: dirty가 아닌 사본은 지운다.
    b.open(OpenArgs::default(), &|_| {}).unwrap();
    let other = jdr_core::workcopy::new_temp(&app).unwrap();
    assert!(other.dir.is_dir());
    std::fs::write(&other.db_path, b"").unwrap();
    assert_eq!(ok(&b, "purge_workcopies", json!({})), json!(1));
    assert!(!other.dir.exists());
    assert!(
        b.current_dir().unwrap().unwrap().is_dir(),
        "열린 사본은 남긴다"
    );
    let key = b
        .current_dir()
        .unwrap()
        .unwrap()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .into_owned();
    ok(&b, "remove_workcopy", json!({ "key": key }));
    assert!(b.current_dir().unwrap().is_none());
    assert_eq!(
        call(&b, "remove_workcopy", json!({ "key": "../x" }))
            .unwrap_err()
            .code,
        Code::FileWrite
    );
}

#[test]
fn non_sqlite_and_missing_files_are_rejected() {
    let tmp = TempDir::new("junk");
    let junk = tmp.join("junk.db");
    std::fs::write(&junk, b"definitely not a database ".repeat(64)).unwrap();
    let b = Backend::new(tmp.join("app"));
    let err = b
        .open(
            OpenArgs {
                original_path: Some(junk.to_string_lossy().into_owned()),
                discard_workcopy: false,
                workcopy_key: None,
            },
            &|_| {},
        )
        .unwrap_err();
    assert_eq!(err.code, Code::FileNotSqlite);
    let err = b
        .open(
            OpenArgs {
                original_path: Some(tmp.join("없음.db").to_string_lossy().into_owned()),
                discard_workcopy: false,
                workcopy_key: None,
            },
            &|_| {},
        )
        .unwrap_err();
    assert_eq!(err.code, Code::FileWrite);
    // 헤더만 맞는 손상 파일.
    let corrupt = tmp.join("corrupt.db");
    let mut bytes = b"SQLite format 3\0".to_vec();
    bytes.extend(std::iter::repeat_n(0xffu8, 4096));
    std::fs::write(&corrupt, bytes).unwrap();
    let err = b
        .open(
            OpenArgs {
                original_path: Some(corrupt.to_string_lossy().into_owned()),
                discard_workcopy: false,
                workcopy_key: None,
            },
            &|_| {},
        )
        .unwrap_err();
    assert!(
        matches!(
            err.code,
            Code::FileNotSqlite | Code::FileCorrupt | Code::DbQuery
        ),
        "{err}"
    );
    // 메타 없는 외부 파일은 경로 해시 키로 열린다.
    let external = tmp.join("외부.db");
    {
        let conn = rusqlite::Connection::open(&external).unwrap();
        conn.execute_batch(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT); INSERT INTO t (s) VALUES ('x');",
        )
        .unwrap();
    }
    let info = open_original(&b, &external);
    assert!(info.workcopy_key.starts_with("p-"));
    assert_eq!(info.original_revision, None);
}
