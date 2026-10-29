//! `berth tools enable|disable|install|update|remove`：插件生命周期的 CLI
//! 适配，逻辑全在 `berth_tool_core::plugins`（GUI 设置页同实现）。

use clap::Args;
use serde_json::json;

use super::tool_error;
use crate::CliError;

#[derive(Debug, Args)]
pub(crate) struct TargetArgs {
    /// 插件 id（tools/ 下的目录名）。
    tool: String,
    /// 输出一个机器可读的 JSON 对象。
    #[arg(long)]
    json: bool,
}

fn report(operation: &str, json: bool, result: serde_json::Value, text: String) {
    if json {
        let mut envelope = json!({ "operation": operation, "status": "ok" });
        if let (Some(envelope), Some(result)) = (envelope.as_object_mut(), result.as_object()) {
            envelope.extend(result.clone());
        }
        println!("{envelope}");
    } else {
        println!("{text}");
    }
}

fn fail(
    operation: &str,
    json: bool,
) -> impl Fn(berth_tool_core::error::ToolCoreError) -> CliError + '_ {
    move |error| tool_error(operation, crate::EXIT_USER_ERROR, error.to_string(), json)
}

pub(crate) fn set_enabled(args: TargetArgs, enabled: bool) -> Result<(), CliError> {
    let operation = if enabled {
        "tools.enable"
    } else {
        "tools.disable"
    };
    berth_tool_core::plugins::set_enabled(&args.tool, enabled)
        .map_err(fail(operation, args.json))?;
    let state = if enabled { "enabled" } else { "disabled" };
    report(
        operation,
        args.json,
        json!({ "id": args.tool, "enabled": enabled }),
        format!("{} {state}", args.tool),
    );
    Ok(())
}

fn installed_json(installed: &berth_tool_core::plugins::Installed) -> serde_json::Value {
    json!({ "id": installed.id, "source": installed.source, "rev": installed.rev })
}

pub(crate) fn install(source: &str, json: bool) -> Result<(), CliError> {
    let installed =
        berth_tool_core::plugins::install(source).map_err(fail("tools.install", json))?;
    report(
        "tools.install",
        json,
        installed_json(&installed),
        format!(
            "installed {} from {} at {}",
            installed.id, installed.source, installed.rev
        ),
    );
    Ok(())
}

pub(crate) fn update(args: TargetArgs) -> Result<(), CliError> {
    let installed =
        berth_tool_core::plugins::update(&args.tool).map_err(fail("tools.update", args.json))?;
    report(
        "tools.update",
        args.json,
        installed_json(&installed),
        format!("updated {} to {}", installed.id, installed.rev),
    );
    Ok(())
}

pub(crate) fn remove(args: TargetArgs) -> Result<(), CliError> {
    berth_tool_core::plugins::remove(&args.tool).map_err(fail("tools.remove", args.json))?;
    report(
        "tools.remove",
        args.json,
        json!({ "id": args.tool }),
        format!("removed {}", args.tool),
    );
    Ok(())
}

/// `berth tools edit`：$EDITOR 编辑 tool.json，保存后重载并做包检查；有问题非零退出，
/// 如实报告「文件已保存」，不自动修正。
pub(crate) fn edit(tool: &str) -> Result<(), CliError> {
    let path = berth_tool_core::repository::tool_asset_file_path(tool)
        .map_err(|error| CliError::not_found(error.to_string()))?;
    if !path.is_file() {
        return Err(CliError::not_found(format!(
            "no registered tool.json at {}; create tools/{tool}/tool.json first (see docs/contribution-points.md)",
            path.display()
        )));
    }
    let editor = std::env::var_os("VISUAL")
        .or_else(|| std::env::var_os("EDITOR"))
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            CliError::user(
                "neither $VISUAL nor $EDITOR is set; refusing to open an editorless session",
            )
        })?;
    let status = std::process::Command::new(&editor)
        .arg(&path)
        .status()
        .map_err(|error| {
            CliError::user(format!(
                "failed to start editor {}: {error}",
                editor.to_string_lossy()
            ))
        })?;
    if !status.success() {
        return Err(CliError::user(format!(
            "editor exited with {status}; tool.json not validated as applied"
        )));
    }
    let asset = match berth_tool_core::repository::load_tool_asset(tool) {
        Err(error) => {
            return Err(CliError::rejected(format!(
                "editor saved but reload check failed on {}: {error}",
                path.display()
            )))
        }
        Ok(None) => {
            return Err(CliError::rejected(format!(
                "editor session ended but {} no longer exists",
                path.display()
            )))
        }
        Ok(Some(asset)) => asset,
    };
    let mut findings = asset.diagnostics();
    if let Some(dir) = path.parent() {
        findings.extend(berth_tool_core::package::check_package(dir, asset.raw()));
    }
    for finding in &findings {
        eprintln!("diagnostic [{}]: {}", finding.location, finding.message);
    }
    if findings.is_empty() {
        println!(
            "reloaded {} (protocol {})",
            path.display(),
            asset.protocol().unwrap_or("<missing>")
        );
        Ok(())
    } else {
        Err(CliError::rejected(format!(
            "editor saved {}; reload check reported {} diagnostic(s) (file left as saved, nothing rewritten)",
            path.display(),
            findings.len()
        )))
    }
}
