//! 项目群组：消息收发、送达成员 pane、派发 worker、后台收集与送达（`berth group` 与 GUI 群组视图共用）。
//!
//! 账本在 `berth_project_core::tasks::group`（主项目 `.berth/local/groups/`）。一个项目一个群（`main`）：
//! 主目录和各 worktree 的成员、消息都在这个群里，worktree 只是成员终端的工作目录。
//! 终端与会话经 [`Terminals`] / [`Sessions`] 注入：CLI 连 termd，桌面宿主用自己的终端管理。
//! Agent 的状态、会话与一轮结束都来自它自己的 hook（[`hook`]，`berth group hook`）。
//! 成员不在一轮里时当场送达；一轮中排队的消息与成员派生由每个主项目一个的后台进程
//! `berth group watch` 负责（[`watch`]），hook 一轮结束时叫醒它。

pub mod builtin;
mod deliver;
mod hook;
mod identity;
mod spawn;
mod term;
mod watch;

#[cfg(test)]
mod tests;

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use berth_project_core::tasks::{self, group, TaskError, TaskResult};
use serde_json::{json, Value};

pub use hook::{signal as hook_signal, Hook};
pub use spawn::SpawnRequest;
pub use term::{
    agent_of, state_name, CreateAgent, Fail, Input, PaneProbe, SessionFiles, Sessions, Terminals,
};
pub use watch::brief_lines;

/// 一次调用的上下文。
pub struct Ctx {
    /// 主项目（`berth project init` 标记的 checkout）：群与运行态都在这里。
    pub main: PathBuf,
    /// termd 端点；只在显式指定或在 Berth 终端里（`BERTH` 已设）才可信，否则为 `None`，送达交给后台进程。
    pub socket: Option<PathBuf>,
    pub gui: Option<OsString>,
    /// berth CLI 可执行文件：拉起后台进程、写给 Agent 粘贴的命令都用它。
    pub cli: PathBuf,
    /// 调用方所在终端（`BERTH_TARGET_REF`）；GUI 等不在终端里的调用方为 `None`。
    pub caller: Option<String>,
}

impl Ctx {
    pub fn new(
        workspace: &Path,
        socket: Option<PathBuf>,
        gui: Option<OsString>,
        cli: PathBuf,
        caller: Option<String>,
    ) -> TaskResult<Self> {
        let main = tasks::resolve(workspace)?.main;
        group::prepare(&main)?;
        Ok(Self {
            main,
            socket,
            gui,
            cli,
            caller,
        })
    }
}

/// 本进程的可执行文件（CLI 用来填 [`Ctx::cli`]）。升级时文件被替换，Linux 上 `current_exe` 会带
/// ` (deleted)` 后缀，去掉后就是新文件。
pub fn current_exe() -> Option<PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let text = exe.to_string_lossy();
    Some(match text.strip_suffix(" (deleted)") {
        Some(path) => PathBuf::from(path),
        None => exe,
    })
}

pub(crate) fn text<'a>(event: &'a Value, key: &str) -> Option<&'a str> {
    event
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

fn required(value: &str, flag: &str) -> TaskResult<String> {
    let value = value.trim();
    if value.is_empty() {
        return Err(TaskError::new(
            "invalid_input",
            format!("{flag} is required"),
        ));
    }
    Ok(value.to_owned())
}

fn existing(ctx: &Ctx, name: &str) -> TaskResult<(String, Value, Vec<Value>)> {
    let name = group::validate_name(name)?;
    // 内部键照读那个账本（旧版 worktree 群只读保留）；目录名都指向项目群。
    let name = if group::info(&ctx.main, &name)?.is_some() && group::has_ledger(&ctx.main, &name) {
        name
    } else {
        group::project_group(&ctx.main, &name)?;
        group::MAIN_GROUP.to_owned()
    };
    let info = group::info(&ctx.main, &name)?
        .ok_or_else(|| TaskError::new("not_found", format!("Channel not found: {name}")))?;
    let events = group::events(&ctx.main, &name)?;
    Ok((name, info, events))
}

/// 写操作都进项目群（一个项目一个群）：`name` 写主目录或任何 worktree 的群名都行；旧群只读。
fn project_existing(ctx: &Ctx, name: &str) -> TaskResult<(String, Value, Vec<Value>)> {
    group::project_group(&ctx.main, name)?;
    existing(ctx, group::MAIN_GROUP)
}

