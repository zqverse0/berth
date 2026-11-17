//! `berth group`：参数解析与输出；逻辑全在 `berth_group`（与 GUI 群组视图共用）。
//! 这里只提供调用方身份（CLI 自身路径）。

use std::ffi::OsString;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use berth_group::{Ctx, Hook, SpawnRequest};
use berth_project_core::tasks::TaskResult;
use clap::{Parser, Subcommand};
use serde_json::{json, Value};

/// 启动提示的群组段落（`berth guide --brief`）。
pub(crate) fn brief_lines(cwd: &Path) -> Option<String> {
    berth_group::brief_lines(cwd)
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
    /// 在群的 ACP 成员：Agent、目录、专家、会话 id、是否在答、是否交给了终端。
    Who { name: String },
    /// 以 ACP 方式入群（不占终端）：`--acp` 为插件 id，须声明 `agent.acp`；`--as` 为成员名。
    Join {
        name: String,
        #[arg(long = "as", default_value = "")]
        as_name: String,
        #[arg(long, value_name = "AGENT")]
        acp: String,
        /// 成员的专家。
        #[arg(long)]
        expert: Option<String>,
        /// 成员的工作目录（本项目的目录之一，缺省主目录）。
        #[arg(long)]
        cwd: Option<PathBuf>,
    },
    /// 应答 ACP 成员的审批请求：`<请求 seq> <选项 id>`，不给选项即取消。
    Approve {
        name: String,
        request: u64,
        option: Option<String>,
    },
    /// 管理 ACP 成员：`stop` 停下这一轮，`new` 下一条消息开新会话，`leave` 移出群（会话保留），
    /// `handoff` 把会话交给终端（输出里有会话 id，在终端里用它打开），`return` 交回群里。
    Member {
        name: String,
        member: String,
        #[arg(value_parser = ["stop", "new", "leave", "handoff", "return"])]
        action: String,
        /// `handoff`：打开会话的终端。
        #[arg(long)]
        terminal: Option<String>,
    },
    /// 派发 worker：以 ACP 成员在主目录或指定 worktree（`<群>` 写目录名）入群，任务作为第一条消息；消息都在项目群。
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
    /// 发消息；`--to` 是 ACP 成员时由后台进程发给它（忙时排队）。
    Post {
        name: String,
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
    /// 后台进程：ACP 成员的进程与送达、git 记录（由其他命令按需拉起）。
    #[command(hide = true)]
    Watch,
    /// Agent 的 hook 调用：`session-start` / `turn-start` / `turn-end` / `attention` / `idle`，stdin 为 hook JSON。
    /// 不输出、总是成功退出（hook 的输出会进 Agent 上下文，失败可能拦住 Agent）。
    #[command(hide = true)]
    Hook { event: String },
    /// 专家与它们在项目群里的成员数（`berth project . expert`）。
    #[command(hide = true)]
    Expert {
        #[command(subcommand)]
        command: ExpertCommand,
    },
}

#[derive(Debug, Subcommand)]
enum ExpertCommand {
    /// 全部专家：id、名字、在群里的成员数。
    Ls,
    /// 一个专家：它在群里的各个成员。
    Show { id: String },
}

fn execute(ctx: &Ctx, command: GroupCommand) -> TaskResult<Value> {
    match command {
        GroupCommand::Presets => berth_group::presets(ctx),
        GroupCommand::Read { name, after, to } => {
            berth_group::read(ctx, &name, after, to.as_deref())
        }
        GroupCommand::Who { name } => berth_group::who(ctx, &name),
        GroupCommand::Join { name, as_name, acp, expert, cwd } => {
            let inputs = expert.map(|expert| ("expert".to_owned(), json!(expert))).into_iter().collect();
            berth_group::join_acp(ctx, &name, &as_name, &acp, inputs, None, cwd)
        }
        GroupCommand::Approve { name, request, option } => berth_group::approve(ctx, &name, request, option),
        GroupCommand::Member { name, member, action, terminal } => {
            berth_group::control(ctx, &name, &member, &action, terminal)
        }
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
        } => berth_group::spawn(
                ctx,
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
            ),
        GroupCommand::Post {
            name,
            as_name,
            text,
            to,
            idempotency_key,
        } => berth_group::post(ctx, &name, &as_name, &text, to, None, idempotency_key),
        GroupCommand::Spec {
            name,
            as_name,
            note,
            task,
        } => berth_group::spec(ctx, &name, &as_name, &note, &task),
        GroupCommand::Change {
            name,
            as_name,
            to,
            text,
        } => berth_group::change(ctx, &name, &as_name, &to, &text),
        GroupCommand::Expert { command } => match command {
            ExpertCommand::Ls => berth_group::experts(ctx, None),
            ExpertCommand::Show { id } => berth_group::experts(ctx, Some(&id)),
        },
        GroupCommand::Watch => {
            berth_group::watch(ctx);
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
        hook(event, gui);
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

/// `berth group hook <事件>`：把状态写回 Agent 所在终端（`BERTH_AGENT_TTY`，launch.js 导出），
/// 再唤醒 GUI 立即重读（终端状态点）。与群组无关，留在这里是因为插件的 hook 配置已指向它。任何失败都静默。
fn hook(event: &str, gui: Option<&OsString>) {
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
    let _ = crate::gui_client::agent_changed(gui);
}
