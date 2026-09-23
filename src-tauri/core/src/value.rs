//! SQL 값과 파라미터의 JSON 형식(D-15). 정수·실수·문자열·null은 그대로, BLOB은 `{ "$blob": "<base64>" }`.

use crate::error::{AppError, Result};
use rusqlite::types::{ToSql, ToSqlOutput, Value, ValueRef};
use serde::de::{self, Deserializer};
use serde::ser::{SerializeMap, Serializer};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

/// SQLite 저장 클래스 하나.
#[derive(Debug, Clone, PartialEq)]
pub enum SqlValue {
    Null,
    Integer(i64),
    Real(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl SqlValue {
    pub fn from_ref(value: ValueRef<'_>) -> Result<SqlValue> {
        Ok(match value {
            ValueRef::Null => SqlValue::Null,
            ValueRef::Integer(i) => SqlValue::Integer(i),
            ValueRef::Real(r) => SqlValue::Real(r),
            ValueRef::Text(bytes) => SqlValue::Text(
                std::str::from_utf8(bytes)
                    .map_err(|e| AppError::query(format!("invalid utf-8 in text column: {e}")))?
                    .to_string(),
            ),
            ValueRef::Blob(bytes) => SqlValue::Blob(bytes.to_vec()),
        })
    }
}

impl ToSql for SqlValue {
    fn to_sql(&self) -> rusqlite::Result<ToSqlOutput<'_>> {
        Ok(match self {
            SqlValue::Null => ToSqlOutput::Owned(Value::Null),
            SqlValue::Integer(i) => ToSqlOutput::Owned(Value::Integer(*i)),
            SqlValue::Real(r) => ToSqlOutput::Owned(Value::Real(*r)),
            SqlValue::Text(s) => ToSqlOutput::Borrowed(ValueRef::Text(s.as_bytes())),
            SqlValue::Blob(b) => ToSqlOutput::Borrowed(ValueRef::Blob(b)),
        })
    }
}

impl Serialize for SqlValue {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        match self {
            SqlValue::Null => serializer.serialize_unit(),
            SqlValue::Integer(i) => serializer.serialize_i64(*i),
            SqlValue::Real(r) => serializer.serialize_f64(*r),
            SqlValue::Text(s) => serializer.serialize_str(s),
            SqlValue::Blob(b) => {
                let mut map = serializer.serialize_map(Some(1))?;
                map.serialize_entry("$blob", &base64_encode(b))?;
                map.end()
            }
        }
    }
}

impl<'de> Deserialize<'de> for SqlValue {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> std::result::Result<Self, D::Error> {
        let raw = serde_json::Value::deserialize(deserializer)?;
        from_json(&raw).map_err(de::Error::custom)
    }
}

/// JSON 값 하나를 SQL 값으로. 배열·중첩 객체는 거부한다.
pub fn from_json(raw: &serde_json::Value) -> std::result::Result<SqlValue, String> {
    match raw {
        serde_json::Value::Null => Ok(SqlValue::Null),
        serde_json::Value::Bool(b) => Ok(SqlValue::Integer(i64::from(*b))),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                Ok(SqlValue::Integer(i))
            } else if let Some(f) = n.as_f64() {
                Ok(SqlValue::Real(f))
            } else {
                Err(format!("number out of range: {n}"))
            }
        }
        serde_json::Value::String(s) => Ok(SqlValue::Text(s.clone())),
        serde_json::Value::Object(map) => match map.get("$blob") {
            Some(serde_json::Value::String(b64)) if map.len() == 1 => {
                base64_decode(b64).map(SqlValue::Blob)
            }
            _ => Err("object is not a { \"$blob\": base64 } value".into()),
        },
        serde_json::Value::Array(_) => Err("array is not a SQL value".into()),
    }
}

/// 위치(`?`) 또는 이름(`:name`) 바인딩.
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(untagged)]
pub enum Params {
    Positional(Vec<SqlValue>),
    Named(BTreeMap<String, SqlValue>),
}

