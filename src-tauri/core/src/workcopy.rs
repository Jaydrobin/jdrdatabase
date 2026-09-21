//! 작업 사본(D-15): 앱 데이터 폴더 `workcopies/<key>/current.db`와 `meta.json`.
//!
//! 키는 원본의 `_jdr_meta.db_id`이고, 메타가 없는 파일은 원본 경로의 FNV-1a 64비트 해시다.
//! 남은 사본이 dirty(`_jdr_meta.dirty = 1`)면 복사하지 않고 그대로 열어 복구 흐름에 넘긴다.

use crate::error::{AppError, Code, Result};
use rusqlite::{Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

pub const WORKCOPY_DIR: &str = "workcopies";
pub const CURRENT_DB: &str = "current.db";
pub const META_JSON: &str = "meta.json";
const SQLITE_MAGIC: &[u8; 16] = b"SQLite format 3\0";
/// 복사 진행률 보고 간격(바이트).
const COPY_PROGRESS_EVERY: u64 = 64 * 1024 * 1024;

/// `meta.json`. 사본이 어느 원본에서 왔는지와 열 때 본 원본의 상태.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WorkcopyMeta {
    pub original_path: Option<String>,
    pub original_mtime: Option<u64>,
    pub original_size: Option<u64>,
    pub opened_at: u64,
}

/// 원본을 읽기 전용으로 들여다본 결과.
#[derive(Debug, Clone)]
pub struct OriginalInfo {
    pub db_id: Option<String>,
    pub revision: Option<i64>,
    pub mtime: u64,
    pub size: u64,
}

/// 준비된 사본.
#[derive(Debug)]
pub struct Prepared {
    pub key: String,
    pub dir: PathBuf,
    pub db_path: PathBuf,
    /// 남아 있던 dirty 사본을 그대로 열었는가.
    pub reused_dirty: bool,
    /// 재사용한 사본의 `_jdr_meta.revision`.
    pub workcopy_revision: Option<i64>,
    pub copy_ms: u64,
    pub meta: WorkcopyMeta,
}

/// 목록 항목(`list`).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkcopyEntry {
    pub key: String,
    pub dir: String,
    pub dirty: bool,
    pub size: u64,
    pub meta: Option<WorkcopyMeta>,
}

pub fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// FNV-1a 64비트. 경로 해시와 임의 접미사에 쓴다(외부 크레이트 없이).
pub fn fnv1a(bytes: &[u8]) -> u64 {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for &b in bytes {
        hash ^= u64::from(b);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    hash
}

static COUNTER: AtomicU64 = AtomicU64::new(0);

/// 프로세스 안에서 겹치지 않는 16자리 16진수 접미사.
pub fn random_suffix() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos() as u64)
        .unwrap_or(0);
    let n = COUNTER.fetch_add(1, Ordering::Relaxed);
    let pid = u64::from(std::process::id());
    format!(
        "{:016x}",
        fnv1a(&[nanos.to_le_bytes(), n.to_le_bytes(), pid.to_le_bytes()].concat())
    )
}

/// 파일의 mtime(ms)과 크기.
pub fn file_stamp(path: &Path) -> Result<(u64, u64)> {
    let meta = fs::metadata(path).map_err(|e| AppError::from_io(e, "stat", Some(path)))?;
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0);
    Ok((mtime, meta.len()))
}

/// SQLite 매직 헤더 검사. 빈 파일(0바이트)은 새 DB로 본다.
pub fn validate_header(path: &Path) -> Result<()> {
    let mut file = fs::File::open(path).map_err(|e| AppError::from_io(e, "open", Some(path)))?;
    let mut head = [0u8; 16];
    let n = file
        .read(&mut head)
        .map_err(|e| AppError::from_io(e, "read", Some(path)))?;
    if n == 0 {
        return Ok(());
    }
    if n < 16 || &head != SQLITE_MAGIC {
        return Err(AppError::new(
            Code::FileNotSqlite,
            "file does not start with the SQLite header",
        )
        .add_detail(
            "path",
            serde_json::Value::String(path.to_string_lossy().into_owned()),
        ));
    }
    Ok(())
}

/// `_jdr_meta`가 있으면 그 키의 값.
pub fn read_meta_value(conn: &Connection, key: &str) -> Result<Option<String>> {
    let has: i64 = conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type = 'table' AND name = '_jdr_meta'",
        [],
        |r| r.get(0),
    )?;
    if has == 0 {
        return Ok(None);
    }
    let mut stmt = conn.prepare("SELECT value FROM _jdr_meta WHERE key = ? LIMIT 1")?;
    let mut rows = stmt.query([key])?;
    Ok(match rows.next()? {
        Some(row) => Some(row.get::<_, String>(0)?),
        None => None,
    })
}

