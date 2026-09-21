//! 커넥션 상태와 엔진 명령(D-15): open/close/exec/run/run_batch/begin/commit/rollback/interrupt/info.
//!
//! 쓰기는 트랜잭션 안에서만 허용되고(wasm 엔진과 같은 규칙), 중첩 트랜잭션은 SAVEPOINT다.
//! 결과 1만 행 초과는 `E_RESULT_TOO_LARGE`.

use crate::error::{AppError, Code, Result};
use crate::value::{Params, SqlValue};
use crate::workcopy::{self, Prepared};
use crate::{Backend, Progress};
use rusqlite::{Connection, InterruptHandle};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::time::Instant;

/// 읽기 결과 행 수 상한(`src/db/engine.js`의 `MAX_RESULT_ROWS`와 같다).
pub const MAX_RESULT_ROWS: usize = 10_000;
/// `run_batch` 파라미터 목록 길이 상한(`MAX_BATCH_PARAMS`).
pub const MAX_BATCH_PARAMS: usize = 10_000;

/// 열려 있는 원본의 상태(저장 직전 비교용).
#[derive(Debug, Clone)]
pub struct OriginalRef {
    pub path: PathBuf,
    pub mtime: u64,
    pub size: u64,
}

/// 열린 DB 하나.
pub struct Session {
    pub conn: Connection,
    pub tx_depth: u32,
    pub dir: PathBuf,
    pub db_path: PathBuf,
    pub original: Option<OriginalRef>,
}

#[derive(Debug, Clone, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct OpenArgs {
    pub original_path: Option<String>,
    #[serde(default)]
    pub discard_workcopy: bool,
    /// `list()`가 돌려준 키로 남은 사본을 직접 연다(새 DB의 dirty 사본 복구).
    pub workcopy_key: Option<String>,
}

/// `open`의 결과(6장 `db.open`의 `workcopy` 항목).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenInfo {
    pub dirty: bool,
    pub original_path: Option<String>,
    pub original_revision: Option<i64>,
    pub workcopy_revision: Option<i64>,
    pub original_mtime: Option<u64>,
    pub original_size: Option<u64>,
    pub size: u64,
    pub workcopy_path: String,
    pub workcopy_key: String,
    pub copy_ms: u64,
    pub open_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExecResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<SqlValue>>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RunResult {
    pub changes: u64,
    pub last_id: i64,
}

#[derive(Debug, Clone, Serialize)]
pub struct BatchResult {
    pub changes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineInfo {
    pub sqlite_version: String,
    pub compile_options: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub persistence: &'static str,
    pub fts5: bool,
    pub cancellable: bool,
    /// null = 상한 없음(JS는 Infinity로 읽는다).
    pub max_file_bytes: Option<u64>,
    pub warn_file_bytes: Option<u64>,
}

/// 새 PRAGMA는 여기에만 추가한다. 작업 사본은 클라우드 폴더 밖이므로 WAL이 안전하다(D-15).
fn apply_pragmas(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA temp_store = MEMORY; PRAGMA cache_size = -32000;",
    )
    .map_err(|e| AppError::from_sqlite(e, Some("PRAGMA")))
}

fn savepoint_name(depth: u32) -> String {
    format!("jdr_sp_{depth}")
}

