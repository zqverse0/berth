//! 空间群组：消息收发、ACP 成员、派发 worker（`berth group` 与 GUI 群组视图共用）。
//!
//! 账本在 `berth_project_core::tasks::group`（`<空间目录>/local/groups/`）。一个空间可以有多个群（`main` 为默认群），
//! 每个群有自己的目录（主项目或某个 worktree），成员的 Agent 在群目录里运行；worktree 的 checkout 记录不是群。
//! 群成员是 ACP 成员：由每个主项目一个的后台进程 `berth group watch`（[`watch`]、[`acp`]）起适配器收发；
//! 终端里的 Agent 不进群，`berth group hook` 只把它的状态写回终端（[`hook`]）。

pub mod acp;
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

/// 群名解析：聊天群（`main`、新建的）原样；worktree 的目录名或 checkout 键（旧写法）→ 目录是它的群，没有就是 `main`。
fn resolve(ctx: &Ctx, name: &str) -> TaskResult<String> {
    let name = group::validate_name(name)?;
    if group::is_chat_group(&ctx.main, &name)? {
        return Ok(name);
    }
    let (_, env) = group::project_group(&ctx.main, &name)?;
    Ok(group_at(&ctx.main, Path::new(&env.worktree))?.unwrap_or_else(|| group::MAIN_GROUP.to_owned()))
}

/// 目录是 `dir` 的群（第一个）。
pub(crate) fn group_at(main: &Path, dir: &Path) -> TaskResult<Option<String>> {
    let dir = dir.canonicalize().unwrap_or_else(|_| dir.to_path_buf());
    for name in group::chat_groups(main)? {
        let settings = group::settings(main, &name)?;
        // 私聊不是哪个目录的群。
        if settings.dm.is_some() {
            continue;
        }
        let cwd = settings.dir(main);
        if cwd.canonicalize().unwrap_or(cwd) == dir {
            return Ok(Some(name));
        }
    }
    Ok(None)
}

/// 目录是 `dir` 的群；没有就建一个，群名取目录名（重名编号）。`spawn --group <worktree>` 用。
pub(crate) fn group_for_dir(ctx: &Ctx, dir: &Path) -> TaskResult<String> {
    if let Some(name) = group_at(&ctx.main, dir)? {
        return Ok(name);
    }
    let base = group::validate_name(&dir.file_name().map(|name| name.to_string_lossy().into_owned()).unwrap_or_default())
        .unwrap_or_else(|_| "group".to_owned());
    let taken = group::meta(&ctx.main)?;
    let name = std::iter::once(base.clone())
        .chain((2..).map(|n| format!("{base}-{n}")))
        .find(|candidate| taken["groups"].get(candidate).is_none())
        .unwrap_or(base);
    group::create(&ctx.main, &name)?;
    group::set_cwd(&ctx.main, &name, Some(dir))?;
    Ok(name)
}

fn existing(ctx: &Ctx, name: &str) -> TaskResult<(String, Value, Vec<Value>)> {
    let name = group::validate_name(name)?;
    // 内部键照读那个账本（旧版 worktree 群只读保留）；目录名指向目录是它的群。
    let name = if group::info(&ctx.main, &name)?.is_some() && group::has_ledger(&ctx.main, &name) {
        name
    } else {
        resolve(ctx, &name)?
    };
    let info = group::info(&ctx.main, &name)?
        .ok_or_else(|| TaskError::new("not_found", format!("Channel not found: {name}")))?;
    let events = group::events(&ctx.main, &name)?;
    Ok((name, info, events))
}

/// 写操作只进聊天群（见 [`resolve`]）；旧版 worktree 群只读。
fn project_existing(ctx: &Ctx, name: &str) -> TaskResult<(String, Value, Vec<Value>)> {
    let name = resolve(ctx, name)?;
    existing(ctx, &name)
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
    let (name, _, _) = existing(ctx, name)?;
    group::read(&ctx.main, &name, after, None, 500, to)
}

/// 群成员：Agent、目录、会话 id、是否正在回答、会话是否交给了终端。
pub fn who(ctx: &Ctx, name: &str) -> TaskResult<Value> {
    let (name, _, events) = project_existing(ctx, name)?;
    Ok(who_rows(ctx, &name, &events))
}

