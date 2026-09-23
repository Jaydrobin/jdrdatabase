//! 앱 오류(DESIGN.md 7장). 코드는 `src/util/errors.js`의 목록과 1:1이고 JS로는 `{ code, message, detail }`로 직렬화된다.

use rusqlite::ErrorCode;
use serde::Serialize;
use std::fmt;
use std::io;

/// 오류 코드. JS `ERROR_CODES`의 부분집합이며 이름이 그대로 직렬화된다.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum Code {
    #[serde(rename = "E_FILE_NOT_SQLITE")]
    FileNotSqlite,
    #[serde(rename = "E_FILE_CORRUPT")]
    FileCorrupt,
    #[serde(rename = "E_FILE_PERMISSION")]
    FilePermission,
    #[serde(rename = "E_FILE_WRITE")]
    FileWrite,
    #[serde(rename = "E_DB_QUERY")]
    DbQuery,
    #[serde(rename = "E_DB_BUSY")]
    DbBusy,
    #[serde(rename = "E_RESULT_TOO_LARGE")]
    ResultTooLarge,
    #[serde(rename = "E_BATCH_TOO_LARGE")]
    BatchTooLarge,
    #[serde(rename = "E_MEM")]
    Mem,
    #[serde(rename = "E_IMPORT_CANCELLED")]
    ImportCancelled,
    #[serde(rename = "E_UNSUPPORTED")]
    Unsupported,
    #[serde(rename = "E_NATIVE_IPC")]
    NativeIpc,
    #[serde(rename = "E_DISK_FULL")]
    DiskFull,
    #[serde(rename = "E_FILE_LOCKED")]
    FileLocked,
    #[serde(rename = "E_ORIGINAL_CHANGED")]
    OriginalChanged,
    #[serde(rename = "E_UNKNOWN")]
    Unknown,
}

impl Code {
    /// JS 쪽 문자열.
    pub fn as_str(self) -> &'static str {
        match self {
            Code::FileNotSqlite => "E_FILE_NOT_SQLITE",
            Code::FileCorrupt => "E_FILE_CORRUPT",
            Code::FilePermission => "E_FILE_PERMISSION",
            Code::FileWrite => "E_FILE_WRITE",
            Code::DbQuery => "E_DB_QUERY",
            Code::DbBusy => "E_DB_BUSY",
            Code::ResultTooLarge => "E_RESULT_TOO_LARGE",
            Code::BatchTooLarge => "E_BATCH_TOO_LARGE",
            Code::Mem => "E_MEM",
            Code::ImportCancelled => "E_IMPORT_CANCELLED",
            Code::Unsupported => "E_UNSUPPORTED",
            Code::NativeIpc => "E_NATIVE_IPC",
            Code::DiskFull => "E_DISK_FULL",
            Code::FileLocked => "E_FILE_LOCKED",
            Code::OriginalChanged => "E_ORIGINAL_CHANGED",
            Code::Unknown => "E_UNKNOWN",
        }
    }
}

/// JS 경계로 나가는 유일한 오류 형태. `detail`은 JSON으로 직렬화 가능한 값만 담는다.
#[derive(Debug, Clone, Serialize)]
pub struct AppError {
    pub code: Code,
    pub message: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<serde_json::Value>,
}

impl AppError {
    pub fn new(code: Code, message: impl Into<String>) -> Self {
        AppError {
            code,
            message: message.into(),
            detail: None,
        }
    }

    pub fn with_detail(mut self, detail: serde_json::Value) -> Self {
        self.detail = Some(detail);
        self
    }

    /// `detail`에 키 하나를 더한다(없으면 객체를 만든다).
    pub fn add_detail(mut self, key: &str, value: serde_json::Value) -> Self {
        let mut map = match self.detail.take() {
            Some(serde_json::Value::Object(map)) => map,
            _ => serde_json::Map::new(),
        };
        map.insert(key.to_string(), value);
        self.detail = Some(serde_json::Value::Object(map));
        self
    }

