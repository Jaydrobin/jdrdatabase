//! 경로 싱크(Step 11): 내보내기 조각을 임시 파일에 쓰고 닫을 때 원자적으로 교체한다(브라우저 모드의 `createWritable()`에 해당).

use crate::db::{path_arg, path_string};
use crate::error::{AppError, Code, Result};
use crate::workcopy;
use crate::Backend;
use serde::Serialize;
use std::collections::HashMap;
use std::fs::{self, File};
use std::io::Write;
use std::path::PathBuf;

pub struct Sink {
    target: PathBuf,
    tmp: PathBuf,
    file: File,
    written: u64,
}

#[derive(Default)]
pub struct Sinks {
    next_id: u64,
    open: HashMap<u64, Sink>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SinkInfo {
    pub path: String,
    pub size: u64,
}

fn tmp_path_for(target: &std::path::Path) -> PathBuf {
    let mut name = target.as_os_str().to_owned();
    name.push(format!(".tmp-{}", workcopy::random_suffix()));
    PathBuf::from(name)
}

impl Backend {
    fn lock_sinks(&self) -> std::sync::MutexGuard<'_, Sinks> {
        self.sinks.lock().unwrap_or_else(|p| p.into_inner())
    }

    /// 임시 파일을 만들고 싱크 id를 돌려준다. 대상 폴더가 없으면 `E_FILE_WRITE`.
    pub fn sink_open(&self, path: &str) -> Result<u64> {
        let target = path_arg(path)?;
        let parent = target
            .parent()
            .filter(|p| !p.as_os_str().is_empty())
            .map(std::path::Path::to_path_buf)
            .unwrap_or_else(|| PathBuf::from("."));
        if !parent.is_dir() {
            return Err(
                AppError::new(Code::FileWrite, "target folder does not exist")
                    .add_detail("path", serde_json::Value::String(path_string(&parent))),
            );
        }
        let tmp = tmp_path_for(&target);
        let file =
            File::create(&tmp).map_err(|e| AppError::from_io(e, "create temp file", Some(&tmp)))?;
        let mut sinks = self.lock_sinks();
        sinks.next_id += 1;
        let id = sinks.next_id;
        sinks.open.insert(
            id,
            Sink {
                target,
                tmp,
                file,
                written: 0,
            },
        );
        Ok(id)
    }

    /// 조각을 임시 파일에 쓴다. 실패하면 싱크를 버리고 임시 파일을 지운다.
    pub fn sink_write(&self, id: u64, bytes: &[u8]) -> Result<u64> {
        let mut sinks = self.lock_sinks();
        let sink = sinks
            .open
            .get_mut(&id)
            .ok_or_else(|| AppError::new(Code::FileWrite, "unknown sink"))?;
        match sink.file.write_all(bytes) {
            Ok(()) => {
                sink.written += bytes.len() as u64;
                Ok(sink.written)
            }
            Err(err) => {
                let tmp = sink.tmp.clone();
                sinks.open.remove(&id);
                let _ = fs::remove_file(&tmp);
                Err(AppError::from_io(err, "write chunk", Some(&tmp)))
            }
        }
    }

    /// 동기화한 뒤 임시 파일을 대상 자리에 놓는다. 대상이 있으면 덮어쓴다.
    pub fn sink_close(&self, id: u64) -> Result<SinkInfo> {
        let sink = self
            .lock_sinks()
            .open
            .remove(&id)
            .ok_or_else(|| AppError::new(Code::FileWrite, "unknown sink"))?;
        let result = (|| -> Result<()> {
            sink.file
                .sync_all()
                .map_err(|e| AppError::from_io(e, "sync", Some(&sink.tmp)))?;
            drop(sink.file);
            if sink.target.exists() {
                fs::remove_file(&sink.target)
                    .map_err(|e| AppError::from_io(e, "replace target", Some(&sink.target)))?;
            }
            fs::rename(&sink.tmp, &sink.target)
                .map_err(|e| AppError::from_io(e, "move temp to target", Some(&sink.target)))
        })();
        if let Err(err) = result {
            let _ = fs::remove_file(&sink.tmp);
            return Err(err);
        }
        Ok(SinkInfo {
            path: path_string(&sink.target),
            size: sink.written,
        })
    }

    /// 임시 파일을 지운다. 대상은 만들어지지 않는다.
    pub fn sink_abort(&self, id: u64) -> Result<()> {
        if let Some(sink) = self.lock_sinks().open.remove(&id) {
            drop(sink.file);
            let _ = fs::remove_file(&sink.tmp);
        }
        Ok(())
    }
}