/// 群列表：各群的键、显示名、目录与在群成员（`main` 在前）。
pub fn groups(ctx: &Ctx) -> TaskResult<Value> {
    let rows = group::chat_groups(&ctx.main)?
        .into_iter()
        .map(|name| {
            let settings = group::settings(&ctx.main, &name)?;
            let members: Vec<String> =
                group::members(&group::events(&ctx.main, &name)?).into_iter().map(|member| member.name).collect();
            Ok(json!({
                "name": name, "title": settings.title, "cwd": settings.dir(&ctx.main), "members": members, "dm": settings.dm,
            }))
        })
        .collect::<TaskResult<Vec<Value>>>()?;
    Ok(json!({ "groups": rows }))
}

/// 群目录须是本空间的项目目录（主项目或 worktree）。
fn group_dir(ctx: &Ctx, cwd: &Path) -> TaskResult<PathBuf> {
    if !in_project(&ctx.main, cwd) {
        return Err(TaskError::new("invalid_input", format!("{} is not a directory of this project", cwd.display())));
    }
    Ok(cwd.canonicalize().unwrap_or_else(|_| cwd.to_path_buf()))
}

/// 与专家私聊的账本（群键 `dm-<专家>`，群条目记 `dm`）：没有就建，返回群键。它和群一样收发、按专家配置入群，
/// 只是不在群列表里显示（GUI 按 `dm` 过滤），消息不进任何群。
pub fn dm(ctx: &Ctx, expert: &str) -> TaskResult<Value> {
    let all = all_experts()?;
    let (id, _) = find_expert(&all, expert)?;
    let name = group::validate_name(&format!("dm-{id}"))?;
    match group::info(&ctx.main, &name)? {
        None => match group::create_dm(&ctx.main, &name, id) {
            Err(error) if error.code != "already_exists" => return Err(error),
            _ => {}
        },
        Some(entry) if entry.get("dm").and_then(Value::as_str) != Some(id.as_str()) => {
            return Err(TaskError::new("already_exists", format!("Group already exists: {name}")));
        }
        Some(_) => {}
    }
    Ok(json!({ "name": name }))
}

/// 新建群：`name` 是群键（也是 CLI 里的名字），`cwd` 缺省主项目。
pub fn create_group(ctx: &Ctx, name: &str, title: Option<&str>, cwd: Option<&Path>) -> TaskResult<Value> {
    let name = group::validate_name(name)?;
    // checkout 记录与群共用 groups.json 的键。
    if group::info(&ctx.main, &name)?.is_some() {
        return Err(TaskError::new("already_exists", format!("Group already exists: {name}")));
    }
    let cwd = cwd.map(|cwd| group_dir(ctx, cwd)).transpose()?;
    group::create(&ctx.main, &name)?;
    group::set_cwd(&ctx.main, &name, cwd.as_deref())?;
    group::set_title(&ctx.main, &name, title.map(str::trim).filter(|title| !title.is_empty()))?;
    Ok(json!({ "name": name }))
}

/// 改群的显示名（群键不变：账本、投递标记、会话都按键存）；空为改回群键。
pub fn rename_group(ctx: &Ctx, name: &str, title: Option<&str>) -> TaskResult<Value> {
    let name = chat_group(ctx, name)?;
    let title = title.map(str::trim).filter(|title| !title.is_empty());
    group::set_title(&ctx.main, &name, title)?;
    Ok(json!({ "name": name, "title": title }))
}

/// 删除群（`main` 不能删）：成员进程停掉，账本与运行态删掉，在 `retired` 留一行。
pub fn delete_group(ctx: &Ctx, name: &str) -> TaskResult<Value> {
    let name = chat_group(ctx, name)?;
    if name == group::MAIN_GROUP {
        return Err(TaskError::new("invalid_input", "The default group cannot be deleted"));
    }
    group::remove(&ctx.main, &name)?;
    let _ = std::fs::remove_dir_all(group::runtime_dir(&ctx.main).join("acp").join(&name));
    watch::kick_now(ctx);
    Ok(json!({ "name": name, "deleted": true }))
}

