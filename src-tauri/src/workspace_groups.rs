//! 侧栏工作区：按用途给项目分组（runtime bridge `workspaceGroups.*`）。
//!
//! 工作区只是本机客户端的分组，不进项目数据、不同步到其他客户端。整份存在数据目录的
//! `workspace-groups.json`；分组规则（迁移、重名、「默认」不可删、worktree 跟 root）由前端
//! `src/lib/workspace-groups.ts` 负责，这里只管读写。
//!
//! - `workspaceGroups.get` → 文件内容；没有文件或文件坏了为 `null`（坏文件改名留存，不覆盖）
//! - `workspaceGroups.set { state }` → 整份覆盖，先写临时文件再改名

use std::path::Path;

use serde::{Deserialize, Serialize};
use serde_json::Value;

const FILE: &str = "workspace-groups.json";

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct State {
    version: u32,
    groups: Vec<Group>,
    members: Vec<Member>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Group {
    id: String,
    name: String,
    #[serde(default)]
    emoji: Option<String>,
    #[serde(default)]
    is_default: bool,
}

/// 一个 root 项目的归属：`device` 本机为 0，其他为设备 id。
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Member {
    device: i64,
    path: String,
    group_id: String,
}

pub fn dispatch(data_dir: &Path, method: &str, params: &Value) -> Result<Value, String> {
    match method {
        "workspaceGroups.get" => Ok(read(data_dir)),
        "workspaceGroups.set" => write(data_dir, &params["state"]).map(|()| Value::Null),
        _ => Err(format!("Unsupported workspaceGroups operation: {method}")),
    }
}

fn read(data_dir: &Path) -> Value {
    let path = data_dir.join(FILE);
    let Ok(bytes) = std::fs::read(&path) else {
        return Value::Null;
    };
    match serde_json::from_slice::<State>(&bytes) {
        Ok(state) if state.version == 1 => serde_json::to_value(state).unwrap_or(Value::Null),
        _ => {
            // 坏文件改名留存：按「没有工作区」处理，项目全回「默认」，只丢分组
            let stamp = chrono::Utc::now().format("%Y%m%d%H%M%S");
            let kept = data_dir.join(format!("{FILE}.broken-{stamp}"));
            if let Err(error) = std::fs::rename(&path, &kept) {
                tracing::warn!(%error, "workspace-groups.json 坏文件改名失败");
            }
            Value::Null
        }
    }
}

fn write(data_dir: &Path, state: &Value) -> Result<(), String> {
    let state: State = serde_json::from_value(state.clone())
        .map_err(|error| format!("工作区数据无效：{error}"))?;
    let bytes = serde_json::to_vec_pretty(&state).map_err(|error| error.to_string())?;
    std::fs::create_dir_all(data_dir).map_err(|error| error.to_string())?;
    let path = data_dir.join(FILE);
    let temporary = data_dir.join(format!(".{FILE}.{}.tmp", std::process::id()));
    std::fs::write(&temporary, bytes)
        .and_then(|()| std::fs::rename(&temporary, &path))
        .map_err(|error| {
            let _ = std::fs::remove_file(&temporary);
            error.to_string()
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn round_trips_and_keeps_broken_file() {
        let dir = tempfile::tempdir().unwrap();
        let dir = dir.path();
        assert_eq!(read(dir), Value::Null, "没有文件");

        let state = json!({
            "version": 1,
            "groups": [{ "id": "default", "name": "默认", "emoji": null, "isDefault": true }],
            "members": [{ "device": 0, "path": "/p", "groupId": "default" }],
        });
        write(dir, &state).unwrap();
        assert_eq!(read(dir), state);
        assert!(
            write(dir, &json!({ "version": 1 })).is_err(),
            "形状不对不写"
        );

        std::fs::write(dir.join(FILE), "{oops").unwrap();
        assert_eq!(read(dir), Value::Null);
        assert!(!dir.join(FILE).exists());
        let kept = std::fs::read_dir(dir).unwrap().flatten().any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("workspace-groups.json.broken-")
        });
        assert!(kept, "坏文件改名留存");
    }
}
