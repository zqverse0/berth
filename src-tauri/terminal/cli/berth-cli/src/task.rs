//! `berth task`：原生实现，核心在 `berth_project_core::tasks`（GUI 任务视图共用）。
//! 输出与旧脚本一致：成功打印 JSON；失败时 `--json` 在 stderr 打印 `{"ok": false, "error": {code, message}}`。

use std::path::{Path, PathBuf};

use berth_project_core::tasks::{self, CreateOptions, FinishOptions, TaskError};
use clap::{Args, Subcommand};
use serde::Serialize;
use serde_json::{json, Value};

#[derive(Debug, Args)]
pub(crate) struct TaskArgs {
    /// 失败时在 stderr 输出机器可读的 JSON 错误。
    #[arg(long, global = true)]
    json: bool,
    /// 在这个目录上执行；Berth session 内固定使用所属项目，不能用此参数切换归属。
    #[arg(long, global = true, value_name = "PATH")]
    workspace: Option<PathBuf>,
    #[command(subcommand)]
    command: TaskCommand,
}

#[derive(Debug, Subcommand)]
enum TaskCommand {
    /// 新建任务文件 `.berth/tasks/<MM-DD-slug>.md`（frontmatter 步骤 + 目标 / 不做 / 验收 / 记录），归入当前所在的群。
    Create {
        title: String,
        #[arg(long)]
        slug: Option<String>,
        /// 任务正文（Markdown，按同一骨架写，不含步骤）；缺省生成待补充的骨架。
        #[arg(long, default_value = "")]
        description: String,
        /// 来源想法 id（`berth knowledge idea ls` 里的）。
        #[arg(long)]
        idea: Option<String>,
    },
    /// 任务摘要列表（任务页列表）；在 worktree 里只列分到它的群的任务。
    List {
        /// 包含已归档的任务。
        #[arg(long)]
        archived: bool,
        #[arg(long, default_value_t = 200)]
        limit: usize,
    },
    /// 全部活跃任务的派生视图（任务页显示的内容）。
    #[command(hide = true)]
    Views,
    /// 单个任务的派生视图；不给任务时按当前分支找。也是重开会话的接续包。
    Show {
        reference: Option<String>,
    },
    /// 开工：检查步骤都填全后标为进行中（与 GUI 一致），返回任务文件与第一步；不建分支或目录。
    Start {
        reference: String,
    },
    /// 完成一步：先提交（正文末尾写 `Task: <任务> S<n>`），再执行它；记下提交，返回下一步、步骤一览与记录末几行。
    Step {
        reference: String,
        /// 步骤编号，如 S1。
        step: String,
    },
    /// 把任务分配给群组（`main` 或已有群组；群组 = worktree，可含多个任务）。
    Assign {
        reference: String,
        #[arg(long)]
        group: String,
    },
    /// 完成并归档任务（GUI「完成并归档」）；不给任务时按当前分支找。`--group` 时以群名为目标，清理已结束且代码已合并的群环境。
    Finish {
        reference: Option<String>,
        /// reference 是群名，检查全群任务与代码后清理环境。
        #[arg(long, requires = "reference")]
        group: bool,
        /// 只检查并列出将执行的动作，不改任何东西。
        #[arg(long)]
        dry_run: bool,
        /// 放弃（GUI「取消任务」）：未完成也归档，任务标「已放弃」。
        #[arg(long)]
        abandon: bool,
        /// 放弃原因，仅配合 --abandon。
        #[arg(long, requires = "abandon")]
        reason: Option<String>,
        /// 清理群环境时保留分支，只删 worktree；仅配合 --group。
        #[arg(long, requires = "group")]
        keep_branch: bool,
    },
    /// 交定时运行的结果：写 `.berth/runs/<任务>/<时间>.md`。定时运行的终端里不用给任务（按 `BERTH_TASK_RUN`）。
    Result {
        reference: Option<String>,
        /// 结果正文（Markdown）。
        #[arg(long, conflicts_with = "file", required_unless_present = "file")]
        text: Option<String>,
        /// 从文件读结果正文。
        #[arg(long)]
        file: Option<PathBuf>,
    },
    /// 重开归档任务，恢复为进行中并保留原群。
    Reopen {
        reference: String,
    },
    /// 把旧 task.json 里的状态导入本机 `local/tasks.json`（不改写 task.json）。幂等。
    #[command(hide = true)]
    Migrate,
}

