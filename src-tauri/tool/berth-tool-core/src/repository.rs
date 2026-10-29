//! Tool Asset 文件读写：`BERTH_HOME/tools/<id>/tool.json` 的发现与加载。
//!
//! 本模块只负责「找到并读出 ToolAsset」，不做投影判断（归 `crate::asset`）。
//! 沿用 `paths` 的 id 规则与 tools 根（BERTH_HOME/tools，不跟随
//! BERTH_DATA_DIR）；1 MiB 读取上限与 launchbar/agent.json 一致。
//! 注册表真相是受管目录中的文件本身，不建索引数据库（09-10 design D3）。

use std::path::PathBuf;

use serde_json::Value;

use crate::asset::ToolAsset;
use crate::error::ToolCoreError;
use crate::paths::{is_valid_manifest_id, tools_root};

/// 单份 tool.json 的读取上限（与 agent.json/launchbar.json 同 rationale）。
pub const MAX_TOOL_JSON_BYTES: u64 = 1024 * 1024;

/// `tools/<id>/tool.json` 的路径。id 规则与 manifest id 一致（目录名主键）。
pub fn tool_asset_file_path(id: &str) -> Result<PathBuf, ToolCoreError> {
    if !is_valid_manifest_id(id) {
        return Err(ToolCoreError::invalid_input(
            "tool asset id must match [a-z0-9][a-z0-9._-]* (max 128 chars)",
        ));
    }
    Ok(tools_root().join(id).join("tool.json"))
}

/// 资产包根目录 `tools/<id>/`：`base: package` 资源（包内脚本）的解析根。
/// 与 `tool_asset_file_path` 同源推导，宿主接线不得各自拼路径（阶段 F）。
pub fn tool_package_dir(id: &str) -> Result<PathBuf, ToolCoreError> {
    let path = tool_asset_file_path(id)?;
    path.parent()
        .map(PathBuf::from)
        .ok_or_else(|| ToolCoreError::invalid_input("tool asset path has no package dir"))
}

/// 加载一个工具资产。文件缺失返回 `Ok(None)`（合法状态：目录存在但没有
/// tool.json）；存在但损坏返回错误（JSON 级），合法 JSON 的坏块由投影
/// 诊断表达（不整包拒载）。
pub fn load_tool_asset(id: &str) -> Result<Option<ToolAsset>, ToolCoreError> {
    let path = tool_asset_file_path(id)?;
    let metadata = match std::fs::metadata(&path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(ToolCoreError::Io(error.to_string())),
    };
    if !metadata.is_file() {
        return Err(ToolCoreError::invalid_input(format!(
            "tool asset {id} is not a regular file"
        )));
    }
    if metadata.len() > MAX_TOOL_JSON_BYTES {
        return Err(ToolCoreError::invalid_input(format!(
            "tool asset {id} exceeds {} bytes",
            MAX_TOOL_JSON_BYTES
        )));
    }
    let bytes = std::fs::read(&path).map_err(|error| ToolCoreError::Io(error.to_string()))?;
    let mut raw: Value = serde_json::from_slice(&bytes).map_err(|error| {
        ToolCoreError::invalid_input(format!("tool asset {id} is not valid JSON: {error}"))
    })?;
    // 新清单骨架（contributes / version）折成投影读的形状，下游只认一种写法。
    crate::manifest::normalize(&mut raw);
    // V2 硬化④：装载路径绑定目录主键——id/identity 校验在此生效
    // （review-fixes「加载时校验」；投影可见性不受影响，只停用执行）。
    Ok(Some(ToolAsset::from_value_with_directory(raw, id)))
}

/// 列出启用且与本 Berth 兼容的工具 id：会话、用量、启动栏等运行入口只看到它们
/// （停用状态见 `crate::plugins`，兼容性见 `crate::manifest`）。
pub fn list_tool_asset_ids() -> Vec<String> {
    let disabled = crate::plugins::disabled_ids();
    let mut ids = list_installed_tool_asset_ids();
    ids.retain(|id| !disabled.contains(id) && crate::plugins::incompatibility(id).is_none());
    ids
}

