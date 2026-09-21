//! 저장 원자성(실패 주입 시 원본 무손상), 원본 변경 감지, 한글 경로 왕복, .bak 복원(Step 11 완료 기준).
mod common;

use common::*;
use jdr_core::error::Code;
use jdr_core::save::{backup_path_for, FailPoint, SaveArgs};
use jdr_core::value::SqlValue;
use jdr_core::Backend;
use serde_json::json;

fn save(
    b: &Backend,
    path: &std::path::Path,
    force: bool,
) -> Result<jdr_core::save::SaveInfo, jdr_core::error::AppError> {
    b.save_to(
        SaveArgs {
            original_path: path.to_string_lossy().into_owned(),
            expected: None,
            force,
        },
        &|_| {},
    )
}

#[test]
fn save_replaces_original_atomically_with_bak_in_korean_path() {
    let tmp = TempDir::new("save");
    let original = tmp.join("한글 폴더/데이터 베이스 (1).db");
    make_original(&original, "db-1", 3, 5);
    let b = Backend::new(tmp.join("app data"));
    let info = open_original(&b, &original);
    assert!(!info.dirty);
    assert_eq!(info.original_revision, Some(3));
    assert_eq!(count_rows(std::path::Path::new(&info.workcopy_path)), 5);

    run_tx(&b, "INSERT INTO t (s) VALUES ('추가')", None);
    run_tx(
        &b,
        "UPDATE _jdr_meta SET value = '4' WHERE key = 'revision'",
        None,
    );
    let saved = save(&b, &original, false).expect("save");
    assert_eq!(saved.path, original.to_string_lossy());
    assert_eq!(
        saved.backup_path.as_deref(),
        Some(backup_path_for(&original).to_string_lossy().as_ref())
    );
    assert_eq!(count_rows(&original), 6, "원본에 새 행이 있다");
    assert_eq!(
        count_rows(&backup_path_for(&original)),
        5,
        ".bak은 저장 전 원본"
    );
    assert_eq!(meta_value(&original, "revision").as_deref(), Some("4"));
    // 임시 파일이 남지 않는다.
    let leftovers: Vec<_> = std::fs::read_dir(original.parent().unwrap())
        .unwrap()
        .flatten()
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.contains(".tmp-"))
        .collect();
    assert!(leftovers.is_empty(), "{leftovers:?}");

    // 두 번째 저장: 세션이 기억한 mtime·크기와 같으므로 통과하고 .bak이 1세대로 회전한다.
    run_tx(&b, "INSERT INTO t (s) VALUES ('둘')", None);
    save(&b, &original, false).expect("second save");
    assert_eq!(count_rows(&original), 7);
    assert_eq!(count_rows(&backup_path_for(&original)), 6);

    // 복원: .bak을 새 파일로.
    let target = tmp.join("한글 폴더/복원본.db");
    let restored = b
        .restore_backup(&original.to_string_lossy(), &target.to_string_lossy())
        .expect("restore");
    assert_eq!(restored.path, target.to_string_lossy());
    assert_eq!(count_rows(&target), 6);
    assert!(b
        .backup_info(&original.to_string_lossy())
        .unwrap()
        .is_some());
    b.close(true).unwrap();
    // 다시 열면 저장한 데이터가 보인다(한글 경로 왕복).
    let reopened = open_original(&b, &original);
    assert_eq!(reopened.original_revision, Some(4));
    assert_eq!(
        b.exec("SELECT count(*) FROM t", None).unwrap().rows,
        vec![vec![SqlValue::Integer(7)]]
    );
}