fn encode<T: Serialize>(value: T) -> Result<Value, TaskError> {
    serde_json::to_value(value).map_err(|error| TaskError {
        code: "io_error",
        message: error.to_string(),
    })
}

fn execute(args: &TaskArgs, workspace: &Path) -> Result<Value, TaskError> {
    match &args.command {
        TaskCommand::Create {
            title,
            slug,
            description,
            idea,
        } => tasks::create(
            workspace,
            CreateOptions {
                title: title.clone(),
                slug: slug.clone(),
                description: description.clone(),
                branch: None,
                base: None,
                idea: idea.clone(),
            },
        ),
        TaskCommand::List { archived, limit } => tasks::list(workspace, *archived, *limit),
        TaskCommand::Views => encode(json!({ "tasks": tasks::views(workspace)? })),
        TaskCommand::Show { reference } => encode(tasks::show(workspace, reference.as_deref())?),
        TaskCommand::Start { reference } => tasks::begin(workspace, reference),
        TaskCommand::Step { reference, step } => tasks::step(workspace, reference, step),
        TaskCommand::Assign { reference, group } => tasks::assign(workspace, reference, group),
        TaskCommand::Finish {
            reference,
            group,
            dry_run,
            abandon,
            reason,
            keep_branch,
        } => {
            let options = FinishOptions {
                dry_run: *dry_run,
                abandon: *abandon,
                keep_branch: *keep_branch,
            };
            let reference = match reference {
                Some(reference) => reference.clone(),
                None => tasks::show(workspace, None)?.task_dir_name,
            };
            if *group {
                tasks::finish_group(workspace, &reference, options)
            } else if *abandon && !*dry_run {
                tasks::archive(workspace, &reference, Some(reason.as_deref().unwrap_or("")))
            } else {
                tasks::finish(workspace, &reference, options)
            }
        }
        TaskCommand::Result {
            reference,
            text,
            file,
        } => {
            let text = match (text, file) {
                (Some(text), _) => text.clone(),
                (None, Some(file)) => std::fs::read_to_string(file)?,
                (None, None) => String::new(),
            };
            let run = std::env::var(tasks::TASK_RUN_ENV).unwrap_or_default();
            let (task, stamp) = match tasks::parse_task_run(&run) {
                Some((task, stamp)) => (task.to_owned(), stamp.to_owned()),
                None => (
                    reference.clone().ok_or_else(|| {
                        TaskError::new(
                            "invalid_input",
                            "Task reference is required outside a scheduled run",
                        )
                    })?,
                    tasks::run_stamp_now(),
                ),
            };
            tasks::write_run_result(workspace, &task, &stamp, &text)
        }
        TaskCommand::Reopen { reference } => tasks::reopen(workspace, reference),
        TaskCommand::Migrate => tasks::migrate(workspace),
    }
}

/// 返回进程退出码：0 成功、2 工作流错误、1 I/O 错误（与旧脚本一致）。
pub(crate) fn run(args: &TaskArgs) -> i32 {
    let workspace = if let Ok(reference) = std::env::var("BERTH_TARGET_REF") {
        tokio::runtime::Builder::new_current_thread().enable_all().build()
            .map_err(|error| TaskError::new("io_error", error.to_string()))
            .and_then(|runtime| runtime.block_on(crate::workspace_terminal::session_project_path(&reference))
                .map_err(|error| TaskError::new("unresolved_session", error.message)))
            .and_then(|owner| {
                if let Some(path) = &args.workspace {
                    if path.canonicalize().ok() != owner.canonicalize().ok() {
                        return Err(TaskError::new("session_scope_mismatch", "Current session is fixed to its worktree; --workspace cannot switch it"));
                    }
                }
                Ok(owner)
            })
    } else {
        Ok(args
            .workspace
            .clone()
            .unwrap_or_else(|| std::env::current_dir().unwrap_or_else(|_| PathBuf::from("."))))
    };
    match workspace.and_then(|workspace| execute(args, &workspace)) {
        Ok(value) => {
            println!(
                "{}",
                serde_json::to_string_pretty(&value).unwrap_or_else(|_| value.to_string())
            );
            0
        }
        Err(error) => {
            if args.json {
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
