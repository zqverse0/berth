//! 空间群组：消息收发、ACP 成员、派发 worker（`berth group` 与 GUI 群组视图共用）。
//!
//! 账本在 `berth_project_core::tasks::group`（`<空间目录>/local/groups/`）。一个空间一个群（`main`）：
//! 主目录和各 worktree 的成员、消息都在这个群里，worktree 只是成员的工作目录。
//! 群成员是 ACP 成员：由每个主项目一个的后台进程 `berth group watch`（[`watch`]、[`acp`]）起适配器收发；
//! 终端里的 Agent 不进群，`berth group hook` 只把它的状态写回终端（[`hook`]）。

pub mod acp;
pub mod builtin;
mod deliver;
mod hook;
mod identity;
mod spawn;
mod watch;

#[cfg(test)]
mod tests;

use std::ffi::OsString;
use std::path::{Path, PathBuf};

use berth_project_core::tasks::{self, group, TaskError, TaskResult};
use serde_json::{json, Value};

pub use hook::{signal as hook_signal, Hook};
pub use spawn::SpawnRequest;
pub use watch::brief_lines;

/// 一次调用的上下文。
pub struct Ctx {
    /// 空间的主项目：群与运行态按它解析到空间目录。
    pub main: PathBuf,
    /// termd 端点：后台进程按它定实例（锁、叫醒 socket），拉起时也传给它。
    pub socket: Option<PathBuf>,
    pub gui: Option<OsString>,
    /// berth CLI 可执行文件：拉起后台进程、运行插件的 `acp(ctx)` 都用它。
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

/// 空间启动预设（`<空间目录>/presets.json`）摘要，配合 `spawn --preset`。
pub fn presets(ctx: &Ctx) -> TaskResult<Value> {
    spawn::list_presets(&ctx.main)
}

/// `after` 之后的事件；`to` 只看发给它和发给所有人的。
pub fn read(ctx: &Ctx, name: &str, after: u64, to: Option<&str>) -> TaskResult<Value> {
    let (_, _, events) = existing(ctx, name)?;
    Ok(group::read(&events, after, to))
}

/// 群成员：Agent、目录、会话 id、是否正在回答、会话是否交给了终端。
pub fn who(ctx: &Ctx, name: &str) -> TaskResult<Value> {
    let (_, _, events) = project_existing(ctx, name)?;
    Ok(who_rows(ctx, &events))
}

/// ACP 成员入群：不占终端，由群组运行时按插件的 `acp(ctx)` 起适配器收发（docs/agent-contracts.md「群组 ACP 模式」）。
/// 插件须在 `tool.json` 声明 `contributes.agent.acp: true`；`cwd` 缺省为主目录，须是本项目的目录。
/// `inputs` 是启动栏的选择（含 `expert`），`provider` 是服务商档案 id 与模型，每次起适配器都按它们启动。
pub fn join_acp(
    ctx: &Ctx,
    name: &str,
    as_name: &str,
    agent: &str,
    inputs: serde_json::Map<String, Value>,
    provider: Option<(i64, Option<String>)>,
    cwd: Option<PathBuf>,
) -> TaskResult<Value> {
    let (name, _, events) = project_existing(ctx, name)?;
    let author = required(as_name, "--as")?;
    if author == group::USER {
        return Err(TaskError::new("invalid_input", format!("{} is reserved for the user", group::USER)));
    }
    if group::members(&events).iter().any(|member| member.name == author) {
        return Err(TaskError::new("conflict", format!("{author} is already a member")));
    }
    berth_tool_core::plugins::ensure_enabled(agent).map_err(|error| TaskError::new("invalid_input", error.to_string()))?;
    let manifest: Value = std::fs::read(berth_tool_core::paths::tools_root().join(agent).join("tool.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default();
    let declared = manifest["contributes"]["agent"]["acp"] == json!(true)
        || manifest["extensions"]["org.berth.agent"]["acp"] == json!(true);
    if !declared {
        return Err(TaskError::new("invalid_input", format!("{agent} does not support groups (tool.json agent.acp)")));
    }
    let cwd = cwd.unwrap_or_else(|| ctx.main.clone());
    if !in_project(&ctx.main, &cwd) {
        return Err(TaskError::new("invalid_input", format!("{} is not a directory of this project", cwd.display())));
    }
    let written = group::append(
        &ctx.main,
        &name,
        json!({
            "kind": "joined", "author": author, "target_ref": format!("{}{author}", acp::PREFIX),
            "agent": agent, "cwd": cwd.canonicalize().unwrap_or(cwd), "expert": inputs.get("expert"),
            "inputs": inputs, "provider": provider.as_ref().map(|(id, _)| id),
            "model": provider.as_ref().and_then(|(_, model)| model.as_ref()), "collect": true,
        }),
    )?;
    watch::ensure_running(ctx);
    Ok(written)
}

/// 管理 ACP 成员：`stop` 停下这一轮，`new` 之后从新会话开始（正在答就中断），`leave` 移出群
/// （进程停掉、会话保留，同名再加回来接着用）。由后台进程执行。
/// `handoff` 把会话交给终端：进程停掉，群里的消息留着；返回的事件带启动终端要的 Agent、目录、启动栏值、
/// 服务商与会话 id。`terminal` 是打开它的终端，可先交接、开好终端后再带上（再交接一次）。
/// `return` 交回群里，下一条消息起新进程接着同一会话（含终端里聊的）。同一会话同一时刻只在一处打开。
pub fn control(ctx: &Ctx, name: &str, member: &str, action: &str, terminal: Option<String>) -> TaskResult<Value> {
    let (name, _, events) = project_existing(ctx, name)?;
    let target_ref = format!("{}{member}", acp::PREFIX);
    let Some(present) = group::members(&events).into_iter().find(|m| m.name == member && m.body(&target_ref).is_some())
    else {
        return Err(TaskError::new("not_found", format!("{member} is not an ACP member")));
    };
    let handed = acp::handed(&events, member).is_some();
    let event = match action {
        "handoff" => {
            if acp::live(&ctx.main, member).is_some() {
                return Err(TaskError::new("conflict", format!("{member} is answering; stop it first")));
            }
            let session = group::bound_session_in(&ctx.main, &name, &events, &target_ref)
                .ok_or_else(|| TaskError::new("invalid_input", format!("{member} has no session yet")))?;
            let joined = acp::joined(&events, &present)
                .ok_or_else(|| TaskError::new("not_found", format!("{member} is not an ACP member")))?;
            json!({
                "kind": "system", "event": "acp_handoff", "author": group::USER, "to": member,
                "session": session, "terminal": terminal, "agent": joined.agent, "cwd": joined.cwd,
                "inputs": joined.inputs, "provider": joined.provider.as_ref().map(|(id, _)| id),
                "model": joined.provider.as_ref().and_then(|(_, model)| model.as_ref()),
            })
        }
        "return" if !handed => return Err(TaskError::new("invalid_input", format!("{member} is not in a terminal"))),
        "return" => json!({"kind": "system", "event": "acp_return", "author": group::USER, "to": member}),
        "stop" | "new" if handed => {
            return Err(TaskError::new("conflict", format!("{member} is open in a terminal; return it first")))
        }
        "stop" => json!({"kind": "system", "event": "acp_stop", "author": group::USER, "to": member}),
        "new" => {
            acp::forget_session(&ctx.main, member);
            json!({"kind": "system", "event": "acp_new", "author": group::USER, "to": member})
        }
        "leave" => json!({"kind": "left", "author": member, "target_ref": target_ref, "reason": "removed"}),
        _ => {
            return Err(TaskError::new(
                "invalid_input",
                format!("Unknown action {action}: stop | new | leave | handoff | return"),
            ))
        }
    };
    let written = group::append(&ctx.main, &name, event)?;
    watch::kick_now(ctx);
    Ok(written)
}

/// 应答 ACP 成员的审批请求（`permission` 事件的 seq）；`option` 为 None 即取消。
pub fn approve(ctx: &Ctx, name: &str, request: u64, option: Option<String>) -> TaskResult<Value> {
    let (name, _, events) = project_existing(ctx, name)?;
    let asked = events
        .iter()
        .find(|event| group::seq(event) == request && text(event, "event") == Some("permission"))
        .ok_or_else(|| TaskError::new("not_found", format!("No permission request #{request}")))?;
    if let Some(option) = &option {
        let known = asked["options"].as_array().into_iter().flatten().any(|item| item["id"] == json!(option));
        if !known {
            return Err(TaskError::new("invalid_input", format!("Unknown option {option}")));
        }
    }
    let written = group::append(
        &ctx.main,
        &name,
        json!({"kind": "system", "event": "permission_reply", "author": group::USER, "reply_to": request, "option": option}),
    )?;
    watch::kick_now(ctx);
    Ok(written)
}

/// 派发 worker：在目标项目群目录启动 Agent，任务仅作为上下文。
pub fn spawn(ctx: &Ctx, request: SpawnRequest) -> TaskResult<Value> {
    spawn::spawn(ctx, request)
}

/// 向主管申请变更契约。
pub fn change(
    ctx: &Ctx,
    name: &str,
    as_name: &str,
    to: &str,
    text: &str,
) -> TaskResult<Value> {
    let (name, _, events) = project_existing(ctx, name)?;
    let author = identity::author(as_name)?;
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
    written["doorbell"] = deliver::doorbell(ctx, &name, &to);
    Ok(written)
}

/// 后台进程主循环：ACP 成员收发、记 git 动作。
pub fn watch(ctx: &Ctx) {
    watch::run(ctx);
}

#[allow(clippy::too_many_arguments)]
pub fn post(
    ctx: &Ctx,
    name: &str,
    author: &str,
    text: &str,
    to: Option<String>,
    reply_to: Option<u64>,
    idempotency_key: Option<String>,
) -> TaskResult<Value> {
    let (name, _, _) = project_existing(ctx, name)?;
    let author = identity::author(author)?;
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
        written["doorbell"] = deliver::doorbell(ctx, &name, &to);
    }
    Ok(written)
}

pub fn spec(
    ctx: &Ctx,
    name: &str,
    author: &str,
    note: &str,
    task: &str,
) -> TaskResult<Value> {
    let (name, _, events) = project_existing(ctx, name)?;
    let author = identity::author(author)?;
    let note = required(note, "--note")?;
    let task = tasks::show(&ctx.main, Some(task))?.task_dir_name;
    let rev = group::spec_rev(&events) + 1;
    let mut written = group::append(
        &ctx.main,
        &name,
        json!({"kind": "spec", "author": author, "rev": rev, "task": task, "note": note}),
    )?;
    let prd = berth_project_core::tasks::berth_dir(&ctx.main)?.join("tasks").join(&task).join("prd.md");
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
        notified.push(json!({"to": member.name, "doorbell": deliver::doorbell(ctx, &name, &member.name)}));
    }
    written["notified"] = json!(notified);
    Ok(written)
}

/// 专家（`$BERTH_HOME/experts`）与以它入群的成员；`id` 给定时只看它。
pub fn experts(ctx: &Ctx, id: Option<&str>) -> TaskResult<Value> {
    let all = berth_tool_core::paths::experts(&berth_tool_core::paths::berth_home_dir())
        .map_err(|message| TaskError::new("invalid_input", message))?;
    let events = group::events(&ctx.main, group::MAIN_GROUP)?;
    let who = who_rows(ctx, &events);
    let members = |expert: &str| -> Vec<Value> {
        who["participants"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|row| row["expert"] == expert)
            .cloned()
            .collect()
    };
    let Some(id) = id else {
        let rows: Vec<Value> = all
            .iter()
            .map(|(id, name)| json!({ "id": id, "name": name, "members": members(id).len() }))
            .collect();
        return Ok(json!({ "experts": rows }));
    };
    let (id, name) = all
        .iter()
        .find(|(expert, _)| expert == id)
        .ok_or_else(|| TaskError::new("not_found", format!("No expert {id} (see `expert ls`)")))?;
    Ok(json!({ "id": id, "name": name, "members": members(id) }))
}

/// 在群的成员（`berth group who`、专家列表）。
pub fn who_rows(ctx: &Ctx, events: &[Value]) -> Value {
    let rows: Vec<Value> = group::members(events)
        .into_iter()
        .filter_map(|member| {
            let joined = acp::joined(events, &member)?;
            let target_ref = format!("{}{}", acp::PREFIX, member.name);
            Some(json!({
                "name": member.name,
                "label": member.label,
                "joined_at": member.joined_at,
                "agent": joined.agent,
                "cwd": joined.cwd,
                "expert": joined.inputs.get("expert"),
                "session_id": group::bound_session_in(&ctx.main, group::MAIN_GROUP, events, &target_ref),
                "busy": acp::live(&ctx.main, &member.name).is_some(),
                "handed": acp::handed(events, &member.name).map(|event| event["terminal"].clone()),
            }))
        })
        .collect();
    json!({ "participants": rows })
}
