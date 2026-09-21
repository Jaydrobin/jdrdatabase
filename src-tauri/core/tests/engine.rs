//! 엔진 명령: 컴파일 옵션, exec/run 규칙, run_batch 원자성, interrupt(Step 11 완료 기준).
mod common;

use common::*;
use jdr_core::db::{MAX_BATCH_PARAMS, MAX_RESULT_ROWS};
use jdr_core::error::Code;
use jdr_core::value::{Params, SqlValue};
use jdr_core::Backend;
use serde_json::json;
use std::sync::Arc;
use std::time::{Duration, Instant};

fn backend(tmp: &TempDir) -> Backend {
    Backend::new(tmp.join("app-data"))
}

#[test]
fn compile_options_include_fts5_and_version_is_recent() {
    let tmp = TempDir::new("info");
    let b = backend(&tmp);
    let info = b.info().expect("info");
    assert!(
        info.compile_options.iter().any(|o| o == "ENABLE_FTS5"),
        "compile_options: {:?}",
        info.compile_options
    );
    let mut parts = info
        .sqlite_version
        .split('.')
        .map(|p| p.parse::<u32>().unwrap_or(0));
    let major = parts.next().unwrap_or(0);
    let minor = parts.next().unwrap_or(0);
    assert!(
        major > 3 || (major == 3 && minor >= 37),
        "sqlite {}",
        info.sqlite_version
    );
    let caps = b.capabilities().expect("caps");
    assert!(caps.fts5);
    assert_eq!(caps.persistence, "native");
    assert_eq!(caps.max_file_bytes, None);
}

#[test]
fn exec_and_run_follow_the_engine_contract() {
    let tmp = TempDir::new("exec");
    let b = backend(&tmp);
    ok(&b, "open", json!({}));
    let one = b
        .exec(
            "SELECT 1 AS one, ? AS two",
            Some(&positional(vec![SqlValue::Integer(2)])),
        )
        .expect("exec");
    assert_eq!(one.columns, vec!["one", "two"]);
    assert_eq!(
        one.rows,
        vec![vec![SqlValue::Integer(1), SqlValue::Integer(2)]]
    );

    let named: Params = serde_json::from_value(json!({ "a": "가나다", ":b": null })).unwrap();
    let r = b
        .exec("SELECT :a AS a, :b AS b", Some(&named))
        .expect("named");
    assert_eq!(
        r.rows,
        vec![vec![SqlValue::Text("가나다".into()), SqlValue::Null]]
    );

    // 트랜잭션 밖의 쓰기는 exec든 run이든 거부되고, 읽기 PRAGMA는 허용된다.
    let err = b
        .exec("CREATE TABLE t (a INTEGER) STRICT", None)
        .unwrap_err();
    assert_eq!(err.code, Code::DbQuery);
    assert!(err.message.contains("outside transaction"));
    assert_eq!(
        b.run("CREATE TABLE t (a)", None).unwrap_err().code,
        Code::DbQuery
    );
    assert_eq!(
        b.exec("PRAGMA foreign_keys", None).unwrap().rows,
        vec![vec![SqlValue::Integer(1)]]
    );

    b.begin().unwrap();
    let created = b
        .exec(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, bl BLOB) STRICT",
            None,
        )
        .unwrap();
    assert!(created.columns.is_empty() && created.rows.is_empty());
    b.run(
        "INSERT INTO t (a, bl) VALUES (?, ?)",
        Some(&positional(vec![
            SqlValue::Text("x".into()),
            SqlValue::Blob(vec![1, 2, 3]),
        ])),
    )
    .unwrap();
    let second = b
        .run(
            "INSERT INTO t (a) VALUES (?)",
            Some(&positional(vec![SqlValue::Text("y".into())])),
        )
        .unwrap();
    assert_eq!((second.changes, second.last_id), (1, 2));
    // 중첩 SAVEPOINT: 안쪽 롤백은 바깥에 영향이 없다.
    b.begin().unwrap();
    b.run("INSERT INTO t (a) VALUES ('z')", None).unwrap();
    b.rollback().unwrap();
    b.commit().unwrap();
    let rows = b
        .exec("SELECT a, bl, typeof(bl) FROM t ORDER BY id", None)
        .unwrap()
        .rows;
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0][1], SqlValue::Blob(vec![1, 2, 3]));
    assert_eq!(rows[0][2], SqlValue::Text("blob".into()));

    // SQL 오류는 E_DB_QUERY이며 detail.sql이 있다.
    let err = b.exec("SELEC 1", None).unwrap_err();
    assert_eq!(err.code, Code::DbQuery);
    assert_eq!(err.detail.unwrap()["sql"], "SELEC 1");

    // 결과 1만 행 초과 거부.
    let sql = "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < ?) SELECT x FROM c";
    let limit = b
        .exec(
            sql,
            Some(&positional(vec![SqlValue::Integer(MAX_RESULT_ROWS as i64)])),
        )
        .unwrap();
    assert_eq!(limit.rows.len(), MAX_RESULT_ROWS);
    let err = b
        .exec(
            sql,
            Some(&positional(vec![SqlValue::Integer(
                MAX_RESULT_ROWS as i64 + 1,
            )])),
        )
        .unwrap_err();
    assert_eq!(err.code, Code::ResultTooLarge);

    // FTS5 trigram 한글 부분 일치.
    b.begin().unwrap();
    b.run(
        "CREATE VIRTUAL TABLE f USING fts5(body, tokenize = 'trigram')",
        None,
    )
    .unwrap();
    b.run(
        "INSERT INTO f VALUES ('서울특별시 강남구'), ('부산광역시 해운대구')",
        None,
    )
    .unwrap();
    b.commit().unwrap();
    let hit = b
        .exec(
            "SELECT body FROM f WHERE f MATCH ?",
            Some(&positional(vec![SqlValue::Text("강남구".into())])),
        )
        .unwrap();
    assert_eq!(
        hit.rows,
        vec![vec![SqlValue::Text("서울특별시 강남구".into())]]
    );
    b.close(true).unwrap();
    assert_eq!(b.exec("SELECT 1", None).unwrap_err().code, Code::DbQuery);
}

