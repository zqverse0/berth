//! Berth 插件宿主接口（docs/plugin-architecture.md）：JSON-RPC 命名空间（[`rpc`]、`ns/`）与
//! 内嵌 QuickJS 的脚本环境（[`script`]）。berth-cli 的 `tools launch` / `tools run` 是唯一入口。

pub mod agent;
mod ns;
pub mod rpc;
pub mod script;

use std::collections::BTreeSet;
use std::path::Path;

use serde_json::Value;

pub use rpc::{ApiError, Host, ProjectLookup, Reason};

/// 由插件包 tool.json 建一次运行的 [`Host`]：权限取 `permissions`，`requires` 里有宿主不支持的
/// 命名空间版本就拒绝运行（§2.3）。
pub fn host_for(package: &Path, project: rpc::ProjectLookup) -> Result<Host, String> {
    let manifest_path = package.join("tool.json");
    let manifest: Value = std::fs::read(&manifest_path)
        .map_err(|error| format!("{}: {error}", manifest_path.display()))
        .and_then(|bytes| {
            serde_json::from_slice(&bytes)
                .map_err(|error| format!("{}: {error}", manifest_path.display()))
        })?;
    let plugin_id = manifest["id"]
        .as_str()
        .filter(|id| berth_tool_core::paths::is_valid_manifest_id(id))
        .ok_or("tool.json has no valid id")?
        .to_owned();
    if let Some(requires) = manifest["requires"].as_object() {
        for (namespace, major) in requires {
            if !major
                .as_u64()
                .is_some_and(|major| Host::supports(namespace, major))
            {
                return Err(format!("plugin {plugin_id} requires {namespace}@{major}, which this Berth does not provide; update Berth"));
            }
        }
    }
    let permissions = manifest["permissions"]
        .as_array()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect::<BTreeSet<_>>()
        })
        .unwrap_or_default();
    // 不预先创建：插件第一次写数据时（storage.set、fs.writeText / mkdir）才出现。
    let state_dir = berth_tool_core::paths::berth_home_dir()
        .join("state")
        .join(&plugin_id);
    Ok(Host {
        plugin_id,
        package: package.to_path_buf(),
        permissions,
        state_dir,
        project,
        sessions: Default::default(),
    })
}

/// `berth tools run <id> <脚本>`：运行包内脚本的默认导出函数（参数为命令行余下的参数），
/// 返回数字即作为退出码。脚本必须在包内。
pub fn run_script(
    package: &Path,
    script: &str,
    args: &[String],
    project: rpc::ProjectLookup,
) -> i32 {
    let result = (|| {
        let host = host_for(package, project)?;
        let root = std::fs::canonicalize(package).map_err(|error| error.to_string())?;
        let path = std::fs::canonicalize(package.join(script))
            .map_err(|error| format!("{script}: {error}"))?;
        if !path.starts_with(&root) {
            return Err(format!("{script} is outside the plugin package"));
        }
        let bootstrap = format!(
            "import * as module from {};\nconst run = module.default;\n\
             const result = typeof run === \"function\" ? await run(JSON.parse(__berth_args)) : undefined;\n\
             globalThis.__berth_result = JSON.stringify(typeof result === \"number\" ? result : 0);",
            script::js_string(&path.to_string_lossy())
        );
        let args = serde_json::to_string(args).unwrap_or_default();
        script::run(host, &bootstrap, &[("__berth_args", args)])
    })();
    match result {
        Ok(code) => code.as_i64().unwrap_or(0) as i32,
        Err(error) => {
            eprintln!("berth tools run: {error}");
            2
        }
    }
}
