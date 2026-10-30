//! 插件 ↔ 宿主的唯一边界：`<命名空间>.<方法>` + JSON 参数 → JSON 结果或错误（docs/plugin-architecture.md §2.2）。
//! 两种运行环境都只经这里调宿主；命名空间的实现各占 `ns/` 一个文件。

use std::collections::BTreeSet;
use std::path::PathBuf;

use serde_json::{json, Value};

use crate::ns;

/// 错误原因（§2.2 的固定集合，只增不改）。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Reason {
    InvalidParams,
    Denied,
    NotFound,
    Conflict,
    Unsupported,
    Cancelled,
    Internal,
}

impl Reason {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::InvalidParams => "invalid-params",
            Self::Denied => "denied",
            Self::NotFound => "not-found",
            Self::Conflict => "conflict",
            Self::Unsupported => "unsupported",
            Self::Cancelled => "cancelled",
            Self::Internal => "internal",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ApiError {
    pub reason: Reason,
    pub message: String,
}

impl ApiError {
    pub fn new(reason: Reason, message: impl Into<String>) -> Self {
        Self {
            reason,
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new(Reason::InvalidParams, message)
    }

    pub fn io(context: &str, error: std::io::Error) -> Self {
        let reason = match error.kind() {
            std::io::ErrorKind::NotFound => Reason::NotFound,
            std::io::ErrorKind::AlreadyExists => Reason::Conflict,
            std::io::ErrorKind::InvalidInput => Reason::InvalidParams,
            _ => Reason::Internal,
        };
        Self::new(reason, format!("{context}: {error}"))
    }
}

pub type ApiResult = Result<Value, ApiError>;

pub type ProjectLookup = Box<dyn Fn() -> Value>;

/// 命名空间 → 主版本、所需权限（§3）。脚本环境不提供页面专属的命名空间。
const NAMESPACES: &[(&str, u64, Option<&str>)] = &[
    ("process", 1, Some("process")),
    ("fs", 1, Some("fs")),
    ("storage", 1, None),
    ("env", 1, None),
    ("data", 1, None),
    ("http", 1, Some("network")),
];

/// 一次脚本运行的宿主侧上下文。
pub struct Host {
    pub plugin_id: String,
    /// 插件包目录（只读）。
    pub package: PathBuf,
    /// tool.json `permissions`。
    pub permissions: BTreeSet<String>,
    /// `$BERTH_HOME/state/<id>/`（`storage`）。
    pub state_dir: PathBuf,
    /// 当前项目 `{id, name, root}`；不在项目里为 null（`env.project`）。要查库，调用时才求。
    pub project: ProjectLookup,
    /// `process.open` 打开的会话；脚本结束随 Host 一起结束进程。
    pub(crate) sessions: ns::process::Sessions,
}

impl Host {
    pub fn call(&self, method: &str, params: Value) -> ApiResult {
        let (namespace, name) = method.split_once('.').ok_or_else(|| {
            ApiError::new(Reason::Unsupported, format!("unknown method {method}"))
        })?;
        let Some((_, _, permission)) = NAMESPACES.iter().find(|(id, _, _)| *id == namespace) else {
            return Err(ApiError::new(
                Reason::Unsupported,
                format!("namespace {namespace} is not available here"),
            ));
        };
        if let Some(permission) = permission {
            if !self.permissions.contains(*permission) {
                return Err(ApiError::new(
                    Reason::Denied,
                    format!("{method} needs permission \"{permission}\" in tool.json"),
                ));
            }
        }
        let params = if params.is_null() { json!({}) } else { params };
        let unknown = || ApiError::new(Reason::Unsupported, format!("unknown method {method}"));
        match namespace {
            "process" => ns::process::call(self, name, &params).unwrap_or_else(|| Err(unknown())),
            "fs" => ns::fs::call(name, &params).unwrap_or_else(|| Err(unknown())),
            "storage" => ns::storage::call(self, name, &params).unwrap_or_else(|| Err(unknown())),
            "env" => ns::env::call(self, name).unwrap_or_else(|| Err(unknown())),
            "data" => ns::data::call(name, &params).unwrap_or_else(|| Err(unknown())),
            "http" => ns::http::call(name, &params).unwrap_or_else(|| Err(unknown())),
            _ => Err(unknown()),
        }
    }

    /// 宿主支持的命名空间主版本（`requires` 校验用）。
    pub fn supports(namespace: &str, major: u64) -> bool {
        NAMESPACES
            .iter()
            .any(|(id, version, _)| *id == namespace && *version == major)
    }
}

/// 参数取值：缺字段或类型不对一律 `invalid-params`。
pub(crate) fn str_param<'a>(params: &'a Value, key: &str) -> Result<&'a str, ApiError> {
    params[key]
        .as_str()
        .ok_or_else(|| ApiError::invalid(format!("{key} must be a string")))
}

pub(crate) fn opt_str_param<'a>(params: &'a Value, key: &str) -> Result<Option<&'a str>, ApiError> {
    match &params[key] {
        Value::Null => Ok(None),
        Value::String(value) => Ok(Some(value)),
        _ => Err(ApiError::invalid(format!("{key} must be a string"))),
    }
}

pub(crate) fn str_list_param(params: &Value, key: &str) -> Result<Vec<String>, ApiError> {
    match &params[key] {
        Value::Null => Ok(Vec::new()),
        Value::Array(items) => items
            .iter()
            .map(|item| item.as_str().map(str::to_owned))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| ApiError::invalid(format!("{key} must be an array of strings"))),
        _ => Err(ApiError::invalid(format!(
            "{key} must be an array of strings"
        ))),
    }
}

/// `{ "K": "V" }`；值不是字符串报错。
pub(crate) fn env_param(params: &Value, key: &str) -> Result<Vec<(String, String)>, ApiError> {
    match &params[key] {
        Value::Null => Ok(Vec::new()),
        Value::Object(map) => map
            .iter()
            .map(|(name, value)| value.as_str().map(|value| (name.clone(), value.to_owned())))
            .collect::<Option<Vec<_>>>()
            .ok_or_else(|| ApiError::invalid(format!("{key} values must be strings"))),
        _ => Err(ApiError::invalid(format!("{key} must be an object"))),
    }
}
