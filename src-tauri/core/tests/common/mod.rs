//! 통합 테스트 공용: 임시 폴더, 원본 DB 만들기, 명령 호출 도우미.
#![allow(dead_code)]

use jdr_core::error::AppError;
use jdr_core::value::{Params, SqlValue};
use jdr_core::Backend;
use rusqlite::Connection;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

static N: AtomicU64 = AtomicU64::new(0);

/// 테스트마다 다른 임시 폴더. 한글·공백이 든 이름으로 경로 처리를 함께 검사한다.
pub struct TempDir {
    pub path: PathBuf,
}

impl TempDir {
    pub fn new(label: &str) -> TempDir {
        let n = N.fetch_add(1, Ordering::Relaxed);
        let path = std::env::temp_dir().join(format!(
            "jdr-core-test {label} {}-{n}-{}",
            std::process::id(),
            jdr_core::workcopy::random_suffix()
        ));
        std::fs::create_dir_all(&path).expect("temp dir");
        TempDir { path }
    }

    pub fn join(&self, name: &str) -> PathBuf {
        self.path.join(name)
    }
}

impl Drop for TempDir {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.path);
    }
}

/// `_jdr_meta`가 있는 원본 파일을 만든다(db_id, revision).
pub fn make_original(path: &Path, db_id: &str, revision: i64, rows: i64) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).expect("parent");
    }
    let _ = std::fs::remove_file(path);
    let conn = Connection::open(path).expect("open original");
    conn.execute_batch(&format!(
        "CREATE TABLE _jdr_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
         INSERT INTO _jdr_meta VALUES ('schema_version', '1'), ('db_id', '{db_id}'), ('revision', '{revision}');
         CREATE TABLE t (id INTEGER PRIMARY KEY, s TEXT) STRICT;"
    ))
    .expect("schema");
    for i in 0..rows {
        conn.execute("INSERT INTO t (s) VALUES (?1)", [format!("행 {i}")])
            .expect("insert");
    }
    drop(conn);
}

pub fn count_rows(path: &Path) -> i64 {
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("open ro");
    conn.query_row("SELECT count(*) FROM t", [], |r| r.get(0))
        .expect("count")
}

pub fn meta_value(path: &Path, key: &str) -> Option<String> {
    let conn = Connection::open_with_flags(path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY)
        .expect("open ro");
    jdr_core::workcopy::read_meta_value(&conn, key).expect("meta")
}

pub fn call(backend: &Backend, cmd: &str, args: Value) -> Result<Value, AppError> {
    backend.call(cmd, args, &|_: Value| {})
}

pub fn ok(backend: &Backend, cmd: &str, args: Value) -> Value {
    call(backend, cmd, args).unwrap_or_else(|e| panic!("{cmd} failed: {e} {:?}", e.detail))
}

pub fn positional(values: Vec<SqlValue>) -> Params {
    Params::Positional(values)
}

/// 트랜잭션 안에서 문장 하나를 실행한다.
pub fn run_tx(backend: &Backend, sql: &str, params: Option<Params>) {
    backend.begin().expect("begin");
    backend.run(sql, params.as_ref()).expect("run");
    backend.commit().expect("commit");
}

pub fn open_original(backend: &Backend, original: &Path) -> jdr_core::db::OpenInfo {
    backend
        .open(
            jdr_core::db::OpenArgs {
                original_path: Some(original.to_string_lossy().into_owned()),
                discard_workcopy: false,
                workcopy_key: None,
            },
            &|_: Value| {},
        )
        .expect("open")
}

pub fn mark_dirty(backend: &Backend) {
    run_tx(
        backend,
        "INSERT INTO _jdr_meta (key, value) VALUES ('dirty', '1') ON CONFLICT(key) DO UPDATE SET value = '1'",
        None,
    );
}