/// 本项目的目录（主目录与各 worktree）。
fn project_dirs(main: &Path) -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = group::envs(main)
        .unwrap_or_default()
        .into_iter()
        .map(|(_, env)| PathBuf::from(env.worktree))
        .collect();
    dirs.push(main.to_path_buf());
    dirs
}

/// `path` 是本项目的目录之一。
pub(crate) fn in_project(main: &Path, path: &Path) -> bool {
    let path = path.canonicalize().ok();
    path.is_some() && project_dirs(main).iter().any(|dir| dir.canonicalize().ok() == path)
}

/// 项目启动预设（`.berth/presets.json`）摘要，配合 `spawn --preset`。
pub fn presets(ctx: &Ctx) -> TaskResult<Value> {
    spawn::list_presets(&ctx.main)
}

/// `after` 之后的事件；`to` 只看发给它和发给所有人的。
pub fn read(ctx: &Ctx, name: &str, after: u64, to: Option<&str>) -> TaskResult<Value> {
    let (_, _, events) = existing(ctx, name)?;
    Ok(group::read(&events, after, to))
}

/// 群成员、pane 状态、hook 是否在工作与绑定的会话 id。
pub fn who(ctx: &Ctx, term: Option<&dyn Terminals>, name: &str) -> TaskResult<Value> {
    let (name, _, events) = project_existing(ctx, name)?;
    Ok(who_rows(ctx, term, &name, &events))
}

/// 入群并登记 pane（`target_ref` 缺省为调用方终端）；Agent 一轮结束由它的 hook 把回复贴回群。
pub fn join(
    ctx: &Ctx,
    term: Option<&dyn Terminals>,
    name: &str,
    as_name: &str,
    target_ref: Option<String>,
    no_collect: bool,
) -> TaskResult<Value> {
    let (name, _, _) = project_existing(ctx, name)?;
    // 在终端里入群：成员名是终端的专家，`--as` 只作显示名；不在终端里才用 `--as` 起名（只能 read）。
    let label = as_name.trim().to_owned();
    let mut event = json!({"kind": "joined"});
    // 登记 pane（缺省为当前 pane），`post --to` 据此送达；最近一次 join 为准。
    let own = ctx.caller.clone().filter(|_| target_ref.is_none());
    let author = if let Some(pane) = target_ref.or(own) {
        event["target_ref"] = json!(pane);
        let probe = term
            .and_then(|term| term.probe(&pane).ok())
            .ok_or_else(|| {
                TaskError::new("invalid_input", "Cannot verify pane project ownership")
            })?;
        if probe.session_project_path.as_deref().is_none_or(|owner| !in_project(&ctx.main, Path::new(owner))) {
            return Err(TaskError::new(
                "invalid_input",
                "Pane belongs to another project session",
            ));
        }
        let agent = term::agent_of(&probe).ok_or_else(|| {
            TaskError::new(
                "invalid_input",
                "Only an Agent pane can join as a group member",
            )
        })?;
        event["agent"] = json!(agent);
        event["cwd"] = json!(probe.session_project_path);
        event["collect"] = json!(!no_collect);
        identity::member_name(&probe).ok_or_else(|| {
            TaskError::new(
                "invalid_input",
                "Only an Agent launched with an expert joins the group (members are experts)",
            )
        })?
    } else {
        let author = required(&label, "--as")?;
        if author == group::USER {
            return Err(TaskError::new(
                "invalid_input",
                format!("{} is reserved for the user", group::USER),
            ));
        }
        author
    };
    event["author"] = json!(author);
    let written = group::append(&ctx.main, &name, event)?;
    if !label.is_empty() && label != author {
        identity::set_label(&ctx.main, &name, &author, &label);
    }
    if written.get("collect") == Some(&json!(true)) {
        watch::ensure_running(ctx);
    }
    Ok(written)
}

/// 离群：在成员的终端里只走这个终端（专家的其他终端还在群），否则整个成员离群。
pub fn leave(ctx: &Ctx, name: &str, as_name: &str) -> TaskResult<Value> {
    let (name, _, events) = project_existing(ctx, name)?;
    let author = identity::author(&events, ctx.caller.as_deref(), as_name)?;
    let body = ctx
        .caller
        .as_deref()
        .filter(|caller| identity::pane_member(&events, Some(caller)).as_deref() == Some(author.as_str()));
    group::append(
        &ctx.main,
        &name,
        json!({"kind": "left", "author": author, "target_ref": body}),
    )
}

