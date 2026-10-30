//! `berth tools` — 插件（`$BERTH_HOME/tools/<id>/`）的 CLI 入口：查看、检查、编辑、
//! 启用 / 停用、安装。只读文件即完成，不要求 daemon/GUI。资产解析共用 `berth-tool-core`。
//! Agent 启动走 `berth terminal create --agent`；pane 里执行的是隐藏的 `tools launch`，
//! 包内脚本经 `tools run` 运行（`scripts.rs`，内嵌引擎）。

use clap::Subcommand;

use crate::CliError;

mod describe;
pub(crate) mod inputs;
mod lifecycle;
mod scripts;

#[derive(Debug, Subcommand)]
pub(crate) enum ToolsCommand {
    /// 列出 $BERTH_HOME/tools 下已注册的工具。
    List {
        /// 输出一个机器可读的 JSON 对象。
        #[arg(long)]
        json: bool,
    },
    /// 查看一个插件：接入了哪些位置、诊断与包内说明（usage.md）。
    Show {
        /// 工具 id（tools/ 下的目录名）。
        tool: String,
        /// 输出一个机器可读的 JSON 对象。
        #[arg(long)]
        json: bool,
    },
    /// 检查插件包边界：未声明的文件、缺失的 package 资源、tools 根的散文件。只读。
    #[command(hide = true)]
    Check {
        /// 可选的工具 id；省略时检查 tools 根与全部工具。
        tool: Option<String>,
        /// 输出一个机器可读的 JSON 对象。
        #[arg(long)]
        json: bool,
    },
    /// 启用一个插件（写 $BERTH_HOME/plugins.json）。
    Enable(lifecycle::TargetArgs),
    /// 停用一个插件：从启动栏、会话读取、用量轮询中移除，且不能再启动。
    Disable(lifecycle::TargetArgs),
    /// 从 git 仓库（URL 或本地仓库路径）安装插件；校验失败不留残留。
    Install {
        /// git 来源；仓库里有多个插件时加 `#<子目录>`，如 `<berth 仓库>#plugins/claude`；
        /// 只写插件 id（如 `claude`）则从官方插件仓库 zqverse0/berth-plugins 安装。
        source: String,
        /// 输出一个机器可读的 JSON 对象。
        #[arg(long)]
        json: bool,
    },
    /// 按安装时记录的 git 来源更新插件；新版本无效时保留旧版本。
    Update(lifecycle::TargetArgs),
    /// 删除插件目录与它在 plugins.json 中的记录。
    Remove(lifecycle::TargetArgs),
    /// 运行 Agent 插件的启动脚本（launch.js）。由 Berth 在终端里调用，参数同启动栏。
    #[command(hide = true)]
    Launch {
        /// `<tools>/<id>/launch.js`。
        script: std::path::PathBuf,
        /// `--berth-launch-inputs <json>`、`--berth-provider <文件>` 与透传给 Agent 的参数。
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// 运行插件包内的脚本（默认导出函数收到余下的参数；返回数字即退出码）。
    Run {
        /// 工具 id。
        tool: String,
        /// 包内脚本的相对路径，如 `private/statusline.js`。
        script: String,
        #[arg(trailing_var_arg = true, allow_hyphen_values = true)]
        args: Vec<String>,
    },
    /// 调用包内脚本的默认导出（`--hook` 时调它的同名方法，如视图的 render），把返回值 JSON 打在最后一行。
    /// 调试视图：`berth tools call gh views/discover.js --hook render --input '{"view":"discover","params":{},"filter":null}'`。
    Call {
        /// 工具 id。
        tool: String,
        /// 包内脚本的相对路径。
        script: String,
        /// 默认导出对象上的方法名；省略时默认导出本身是函数。
        #[arg(long)]
        hook: Option<String>,
        /// 传给函数的参数（JSON），默认 null。
        #[arg(long, default_value = "null")]
        input: String,
    },
    /// 用 $EDITOR 编辑已注册的 tool.json，然后报告重载检查结果。
    #[command(hide = true)]
    Edit {
        /// 工具 id（tools/ 下的目录名）。
        tool: String,
    },
}

pub(crate) use describe::brief;

pub(crate) fn run(command: ToolsCommand) -> Result<(), CliError> {
    match command {
        ToolsCommand::List { json } => describe::list(json),
        ToolsCommand::Show { tool, json } => describe::show(&tool, json),
        ToolsCommand::Check { tool, json } => describe::check(tool.as_deref(), json),
        ToolsCommand::Edit { tool } => lifecycle::edit(&tool),
        ToolsCommand::Enable(args) => lifecycle::set_enabled(args, true),
        ToolsCommand::Disable(args) => lifecycle::set_enabled(args, false),
        ToolsCommand::Install { source, json } => lifecycle::install(&source, json),
        ToolsCommand::Update(args) => lifecycle::update(args),
        ToolsCommand::Remove(args) => lifecycle::remove(args),
        ToolsCommand::Launch { script, args } => scripts::launch(&script, &args),
        ToolsCommand::Run { tool, script, args } => scripts::run(&tool, &script, &args),
        ToolsCommand::Call {
            tool,
            script,
            hook,
            input,
        } => scripts::call(&tool, &script, hook.as_deref(), &input),
    }
}

// ─── 共用小工具 ───────────────────────────────────────────────────────

/// 加载资产；缺失/损坏统一为「target not found」退出码，消息带真实
/// 路径；`--json` 时同码信封（V2 硬化②）。
pub(crate) fn load_asset(
    id: &str,
    operation: &str,
    json: bool,
) -> Result<berth_tool_core::asset::ToolAsset, CliError> {
    let path_hint = berth_tool_core::repository::tool_asset_file_path(id)
        .map(|path| path.display().to_string())
        .unwrap_or_else(|_| format!("tools/{id}/tool.json"));
    berth_tool_core::repository::load_tool_asset(id)
        .map_err(|error| {
            tool_error(
                operation,
                crate::EXIT_TARGET_NOT_FOUND,
                format!("{error} ({path_hint})"),
                json,
            )
        })?
        .ok_or_else(|| {
            tool_error(
                operation,
                crate::EXIT_TARGET_NOT_FOUND,
                format!("no tool.json registered for '{id}' at {path_hint}"),
                json,
            )
        })
}

/// 选择多语言对象中的展示文本（CLI 面向英文，回落 zh-CN 与任意语言）。
pub(crate) fn localized(value: Option<&serde_json::Value>) -> Option<String> {
    match value? {
        serde_json::Value::String(text) => Some(text.clone()),
        serde_json::Value::Object(map) => ["en", "zh-CN"]
            .iter()
            .find_map(|lang| map.get(*lang).and_then(serde_json::Value::as_str))
            .or_else(|| map.values().find_map(serde_json::Value::as_str))
            .map(str::to_string),
        other => Some(other.to_string()),
    }
}

/// --json 错误信封（R4：机器模式有稳定结果、诊断与退出码）。
pub(crate) fn error_json(operation: &str, code: u8, message: &str) -> String {
    serde_json::json!({
        "operation": operation,
        "status": "error",
        "error": { "code": code, "message": message },
    })
    .to_string()
}

/// V2 硬化②：tools 面统一错误构造——带 `--json` 时任何前置错误都
/// 同时产出**单一** stdout JSON 信封（信封码=进程退出码），Agent 可
/// 只解析 stdout；无 `--json` 保持人读 stderr 路径不变。
pub(crate) fn tool_error(
    operation: &str,
    exit_code: u8,
    message: impl Into<String>,
    json: bool,
) -> CliError {
    let message = message.into();
    CliError {
        exit_code,
        json_message: json.then(|| error_json(operation, exit_code, &message)),
        message,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn localized_prefers_en_then_zh_then_any() {
        assert_eq!(
            localized(Some(&json!({ "en": "Launch", "zh-CN": "启动" }))).as_deref(),
            Some("Launch")
        );
        assert_eq!(
            localized(Some(&json!({ "zh-CN": "启动" }))).as_deref(),
            Some("启动")
        );
        assert_eq!(localized(Some(&json!("plain"))).as_deref(), Some("plain"));
        assert!(localized(None).is_none());
    }

    #[test]
    fn error_json_is_a_single_machine_object() {
        let parsed: serde_json::Value =
            serde_json::from_str(&error_json("tools.run", 2, "bad input")).unwrap();
        assert_eq!(parsed["status"], "error");
        assert_eq!(parsed["error"]["code"], 2);
    }
}