/// 改群目录（`Some(None)` 改回主项目）。改了在群里记一条，成员下一条消息在新目录开新会话。
pub fn configure_group(ctx: &Ctx, name: &str, cwd: Option<Option<&Path>>) -> TaskResult<Value> {
    let name = chat_group(ctx, name)?;
    let cwd = cwd.map(|cwd| cwd.map(|cwd| group_dir(ctx, cwd)).transpose()).transpose()?;
    if let Some(cwd) = cwd {
        let before = group::settings(&ctx.main, &name)?.dir(&ctx.main);
        group::set_cwd(&ctx.main, &name, cwd.as_deref())?;
        let after = group::settings(&ctx.main, &name)?.dir(&ctx.main);
        if before != after {
            group::append(
                &ctx.main,
                &name,
                json!({"kind": "system", "event": "group_cwd", "author": group::USER, "cwd": after, "from": before}),
            )?;
            watch::kick_now(ctx);
        }
    }
    Ok(json!({ "name": name, "cwd": group::settings(&ctx.main, &name)?.dir(&ctx.main) }))
}

/// `join --cwd`：核对群目录，不一致时报错并说明群在哪个目录运行。
pub fn check_dir(ctx: &Ctx, name: &str, cwd: &Path) -> TaskResult<()> {
    let name = resolve(ctx, name)?;
    let dir = group::settings(&ctx.main, &name)?.dir(&ctx.main);
    let same = |path: &Path| path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    if same(cwd) != same(&dir) {
        return Err(TaskError::new(
            "invalid_input",
            format!("Group {name} runs in {}; use `berth group settings --cwd` or a group in {}", dir.display(), cwd.display()),
        ));
    }
    Ok(())
}

/// 管理操作只认聊天群的键。
fn chat_group(ctx: &Ctx, name: &str) -> TaskResult<String> {
    let name = group::validate_name(name)?;
    if !group::is_chat_group(&ctx.main, &name)? {
        return Err(TaskError::new("not_found", format!("Group not found: {name}")));
    }
    Ok(name)
}