impl Params {
    pub fn is_empty(&self) -> bool {
        match self {
            Params::Positional(v) => v.is_empty(),
            Params::Named(m) => m.is_empty(),
        }
    }

    /// prepared statement에 바인딩한다. 이름에 접두사가 없으면 `:`를 붙인다(wasm 엔진과 같은 규칙).
    pub fn bind(&self, stmt: &mut rusqlite::Statement<'_>) -> Result<()> {
        match self {
            Params::Positional(values) => {
                for (i, value) in values.iter().enumerate() {
                    stmt.raw_bind_parameter(i + 1, value)?;
                }
            }
            Params::Named(map) => {
                for (key, value) in map {
                    let name = if key.starts_with([':', '$', '@']) {
                        key.clone()
                    } else {
                        format!(":{key}")
                    };
                    let index = stmt
                        .parameter_index(&name)?
                        .ok_or_else(|| AppError::query(format!("no such parameter: {name}")))?;
                    stmt.raw_bind_parameter(index, value)?;
                }
            }
        }
        Ok(())
    }
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/// 표준 base64(패딩 포함). 외부 크레이트를 더하지 않기 위한 최소 구현이다(D-12).
pub fn base64_encode(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = chunk.get(1).copied().unwrap_or(0) as u32;
        let b2 = chunk.get(2).copied().unwrap_or(0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64[(n >> 18) as usize & 63] as char);
        out.push(B64[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            B64[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            B64[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

pub fn base64_decode(text: &str) -> std::result::Result<Vec<u8>, String> {
    fn value(c: u8) -> std::result::Result<u32, String> {
        Ok(match c {
            b'A'..=b'Z' => (c - b'A') as u32,
            b'a'..=b'z' => (c - b'a') as u32 + 26,
            b'0'..=b'9' => (c - b'0') as u32 + 52,
            b'+' => 62,
            b'/' => 63,
            _ => return Err(format!("invalid base64 character: {}", c as char)),
        })
    }
    let bytes = text.as_bytes();
    let trimmed = bytes.iter().rev().take_while(|&&c| c == b'=').count();
    let body = &bytes[..bytes.len() - trimmed];
    if bytes.len() % 4 != 0 || trimmed > 2 {
        return Err("invalid base64 length".into());
    }
    let mut out = Vec::with_capacity(body.len() * 3 / 4);
    for chunk in body.chunks(4) {
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            n |= value(c)? << (18 - 6 * i);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn base64_round_trip() {
        for len in 0..40 {
            let bytes: Vec<u8> = (0..len).map(|i| (i * 37 + 11) as u8).collect();
            let encoded = base64_encode(&bytes);
            assert_eq!(base64_decode(&encoded).unwrap(), bytes, "len {len}");
        }
        assert_eq!(base64_encode(b"\x01\x02\x03"), "AQID");
        assert!(base64_decode("AQI").is_err());
    }

    #[test]
    fn json_round_trip() {
        let values = vec![
            SqlValue::Null,
            SqlValue::Integer(i64::MAX),
            SqlValue::Real(1.5),
            SqlValue::Text("가나다".into()),
            SqlValue::Blob(vec![1, 2, 3]),
        ];
        let json = serde_json::to_string(&values).unwrap();
        assert_eq!(
            json,
            "[null,9223372036854775807,1.5,\"가나다\",{\"$blob\":\"AQID\"}]"
        );
        let back: Vec<SqlValue> = serde_json::from_str(&json).unwrap();
        assert_eq!(back, values);
        let named: Params = serde_json::from_str("{\"a\":1,\":b\":null}").unwrap();
        assert!(matches!(named, Params::Named(_)));
        let positional: Params = serde_json::from_str("[1,\"x\"]").unwrap();
        assert!(matches!(positional, Params::Positional(_)));
    }
}
