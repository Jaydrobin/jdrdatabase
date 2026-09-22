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

#[test]
fn dirty_copy_of_a_saved_new_database_is_found_by_original_path() {
    let tmp = TempDir::new("saveas-dirty");
    let b = Backend::new(tmp.join("app"));
    let info = b.open(OpenArgs::default(), &|_| {}).unwrap();
    assert!(info.workcopy_key.starts_with("new-"));
    run_tx(
        &b,
        "CREATE TABLE _jdr_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT",
        None,
    );
    run_tx(
        &b,
        "INSERT INTO _jdr_meta VALUES ('db_id', 'saved-new'), ('revision', '1'), ('dirty', '0')",
        None,
    );
    run_tx(
        &b,
        "CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT) STRICT",
        None,
    );
    let file = tmp.join("새로 저장.db");
    b.save_to(
        jdr_core::save::SaveArgs {
            original_path: file.to_string_lossy().into_owned(),
            expected: None,
            force: false,
        },
        &|_| {},
    )
    .unwrap();
    run_tx(&b, "INSERT INTO t (s) VALUES ('미저장')", None);
    mark_dirty(&b);
    b.close(false).unwrap();

    // 원본 경로로 다시 열면 키는 db_id지만 `new-*` 폴더의 dirty 사본을 찾아 재사용한다.
    let reopened = open_original(&b, &file);
    assert!(reopened.dirty);
    assert_eq!(reopened.workcopy_key, info.workcopy_key);
    assert_eq!(
        b.exec("SELECT count(*) FROM t", None).unwrap().rows,
        vec![vec![SqlValue::Integer(1)]]
    );
    // 버리면 그 폴더도 지우고 db_id 키로 새로 복사한다.
    let fresh = b
        .open(
            OpenArgs {
                original_path: Some(file.to_string_lossy().into_owned()),
                discard_workcopy: true,
                workcopy_key: None,
            },
            &|_| {},
        )
        .unwrap();
    assert!(!fresh.dirty);
    assert_eq!(fresh.workcopy_key, "saved-new");
    assert!(!tmp.join("app/workcopies").join(&info.workcopy_key).exists());
    assert_eq!(
        b.exec("SELECT count(*) FROM t", None).unwrap().rows,
        vec![vec![SqlValue::Integer(0)]]
    );
}

#[test]
fn reused_dirty_copy_compares_against_the_original_it_was_copied_from() {
    let tmp = TempDir::new("stale-copy");
    let original = tmp.join("동기화.db");
    make_original(&original, "db-stale", 1, 1);
    let b = Backend::new(tmp.join("app"));
    open_original(&b, &original);
    run_tx(&b, "INSERT INTO t (s) VALUES ('내 변경')", None);
    mark_dirty(&b);
    b.close(false).unwrap();
    // 다른 PC의 저장이 동기화됐다.
    make_original(&original, "db-stale", 2, 5);
    let reopened = open_original(&b, &original);
    assert!(reopened.dirty);
    assert_eq!(reopened.original_revision, Some(2));
    assert_eq!(reopened.workcopy_revision, Some(1));
    let err = b
        .save_to(
            jdr_core::save::SaveArgs {
                original_path: original.to_string_lossy().into_owned(),
                expected: None,
                force: false,
            },
            &|_| {},
        )
        .unwrap_err();
    assert_eq!(
        err.code,
        Code::OriginalChanged,
        "사본을 만든 뒤 바뀐 원본을 덮어쓰지 않는다"
    );
    assert_eq!(count_rows(&original), 5);
}

/// 비정상 종료로 체크포인트되지 않은 WAL이 남은 dirty 사본은 "깨끗한 사본"이 아니다.
/// 읽기 전용으로는 WAL 복구를 할 수 없어 `_jdr_meta.dirty`를 읽지 못하는데, 그때 깨끗하다고 보면
/// 기동 때의 `purge_clean`이 미저장 변경이 든 사본을 지운다.
#[test]
fn dirty_workcopy_with_hot_wal_is_kept() {
    let tmp = TempDir::new("핫 WAL");
    let original = tmp.join("원본.db");
    make_original(&original, "db-hot", 4, 1);
    let app = tmp.join("app");
    let b = Backend::new(&app);
    let opened = open_original(&b, &original);
    run_tx(&b, "INSERT INTO t (s) VALUES ('미저장')", None);
    mark_dirty(&b);

    // 크래시 흉내: 커넥션을 닫지 않은 채(= 체크포인트 없이) 사본 폴더를 통째로 복사한다.
    let live = std::path::PathBuf::from(&opened.workcopy_path);
    let live_dir = live.parent().expect("workcopy dir").to_path_buf();
    let crashed_dir = jdr_core::workcopy::workcopy_dir(&app, "db-hot-crashed");
    std::fs::create_dir_all(&crashed_dir).expect("crashed dir");
    for name in ["current.db", "current.db-wal", "meta.json"] {
        let from = live_dir.join(name);
        if from.is_file() {
            std::fs::copy(&from, crashed_dir.join(name)).expect("copy crash snapshot");
        }
    }
    assert!(
        crashed_dir.join("current.db-wal").is_file(),
        "이 검사는 체크포인트되지 않은 WAL이 있어야 뜻이 있다"
    );
    b.close(true).unwrap();

    let entries = jdr_core::workcopy::list(&app);
    let crashed = entries
        .iter()
        .find(|e| e.key == "db-hot-crashed")
        .expect("크래시 사본이 목록에 있다");
    assert!(crashed.dirty, "핫 WAL이 남은 사본도 dirty로 본다");

    jdr_core::workcopy::purge_clean(&app, None);
    assert!(
        crashed_dir.join("current.db").is_file(),
        "미저장 변경이 든 사본을 기동 정리가 지우면 안 된다"
    );
}

/// 엔진 프로토콜 토큰은 시각·pid에서 유도하지 않는다(같은 밀리초·같은 프로세스에서도 달라야 한다).
#[test]
fn random_token_is_not_derived_from_time_and_pid() {
    let a = jdr_core::workcopy::random_token();
    let b = jdr_core::workcopy::random_token();
    assert_eq!(a.len(), 32);
    assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
    assert_ne!(a, b);
    // 시각·pid만으로 만들면 같은 밀리초 안에서 접미사 두 개가 같은 값으로 겹칠 수 있다.
    assert_ne!(a[..16], a[16..], "두 조각이 같은 seed에서 나오면 안 된다");
}