/// 派发 worker：在目标项目群目录启动 Agent，任务仅作为上下文。
pub fn spawn(ctx: &Ctx, term: &dyn Terminals, request: SpawnRequest) -> TaskResult<Value> {
    spawn::spawn(ctx, term, request)
}

/// 向主管申请变更契约。
pub fn change(
    ctx: &Ctx,
    term: Option<&dyn Terminals>,
    name: &str,
    as_name: &str,
    to: &str,
    text: &str,
) -> TaskResult<Value> {
    let (name, _, events) = project_existing(ctx, name)?;
    let author = identity::author(&events, ctx.caller.as_deref(), as_name)?;
    let to = required(to, "--to")?;
    let text = format!(
        "[变更申请 · 基于 rev {}] {}",
        group::spec_rev(&events),
        required(text, "--text")?
    );
    let mut written = group::append(
        &ctx.main,
        &name,
        json!({"kind": "message", "author": author, "to": to, "text": text, "intent": "change"}),
    )?;
    written["doorbell"] = deliver::doorbell(ctx, term, &name, &to);
    Ok(written)
}

/// 后台进程主循环：成员派生、排队送达。
pub fn watch(ctx: &Ctx, term: &dyn Terminals) {
    watch::run(ctx, term);
}

/// Agent 的 hook 事件（`berth group hook`）：记会话、贴回一轮的回答、叫醒后台进程。
/// 终端状态由调用方按 [`hook_signal`] 写回 pane；这里只管群组。
pub fn hook(ctx: &Ctx, term: Option<&dyn Terminals>, sessions: &dyn Sessions, event: Hook, payload: &Value) {
    hook::handle(ctx, term, sessions, event, payload);
}

#[allow(clippy::too_many_arguments)]
pub fn post(
    ctx: &Ctx,
    term: Option<&dyn term::Terminals>,
    name: &str,
    author: &str,
    text: &str,
    to: Option<String>,
    reply_to: Option<u64>,
    idempotency_key: Option<String>,
) -> TaskResult<Value> {
    let (name, _, events) = project_existing(ctx, name)?;
    let author = identity::author(&events, ctx.caller.as_deref(), author)?;
    let text = required(text, "--text")?;
    let to = to.filter(|to| !to.trim().is_empty());
    let mut event = json!({
        "kind": "message", "author": author, "to": to, "text": text,
        "idempotency_key": idempotency_key,
    });
    if let Some(reply_to) = reply_to {
        event["reply_to"] = json!(reply_to);
    }
    let (mut written, fresh) = group::append_new(&ctx.main, &name, event)?;
    // 幂等重放返回旧事件，不再送达。
    if let (Some(to), true) = (to, fresh) {
        written["doorbell"] = deliver::doorbell(ctx, term, &name, &to);
    }
    Ok(written)
}

pub fn spec(
    ctx: &Ctx,
    term: Option<&dyn term::Terminals>,
    name: &str,
    author: &str,
    note: &str,
    task: &str,
) -> TaskResult<Value> {
    let (name, _, events) = project_existing(ctx, name)?;
    let author = identity::author(&events, ctx.caller.as_deref(), author)?;
    let note = required(note, "--note")?;
    let task = tasks::show(&ctx.main, Some(task))?.task_dir_name;
    let rev = group::spec_rev(&events) + 1;
    let mut written = group::append(
        &ctx.main,
        &name,
        json!({"kind": "spec", "author": author, "rev": rev, "task": task, "note": note}),
    )?;
    let prd = ctx.main.join(".berth/tasks").join(&task).join("prd.md");
    // 通知所有在岗成员按新契约继续（与 post --to 同一送达）。
    let mut notified = Vec::new();
    for member in group::members(&events) {
        if member.name == author {
            continue;
        }
        let text = format!(
            "契约已更新到 rev {rev}（{}）：{note}\n按新契约继续。",
            prd.display()
        );
        group::append(
            &ctx.main,
            &name,
            json!({"kind": "message", "author": author, "to": member.name, "text": text}),
        )?;
        notified.push(json!({"to": member.name, "doorbell": deliver::doorbell(ctx, term, &name, &member.name)}));
    }
    written["notified"] = json!(notified);
    Ok(written)
}