#[test]
fn vacuum_failure_leaves_original_and_bak_untouched() {
    let tmp = TempDir::new("vacuum-fail");
    let original = tmp.join("원본.db");
    make_original(&original, "db-2", 1, 3);
    let b = Backend::new(tmp.join("app"));
    open_original(&b, &original);
    run_tx(&b, "INSERT INTO t (s) VALUES ('x')", None);
    save(&b, &original, false).expect("first save makes a .bak");
    let bak = backup_path_for(&original);
    let original_before = std::fs::read(&original).unwrap();
    let bak_before = std::fs::read(&bak).unwrap();

    run_tx(&b, "INSERT INTO t (s) VALUES ('y')", None);
    *b.fail_point.lock().unwrap() = Some(FailPoint::Vacuum);
    let err = save(&b, &original, false).unwrap_err();
    assert!(
        matches!(err.code, Code::DbQuery | Code::FileWrite | Code::DiskFull),
        "{err}"
    );
    assert_eq!(err.detail.as_ref().unwrap()["original"]["untouched"], true);
    assert_eq!(
        std::fs::read(&original).unwrap(),
        original_before,
        "원본 그대로"
    );
    assert_eq!(std::fs::read(&bak).unwrap(), bak_before, ".bak 그대로");
    *b.fail_point.lock().unwrap() = None;
    // 실패 뒤에도 사본은 살아 있어 다시 저장할 수 있다.
    save(&b, &original, false).expect("retry");
    assert_eq!(count_rows(&original), 5);
}

#[test]
fn rename_failure_restores_original_from_bak_and_reports_tmp() {
    let tmp = TempDir::new("rename-fail");
    let original = tmp.join("원본.db");
    make_original(&original, "db-3", 1, 2);
    let b = Backend::new(tmp.join("app"));
    open_original(&b, &original);
    run_tx(&b, "INSERT INTO t (s) VALUES ('x')", None);
    let before = std::fs::read(&original).unwrap();
    *b.fail_point.lock().unwrap() = Some(FailPoint::RenameToOriginal);
    let err = save(&b, &original, false).unwrap_err();
    assert_eq!(err.code, Code::FileLocked);
    let detail = err.detail.unwrap();
    assert_eq!(detail["original"]["restored"], true);
    let tmp_path = std::path::PathBuf::from(detail["tmpPath"].as_str().unwrap());
    assert!(tmp_path.is_file(), "임시 파일은 남겨 경로를 알린다");
    assert_eq!(count_rows(&tmp_path), 3);
    assert_eq!(
        std::fs::read(&original).unwrap(),
        before,
        "원본은 .bak에서 되돌아왔다"
    );
    assert!(!backup_path_for(&original).exists());
}

#[test]
fn original_changed_on_disk_is_detected_unless_forced() {
    let tmp = TempDir::new("changed");
    let original = tmp.join("a.db");
    make_original(&original, "db-4", 1, 1);
    let b = Backend::new(tmp.join("app"));
    open_original(&b, &original);
    run_tx(&b, "INSERT INTO t (s) VALUES ('mine')", None);
    // 다른 PC의 동기화: 원본이 바뀐다(크기가 달라지도록 행을 넣는다).
    make_original(&original, "db-4", 2, 40);
    let err = save(&b, &original, false).unwrap_err();
    assert_eq!(err.code, Code::OriginalChanged);
    assert_eq!(count_rows(&original), 40, "원본은 그대로");
    save(&b, &original, true).expect("force");
    assert_eq!(count_rows(&original), 2);
    assert_eq!(
        count_rows(&backup_path_for(&original)),
        40,
        "덮어쓴 원본은 .bak에"
    );
}

#[test]
fn save_as_new_path_creates_file_and_switches_original() {
    let tmp = TempDir::new("save-as");
    let b = Backend::new(tmp.join("app"));
    ok(&b, "open", json!({}));
    run_tx(
        &b,
        "CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT) STRICT",
        None,
    );
    run_tx(&b, "INSERT INTO t (s) VALUES ('새')", None);
    let target = tmp.join("새 파일.db");
    let saved = save(&b, &target, false).expect("save as");
    assert!(saved.backup_path.is_none());
    assert_eq!(count_rows(&target), 1);
    assert_eq!(
        b.current_original().unwrap().as_deref(),
        Some(target.as_path())
    );
    // 이제 그 경로가 원본이다: 다음 저장은 .bak을 만든다.
    run_tx(&b, "INSERT INTO t (s) VALUES ('둘')", None);
    let again = save(&b, &target, false).expect("save again");
    assert!(again.backup_path.is_some());
    assert_eq!(count_rows(&target), 2);
    let missing = tmp.join("없는 폴더/x.db");
    assert_eq!(save(&b, &missing, false).unwrap_err().code, Code::FileWrite);
}
