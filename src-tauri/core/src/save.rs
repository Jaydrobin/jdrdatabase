//! 저장(D-15): mtime·크기 검사 → `wal_checkpoint(TRUNCATE)` → `VACUUM INTO` 임시 → 원본을 `.bak`으로 → 임시를 원본으로 rename.
//! 원본 파일을 바꾸는 코드는 이 파일에만 있다(CLAUDE.md 5.9).

use crate::db::{path_arg, path_string, OriginalRef};
use crate::error::{AppError, Code, Result};
use crate::workcopy;
use crate::{Backend, Progress};
use serde::{Deserialize, Serialize};
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::time::Instant;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Expected {
    pub mtime: u64,
    pub size: u64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveArgs {
    pub original_path: String,
    /// 열 때(또는 마지막 저장 때) 본 원본의 상태. 없으면 세션이 기억한 값을 쓴다.
    pub expected: Option<Expected>,
    #[serde(default)]
    pub force: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveInfo {
    pub path: String,
    pub size: u64,
    pub mtime: u64,
    pub backup_path: Option<String>,
    pub elapsed_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub path: String,
    pub size: u64,
    pub mtime: u64,
}

/// 테스트가 실패를 주입하는 지점. `Backend::call`로는 설정할 수 없다.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FailPoint {
    /// `VACUUM INTO`가 실제로 실패하도록 임시 파일 경로를 없는 폴더 아래로 둔다.
    Vacuum,
    /// 원본을 `.bak`으로 옮긴 뒤, 임시 파일을 원본 자리에 놓는 rename이 실패한 것으로 본다.
    RenameToOriginal,
}

fn with_suffix(path: &Path, suffix: &str) -> PathBuf {
    let mut name: OsString = path.as_os_str().to_owned();
    name.push(suffix);
    PathBuf::from(name)
}

/// `<원본>.bak`
pub fn backup_path_for(original: &Path) -> PathBuf {
    with_suffix(original, ".bak")
}

fn rename(from: &Path, to: &Path, phase: &str) -> Result<()> {
    fs::rename(from, to).map_err(|e| {
        let code = match e.kind() {
            std::io::ErrorKind::NotFound => Code::FileWrite,
            _ => Code::FileLocked,
        };
        AppError::new(code, format!("{phase}: {e}")).with_detail(serde_json::json!({
            "phase": phase,
            "from": path_string(from),
            "to": path_string(to),
        }))
    })
}

impl Backend {
    /// 열린 사본을 원본 자리에 원자적으로 쓴다. 다른 경로면 새 파일을 만든다(`.bak` 없음).
    pub fn save_to(&self, args: SaveArgs, progress: &Progress) -> Result<SaveInfo> {
        let started = Instant::now();
        let target = path_arg(&args.original_path)?;
        let fail_point = *self.fail_point.lock().unwrap_or_else(|p| p.into_inner());
        let mut guard = self.lock_session()?;
        let session = guard
            .as_mut()
            .ok_or_else(|| AppError::query("database is not open"))?;
        if session.tx_depth > 0 {
            return Err(AppError::query("save inside transaction")
                .add_detail("txDepth", serde_json::Value::from(session.tx_depth)));
        }
        let same_original = session
            .original
            .as_ref()
            .map(|o| same_path(&o.path, &target))
            .unwrap_or(false);
        let exists = target.is_file();
        if same_original && exists && !args.force {
            let (mtime, size) = workcopy::file_stamp(&target)?;
            let expected = match (&args.expected, &session.original) {
                (Some(e), _) => (e.mtime, e.size),
                (None, Some(o)) => (o.mtime, o.size),
                (None, None) => (mtime, size),
            };
            if (mtime, size) != expected {
                return Err(AppError::new(
                    Code::OriginalChanged,
                    "original file changed on disk after it was opened",
                )
                .with_detail(serde_json::json!({
                    "path": path_string(&target),
                    "expected": { "mtime": expected.0, "size": expected.1 },
                    "actual": { "mtime": mtime, "size": size },
                })));
            }
        }
        let parent = target
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .map(Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        if !parent.is_dir() {
            return Err(
                AppError::new(Code::FileWrite, "target folder does not exist")
                    .add_detail("path", serde_json::Value::String(path_string(&parent))),
            );
        }
        progress(serde_json::json!({ "phase": "checkpoint", "done": 0, "total": 0 }));
        session
            .conn
            .execute_batch("PRAGMA wal_checkpoint(TRUNCATE)")
            .map_err(|e| AppError::from_sqlite(e, Some("wal_checkpoint")))?;

        let tmp = if fail_point == Some(FailPoint::Vacuum) {
            parent
                .join(format!("missing-{}", workcopy::random_suffix()))
                .join("save.tmp")
        } else {
            with_suffix(&target, &format!(".tmp-{}", workcopy::random_suffix()))
        };
        progress(serde_json::json!({ "phase": "vacuum", "done": 0, "total": 0 }));
        let vacuum = session
            .conn
            .execute("VACUUM INTO ?1", [path_string(&tmp)])
            .map_err(|e| AppError::from_sqlite(e, Some("VACUUM INTO")));
        if let Err(err) = vacuum {
            let _ = fs::remove_file(&tmp);
            return Err(err.add_detail("original", serde_json::json!({ "untouched": true })));
        }
        if let Err(err) = fs::File::open(&tmp).and_then(|f| f.sync_all()) {
            let _ = fs::remove_file(&tmp);
            return Err(AppError::from_io(err, "sync", Some(&tmp)));
        }

        progress(serde_json::json!({ "phase": "replace", "done": 0, "total": 0 }));
        let mut backup: Option<PathBuf> = None;
        if exists {
            let bak = backup_path_for(&target);
            if let Err(err) = fs::remove_file(&bak) {
                if err.kind() != std::io::ErrorKind::NotFound {
                    let _ = fs::remove_file(&tmp);
                    return Err(AppError::from_io(err, "remove old backup", Some(&bak)));
                }
            }
            if let Err(err) = rename(&target, &bak, "move original to .bak") {
                let _ = fs::remove_file(&tmp);
                return Err(err.add_detail("original", serde_json::json!({ "untouched": true })));
            }
            backup = Some(bak);
        }
        let placed = if fail_point == Some(FailPoint::RenameToOriginal) {
            Err(AppError::new(Code::FileLocked, "injected rename failure").with_detail(
                serde_json::json!({ "phase": "move temp to original", "from": path_string(&tmp), "to": path_string(&target) }),
            ))
        } else {
            rename(&tmp, &target, "move temp to original")
        };
        if let Err(err) = placed {
            // 원본을 `.bak`에서 되돌려 놓고, 임시 파일은 남겨 경로를 알린다(다른 이름으로 저장 유도).
            let restored = match &backup {
                Some(bak) => rename(bak, &target, "restore original from .bak").is_ok(),
                None => true,
            };
            return Err(err.with_detail(serde_json::json!({
                "tmpPath": path_string(&tmp),
                "original": { "restored": restored, "backupPath": backup.as_ref().map(|p| path_string(p)) },
            })));
        }
        let (mtime, size) = workcopy::file_stamp(&target)?;
        session.original = Some(OriginalRef {
            path: target.clone(),
            mtime,
            size,
        });
        workcopy::update_meta_original(&session.dir, &target, mtime, size)?;
        Ok(SaveInfo {
            path: path_string(&target),
            size,
            mtime,
            backup_path: backup.map(|p| path_string(&p)),
            elapsed_ms: started.elapsed().as_millis() as u64,
        })
    }

    /// `<원본>.bak`이 있으면 크기·시각.
    pub fn backup_info(&self, original_path: &str) -> Result<Option<BackupInfo>> {
        let original = path_arg(original_path)?;
        let bak = backup_path_for(&original);
        if !bak.is_file() {
            return Ok(None);
        }
        let (mtime, size) = workcopy::file_stamp(&bak)?;
        Ok(Some(BackupInfo {
            path: path_string(&bak),
            size,
            mtime,
        }))
    }

    /// `<원본>.bak`을 고른 경로로 복사한다. 열린 DB와 원본은 건드리지 않는다.
    pub fn restore_backup(&self, original_path: &str, target_path: &str) -> Result<BackupInfo> {
        let original = path_arg(original_path)?;
        let target = path_arg(target_path)?;
        let bak = backup_path_for(&original);
        if !bak.is_file() {
            return Err(
                AppError::new(Code::FileWrite, "no .bak backup for this file")
                    .add_detail("path", serde_json::Value::String(path_string(&bak))),
            );
        }
        if same_path(&target, &original) || same_path(&target, &bak) {
            return Err(AppError::new(
                Code::FileWrite,
                "restore target must be a new file",
            ));
        }
        fs::copy(&bak, &target).map_err(|e| AppError::from_io(e, "copy backup", Some(&target)))?;
        let (mtime, size) = workcopy::file_stamp(&target)?;
        Ok(BackupInfo {
            path: path_string(&target),
            size,
            mtime,
        })
    }
}

fn same_path(a: &Path, b: &Path) -> bool {
    if a == b {
        return true;
    }
    match (fs::canonicalize(a), fs::canonicalize(b)) {
        (Ok(x), Ok(y)) => x == y,
        _ => false,
    }
}