impl Backend {
    /// 원본(또는 새 DB)을 작업 사본 위에서 연다. 열려 있던 DB는 먼저 닫는다(사본은 dirty면 남긴다).
    pub fn open(&self, args: OpenArgs, progress: &Progress) -> Result<OpenInfo> {
        self.close(false)?;
        let started = Instant::now();
        let original_arg = args.original_path.as_deref().map(PathBuf::from);
        let report = |done: u64, total: u64| {
            progress(serde_json::json!({ "phase": "copy", "done": done, "total": total }));
        };
        let (prepared, info, reused_original): (
            Prepared,
            Option<workcopy::OriginalInfo>,
            Option<PathBuf>,
        ) = if let Some(key) = args.workcopy_key.as_deref() {
            let dir = workcopy::workcopy_dir(&self.app_data, key);
            let db_path = dir.join(workcopy::CURRENT_DB);
            if !db_path.is_file() {
                return Err(AppError::new(Code::FileWrite, "workcopy does not exist")
                    .add_detail("key", serde_json::Value::String(key.into())));
            }
            let meta = workcopy::read_meta(&dir);
            let original = meta
                .as_ref()
                .and_then(|m| m.original_path.clone())
                .map(PathBuf::from);
            let prepared = Prepared {
                key: key.to_string(),
                dir,
                db_path,
                reused_dirty: true,
                workcopy_revision: None,
                copy_ms: 0,
                meta: meta.unwrap_or(workcopy::WorkcopyMeta {
                    original_path: None,
                    original_mtime: None,
                    original_size: None,
                    opened_at: workcopy::now_ms(),
                }),
            };
            let info = match &original {
                Some(path) if path.is_file() => workcopy::inspect_original(path).ok(),
                _ => None,
            };
            (prepared, info, original)
        } else if let Some(original) = &original_arg {
            let info = workcopy::inspect_original(original)?;
            let prepared = workcopy::prepare(
                &self.app_data,
                original,
                &info,
                args.discard_workcopy,
                &report,
            )?;
            (prepared, Some(info), Some(original.clone()))
        } else {
            (workcopy::new_temp(&self.app_data)?, None, None)
        };

        let conn = Connection::open(&prepared.db_path)
            .map_err(|e| AppError::from_sqlite(e, Some("open workcopy")))?;
        // 헤더만 맞는 손상 파일은 첫 읽기에서 SQLITE_NOTADB로 드러난다.
        conn.query_row("SELECT count(*) FROM sqlite_master", [], |r| {
            r.get::<_, i64>(0)
        })
        .map_err(|e| AppError::from_sqlite(e, Some("open workcopy")))?;
        apply_pragmas(&conn)?;
        let mut workcopy_revision = prepared.workcopy_revision;
        if prepared.reused_dirty {
            if workcopy_revision.is_none() {
                workcopy_revision = workcopy::read_meta_value(&conn, "revision")?
                    .and_then(|v| v.trim().parse::<i64>().ok());
            }
        } else if workcopy::read_meta_value(&conn, "dirty")?.is_some() {
            // 새 사본의 dirty는 원본 파일에 남아 있던 값일 뿐이다.
            conn.execute("UPDATE _jdr_meta SET value = '0' WHERE key = 'dirty'", [])
                .map_err(|e| AppError::from_sqlite(e, Some("clear dirty")))?;
        }
        let dirty = prepared.reused_dirty && workcopy::is_dirty(&conn)?;
        let size = std::fs::metadata(&prepared.db_path)
            .map(|m| m.len())
            .unwrap_or(0);
        let original_ref = match (&reused_original, &info) {
            (Some(path), Some(info)) => Some(OriginalRef {
                path: path.clone(),
                mtime: info.mtime,
                size: info.size,
            }),
            _ => None,
        };
        let open_info = OpenInfo {
            dirty,
            original_path: reused_original
                .as_ref()
                .map(|p| p.to_string_lossy().into_owned()),
            original_revision: info.as_ref().and_then(|i| i.revision),
            workcopy_revision,
            original_mtime: info.as_ref().map(|i| i.mtime),
            original_size: info.as_ref().map(|i| i.size),
            size,
            workcopy_path: prepared.db_path.to_string_lossy().into_owned(),
            workcopy_key: prepared.key.clone(),
            copy_ms: prepared.copy_ms,
            open_ms: started.elapsed().as_millis() as u64,
        };
        let handle = conn.get_interrupt_handle();
        *self.lock_interrupt() = Some(handle);
        *self.lock_session()? = Some(Session {
            conn,
            tx_depth: 0,
            dir: prepared.dir,
            db_path: prepared.db_path,
            original: original_ref,
        });
        Ok(open_info)
    }

