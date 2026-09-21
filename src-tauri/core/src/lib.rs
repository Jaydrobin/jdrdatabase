//! jdr-core: 데스크톱 모드의 네이티브 SQLite 엔진·저장·작업 사본(D-15). 타우리에 의존하지 않는다.
//!
//! `Backend::call(cmd, args, progress)`가 유일한 진입점이며, 타우리 명령(`src-tauri/src/commands.rs`)과
//! 표준 입출력 하네스(`bin/jdr-ipc-stdio.rs`)가 같은 함수를 부른다.

pub mod db;
pub mod error;
pub mod save;
pub mod value;
pub mod workcopy;

use db::Session;
use error::{AppError, Code, Result};
use rusqlite::InterruptHandle;
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use value::Params;

/// 진행률 콜백. 인자는 `{ phase, done, total }`.
pub type Progress<'a> = dyn Fn(Value) + Send + Sync + 'a;

/// 관리 상태 하나. 커넥션 뮤텍스와 인터럽트 핸들을 따로 두어 긴 문장 도중에도 `interrupt`가 된다.
pub struct Backend {
    pub app_data: PathBuf,
    pub(crate) session: Mutex<Option<Session>>,
    pub(crate) interrupt: Mutex<Option<InterruptHandle>>,
    /// 테스트 전용 실패 주입(`save.rs`). `call`로는 바꿀 수 없다.
    pub fail_point: Mutex<Option<save::FailPoint>>,
}

#[derive(Deserialize)]
struct SqlArgs {
    sql: String,
    params: Option<Params>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct BatchArgs {
    sql: String,
    params_list: Vec<Params>,
}

#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
struct CloseArgs {
    #[serde(default)]
    discard_workcopy: bool,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct PathArgs {
    original_path: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct RestoreArgs {
    original_path: String,
    target_path: String,
}

#[derive(Deserialize)]
struct KeyArgs {
    key: String,
}

fn parse<T: for<'de> Deserialize<'de>>(args: Value) -> Result<T> {
    let value = if args.is_null() {
        Value::Object(serde_json::Map::new())
    } else {
        args
    };
    serde_json::from_value(value).map_err(AppError::from)
}

impl Backend {
    pub fn new(app_data: impl AsRef<Path>) -> Backend {
        Backend {
            app_data: app_data.as_ref().to_path_buf(),
            session: Mutex::new(None),
            interrupt: Mutex::new(None),
            fail_point: Mutex::new(None),
        }
    }

    /// 명령 이름으로 함수를 고른다(6장·D-15). 모르는 명령은 `E_NATIVE_IPC`.
    pub fn call(&self, cmd: &str, args: Value, progress: &Progress) -> Result<Value> {
        match cmd {
            "open" => Ok(serde_json::to_value(self.open(parse(args)?, progress)?)?),
            "close" => {
                let a: CloseArgs = parse(args)?;
                self.close(a.discard_workcopy)?;
                Ok(Value::Null)
            }
            "exec" => {
                let a: SqlArgs = parse(args)?;
                Ok(serde_json::to_value(self.exec(&a.sql, a.params.as_ref())?)?)
            }
            "run" => {
                let a: SqlArgs = parse(args)?;
                Ok(serde_json::to_value(self.run(&a.sql, a.params.as_ref())?)?)
            }
            "run_batch" => {
                let a: BatchArgs = parse(args)?;
                Ok(serde_json::to_value(self.run_batch(
                    &a.sql,
                    &a.params_list,
                    progress,
                )?)?)
            }
            "begin" => Ok(Value::from(self.begin()?)),
            "commit" => Ok(Value::from(self.commit()?)),
            "rollback" => Ok(Value::from(self.rollback()?)),
            "interrupt" => {
                self.interrupt();
                Ok(Value::Null)
            }
            "info" => Ok(serde_json::to_value(self.info()?)?),
            "capabilities" => Ok(serde_json::to_value(self.capabilities()?)?),
            "save_to" => Ok(serde_json::to_value(self.save_to(parse(args)?, progress)?)?),
            "backup_info" => {
                let a: PathArgs = parse(args)?;
                Ok(serde_json::to_value(self.backup_info(&a.original_path)?)?)
            }
            "restore_backup" => {
                let a: RestoreArgs = parse(args)?;
                Ok(serde_json::to_value(
                    self.restore_backup(&a.original_path, &a.target_path)?,
                )?)
            }
            "list_workcopies" => Ok(serde_json::to_value(workcopy::list(&self.app_data))?),
            "purge_workcopies" => {
                let current = self.current_dir()?;
                Ok(Value::from(workcopy::purge_clean(
                    &self.app_data,
                    current.as_deref(),
                )))
            }
            "remove_workcopy" => {
                let a: KeyArgs = parse(args)?;
                if a.key.contains(['/', '\\']) || a.key == "." || a.key == ".." {
                    return Err(AppError::new(Code::FileWrite, "invalid workcopy key"));
                }
                let dir = workcopy::workcopy_dir(&self.app_data, &a.key);
                if self.current_dir()?.as_deref() == Some(dir.as_path()) {
                    self.close(true)?;
                } else {
                    workcopy::remove_dir(&dir)?;
                }
                Ok(Value::Null)
            }
            _ => Err(AppError::new(
                Code::NativeIpc,
                format!("unknown command: {cmd}"),
            )),
        }
    }
}

/// 명령 이름 목록(하네스·테스트가 검사).
pub const COMMANDS: &[&str] = &[
    "open",
    "close",
    "exec",
    "run",
    "run_batch",
    "begin",
    "commit",
    "rollback",
    "interrupt",
    "info",
    "capabilities",
    "save_to",
    "backup_info",
    "restore_backup",
    "list_workcopies",
    "purge_workcopies",
    "remove_workcopy",
];