/// ACP 成员入群：不占终端，由群组运行时按插件的 `acp(ctx)` 起适配器收发（docs/agent-contracts.md「群组 ACP 模式」）。
/// 插件须在 `tool.json` 声明 `contributes.agent.acp: true`；Agent 在群目录运行（规则 4）。
/// `inputs` 是启动栏的选择（含 `expert`），`provider` 是服务商档案 id 与模型，每次起适配器都按它们启动。
/// `as_name` 不给时成员名取所选专家的 id（规则 3），没选专家报错；同群已有同名成员一律拒绝。
pub fn join_acp(
    ctx: &Ctx,
    name: &str,
    as_name: Option<&str>,
    agent: &str,
    inputs: serde_json::Map<String, Value>,
    provider: Option<(i64, Option<String>)>,
) -> TaskResult<Value> {
    let (name, _, events) = project_existing(ctx, name)?;
    let author = match as_name.map(str::trim).filter(|as_name| !as_name.is_empty()) {
        Some(as_name) => as_name.to_owned(),
        None => spawn::expert_of(agent, &Value::Object(inputs.clone()))
            .ok_or_else(|| TaskError::new("invalid_input", "choose an expert: group members are experts"))?,
    };
    if author == group::USER {
        return Err(TaskError::new("invalid_input", format!("{} is reserved for the user", group::USER)));
    }
    if group::members(&events).iter().any(|member| member.name == author) {
        return Err(TaskError::new("conflict", format!("{author} is already a member")));
    }
    acp_agent(agent)?;
    // 记下入群时的群目录（显示、交给终端用）；运行时总按群当前的目录起进程。
    let cwd = group::settings(&ctx.main, &name)?.dir(&ctx.main);
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

/// 能以 ACP 成员入群的插件：已启用且 `tool.json` 声明 `agent.acp`。
fn acp_agent(agent: &str) -> TaskResult<()> {
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
    Ok(())
}

/// 改 ACP 成员的 Agent、启动栏输入、服务商与模型：记一条 `acp_settings`，下一条消息生效（运行时比对后切换，见 `acp`）。
/// 专家不变（成员就是它）；换了 Agent 旧会话不能续，清掉、下次开新会话。
pub fn member_settings(
    ctx: &Ctx,
    name: &str,
    member: &str,
    agent: &str,
    mut inputs: serde_json::Map<String, Value>,
    provider: Option<(i64, Option<String>)>,
) -> TaskResult<Value> {
    let (name, _, events) = project_existing(ctx, name)?;
    let present = group::members(&events)
        .into_iter()
        .find(|m| m.name == member)
        .and_then(|present| acp::joined(&events, &name, &present))
        .ok_or_else(|| TaskError::new("not_found", format!("{member} is not an ACP member")))?;
    if acp::handed(&events, member).is_some() {
        return Err(TaskError::new("conflict", format!("{member} is open in a terminal; return it first")));
    }
    acp_agent(agent)?;
    if let Some(expert) = present.inputs.get("expert") {
        inputs.insert("expert".to_owned(), expert.clone());
    }
    if present.agent != agent {
        acp::forget_session(&ctx.main, &name, member);
    }
    let written = group::append(
        &ctx.main,
        &name,
        json!({
            "kind": "system", "event": "acp_settings", "author": group::USER, "to": member,
            "agent": agent, "inputs": inputs, "provider": provider.as_ref().map(|(id, _)| id),
            "model": provider.as_ref().and_then(|(_, model)| model.as_ref()),
        }),
    )?;
    watch::kick_now(ctx);
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
            if acp::live(&ctx.main, &name, member).is_some() {
                return Err(TaskError::new("conflict", format!("{member} is answering; stop it first")));
            }
            let session = group::bound_session_in(&ctx.main, &name, &events, &target_ref)
                .ok_or_else(|| TaskError::new("invalid_input", format!("{member} has no session yet")))?;
            let joined = acp::joined(&events, &name, &present)
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
            acp::forget_session(&ctx.main, &name, member);
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

/// 例行发群：到点以用户身份发给 `member`，带 `source: routine`（不进别人的群上下文）；`key` 幂等。
/// 成员正在回答时不发，返回 `None`。
pub fn routine(ctx: &Ctx, member: &str, text: &str, key: &str) -> TaskResult<Option<u64>> {
    let (name, _, events) = project_existing(ctx, group::MAIN_GROUP)?;
    if !group::members(&events).iter().any(|present| present.name == member) {
        return Err(TaskError::new("not_found", format!("{member} is not a member")));
    }
    if acp::live(&ctx.main, &name, member).is_some() {
        return Ok(None);
    }
    let event = json!({
        "kind": "message", "author": group::USER, "to": member, "text": required(text, "text")?,
        "source": "routine", "idempotency_key": key,
    });
    let (written, fresh) = group::append_new(&ctx.main, &name, event)?;
    if fresh {
        deliver::doorbell(ctx, &name, member);
    }
    Ok(Some(group::seq(&written)))
}

/// 例行那条消息（`seq`）这一轮的结局：成员答了是 `Ok(回答)`，中断 / 失败 / 起不来 / 没回答 / 之后丢了上下文是 `Err(原因)`，
/// 还没结束是 `None`。按 seq 顺序取第一个结局：上下文丢失不带 `reply_to`，发生在例行之后就算这一轮失败。
pub fn routine_outcome(main: &Path, member: &str, seq: u64) -> TaskResult<Option<Result<String, String>>> {
    let events = group::events(main, group::MAIN_GROUP)?;
    Ok(events
        .iter()
        .filter(|event| group::seq(event) > seq)
        .filter(|event| text(event, "author") == Some(member) && text(event, "kind") == Some("message"))
        .find_map(|event| {
            let said = text(event, "text").unwrap_or_default().to_owned();
            let answers = event.get("reply_to").and_then(Value::as_u64) == Some(seq);
            match text(event, "event") {
                Some("context_lost") => Some(Err(said)),
                None if answers => Some(Ok(said)),
                Some("turn_interrupted" | "turn_failed" | "acp_unavailable" | "turn_empty") if answers => Some(Err(said)),
                _ => None,
            }
        }))
}

/// 例行连续失败：在群里告诉用户（与成员通知同形，`event: routine_failed`）。
pub fn routine_failed(main: &Path, member: &str, text: &str) -> TaskResult<()> {
    group::append(
        main,
        group::MAIN_GROUP,
        json!({
            "kind": "message", "source": "transcript", "event": "routine_failed", "author": member,
            "to": group::USER, "text": text,
        }),
    )?;
    Ok(())
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
    let (name, _, events) = project_existing(ctx, name)?;
    let author = identity::author(author)?;
    let text = required(text, "--text")?;
    let to = to.filter(|to| !to.trim().is_empty());
    let recipients = match to {
        None if author == group::USER => recipients(&events, &text, reply_to),
        to => vec![to],
    };
    admit(ctx, &name, &events, &recipients)?;
    // 发给多人：每人一条，幂等键按人区分（同一批次，时间线合成一条）。
    let several = recipients.len() > 1;
    let mut first: Option<Value> = None;
    for to in recipients {
        let key = idempotency_key
            .as_ref()
            .map(|key| if several { format!("{key}:{}", to.as_deref().unwrap_or_default()) } else { key.clone() });
        let mut event = json!({
            "kind": "message", "author": author, "to": to, "text": text,
            "idempotency_key": key,
        });
        if let Some(reply_to) = reply_to {
            event["reply_to"] = json!(reply_to);
        }
        let (mut written, fresh) = group::append_new(&ctx.main, &name, event)?;
        // 幂等重放返回旧事件，不再送达。
        if let (Some(to), true) = (to, fresh) {
            written["doorbell"] = deliver::doorbell(ctx, &name, &to);
        }
        first.get_or_insert(written);
    }
    Ok(first.unwrap_or_default())
}

/// 收件人是专家、还不在群：按它在本空间的配置入群（规则 3），再投递。有专家没配置就报错、什么都不写；
/// 不是专家的名字（spawn 的 worker、旧成员）照旧。
fn admit(ctx: &Ctx, name: &str, events: &[Value], recipients: &[Option<String>]) -> TaskResult<()> {
    let present: Vec<String> = group::members(events).into_iter().map(|member| member.name).collect();
    let configs = group::expert_configs(&ctx.main)?;
    let experts = all_experts()?;
    let mut joins = Vec::new();
    for to in recipients.iter().flatten() {
        if present.contains(to) || !experts.iter().any(|(id, _)| id == to) {
            continue;
        }
        let config = configs
            .get(to)
            .ok_or_else(|| TaskError::new("invalid_input", format!("Choose an Agent for {to} on the Experts page first")))?;
        joins.push((to, config));
    }
    for (to, config) in joins {
        let inputs = config["inputs"].as_object().cloned().unwrap_or_default();
        let provider = config["provider"].as_i64().map(|id| (id, config["model"].as_str().map(str::to_owned)));
        join_acp(ctx, name, Some(to), config["agent"].as_str().unwrap_or_default(), inputs, provider)?;
    }
    Ok(())
}

/// 用户没指定收件人时发给谁（规则 5）；不从正文解析 @，只认 `@everyone`：
/// `@everyone` → 所有在群成员；回复某成员的话 → 它；否则只记进群（`[None]`）。
fn recipients(events: &[Value], text: &str, reply_to: Option<u64>) -> Vec<Option<String>> {
    let members: Vec<String> = group::members(events).into_iter().map(|member| member.name).collect();
    if text.split_whitespace().any(|word| word == "@everyone") && !members.is_empty() {
        return members.into_iter().map(Some).collect();
    }
    let replied = reply_to
        .and_then(|seq| events.iter().find(|event| group::seq(event) == seq))
        .and_then(|event| crate::text(event, "author"))
        .filter(|author| members.iter().any(|member| member == author))
        .map(str::to_owned);
    vec![replied]
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

/// 专家（`$BERTH_HOME/experts`）、它在本空间的配置（`config`，未配置为 null）与以它入群的成员（各群的，带 `group`）；
/// `id` 给定时只看它。
pub fn experts(ctx: &Ctx, id: Option<&str>) -> TaskResult<Value> {
    let all = all_experts()?;
    let configs = group::expert_configs(&ctx.main)?;
    let mut rows: Vec<Value> = Vec::new();
    for name in group::chat_groups(&ctx.main)? {
        let events = group::events(&ctx.main, &name)?;
        for mut row in who_rows(ctx, &name, &events)["participants"].as_array().cloned().unwrap_or_default() {
            row["group"] = json!(name);
            rows.push(row);
        }
    }
    let members = |expert: &str| -> Vec<Value> { rows.iter().filter(|row| row["expert"] == expert).cloned().collect() };
    let Some(id) = id else {
        let rows: Vec<Value> = all
            .iter()
            .map(|(id, name)| json!({ "id": id, "name": name, "config": configs.get(id), "members": members(id).len() }))
            .collect();
        return Ok(json!({ "experts": rows }));
    };
    let (id, name) = find_expert(&all, id)?;
    Ok(json!({ "id": id, "name": name, "config": configs.get(id), "members": members(id) }))
}

fn all_experts() -> TaskResult<Vec<(String, String)>> {
    berth_tool_core::paths::experts(&berth_tool_core::paths::berth_home_dir())
        .map_err(|message| TaskError::new("invalid_input", message))
}

fn find_expert<'a>(all: &'a [(String, String)], id: &str) -> TaskResult<&'a (String, String)> {
    all.iter()
        .find(|(expert, _)| expert == id)
        .ok_or_else(|| TaskError::new("not_found", format!("No expert {id} (see `expert ls`)")))
}

/// 专家页「Agent / 模型」：存进本空间的专家配置（所有群共用），并对它已在的每个群记 `acp_settings`
/// （[`member_settings`]，下一条消息切换）。在终端里打开着的群跳过，交回后再存一次才生效。
/// `inputs` 是该 Agent 启动栏的选择，专家项由这里按启动栏填上。返回配置与已切换的群。
pub fn set_expert(
    ctx: &Ctx,
    expert: &str,
    agent: &str,
    mut inputs: serde_json::Map<String, Value>,
    provider: Option<(i64, Option<String>)>,
) -> TaskResult<Value> {
    let (expert, _) = find_expert(&all_experts()?, expert.trim())?.clone();
    acp_agent(agent)?;
    let key = berth_tool_core::paths::expert_input(&berth_tool_core::paths::tools_root().join(agent))
        .ok_or_else(|| TaskError::new("invalid_input", format!("{agent} has no expert option in its launchbar")))?;
    inputs.insert(key, json!(expert));
    let config = json!({
        "agent": agent, "inputs": inputs, "provider": provider.as_ref().map(|(id, _)| id),
        "model": provider.as_ref().and_then(|(_, model)| model.as_ref()),
    });
    group::set_expert_config(&ctx.main, &expert, Some(config.clone()))?;
    let mut groups = Vec::new();
    for name in group::chat_groups(&ctx.main)? {
        match member_settings(ctx, &name, &expert, agent, inputs.clone(), provider.clone()) {
            Ok(_) => groups.push(name),
            // 不在这个群，或会话在终端里。
            Err(error) if matches!(error.code, "not_found" | "conflict") => {}
            Err(error) => return Err(error),
        }
    }
    Ok(json!({ "expert": expert, "config": config, "groups": groups }))
}

/// 群 `name` 在群的成员（`berth group who`、专家列表）。
pub fn who_rows(ctx: &Ctx, name: &str, events: &[Value]) -> Value {
    let rows: Vec<Value> = group::members(events)
        .into_iter()
        .filter_map(|member| {
            let joined = acp::joined(events, name, &member)?;
            let target_ref = format!("{}{}", acp::PREFIX, member.name);
            Some(json!({
                "name": member.name,
                "label": member.label,
                "joined_at": member.joined_at,
                "agent": joined.agent,
                "cwd": joined.cwd,
                "expert": joined.inputs.get("expert"),
                "session_id": group::bound_session_in(&ctx.main, name, events, &target_ref),
                "busy": acp::live(&ctx.main, name, &member.name).is_some(),
                "handed": acp::handed(events, &member.name).map(|event| event["terminal"].clone()),
            }))
        })
        .collect();
    json!({ "participants": rows })
}