    /// 닫는다. `discard`면 사본을 지우고, 아니면 dirty 사본만 남긴다.
    pub fn close(&self, discard: bool) -> Result<()> {
        let session = self.lock_session()?.take();
        *self.lock_interrupt() = None;
        let Some(session) = session else {
            return Ok(());
        };
        let keep = !discard && workcopy::is_dirty(&session.conn).unwrap_or(true);
        drop(session.conn);
        if !keep {
            workcopy::remove_dir(&session.dir)?;
        }
        Ok(())
    }

    /// 읽기. 트랜잭션 밖에서는 파일을 바꾸는 문장을 거부한다.
    pub fn exec(&self, sql: &str, params: Option<&Params>) -> Result<ExecResult> {
        let mut guard = self.lock_session()?;
        let session = require(&mut guard)?;
        let tx_depth = session.tx_depth;
        let mut stmt = session
            .conn
            .prepare_cached(sql)
            .map_err(|e| AppError::from_sqlite(e, Some(sql)))?;
        if tx_depth == 0 && !stmt.readonly() {
            return Err(AppError::query("write outside transaction").add_detail(
                "sql",
                serde_json::Value::String(crate::error::truncate(sql, 200)),
            ));
        }
        if let Some(params) = params.filter(|p| !p.is_empty()) {
            params.bind(&mut stmt).map_err(|e| with_sql(e, sql))?;
        }
        let columns: Vec<String> = stmt.column_names().iter().map(|c| c.to_string()).collect();
        let ncols = columns.len();
        let mut rows_out: Vec<Vec<SqlValue>> = Vec::new();
        let mut rows = stmt.raw_query();
        while let Some(row) = rows
            .next()
            .map_err(|e| AppError::from_sqlite(e, Some(sql)))?
        {
            if rows_out.len() >= MAX_RESULT_ROWS {
                return Err(AppError::new(
                    Code::ResultTooLarge,
                    format!("result exceeds {MAX_RESULT_ROWS} rows"),
                )
                .with_detail(serde_json::json!({ "limit": MAX_RESULT_ROWS, "sql": crate::error::truncate(sql, 200) })));
            }
            let mut out = Vec::with_capacity(ncols);
            for i in 0..ncols {
                out.push(SqlValue::from_ref(
                    row.get_ref(i)
                        .map_err(|e| AppError::from_sqlite(e, Some(sql)))?,
                )?);
            }
            rows_out.push(out);
        }
        Ok(ExecResult {
            columns,
            rows: rows_out,
        })
    }

    /// 쓰기 한 문장. 트랜잭션 안에서만.
    pub fn run(&self, sql: &str, params: Option<&Params>) -> Result<RunResult> {
        let mut guard = self.lock_session()?;
        let session = require(&mut guard)?;
        if session.tx_depth == 0 {
            return Err(AppError::query("write outside transaction").add_detail(
                "sql",
                serde_json::Value::String(crate::error::truncate(sql, 200)),
            ));
        }
        let conn = &session.conn;
        run_one(conn, sql, params).map_err(|e| with_sql(e, sql))
    }

