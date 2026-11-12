//! env@1（无需权限）：当前项目与调用方 Agent。平台、版本、环境变量是静态值，随脚本启动一次给出（`script::statics`）。

use std::path::Path;

use serde_json::{json, Value};

use crate::rpc::{ApiResult, Host};

pub fn call(host: &Host, name: &str) -> Option<ApiResult> {
    match name {
        "project" => Some(Ok((host.project)())),
        "agent" => Some(Ok(agent(
            std::env::var_os(crate::agent::LAUNCH_MANIFEST_ENV).as_deref().map(Path::new),
        ))),
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

/// 调用方 Agent `{id, expert?}`：读本进程继承的启动清单（Agent 经 `berth tools launch` 启动时设置）。
/// 没有清单（页面、用户自己在终端跑）或读不懂都为 null。
fn agent(manifest: Option<&Path>) -> Value {
    let Some(manifest) = manifest
        .and_then(|path| std::fs::read(path).ok())
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    else {
        return Value::Null;
    };
    let Some(id) = manifest["agent"].as_str() else {
        return Value::Null;
    };
    match manifest["expert"]["id"].as_str() {
        Some(expert) => json!({ "id": id, "expert": expert }),
        None => json!({ "id": id }),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn env_agent_reads_the_launch_manifest() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("m.json");
        std::fs::write(&path, r#"{"agent":"claude","expert":{"id":"dev","name":"Dev"}}"#).unwrap();
        assert_eq!(agent(Some(&path)), json!({"id": "claude", "expert": "dev"}));
        std::fs::write(&path, r#"{"agent":"codex","expert":null}"#).unwrap();
        assert_eq!(agent(Some(&path)), json!({"id": "codex"}));
        std::fs::write(&path, "{broken").unwrap();
        assert_eq!(agent(Some(&path)), Value::Null);
        assert_eq!(agent(Some(&dir.path().join("missing.json"))), Value::Null);
        assert_eq!(agent(None), Value::Null);
    }
}