#[test]
fn run_batch_is_atomic_and_reports_progress() {
    let tmp = TempDir::new("batch");
    let b = backend(&tmp);
    ok(&b, "open", json!({}));
    run_tx(
        &b,
        "CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT NOT NULL) STRICT",
        None,
    );
    let rows: Vec<Params> = (0..MAX_BATCH_PARAMS as i64)
        .map(|i| {
            positional(vec![
                SqlValue::Integer(i + 1),
                SqlValue::Text(format!("v{i}")),
            ])
        })
        .collect();
    let seen = std::sync::Mutex::new(Vec::new());
    let result = b
        .run_batch("INSERT INTO t VALUES (?, ?)", &rows, &|p| {
            seen.lock().unwrap().push(p["done"].as_u64().unwrap());
        })
        .unwrap();
    assert_eq!(result.changes as usize, MAX_BATCH_PARAMS);
    assert_eq!(
        seen.lock().unwrap().last().copied(),
        Some(MAX_BATCH_PARAMS as u64)
    );
    run_tx(&b, "DELETE FROM t", None);

    let bad: Vec<Params> = (0..MAX_BATCH_PARAMS as i64)
        .map(|i| {
            positional(vec![
                SqlValue::Integer(i + 1),
                if i == 5000 {
                    SqlValue::Null
                } else {
                    SqlValue::Text(format!("v{i}"))
                },
            ])
        })
        .collect();
    let err = b
        .run_batch("INSERT INTO t VALUES (?, ?)", &bad, &|_| {})
        .unwrap_err();
    assert_eq!(err.code, Code::DbQuery);
    assert_eq!(err.detail.unwrap()["index"], 5000);
    assert_eq!(
        b.exec("SELECT count(*) FROM t", None).unwrap().rows,
        vec![vec![SqlValue::Integer(0)]]
    );

    // 바깥 트랜잭션 안에서는 SAVEPOINT: 실패한 배치만 되돌리고 바깥은 살아 있다.
    b.begin().unwrap();
    b.run_batch("INSERT INTO t VALUES (?, ?)", &rows[..2], &|_| {})
        .unwrap();
    let inner = b.run_batch("INSERT INTO t VALUES (?, ?)", &bad[2..4], &|_| {});
    assert!(inner.is_ok(), "bad[2..4] has no null and new ids");
    let err = b
        .run_batch(
            "INSERT INTO t VALUES (?, ?)",
            &[positional(vec![SqlValue::Integer(99), SqlValue::Null])],
            &|_| {},
        )
        .unwrap_err();
    assert_eq!(err.code, Code::DbQuery);
    assert_eq!(
        b.exec("SELECT count(*) FROM t", None).unwrap().rows,
        vec![vec![SqlValue::Integer(4)]]
    );
    b.rollback().unwrap();
    assert_eq!(
        b.exec("SELECT count(*) FROM t", None).unwrap().rows,
        vec![vec![SqlValue::Integer(0)]]
    );
    let too_many: Vec<Params> = (0..=MAX_BATCH_PARAMS).map(|_| positional(vec![])).collect();
    assert_eq!(
        b.run_batch("SELECT 1", &too_many, &|_| {})
            .unwrap_err()
            .code,
        Code::BatchTooLarge
    );
}

