//! `berth group`：参数解析与输出；逻辑全在 `berth_group`（与 GUI 群组视图共用）。
//! 这里只提供 termd 实现（[`Termd`]）与调用方身份（当前终端、CLI 自身路径）。

mod termd;

use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use berth_group::{Ctx, Hook, SessionFiles, SpawnRequest, Terminals};
use berth_project_core::tasks::{TaskError, TaskResult};
use clap::{Parser, Subcommand};
use serde_json::{json, Value};

pub(crate) use termd::Termd;

/// 启动提示的群组段落（`berth guide --brief`）。
pub(crate) fn brief_lines(cwd: &Path, socket: Option<PathBuf>) -> Option<String> {
    berth_group::brief_lines(
        cwd,
        socket.filter(|_| std::env::var_os("BERTH").is_some()),
        cli_path(),
    )
}

/// 本 CLI 的可执行文件；拿不到时退回 PATH 上的 `berth`。
fn cli_path() -> PathBuf {
    berth_group::current_exe().unwrap_or_else(|| PathBuf::from("berth"))
}

#[derive(Debug, Parser)]
#[command(name = "berth group")]
pub(crate) struct GroupArgs {
    /// 失败时在 stderr 输出机器可读的 JSON 错误。
    #[arg(long, global = true)]
    json: bool,
    /// 在这个目录（项目或其 worktree）上执行；缺省为当前目录。
    #[arg(long, global = true, value_name = "PATH")]
    workspace: Option<PathBuf>,
    #[command(subcommand)]
    command: GroupCommand,
}

#[derive(Debug, Subcommand)]
enum GroupCommand {
    /// 项目启动预设（`.berth/presets.json`）摘要，配合 `spawn --preset`。
    #[command(hide = true)]
    Presets,
    /// 读 `--after` 之后的事件；`--to` 只看发给自己和发给所有人的。
    Read {
        name: String,
        #[arg(long, default_value_t = 0)]
        after: u64,
        #[arg(long)]
        to: Option<String>,
    },
    /// 在群成员、pane 状态、是否在收集与绑定的会话 id。
    Who { name: String },
    /// 入群并登记当前 pane（`--target-ref` 代他人登记）；Agent 一轮结束由 Berth 收集回复贴回群。
    Join {
        name: String,
        #[arg(long = "as", default_value = "")]
        as_name: String,
        #[arg(long)]
        target_ref: Option<String>,
        /// 不收集这个成员的回复（只收消息）。
        #[arg(long)]
        no_collect: bool,
    },
    /// 离群（清掉登记的 pane）。
    #[command(hide = true)]
    Leave {
        name: String,
        #[arg(long = "as", default_value = "")]
        as_name: String,
    },
    /// 派发 worker：在主目录或指定 worktree（`<群>` 写目录名）启动 Agent，任务仅作为上下文；消息都在项目群。
    Spawn {
        name: String,
        /// 派发者（缺省 lead）。
        #[arg(long = "as")]
        as_name: Option<String>,
        /// worker 的显示名（成员名是它的专家）。
        #[arg(long = "name", default_value = "")]
        worker: String,
        #[arg(long)]
        agent: Option<String>,
        /// worker 的专家（群成员都是专家）；预设或 `--input` 已选专家时可省。
        #[arg(long)]
        expert: Option<String>,
        #[arg(long)]
        preset: Option<String>,
        #[arg(long)]
        branch: Option<String>,
        #[arg(long)]
        task: Option<String>,
        /// 额外启动输入 `键=值`，可重复。
        #[arg(long)]
        input: Vec<String>,
        #[arg(long)]
        text: String,
    },
    /// 发消息；`--to` 指定成员时送达它的 pane（忙时排队）。
    Post {
        name: String,
        /// 在本群成员的终端里可省：作者取该终端对应的成员。
        #[arg(long = "as", default_value = "")]
        as_name: String,
        #[arg(long)]
        text: String,
        #[arg(long)]
        to: Option<String>,
        #[arg(long)]
        idempotency_key: Option<String>,
    },
    /// 任务契约升版并通知在岗成员。
    #[command(hide = true)]
    Spec {
        name: String,
        #[arg(long = "as", default_value = "")]
        as_name: String,
        #[arg(long)]
        note: String,
        /// 契约所属任务（slug 或任务目录名）。
        #[arg(long)]
        task: String,
    },
    /// 向主管申请变更契约。
    #[command(hide = true)]
    Change {
        name: String,
        #[arg(long = "as", default_value = "")]
        as_name: String,
        #[arg(long)]
        to: String,
        #[arg(long)]
        text: String,
    },
    /// 后台进程：成员派生、排队送达（由其他命令按需拉起）。
    #[command(hide = true)]
    Watch,
    /// Agent 的 hook 调用：`session-start` / `turn-start` / `turn-end` / `attention` / `idle`，stdin 为 hook JSON。
    /// 不输出、总是成功退出（hook 的输出会进 Agent 上下文，失败可能拦住 Agent）。
    #[command(hide = true)]
    Hook { event: String },
    /// 专家与它们在项目群里的终端（`berth project . expert`）。
    #[command(hide = true)]
    Expert {
        #[command(subcommand)]
        command: ExpertCommand,
    },
}

#[derive(Debug, Subcommand)]
enum ExpertCommand {
    /// 全部专家：id、名字、在群里的终端数、规矩文件。
    Ls,
    /// 一个专家：它的各个终端（编号、Agent、目录、状态）和规矩。
    Show { id: String },
}

