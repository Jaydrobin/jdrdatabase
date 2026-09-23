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

/// 다른 프로그램이 체크포인트하지 않은 WAL을 남긴 파일을 열면, WAL에만 있는 커밋도 보여야 한다.
/// 본체만 복사하면 그 커밋이 사라지고, 그대로 저장하면 원본에서도 없어진다.
#[test]
fn hot_wal_of_an_external_file_is_copied_into_the_workcopy() {
    let tmp = TempDir::new("외부 핫 WAL");
    let original = tmp.join("다른 도구.db");
    let app = tmp.join("app");

    // 다른 프로그램이 WAL 모드로 쓰다가 체크포인트 없이 죽은 상태를 만든다.
    {
        let conn = rusqlite::Connection::open(&original).expect("open");
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT);
             INSERT INTO t (s) VALUES ('본체에 있는 행');",
        )
        .expect("schema");
        conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .expect("checkpoint");
        // 여기부터의 커밋은 WAL에만 있다.
        conn.execute_batch("INSERT INTO t (s) VALUES ('WAL에만 있는 행');")
            .expect("wal insert");
        std::mem::forget(conn); // 닫지 않는다(닫으면 체크포인트된다).
    }
    let wal = std::path::PathBuf::from(format!("{}-wal", original.to_string_lossy()));
    assert!(
        wal.is_file(),
        "이 검사는 체크포인트되지 않은 WAL이 있어야 뜻이 있다"
    );

    let b = Backend::new(&app);
    open_original(&b, &original);
    assert_eq!(
        b.exec("SELECT count(*) FROM t", None).unwrap().rows,
        vec![vec![SqlValue::Integer(2)]],
        "WAL에만 있던 커밋도 사본에 와야 한다",
    );
    b.close(true).unwrap();
}

/// 복사는 OS마다 경로가 다르다(Linux는 64 MB 조각의 `io::copy`, 그 밖은 8 MB 버퍼). 어느 쪽이든
/// 사본이 원본과 바이트 단위로 같고, 진행률이 조각마다 늘며 마지막 보고가 파일 크기여야 한다.
#[test]
fn workcopy_copy_is_byte_exact_and_reports_progress_per_chunk() {
    const MB: usize = 1024 * 1024;
    let tmp = TempDir::new("큰 사본");
    let original = tmp.join("큰 원본.db");
    make_original(&original, "db-big", 1, 0);
    {
        let conn = rusqlite::Connection::open(&original).expect("open");
        conn.execute_batch("CREATE TABLE b (x BLOB) STRICT")
            .expect("blob table");
        // 64 MB 조각 둘을 넘기고 끝이 조각 경계에 맞지 않게 한다. 값마다 달라야 어긋난 조각이 드러난다.
        for i in 0..14u8 {
            let blob: Vec<u8> = (0..10 * MB).map(|j| (j as u8) ^ i).collect();
            conn.execute("INSERT INTO b (x) VALUES (?1)", [blob])
                .expect("insert blob");
        }
    }
    let info = jdr_core::workcopy::inspect_original(&original).expect("inspect");
    assert!(info.size > 2 * 64 * MB as u64 && info.size % (64 * MB as u64) != 0);

    let reports = std::cell::RefCell::new(Vec::<(u64, u64)>::new());
    let prepared =
        jdr_core::workcopy::prepare(&tmp.join("app"), &original, &info, false, &|done, total| {
            reports.borrow_mut().push((done, total))
        })
        .expect("prepare");
    assert!(!prepared.reused_dirty);
    assert!(
        std::fs::read(&original).expect("read original")
            == std::fs::read(&prepared.db_path).expect("read copy"),
        "사본이 원본과 바이트 단위로 같아야 한다"
    );

    let reports = reports.into_inner();
    assert!(reports.iter().all(|&(_, total)| total == info.size));
    let done: Vec<u64> = reports.iter().map(|&(d, _)| d).collect();
    assert_eq!(
        done.last().copied(),
        Some(info.size),
        "마지막 보고는 파일 크기"
    );
    assert!(
        done.windows(2).all(|w| w[0] <= w[1]),
        "진행률은 줄지 않는다: {done:?}"
    );
    let intermediate = done.iter().filter(|&&d| d < info.size).count();
    assert!(intermediate >= 2, "64 MB마다 보고한다: {done:?}");
}