/// 列出存在 tool.json 的工具 id（目录名），含停用的；供管理视图
/// （设置页、`berth tools list/check`）。坏目录跳过，不影响其他条目。
pub fn list_installed_tool_asset_ids() -> Vec<String> {
    let mut ids = Vec::new();
    let Ok(entries) = std::fs::read_dir(tools_root()) else {
        return ids;
    };
    for entry in entries.flatten() {
        let Ok(file_type) = entry.file_type() else {
            continue;
        };
        if !file_type.is_dir() {
            continue;
        }
        let Some(name) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        if !is_valid_manifest_id(&name) {
            continue;
        }
        if tool_asset_file_path(&name)
            .ok()
            .and_then(|path| std::fs::metadata(path).ok())
            .is_some_and(|metadata| metadata.is_file())
        {
            ids.push(name);
        }
    }
    ids.sort();
    ids
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::asset::TOOL_ASSET_PROTOCOL;
    use crate::paths::TEST_ENV_LOCK;
    use serde_json::json;

    fn with_temp_berth_home(test: impl FnOnce(PathBuf)) {
        let lock = TEST_ENV_LOCK.get_or_init(|| std::sync::Mutex::new(()));
        let _guard = lock.lock().unwrap();
        let previous = std::env::var_os("BERTH_HOME");
        // 锁保证同时只有一个测试线程；命名与桌面侧旧测试目录区分，避免互删。
        let dir = std::env::temp_dir().join(format!("tool-asset-core-test-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("tools")).unwrap();
        std::env::set_var("BERTH_HOME", &dir);
        test(dir.clone());
        match previous {
            Some(value) => std::env::set_var("BERTH_HOME", value),
            None => std::env::remove_var("BERTH_HOME"),
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn id_rules_reuse_manifest_pattern() {
        // 新断言会真实读取 tools_root()，须与 with_temp_berth_home 的
        // BERTH_HOME 换值串行（同一把锁），否则并行时两侧读到不同根。
        let lock = TEST_ENV_LOCK.get_or_init(|| std::sync::Mutex::new(()));
        let _guard = lock.lock().unwrap();
        assert!(tool_asset_file_path("claude").is_ok());
        assert_eq!(
            tool_package_dir("claude").unwrap(),
            tools_root().join("claude")
        );
        assert!(tool_asset_file_path("a").is_ok());
        assert!(tool_asset_file_path("Bad").is_err());
        assert!(tool_asset_file_path("../escape").is_err());
        assert!(tool_asset_file_path("").is_err());
    }

    #[test]
    fn missing_file_is_none_and_broken_json_is_flagged() {
        with_temp_berth_home(|home| {
            assert!(load_tool_asset("ghost").unwrap().is_none());

            let dir = home.join("tools/broken");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("tool.json"), b"not json").unwrap();
            let error = load_tool_asset("broken").unwrap_err();
            assert!(error.to_string().contains("not valid JSON"));

            // 合法 JSON 但非对象：仍产出投影（原文可见），protocol 诊断标记。
            std::fs::write(dir.join("tool.json"), b"[1,2]").unwrap();
            let asset = load_tool_asset("broken").unwrap().unwrap();
            assert!(asset.protocol().is_none());
            assert!(!asset.diagnostics().is_empty());
        });
    }

    #[test]
    fn loaded_identity_mismatch_is_diagnosed_not_hidden() {
        // id 与目录名不符 / 缺 identity.name → 诊断，原文依旧可见。
        with_temp_berth_home(|home| {
            let dir = home.join("tools/renamed");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("tool.json"),
                serde_json::to_vec(&json!({
                    "protocol": TOOL_ASSET_PROTOCOL,
                    "id": "original",
                    "identity": { "name": "Original" }
                }))
                .unwrap(),
            )
            .unwrap();
            let asset = load_tool_asset("renamed").unwrap().unwrap();
            assert!(asset
                .diagnostics()
                .iter()
                .any(|d| d.location == "id" && d.message.contains("不等于目录名")));

            // 缺 identity.name：同样记诊断。
            std::fs::write(
                dir.join("tool.json"),
                serde_json::to_vec(&json!({
                    "protocol": TOOL_ASSET_PROTOCOL,
                    "id": "renamed"
                }))
                .unwrap(),
            )
            .unwrap();
            let asset = load_tool_asset("renamed").unwrap().unwrap();
            assert!(asset
                .diagnostics()
                .iter()
                .any(|d| d.location == "identity.name"));
            // 身份良好的资产不受影响。
            let dir = home.join("tools/good");
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(
                dir.join("tool.json"),
                serde_json::to_vec(&json!({
                    "protocol": TOOL_ASSET_PROTOCOL,
                    "id": "good",
                    "identity": { "name": "Good" }
                }))
                .unwrap(),
            )
            .unwrap();
            assert!(load_tool_asset("good")
                .unwrap()
                .unwrap()
                .diagnostics()
                .is_empty());
        });
    }

    #[test]
    fn loads_and_lists_assets() {
        with_temp_berth_home(|home| {
            for id in ["alpha", "beta"] {
                let dir = home.join(format!("tools/{id}"));
                std::fs::create_dir_all(&dir).unwrap();
                std::fs::write(
                    dir.join("tool.json"),
                    serde_json::to_vec(&json!({
                        "protocol": TOOL_ASSET_PROTOCOL,
                        "id": id,
                        "identity": { "name": id }
                    }))
                    .unwrap(),
                )
                .unwrap();
            }
            // 无 tool.json 的目录不入列。
            std::fs::create_dir_all(home.join("tools/plain")).unwrap();
            // 根级 manifest 文件也不是资产目录。
            std::fs::write(home.join("tools/root.json"), b"{}").unwrap();

            let asset = load_tool_asset("alpha").unwrap().unwrap();
            assert_eq!(asset.id(), Some("alpha"));
            assert_eq!(list_tool_asset_ids(), ["alpha", "beta"]);
        });
    }
}