fn execute(ctx: &Ctx, command: GroupCommand) -> TaskResult<Value> {
    let term = ctx
        .socket
        .as_deref()
        .and_then(|socket| Termd::new(socket, ctx.gui.clone()));
    let term = term.as_ref().map(|term| term as &dyn Terminals);
    match command {
        GroupCommand::Presets => berth_group::presets(ctx),
        GroupCommand::Read { name, after, to } => {
            berth_group::read(ctx, &name, after, to.as_deref())
        }
        GroupCommand::Who { name } => berth_group::who(ctx, term, &name),
        GroupCommand::Join {
            name,
            as_name,
            target_ref,
            no_collect,
        } => berth_group::join(ctx, term, &name, &as_name, target_ref, no_collect),
        GroupCommand::Leave { name, as_name } => berth_group::leave(ctx, &name, &as_name),
        GroupCommand::Spawn {
            name,
            as_name,
            worker,
            agent,
            expert,
            preset,
            branch,
            task,
            input,
            text,
        } => {
            let term = term.ok_or_else(|| {
                // 只在 Berth 终端里派发，确保连的是本项目所在的 termd。
                TaskError::new(
                    "outside_berth_terminal",
                    "spawn must run inside a Berth terminal",
                )
            })?;
            berth_group::spawn(
                ctx,
                term,
                SpawnRequest {
                    group: name,
                    lead: as_name.unwrap_or_default(),
                    worker,
                    agent,
                    expert,
                    preset,
                    branch,
                    task,
                    inputs: input,
                    text,
                },
            )
        }
        GroupCommand::Post {
            name,
            as_name,
            text,
            to,
            idempotency_key,
        } => berth_group::post(ctx, term, &name, &as_name, &text, to, None, idempotency_key),
        GroupCommand::Spec {
            name,
            as_name,
            note,
            task,
        } => berth_group::spec(ctx, term, &name, &as_name, &note, &task),
        GroupCommand::Change {
            name,
            as_name,
            to,
            text,
        } => berth_group::change(ctx, term, &name, &as_name, &to, &text),
        GroupCommand::Expert { command } => match command {
            ExpertCommand::Ls => berth_group::experts(ctx, term, None),
            ExpertCommand::Show { id } => berth_group::experts(ctx, term, Some(&id)),
        },
        GroupCommand::Watch => {
            let term = term.ok_or_else(|| {
                TaskError::new("outside_berth_terminal", "watch needs the terminal daemon")
            })?;
            berth_group::watch(ctx, term);
            Ok(json!({"stopped": true}))
        }
        GroupCommand::Hook { .. } => unreachable!("hook runs before execute"),
    }
}

/// berth group 子命令入口：返回进程退出码（0 成功、2 工作流错误、1 I/O 错误）。
pub(crate) fn run(args: &[OsString], socket: Option<PathBuf>, gui: Option<&OsString>) -> i32 {
    let mut argv = vec![OsString::from("berth group")];
    argv.extend(args.iter().cloned());
    let parsed = match GroupArgs::try_parse_from(argv) {
        Ok(parsed) => parsed,
        Err(error) => error.exit(),
    };
    let workspace = parsed
        .workspace
        .clone()
        .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")));
    if let GroupCommand::Hook { event } = &parsed.command {
        hook(event, &workspace, socket, gui);
        return 0;
    }
    let result = Ctx::new(
        &workspace,
        socket,
        gui.cloned(),
        cli_path(),
        std::env::var("BERTH_TARGET_REF").ok(),
    )
    .and_then(|ctx| execute(&ctx, parsed.command));
    match result {
        Ok(value) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string())
            );
            0
        }
        Err(error) => {
            if parsed.json {
                eprintln!(
                    "{}",
                    json!({"ok": false, "error": {"code": error.code, "message": error.message}})
                );
            } else {
                eprintln!("berth: {}", error.message);
            }
            if error.code == "io_error" {
                1
            } else {
                2
            }
        }
    }
}

/// hook JSON 的上限：最终回答可能很长，但不该无界读。
const HOOK_INPUT_MAX: u64 = 4 << 20;

/// `berth group hook <事件>`：先把状态写回 Agent 所在终端（`BERTH_AGENT_TTY`，launch.js 导出），
/// 再处理群组部分，最后唤醒 GUI 立即重读。不在 Berth 项目里也照写状态（GUI 状态点不依赖群组）。任何失败都静默。
fn hook(event: &str, workspace: &Path, socket: Option<PathBuf>, gui: Option<&OsString>) {
    let Some(event) = Hook::parse(event) else {
        return;
    };
    let mut raw = String::new();
    let _ = std::io::stdin().take(HOOK_INPUT_MAX).read_to_string(&mut raw);
    let payload: Value = serde_json::from_str(&raw).unwrap_or_else(|_| json!({}));
    if let (Some(signal), Some(tty)) = (
        berth_group::hook_signal(event, &payload),
        std::env::var_os("BERTH_AGENT_TTY").filter(|tty| !tty.is_empty()),
    ) {
        if let Ok(mut tty) = std::fs::OpenOptions::new().write(true).open(tty) {
            let _ = tty.write_all(signal.as_bytes());
        }
    }
    let caller = std::env::var("BERTH_TARGET_REF").ok().filter(|caller| !caller.is_empty());
    if let Ok(ctx) = Ctx::new(workspace, socket, gui.cloned(), cli_path(), caller) {
        let term = ctx
            .socket
            .as_deref()
            .and_then(|socket| Termd::new(socket, ctx.gui.clone()));
        let term = term.as_ref().map(|term| term as &dyn Terminals);
        berth_group::hook(&ctx, term, &SessionFiles, event, &payload);
    }
    let _ = crate::gui_client::agent_changed(gui);
}