    pub fn query(message: impl Into<String>) -> Self {
        AppError::new(Code::DbQuery, message)
    }

    pub fn unsupported(message: impl Into<String>) -> Self {
        AppError::new(Code::Unsupported, message)
    }

    /// rusqlite 오류를 매핑한다. `sql`은 앞 200자만 detail에 남긴다.
    pub fn from_sqlite(err: rusqlite::Error, sql: Option<&str>) -> Self {
        let (code, result_code) = match &err {
            rusqlite::Error::SqliteFailure(ffi, _) => (
                match ffi.code {
                    ErrorCode::DiskFull => Code::DiskFull,
                    ErrorCode::DatabaseBusy | ErrorCode::DatabaseLocked => Code::FileLocked,
                    ErrorCode::OperationInterrupted => Code::ImportCancelled,
                    ErrorCode::NotADatabase => Code::FileNotSqlite,
                    ErrorCode::OutOfMemory => Code::Mem,
                    ErrorCode::DatabaseCorrupt => Code::FileCorrupt,
                    _ => Code::DbQuery,
                },
                Some(ffi.extended_code),
            ),
            _ => (Code::DbQuery, None),
        };
        let mut detail = serde_json::Map::new();
        if let Some(sql) = sql {
            detail.insert("sql".into(), serde_json::Value::String(truncate(sql, 200)));
        }
        if let Some(rc) = result_code {
            detail.insert("resultCode".into(), serde_json::Value::from(rc));
        }
        AppError {
            code,
            message: err.to_string(),
            detail: Some(serde_json::Value::Object(detail)),
        }
    }

    /// `std::io` 오류를 매핑한다. `phase`는 어떤 단계였는지(copy, vacuum, rename…)를 detail에 남긴다.
    pub fn from_io(err: io::Error, phase: &str, path: Option<&std::path::Path>) -> Self {
        let code = match err.kind() {
            io::ErrorKind::PermissionDenied => Code::FilePermission,
            io::ErrorKind::NotFound => Code::FileWrite,
            _ if is_disk_full(&err) => Code::DiskFull,
            _ => Code::FileWrite,
        };
        let mut detail = serde_json::Map::new();
        detail.insert("phase".into(), serde_json::Value::String(phase.into()));
        if let Some(path) = path {
            detail.insert(
                "path".into(),
                serde_json::Value::String(path.to_string_lossy().into_owned()),
            );
        }
        AppError {
            code,
            message: format!("{phase}: {err}"),
            detail: Some(serde_json::Value::Object(detail)),
        }
    }
}

/// ENOSPC는 `ErrorKind`로 안정적으로 드러나지 않으므로(1.83 전에는 `Other`) OS 코드로 본다.
fn is_disk_full(err: &io::Error) -> bool {
    #[cfg(unix)]
    {
        err.raw_os_error() == Some(28)
    }
    #[cfg(windows)]
    {
        // ERROR_DISK_FULL(112), ERROR_HANDLE_DISK_FULL(39)
        matches!(err.raw_os_error(), Some(112) | Some(39))
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = err;
        false
    }
}

/// 문자 경계를 지키며 앞 `max`자를 남긴다(로그·detail에 큰 문자열을 두지 않는다).
pub fn truncate(s: &str, max: usize) -> String {
    s.chars().take(max).collect()
}

impl fmt::Display for AppError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code.as_str(), self.message)
    }
}

impl std::error::Error for AppError {}

impl From<rusqlite::Error> for AppError {
    fn from(err: rusqlite::Error) -> Self {
        AppError::from_sqlite(err, None)
    }
}

impl From<serde_json::Error> for AppError {
    fn from(err: serde_json::Error) -> Self {
        AppError::new(Code::DbQuery, format!("invalid arguments: {err}"))
    }
}

pub type Result<T> = std::result::Result<T, AppError>;
