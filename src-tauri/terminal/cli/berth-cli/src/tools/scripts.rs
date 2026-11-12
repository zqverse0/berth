//! `berth tools launch <launch.js> …`、`berth tools run|call <id> <脚本> …`：用内嵌引擎运行插件脚本
//! （berth-plugin-api，docs/plugin-architecture.md）。退出码就是脚本 / Agent 的退出码。

use std::path::Path;
use std::time::{Duration, Instant};

use berth_control_proto::ProjectScope;
use serde_json::{json, Value};

/// Agent 启动：GUI 与 `berth terminal create --agent` 在 pane 里执行的就是这条命令。
pub(crate) fn launch(script: &Path, args: &[String]) -> ! {
    let extras = berth_plugin_api::agent::LaunchExtras {
        brief,
        project: Box::new(current_project),
    };
    std::process::exit(berth_plugin_api::agent::launch(script, args, extras))
}

/// `berth.editor.render` 的窗口通道：经 control 交给已开着的 Berth 窗口（只读连接，不拉起 GUI）。
fn inject_desktop() {
    use berth_plugin_api::{ApiError, Reason};
    berth_plugin_api::set_desktop(Box::new(|params| {
        let params: berth_control_proto::EditorRenderParams = serde_json::from_value(params)
            .map_err(|error| ApiError::invalid(error.to_string()))?;
        let result = crate::gui_client::editor_render(&params).map_err(|error| {
            let reason = match error.kind {
                "gui_unavailable" | "incompatible_version" => Reason::Unsupported,
                "not_found" => Reason::NotFound,
                "invalid_params" => Reason::InvalidParams,
                "rejected" => Reason::Conflict,
                _ => Reason::Internal,
            };
            let message = if error.kind == "gui_unavailable" {
                format!("Berth is not running; open Berth and retry ({})", error.message)
            } else {
                error.message
            };
            ApiError::new(reason, message)
        })?;
        serde_json::to_value(result).map_err(|error| ApiError::new(Reason::Internal, error.to_string()))
    }));
}

/// `berth.knowledge` 的来源方法：交给 berth-project-core（GUI 的插件视图注入同一组）。
fn inject_knowledge() {
    use berth_project_core::knowledge;
    berth_plugin_api::set_knowledge(berth_plugin_api::KnowledgeHost {
        vault: knowledge::vault_project,
        find_source: knowledge::find_source,
        add_source: knowledge::add_source,
    });
}

/// 包内其他脚本（如 Agent 状态栏命令）。
pub(crate) fn run(tool: &str, script: &str, args: &[String]) -> ! {
    inject_desktop();
    inject_knowledge();
    if let Err(error) = berth_tool_core::plugins::ensure_enabled(tool) {
        eprintln!("berth tools run: {error}");
        std::process::exit(2);
    }
    let package = berth_tool_core::paths::tools_root().join(tool);
    std::process::exit(berth_plugin_api::run_script(
        &package,
        script,
        args,
        Box::new(current_project),
    ))
}

/// 调用包内脚本，返回值 JSON 打在 stdout 最后一行（脚本自己的 console.log 在它前面）。
pub(crate) fn call(tool: &str, script: &str, hook: Option<&str>, input: &str) -> ! {
    inject_desktop();
    inject_knowledge();
    let result = berth_tool_core::plugins::ensure_enabled(tool)
        .map_err(|error| error.to_string())
        .and_then(|_| {
            serde_json::from_str::<Value>(input).map_err(|error| format!("--input: {error}"))
        })
        .and_then(|input| {
            let package = berth_tool_core::paths::tools_root().join(tool);
            berth_plugin_api::call_script(
                &package,
                script,
                hook,
                &input,
                Box::new(current_project),
                Default::default(),
            )
        });
    match result {
        Ok(value) => {
            println!("{value}");
            std::process::exit(0)
        }
        Err(error) => {
            eprintln!("berth tools call: {error}");
            std::process::exit(2)
        }
    }
}

/// Berth 能力索引（`berth guide --brief`，与本 CLI 同一版本）；取不到或超过 5 秒就为空，不挡启动。
fn brief() -> String {
    let Ok(exe) = std::env::current_exe() else {
        return String::new();
    };
    let Ok(mut child) = std::process::Command::new(exe)
        .args(["guide", "--brief"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return String::new();
    };
    let started = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(status)) if status.success() => break,
            Ok(None) if started.elapsed() < Duration::from_secs(5) => {
                std::thread::sleep(Duration::from_millis(20))
            }
            _ => {
                let _ = child.kill();
                let _ = child.wait();
                return String::new();
            }
        }
    }
    let mut text = String::new();
    if let Some(mut stdout) = child.stdout.take() {
        let _ = std::io::Read::read_to_string(&mut stdout, &mut text);
    }
    text.trim().to_owned()
}

/// 当前目录所在的已注册项目（最深的那个）；不在项目里或库不可读为 null。
fn current_project() -> Value {
    let lookup = || -> Option<Value> {
        let cwd = std::env::current_dir().ok()?;
        let instance = crate::project::resolve_instance(false).ok()?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .ok()?;
        let catalog = runtime
            .block_on(crate::project::catalog_entries(
                &instance,
                ProjectScope::All,
            ))
            .ok()?;
        let entry = catalog
            .iter()
            .filter(|entry| cwd.starts_with(&entry.path))
            .max_by_key(|entry| entry.path.len())?;
        Some(json!({ "id": entry.id.to_string(), "name": entry.name, "root": entry.path }))
    };
    lookup().unwrap_or(Value::Null)
}