    /// 같은 문장을 파라미터 목록만큼 반복한다. 하나의 트랜잭션(중첩이면 SAVEPOINT)이고 실패하면 전체 롤백.
    pub fn run_batch(
        &self,
        sql: &str,
        params_list: &[Params],
        progress: &Progress,
    ) -> Result<BatchResult> {
        if params_list.len() > MAX_BATCH_PARAMS {
            return Err(AppError::new(
                Code::BatchTooLarge,
                format!(
                    "runBatch paramsList length {} exceeds {MAX_BATCH_PARAMS}",
                    params_list.len()
                ),
            ));
        }
        let mut guard = self.lock_session()?;
        let session = require(&mut guard)?;
        let depth = session.tx_depth;
        begin_at(&session.conn, depth)?;
        session.tx_depth += 1;
        let conn = &session.conn;
        let before = conn.total_changes();
        let result = (|| -> Result<()> {
            let mut stmt = conn
                .prepare_cached(sql)
                .map_err(|e| AppError::from_sqlite(e, Some(sql)))?;
            for (i, params) in params_list.iter().enumerate() {
                step_batch_row(&mut stmt, params).map_err(|e| {
                    with_sql(e, sql).add_detail("index", serde_json::Value::from(i))
                })?;
                if (i + 1) % 500 == 0 {
                    progress(
                        serde_json::json!({ "phase": "batch", "done": i + 1, "total": params_list.len() }),
                    );
                }
            }
            Ok(())
        })();
        match result {
            Ok(()) => {
                commit_at(conn, depth)?;
                session.tx_depth -= 1;
                Ok(BatchResult {
                    changes: conn.total_changes() - before,
                })
            }
            Err(err) => {
                let rollback = rollback_at(conn, depth);
                session.tx_depth -= 1;
                Err(match rollback {
                    Ok(()) => err,
                    Err(rb) => {
                        err.add_detail("rollbackFailed", serde_json::Value::String(rb.message))
                    }
                })
            }
        }
    }

    pub fn begin(&self) -> Result<u32> {
        let mut guard = self.lock_session()?;
        let session = require(&mut guard)?;
        begin_at(&session.conn, session.tx_depth)?;
        session.tx_depth += 1;
        Ok(session.tx_depth)
    }

    pub fn commit(&self) -> Result<u32> {
        let mut guard = self.lock_session()?;
        let session = require(&mut guard)?;
        if session.tx_depth == 0 {
            return Err(AppError::query("commit without transaction"));
        }
        let depth = session.tx_depth - 1;
        commit_at(&session.conn, depth)?;
        session.tx_depth = depth;
        Ok(depth)
    }

    pub fn rollback(&self) -> Result<u32> {
        let mut guard = self.lock_session()?;
        let session = require(&mut guard)?;
        if session.tx_depth == 0 {
            return Err(AppError::query("rollback without transaction"));
        }
        let depth = session.tx_depth - 1;
        let result = rollback_at(&session.conn, depth);
        session.tx_depth = depth;
        result?;
        Ok(depth)
    }

    /// 실행 중인 문장을 중단한다. 커넥션 뮤텍스를 잡지 않으므로 긴 질의 도중에도 부를 수 있다.
    pub fn interrupt(&self) {
        if let Some(handle) = self.lock_interrupt().as_ref() {
            handle.interrupt();
        }
    }

    pub fn info(&self) -> Result<EngineInfo> {
        let guard = self.lock_session()?;
        let conn: Connection;
        let conn_ref = match guard.as_ref() {
            Some(session) => &session.conn,
            None => {
                conn = Connection::open_in_memory()?;
                &conn
            }
        };
        let sqlite_version: String =
            conn_ref.query_row("SELECT sqlite_version()", [], |r| r.get(0))?;
        let mut stmt = conn_ref.prepare("PRAGMA compile_options")?;
        let compile_options = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<std::result::Result<Vec<_>, _>>()?;
        Ok(EngineInfo {
            sqlite_version,
            compile_options,
        })
    }

    pub fn capabilities(&self) -> Result<Capabilities> {
        let info = self.info()?;
        Ok(Capabilities {
            persistence: "native",
            fts5: info.compile_options.iter().any(|o| o == "ENABLE_FTS5"),
            cancellable: true,
            max_file_bytes: None,
            warn_file_bytes: None,
        })
    }

    /// 지금 열린 사본의 폴더(없으면 None).
    pub fn current_dir(&self) -> Result<Option<PathBuf>> {
        Ok(self.lock_session()?.as_ref().map(|s| s.dir.clone()))
    }

    /// 열려 있는 원본 경로.
    pub fn current_original(&self) -> Result<Option<PathBuf>> {
        Ok(self
            .lock_session()?
            .as_ref()
            .and_then(|s| s.original.as_ref().map(|o| o.path.clone())))
    }