/// 专家（`$BERTH_HOME/experts`）与它们在项目群里的终端；`id` 给定时只看它，并附上它的规矩。
pub fn experts(ctx: &Ctx, term: Option<&dyn Terminals>, id: Option<&str>) -> TaskResult<Value> {
    let all = berth_tool_core::paths::experts(&berth_tool_core::paths::berth_home_dir())
        .map_err(|message| TaskError::new("invalid_input", message))?;
    let events = group::events(&ctx.main, group::MAIN_GROUP)?;
    let who = who_rows(ctx, term, group::MAIN_GROUP, &events);
    let bodies = |expert: &str| {
        who["participants"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|row| row["name"] == expert)
            .map(|row| row["bodies"].clone())
            .unwrap_or_else(|| json!([]))
    };
    let rules_file = |expert: &str| {
        let file = berth_project_core::knowledge::rules::rules_file(expert);
        ctx.main.join(&file).is_file().then_some(file)
    };
    let Some(id) = id else {
        let rows: Vec<Value> = all
            .iter()
            .map(|(id, name)| {
                let bodies = bodies(id);
                json!({
                    "id": id, "name": name,
                    "terminals": bodies.as_array().map_or(0, Vec::len),
                    "rules": rules_file(id),
                })
            })
            .collect();
        return Ok(json!({ "experts": rows }));
    };
    let (id, name) = all
        .iter()
        .find(|(expert, _)| expert == id)
        .ok_or_else(|| TaskError::new("not_found", format!("No expert {id} (see `expert ls`)")))?;
    Ok(json!({
        "id": id, "name": name,
        "terminals": bodies(id),
        "rules": rules_file(id),
        "rules_text": berth_project_core::knowledge::rules::brief(&ctx.main, id),
    }))
}

pub fn who_rows(ctx: &Ctx, term: Option<&dyn term::Terminals>, name: &str, events: &[Value]) -> Value {
    let rows: Vec<Value> = group::members(events)
        .into_iter()
        .map(|member| {
            let bodies: Vec<Value> = member
                .bodies
                .iter()
                .map(|body| {
                    let probe = term.map(|term| term.probe(&body.target_ref));
                    let state = match &probe {
                        None => "unknown",
                        Some(Ok(probe)) => term::state_name(probe),
                        Some(Err(term::Fail::Stale)) => "stale",
                        Some(Err(_)) => "unknown",
                    };
                    let hooked = watch::member_state(&ctx.main, name, &member.name, &body.target_ref);
                    json!({
                        "terminal": probe.and_then(Result::ok).map(|probe| probe.pane_id),
                        "target_ref": body.target_ref,
                        "agent": body.agent,
                        "state": state,
                        // hook 报告过会话：Berth 知道它何时一轮结束（才送达、才贴结果）。
                        "hooked": hooked.as_ref().is_some_and(|state| state.session_id.is_some()),
                        "session_id": hooked.and_then(|state| state.session_id),
                        "derived": body.derived,
                    })
                })
                .collect();
            json!({
                "name": member.name,
                "label": member.label,
                "joined_at": member.joined_at,
                "bodies": bodies,
            })
        })
        .collect();
    json!({ "participants": rows, "terminals": plain_terminals(ctx, term, events) })
}

/// 本项目目录下不是成员的终端（shell、没选专家的 Agent）：不收委托，Agent 用 `berth terminal send -t <target_ref>` / `berth terminal capture -t <target_ref>` 直接操作。
fn plain_terminals(
    ctx: &Ctx,
    term: Option<&dyn term::Terminals>,
    events: &[Value],
) -> Vec<Value> {
    let Some(term) = term else {
        return Vec::new();
    };
    let members: Vec<String> = group::members(events)
        .into_iter()
        .flat_map(|member| member.bodies)
        .map(|body| body.target_ref)
        .collect();
    term.panes_under(&project_dirs(&ctx.main))
        .unwrap_or_default()
        .into_iter()
        .filter(|(target_ref, _)| !members.contains(target_ref))
        .map(|(target_ref, probe)| {
            json!({
                "terminal": probe.pane_id,
                "target_ref": target_ref,
                "agent": term::agent_of(&probe),
                "command": probe.foreground_command,
                "cwd": probe.cwd,
            })
        })
        .collect()
}

