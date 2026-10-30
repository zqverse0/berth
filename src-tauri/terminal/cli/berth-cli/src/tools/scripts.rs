//! `berth tools launch <launch.js> …`、`berth tools run|call <id> <脚本> …`：用内嵌引擎运行插件脚本
//! （berth-plugin-api，docs/plugin-architecture.md）。退出码就是脚本 / Agent 的退出码。

use std::path::Path;
use std::time::{Duration, Instant};

use berth_control_proto::ProjectScope;
use serde_json::{json, Value};

/// Agent 启动：GUI 与 `berth terminal create --agent` 在 pane 里执行的就是这条命令。
pub(crate) fn launch(script: &Path, args: &[String]) -> ! {
    let extras = berth_plugin_api::agent::LaunchExtras {
        brief: brief(),
        project: Box::new(current_project),
    };
    std::process::exit(berth_plugin_api::agent::launch(script, args, extras))
}

/// 包内其他脚本（如 Agent 状态栏命令）。
pub(crate) fn run(tool: &str, script: &str, args: &[String]) -> ! {
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
    let result = berth_tool_core::plugins::ensure_enabled(tool)
        .map_err(|error| error.to_string())
        .and_then(|_| {
            serde_json::from_str::<Value>(input).map_err(|error| format!("--input: {error}"))
        })
        .and_then(|input| {
            let package = berth_tool_core::paths::tools_root().join(tool);
            berth_plugin_api::call_script(&package, script, hook, &input, Box::new(current_project))
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