    pub(crate) fn lock_interrupt(&self) -> std::sync::MutexGuard<'_, Option<InterruptHandle>> {
        self.interrupt
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// 커넥션 뮤텍스. poison되면(패닉) 커넥션을 버리고 오류로 알린다(다시 열어야 한다).
    pub(crate) fn lock_session(&self) -> Result<std::sync::MutexGuard<'_, Option<Session>>> {
        match self.session.lock() {
            Ok(guard) => Ok(guard),
            Err(poisoned) => {
                let mut guard = poisoned.into_inner();
                *guard = None;
                self.session.clear_poison();
                Err(AppError::query(
                    "engine state was poisoned by a panic; reopen the file",
                ))
            }
        }
    }
}

fn require(guard: &mut Option<Session>) -> Result<&mut Session> {
    guard
        .as_mut()
        .ok_or_else(|| AppError::query("database is not open"))
}

fn with_sql(err: AppError, sql: &str) -> AppError {
    match &err.detail {
        Some(serde_json::Value::Object(map)) if map.contains_key("sql") => err,
        _ => err.add_detail(
            "sql",
            serde_json::Value::String(crate::error::truncate(sql, 200)),
        ),
    }
}

fn begin_at(conn: &Connection, depth: u32) -> Result<()> {
    let sql = if depth == 0 {
        "BEGIN".to_string()
    } else {
        format!("SAVEPOINT {}", savepoint_name(depth))
    };
    conn.execute_batch(&sql)
        .map_err(|e| AppError::from_sqlite(e, Some(&sql)))
}

fn commit_at(conn: &Connection, depth: u32) -> Result<()> {
    let sql = if depth == 0 {
        "COMMIT".to_string()
    } else {
        format!("RELEASE {}", savepoint_name(depth))
    };
    conn.execute_batch(&sql)
        .map_err(|e| AppError::from_sqlite(e, Some(&sql)))
}

fn rollback_at(conn: &Connection, depth: u32) -> Result<()> {
    let sql = if depth == 0 {
        "ROLLBACK".to_string()
    } else {
        let name = savepoint_name(depth);
        format!("ROLLBACK TO {name}; RELEASE {name}")
    };
    conn.execute_batch(&sql)
        .map_err(|e| AppError::from_sqlite(e, Some(&sql)))
}

/// 문장 하나를 한 번 step한다. 결과 행이 있는 문장(RETURNING)도 첫 행까지만 실행한다(wasm과 같다).
fn run_one(conn: &Connection, sql: &str, params: Option<&Params>) -> Result<RunResult> {
    let before = conn.total_changes();
    let mut stmt = conn
        .prepare_cached(sql)
        .map_err(|e| AppError::from_sqlite(e, Some(sql)))?;
    if let Some(params) = params.filter(|p| !p.is_empty()) {
        params.bind(&mut stmt)?;
    }
    {
        let mut rows = stmt.raw_query();
        rows.next()
            .map_err(|e| AppError::from_sqlite(e, Some(sql)))?;
    }
    Ok(RunResult {
        changes: conn.total_changes() - before,
        last_id: conn.last_insert_rowid(),
    })
}

fn step_batch_row(stmt: &mut rusqlite::CachedStatement<'_>, params: &Params) -> Result<()> {
    if !params.is_empty() {
        params.bind(stmt)?;
    }
    {
        let mut rows = stmt.raw_query();
        rows.next()?;
    }
    stmt.clear_bindings();
    Ok(())
}

/// 경로 문자열을 `PathBuf`로. 빈 문자열은 거부한다(경로는 문자열 결합으로 만들지 않는다).
pub fn path_arg(value: &str) -> Result<PathBuf> {
    if value.trim().is_empty() {
        return Err(AppError::new(Code::FileWrite, "path is empty"));
    }
    Ok(PathBuf::from(value))
}

pub fn path_string(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}