#[test]
fn interrupt_stops_a_long_query_from_another_thread() {
    let tmp = TempDir::new("interrupt");
    let b = Arc::new(backend(&tmp));
    ok(&b, "open", json!({}));
    let worker = {
        let b = Arc::clone(&b);
        std::thread::spawn(move || {
            let started = Instant::now();
            let result = b.exec(
                "WITH RECURSIVE c(x) AS (SELECT 1 UNION ALL SELECT x + 1 FROM c WHERE x < 2000000000) SELECT count(*) FROM c",
                None,
            );
            (result, started.elapsed())
        })
    };
    std::thread::sleep(Duration::from_millis(200));
    b.interrupt();
    let (result, elapsed) = worker.join().unwrap();
    let err = result.unwrap_err();
    assert_eq!(err.code, Code::ImportCancelled, "{err}");
    assert!(
        elapsed < Duration::from_secs(20),
        "interrupt took {elapsed:?}"
    );
    // 중단 뒤에도 커넥션은 쓸 수 있다.
    assert_eq!(
        b.exec("SELECT 1", None).unwrap().rows,
        vec![vec![SqlValue::Integer(1)]]
    );
}

#[test]
fn call_dispatch_round_trips_json() {
    let tmp = TempDir::new("call");
    let b = backend(&tmp);
    ok(&b, "open", json!({}));
    ok(&b, "begin", json!(null));
    ok(
        &b,
        "run",
        json!({ "sql": "CREATE TABLE t (a INTEGER, b BLOB) STRICT" }),
    );
    ok(
        &b,
        "run",
        json!({ "sql": "INSERT INTO t VALUES (?, ?)", "params": [1, { "$blob": "AQID" }] }),
    );
    ok(&b, "commit", json!(null));
    let r = ok(&b, "exec", json!({ "sql": "SELECT a, b FROM t" }));
    assert_eq!(
        r,
        json!({ "columns": ["a", "b"], "rows": [[1, { "$blob": "AQID" }]] })
    );
    let err = call(&b, "nope", json!({})).unwrap_err();
    assert_eq!(err.code, Code::NativeIpc);
    let err = call(&b, "exec", json!({ "params": [] })).unwrap_err();
    assert_eq!(err.code, Code::DbQuery);
    assert!(err.message.contains("invalid arguments"));
    ok(&b, "close", json!({ "discardWorkcopy": true }));
}