/// `_jdr_meta.dirty = 1`인가.
pub fn is_dirty(conn: &Connection) -> Result<bool> {
    Ok(read_meta_value(conn, "dirty")?.as_deref() == Some("1"))
}

fn parse_revision(value: Option<String>) -> Option<i64> {
    value.and_then(|v| v.trim().parse::<i64>().ok())
}

/// 원본을 읽기 전용으로 열어 `db_id`·`revision`을 읽는다. 헤더가 틀리면 `E_FILE_NOT_SQLITE`.
pub fn inspect_original(path: &Path) -> Result<OriginalInfo> {
    validate_header(path)?;
    let (mtime, size) = file_stamp(path)?;
    if size == 0 {
        return Ok(OriginalInfo {
            db_id: None,
            revision: None,
            mtime,
            size,
        });
    }
    let conn = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|e| AppError::from_sqlite(e, Some("open original")))?;
    // 헤더만 맞는 손상 파일은 첫 읽기에서 드러난다.
    let db_id = read_meta_value(&conn, "db_id")?;
    let revision = parse_revision(read_meta_value(&conn, "revision")?);
    Ok(OriginalInfo {
        db_id,
        revision,
        mtime,
        size,
    })
}

/// 사본 폴더 이름. `db_id`가 없으면 경로 해시.
pub fn workcopy_key(original: &Path, info: &OriginalInfo) -> String {
    match &info.db_id {
        Some(id) if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-') => {
            id.clone()
        }
        _ => format!("p-{:016x}", fnv1a(original.to_string_lossy().as_bytes())),
    }
}

pub fn workcopies_root(app_data: &Path) -> PathBuf {
    app_data.join(WORKCOPY_DIR)
}

pub fn workcopy_dir(app_data: &Path, key: &str) -> PathBuf {
    workcopies_root(app_data).join(key)
}

fn write_meta(dir: &Path, meta: &WorkcopyMeta) -> Result<()> {
    let path = dir.join(META_JSON);
    let json = serde_json::to_vec_pretty(meta)?;
    fs::write(&path, json).map_err(|e| AppError::from_io(e, "write meta.json", Some(&path)))
}

pub fn read_meta(dir: &Path) -> Option<WorkcopyMeta> {
    let text = fs::read(dir.join(META_JSON)).ok()?;
    serde_json::from_slice(&text).ok()
}

/// 사본 폴더를 통째로 지운다. 없으면 성공.
pub fn remove_dir(dir: &Path) -> Result<()> {
    match fs::remove_dir_all(dir) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(AppError::from_io(e, "remove workcopy", Some(dir))),
    }
}

