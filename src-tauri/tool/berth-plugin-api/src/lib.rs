//! Berth 插件宿主接口（docs/plugin-architecture.md）：JSON-RPC 命名空间（[`rpc`]、`ns/`）与
//! 内嵌 QuickJS 的脚本环境（[`script`]）。入口：berth-cli 的 `tools launch` / `tools run` /
//! `tools call`，以及 GUI 渲染插件视图（[`call_script`]）。

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

/// 包内脚本的规范化绝对路径；不在包内就拒绝。
fn package_script(package: &Path, script: &str) -> Result<std::path::PathBuf, String> {
    let root = std::fs::canonicalize(package).map_err(|error| error.to_string())?;
    let path = std::fs::canonicalize(package.join(script))
        .map_err(|error| format!("{script}: {error}"))?;
    if !path.starts_with(&root) {
        return Err(format!("{script} is outside the plugin package"));
    }
    Ok(path)
}

/// 调用包内脚本的默认导出：`hook` 给出时调它的同名方法（如视图的 `render`），否则默认导出本身是函数。
/// 参数是 `input`，返回值转成 JSON（`undefined` 为 null）。视图渲染与视图动作都走这里。
pub fn call_script(
    package: &Path,
    script: &str,
    hook: Option<&str>,
    input: &Value,
    project: rpc::ProjectLookup,
) -> Result<Value, String> {
    let host = host_for(package, project)?;
    let path = package_script(package, script)?;
    let hook = hook.map(script::js_string).unwrap_or_else(|| "null".into());
    let bootstrap = format!(
        "import * as module from {};\n\
         const target = module.default;\n\
         const hook = {hook};\n\
         const run = hook === null ? target : target?.[hook];\n\
         if (typeof run !== \"function\") throw new Error(hook === null ? \"default export is not a function\" : `default export has no ${{hook}}()`);\n\
         const result = await run.call(target, JSON.parse(__berth_input));\n\
         globalThis.__berth_result = JSON.stringify(result ?? null);",
        script::js_string(&path.to_string_lossy())
    );
    script::run(host, &bootstrap, &[("__berth_input", input.to_string())])
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
        let path = package_script(package, script)?;
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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn package(files: &[(&str, &str)]) -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("tool.json"), r#"{"id":"demo"}"#).unwrap();
        for (name, source) in files {
            std::fs::write(dir.path().join(name), source).unwrap();
        }
        dir
    }

    fn call(dir: &Path, script: &str, hook: Option<&str>, input: Value) -> Result<Value, String> {
        call_script(dir, script, hook, &input, Box::new(|| Value::Null))
    }

    #[test]
    fn call_script_runs_a_hook_with_this_or_the_default_function() {
        let dir = package(&[
            (
                "view.js",
                r##"export default { prefix: "#", render(req) { return { type: "list", items: [{ id: this.prefix + req.filter }] } } }"##,
            ),
            (
                "action.js",
                "export default (input) => { if (input.n !== 2) throw new Error('bad') }",
            ),
        ]);
        assert_eq!(
            call(
                dir.path(),
                "view.js",
                Some("render"),
                json!({"filter": "a"})
            )
            .unwrap(),
            json!({"type": "list", "items": [{"id": "#a"}]})
        );
        assert_eq!(
            call(dir.path(), "action.js", None, json!({"n": 2})).unwrap(),
            Value::Null
        );
        assert!(call(dir.path(), "view.js", Some("missing"), json!({}))
            .unwrap_err()
            .contains("has no missing()"));
        assert!(call(dir.path(), "../x.js", None, json!({})).is_err());
    }

    #[test]
    fn http_needs_the_network_permission() {
        let dir = package(&[(
            "main.js",
            r#"export default () => berth.http.fetch("https://example.com").catch((error) => error.reason)"#,
        )]);
        assert_eq!(
            call(dir.path(), "main.js", None, json!(null)).unwrap(),
            json!("denied")
        );
    }
}
