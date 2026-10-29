//! env@1（无需权限）：当前项目。平台、版本、环境变量是静态值，随脚本启动一次给出（`script::statics`）。

use serde_json::Value;

use crate::rpc::{ApiResult, Host};

pub fn call(host: &Host, name: &str) -> Option<ApiResult> {
    match name {
        "project" => Some(Ok((host.project)())),
        _ => None,
    }
}

pub fn platform() -> &'static str {
    match std::env::consts::OS {
        "macos" => "darwin",
        other => other,
    }
}

/// 环境变量快照（非 UTF-8 的跳过）。
pub fn vars() -> Value {
    Value::Object(
        std::env::vars()
            .map(|(key, value)| (key, Value::String(value)))
            .collect(),
    )
}