/// 원본을 사본으로 복사한다. 64 MB마다 진행률을 보고한다. 실패하면 부분 파일을 지운다.
fn copy_original(
    original: &Path,
    target: &Path,
    size: u64,
    progress: &dyn Fn(u64, u64),
) -> Result<()> {
    let mut src = fs::File::open(original)
        .map_err(|e| AppError::from_io(e, "copy: open original", Some(original)))?;
    let result = (|| -> Result<()> {
        let mut dst = fs::File::create(target)
            .map_err(|e| AppError::from_io(e, "copy: create workcopy", Some(target)))?;
        let mut buf = vec![0u8; 8 * 1024 * 1024];
        let mut done: u64 = 0;
        let mut next_report = COPY_PROGRESS_EVERY;
        loop {
            let n = src
                .read(&mut buf)
                .map_err(|e| AppError::from_io(e, "copy: read", Some(original)))?;
            if n == 0 {
                break;
            }
            dst.write_all(&buf[..n])
                .map_err(|e| AppError::from_io(e, "copy: write", Some(target)))?;
            done += n as u64;
            if done >= next_report {
                progress(done, size);
                next_report += COPY_PROGRESS_EVERY;
            }
        }
        dst.sync_all()
            .map_err(|e| AppError::from_io(e, "copy: sync", Some(target)))?;
        progress(done, size);
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(target);
    }
    result
}

fn remove_sidecars(db_path: &Path) {
    for suffix in ["-wal", "-shm", "-journal"] {
        let mut name = db_path.as_os_str().to_owned();
        name.push(suffix);
        let _ = fs::remove_file(PathBuf::from(name));
    }
}

/// 원본의 사본을 준비한다. 남은 사본이 dirty고 `discard`가 아니면 그대로 쓴다.
pub fn prepare(
    app_data: &Path,
    original: &Path,
    info: &OriginalInfo,
    discard: bool,
    progress: &dyn Fn(u64, u64),
) -> Result<Prepared> {
    let key = workcopy_key(original, info);
    let dir = workcopy_dir(app_data, &key);
    let db_path = dir.join(CURRENT_DB);
    if !discard && db_path.is_file() {
        if let Ok(conn) = Connection::open_with_flags(
            &db_path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        ) {
            if is_dirty(&conn).unwrap_or(false) {
                let workcopy_revision = parse_revision(read_meta_value(&conn, "revision")?);
                drop(conn);
                let meta = read_meta(&dir).unwrap_or(WorkcopyMeta {
                    original_path: Some(original.to_string_lossy().into_owned()),
                    original_mtime: None,
                    original_size: None,
                    opened_at: now_ms(),
                });
                return Ok(Prepared {
                    key,
                    dir,
                    db_path,
                    reused_dirty: true,
                    workcopy_revision,
                    copy_ms: 0,
                    meta,
                });
            }
        }
    }
    remove_dir(&dir)?;
    fs::create_dir_all(&dir)
        .map_err(|e| AppError::from_io(e, "create workcopy dir", Some(&dir)))?;
    let started = std::time::Instant::now();
    copy_original(original, &db_path, info.size, progress)?;
    remove_sidecars(&db_path);
    let meta = WorkcopyMeta {
        original_path: Some(original.to_string_lossy().into_owned()),
        original_mtime: Some(info.mtime),
        original_size: Some(info.size),
        opened_at: now_ms(),
    };
    write_meta(&dir, &meta)?;
    Ok(Prepared {
        key,
        dir,
        db_path,
        reused_dirty: false,
        workcopy_revision: None,
        copy_ms: started.elapsed().as_millis() as u64,
        meta,
    })
}

/// 원본 없는 새 DB의 임시 사본(`workcopies/new-<random>/current.db`).
pub fn new_temp(app_data: &Path) -> Result<Prepared> {
    let key = format!("new-{}", random_suffix());
    let dir = workcopy_dir(app_data, &key);
    fs::create_dir_all(&dir)
        .map_err(|e| AppError::from_io(e, "create workcopy dir", Some(&dir)))?;
    let meta = WorkcopyMeta {
        original_path: None,
        original_mtime: None,
        original_size: None,
        opened_at: now_ms(),
    };
    write_meta(&dir, &meta)?;
    Ok(Prepared {
        db_path: dir.join(CURRENT_DB),
        key,
        dir,
        reused_dirty: false,
        workcopy_revision: None,
        copy_ms: 0,
        meta,
    })
}

/// 저장 뒤 원본 경로·상태를 `meta.json`에 반영한다.
pub fn update_meta_original(dir: &Path, original: &Path, mtime: u64, size: u64) -> Result<()> {
    let mut meta = read_meta(dir).unwrap_or(WorkcopyMeta {
        original_path: None,
        original_mtime: None,
        original_size: None,
        opened_at: now_ms(),
    });
    meta.original_path = Some(original.to_string_lossy().into_owned());
    meta.original_mtime = Some(mtime);
    meta.original_size = Some(size);
    write_meta(dir, &meta)
}

/// 남아 있는 사본 목록. dirty 여부는 파일을 읽기 전용으로 열어 본다.
pub fn list(app_data: &Path) -> Vec<WorkcopyEntry> {
    let root = workcopies_root(app_data);
    let mut out = Vec::new();
    let Ok(entries) = fs::read_dir(&root) else {
        return out;
    };
    for entry in entries.flatten() {
        let dir = entry.path();
        let db_path = dir.join(CURRENT_DB);
        if !db_path.is_file() {
            continue;
        }
        let size = fs::metadata(&db_path).map(|m| m.len()).unwrap_or(0);
        let dirty = Connection::open_with_flags(
            &db_path,
            OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
        )
        .ok()
        .and_then(|conn| is_dirty(&conn).ok())
        .unwrap_or(false);
        out.push(WorkcopyEntry {
            key: entry.file_name().to_string_lossy().into_owned(),
            dir: dir.to_string_lossy().into_owned(),
            dirty,
            size,
            meta: read_meta(&dir),
        });
    }
    out.sort_by(|a, b| {
        let ka = a.meta.as_ref().map(|m| m.opened_at).unwrap_or(0);
        let kb = b.meta.as_ref().map(|m| m.opened_at).unwrap_or(0);
        kb.cmp(&ka)
    });
    out
}

/// dirty가 아닌 사본을 모두 지운다(`exclude`는 지금 열린 사본). 지운 개수.
pub fn purge_clean(app_data: &Path, exclude: Option<&Path>) -> usize {
    let mut removed = 0;
    for entry in list(app_data) {
        let dir = PathBuf::from(&entry.dir);
        if entry.dirty || exclude == Some(dir.as_path()) {
            continue;
        }
        if remove_dir(&dir).is_ok() {
            removed += 1;
        }
    }
    removed
}
