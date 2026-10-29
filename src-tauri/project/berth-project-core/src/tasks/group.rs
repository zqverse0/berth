//! 群组账本：`<主项目>/.berth/local/groups/groups.json` 元数据 + `<群>.jsonl` 事件流，
//! 同一把 `.lock`。`berth group`、开工、GUI 群时间线共用；只追加，不改写已有事件。
//!
//! 成员不另存名单：由 `joined` / `left` 事件派生（[`members`]），每人以最近一条为准；
//! 显示名由群主的 `renamed` 事件给出（[`rename`]），成员名本身不变（投递、收集都按成员名）。

use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::{json, Map, Value};

use super::fsutil;
use super::hub::local_dir;
use super::state::now;
use super::{TaskError, TaskResult};

pub const NAME_MAX: usize = 64;
/// 成员显示名最长字符数。
pub const LABEL_MAX: usize = 32;
const MAX_GROUP_BYTES: u64 = 8 * 1024 * 1024;
/// 群主（用户）的固定作者名。
pub const USER: &str = "user";

pub fn dir(main: &Path) -> PathBuf {
    let dir = local_dir(main).join("groups");
    // 旧布局 `local/channel/` 只迁一次：`groups/` 有了元数据就不再碰它。旧版 berth（未升级的 CLI / 桌面）
    // 找不到账本会重建 `local/channel/`，反复迁移会让两边互相覆盖、每轮多出重复的群。
    if !dir.join("groups.json").is_file() && legacy_dir(main).join("channels.json").is_file() {
        let _ = migrate_legacy(main);
    }
    dir
}

fn legacy_dir(main: &Path) -> PathBuf {
    local_dir(main).join("channel")
}

/// 旧布局迁移：只搬仍在用的群（`main` 与目录还在的 worktree 群）；其余（退役的任务频道、已删目录的群）
/// 压成 `retired` 里的一行（[`retired_entry`]），账本、投递标记、成员 hook 状态丢掉；旧目录整体改名 `channel.bak-<时间>` 留底。
fn migrate_legacy(main: &Path) -> TaskResult<()> {
    let old = legacy_dir(main);
    let _guard = fsutil::lock(&old.join(".lock"))?;
    let Some(meta) = fsutil::read_json(&old.join("channels.json"))? else {
        // 别的进程刚迁完：等锁时它把目录改了名，这里只剩开锁时新建的空目录。
        let _ = fs::remove_dir_all(&old);
        return Ok(());
    };
    let new = local_dir(main).join("groups");
    fs::create_dir_all(&new)?;
    if new.join("groups.json").is_file() {
        return Ok(());
    }
    let mut kept = Map::new();
    let mut retired = Map::new();
    for (name, entry) in meta["channels"].as_object().into_iter().flatten() {
        let in_use = entry.get("task").is_none_or(Value::is_null)
            && (name == MAIN_GROUP
                || entry
                    .pointer("/env/worktree")
                    .and_then(Value::as_str)
                    .is_some_and(|worktree| Path::new(worktree).is_dir()));
        let ledger = old.join(format!("{name}.jsonl"));
        if in_use {
            let mut entry = entry.clone();
            if let Some(fields) = entry.as_object_mut() {
                fields.remove("task");
                fields.remove("description");
            }
            kept.insert(name.clone(), entry);
            if ledger.is_file() {
                fs::rename(&ledger, new.join(format!("{name}.jsonl")))?;
            }
        } else {
            let events = read_events(&ledger).unwrap_or_default();
            forget_runtime(main, name, &events);
            let worktree = entry.pointer("/env/worktree").and_then(Value::as_str);
            if let Some(line) = retired_entry(worktree, &events) {
                retired.insert(name.clone(), line);
            }
        }
    }
    fsutil::write_json(
        &new.join("groups.json"),
        &json!({"version": 1, "groups": kept, "retired": retired}),
    )?;
    let runtime = runtime_dir(main);
    let _ = fs::remove_file(runtime.join("before-project-groups.json"));
    for entry in fs::read_dir(runtime.join("doorbell")).into_iter().flatten().flatten() {
        if entry.path().extension().is_some_and(|ext| ext == "collector") {
            let _ = fs::remove_file(entry.path());
        }
    }
    let stamp = chrono::Local::now().format("%Y%m%d%H%M%S").to_string();
    let mut backup = local_dir(main).join(format!("channel.bak-{stamp}"));
    for index in 2.. {
        if !backup.exists() {
            break;
        }
        backup = local_dir(main).join(format!("channel.bak-{stamp}-{index}"));
    }
    fs::rename(&old, backup)?;
    Ok(())
}

/// 删掉的群留下的一行：原目录与账本里出现过的 Agent 会话 id、最早记下的时间。项目会话列表靠它
/// 继续列出在已删 worktree 里跑过的会话、判断它们由 Berth 启动；既没有目录也没有会话的什么都不留。
fn retired_entry(worktree: Option<&str>, events: &[Value]) -> Option<Value> {
    let mut sessions: Vec<&str> = Vec::new();
    let mut since: Option<u64> = None;
    for event in events {
        if let Some(id) = text(event, "session_id") {
            if !sessions.contains(&id) {
                sessions.push(id);
            }
            if let Some(at) = event.get("timestamp_ms").and_then(Value::as_u64) {
                since = Some(since.map_or(at, |since| since.min(at)));
            }
        }
    }
    (worktree.is_some() || !sessions.is_empty())
        .then(|| json!({"worktree": worktree, "sessions": sessions, "since": since}))
}

/// 删掉一个群在 `runtime/` 下的投递标记与成员 hook 状态（按群、成员、pane 派生的路径）。
fn forget_runtime(main: &Path, name: &str, events: &[Value]) {
    for event in events {
        let (Some(member), Some(target_ref)) = (text(event, "author"), text(event, "target_ref"))
        else {
            continue;
        };
        let delivery = delivery_path(main, name, member, target_ref);
        for ext in ["seq", "lock", "collector"] {
            let _ = fs::remove_file(delivery.with_extension(ext));
        }
        let _ = fs::remove_file(member_state_path(main, name, member, target_ref));
    }
}

/// 本机运行态（投递标记、后台进程锁），与账本同在 `local/`。
pub fn runtime_dir(main: &Path) -> PathBuf {
    local_dir(main).join("runtime")
}

/// 成员 hook 状态路径：GUI 与 CLI 共用既有持久化键，不改格式。
pub fn member_state_path(main: &Path, name: &str, member: &str, target_ref: &str) -> PathBuf {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("{name}\0{member}\0{target_ref}").as_bytes());
    let key: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    runtime_dir(main)
        .join("members")
        .join(format!("{key}.json"))
}

/// 这个运行目标明确绑定的当前会话；hook 报告的会话优先于历史汇报（支持 /clear）。
pub fn bound_session_id(main: &Path, name: &str, target_ref: &str) -> Option<String> {
    bound_session_in(main, name, &events(main, name).ok()?, target_ref)
}

/// [`bound_session_id`]，账本已读出时用。
pub fn bound_session_in(
    main: &Path,
    name: &str,
    events: &[Value],
    target_ref: &str,
) -> Option<String> {
    let member = member_of(events, target_ref)?;
    let state: Option<Value> = fs::read(member_state_path(main, name, &member.name, target_ref))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok());
    state
        .as_ref()
        .and_then(|state| text(state, "sessionId"))
        .or_else(|| {
            events
                .iter()
                .rev()
                .find(|event| {
                    text(event, "author") == Some(member.name.as_str())
                        && text(event, "target_ref").is_none_or(|own| own == target_ref)
                        && text(event, "session_id").is_some()
                })
                .and_then(|event| text(event, "session_id"))
        })
        .map(str::to_owned)
}

fn meta_path(main: &Path) -> PathBuf {
    dir(main).join("groups.json")
}

fn events_path(main: &Path, name: &str) -> PathBuf {
    dir(main).join(format!("{name}.jsonl"))
}

/// 账本读写前的检查：`.berth/` 只由 `berth init` 创建；`local/` 的忽略文件补齐（运行态绝不能被提交）。
pub fn prepare(main: &Path) -> TaskResult<()> {
    if !main.join(".berth").is_dir() {
        return Err(super::hub::not_initialized(main));
    }
    let ignore = local_dir(main).join(".gitignore");
    if !ignore.exists() {
        fsutil::atomic_write(&ignore, b"*\n")?;
    }
    Ok(())
}

pub fn validate_name(name: &str) -> TaskResult<String> {
    fsutil::safe_component(name, "group name", NAME_MAX)
}

/// `groups.json`；不存在时为空表。
pub fn meta(main: &Path) -> TaskResult<Value> {
    let value = fsutil::read_json(&meta_path(main))?
        .unwrap_or_else(|| json!({"version": 1, "groups": {}}));
    if !value.get("groups").is_some_and(Value::is_object) {
        return Err(TaskError::new("invalid_json", "Malformed group metadata"));
    }
    Ok(value)
}

/// 群的元数据条目；不存在为 `None`。
pub fn info(main: &Path, name: &str) -> TaskResult<Option<Value>> {
    Ok(meta(main)?["groups"].get(name).cloned())
}

/// 任务中心所在目录的项目群内部键；显示名始终取目录名。
pub const MAIN_GROUP: &str = "main";

/// 任务所在的群（实时状态里的引用）。
pub fn group_of_task(main: &Path, task: &str) -> TaskResult<Option<String>> {
    Ok(super::state::load(main)?
        .tasks
        .get(task)
        .and_then(|live| live.group.clone()))
}

/// 群组持有的执行环境（群目录的分支与 worktree，对账时记录；基线是主项目当前分支）：任务只是群里的条目，换主任务、
/// 移走或归档任务都不改变它。存在 `groups.json` 的群条目 `env` 里。
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GroupEnv {
    pub branch: String,
    pub base_branch: String,
    pub worktree: String,
}

fn env_of(entry: &Value) -> Option<GroupEnv> {
    let env = entry.get("env")?;
    let text = |key: &str| env.get(key).and_then(Value::as_str).map(str::to_owned);
    Some(GroupEnv {
        branch: text("branch")?,
        base_branch: text("baseBranch")?,
        worktree: text("worktree")?,
    })
}

/// 群组的执行环境；群不存在或没有 `env`（旧群、`main`）为 `None`。
pub fn env(main: &Path, name: &str) -> TaskResult<Option<GroupEnv>> {
    Ok(info(main, name)?.as_ref().and_then(env_of))
}

/// 全部持有环境的群组（群名，环境）。
pub fn envs(main: &Path) -> TaskResult<Vec<(String, GroupEnv)>> {
    let meta = meta(main)?;
    let checkouts = super::git::worktrees(main);
    Ok(meta["groups"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(name, entry)| env_of(entry).map(|env| (name.clone(), env)))
        .filter(|(_, env)| {
            let path = Path::new(&env.worktree);
            path.is_dir()
                && (super::git::same_path(path, main)
                    || checkouts
                        .iter()
                        .any(|checkout| super::git::same_path(&checkout.path, path)))
        })
        .collect())
}

/// 写（`Some`）或清除（`None`）群组环境。一个 worktree 只属于一个群：
/// 本项目另一个群已持有同一路径时拒绝（`conflict`）。
pub fn set_env(main: &Path, name: &str, env: Option<&GroupEnv>) -> TaskResult<()> {
    let _guard = fsutil::lock(&dir(main).join(".lock"))?;
    let mut meta = meta(main)?;
    let groups = meta["groups"].as_object_mut().expect("checked object");
    if !groups.contains_key(name) {
        return Err(TaskError::new(
            "not_found",
            format!("Group not found: {name}"),
        ));
    }
    if let Some(env) = env {
        let holder = groups
            .iter()
            .filter(|(other, _)| other.as_str() != name)
            .find(|(_, entry)| {
                env_of(entry).is_some_and(|held| {
                    super::git::same_path(Path::new(&held.worktree), Path::new(&env.worktree))
                })
            });
        if let Some((other, _)) = holder {
            return Err(TaskError::new(
                "conflict",
                format!("Worktree {} already belongs to group {other}", env.worktree),
            ));
        }
    }
    let entry = groups
        .get_mut(name)
        .and_then(Value::as_object_mut)
        .ok_or_else(|| TaskError::new("not_found", format!("Group not found: {name}")))?;
    match env {
        Some(env) => entry.insert(
            "env".to_owned(),
            json!({"branch": env.branch, "baseBranch": env.base_branch, "worktree": env.worktree}),
        ),
        None => entry.remove("env"),
    };
    fsutil::write_json(&meta_path(main), &meta)
}

/// worktree 目录（与分支）改名后同步群环境与任务实时状态。群按目录路径认，不同步就会被对账成新群、
/// 旧群丢环境；目录已搬走，所以按记录的路径字符串找群（不经 `envs`，它会滤掉不存在的目录）。
/// `branch` 为 `(旧名, 新名)`。项目未启用 Berth 时无事可做。
pub fn move_checkout(
    main: &Path,
    from: &Path,
    to: &Path,
    branch: Option<(&str, &str)>,
) -> TaskResult<()> {
    if !main.join(".berth").is_dir() {
        return Ok(());
    }
    let meta = meta(main)?;
    let held = meta["groups"]
        .as_object()
        .into_iter()
        .flatten()
        .filter_map(|(name, entry)| env_of(entry).map(|env| (name.clone(), env)))
        .find(|(_, env)| Path::new(&env.worktree) == from);
    if let Some((name, mut env)) = held {
        env.worktree = to.to_string_lossy().into_owned();
        if let Some((_, new)) = branch.filter(|(old, _)| env.branch == *old) {
            env.branch = new.to_owned();
        }
        set_env(main, &name, Some(&env))?;
    }
    super::state::update(main, |state| {
        for live in state.tasks.values_mut() {
            if live.worktree.as_deref().map(Path::new) == Some(from) {
                live.worktree = Some(to.to_string_lossy().into_owned());
            }
            if let Some((old, new)) = branch {
                if live.branch.as_deref() == Some(old) {
                    live.branch = Some(new.to_owned());
                }
            }
        }
        Ok(())
    })
}

/// 群不存在就建（不绑定任务，如 `main`）。
pub fn ensure_group(main: &Path, name: &str) -> TaskResult<()> {
    match create(main, name) {
        Ok(_) => Ok(()),
        Err(error) if error.code == "already_exists" => Ok(()),
        Err(error) => Err(error),
    }
}

/// worktree 的 checkout 记录：只在 `groups.json` 登记（任务分配、收尾据此找到目录），不建账本——
/// 一个项目一个群，消息都在 `main`。
fn register_checkout(main: &Path, name: &str) -> TaskResult<()> {
    let _guard = fsutil::lock(&dir(main).join(".lock"))?;
    let mut meta = meta(main)?;
    let groups = meta["groups"].as_object_mut().expect("checked object");
    if groups.contains_key(name) {
        return Ok(());
    }
    groups.insert(name.to_owned(), json!({"createdAt": now()}));
    fsutil::write_json(&meta_path(main), &meta)
}

/// 群（旧版 worktree 群）有没有账本：没有的只是 checkout 记录。
pub fn has_ledger(main: &Path, name: &str) -> bool {
    events_path(main, name).is_file()
}

/// 对账实际存在的 checkout：主目录补建项目群，没有记录的 worktree 补一条 checkout 记录。
pub fn checkout_groups(main: &Path) -> TaskResult<Vec<(String, GroupEnv)>> {
    prepare(main)?;
    let _guard = fsutil::lock(&dir(main).join(".checkout-groups.lock"))?;
    let legacy_state = super::state::load(main)?;
    let legacy_meta = meta(main)?;
    ensure_group(main, MAIN_GROUP)?;
    let mut groups = envs(main)?;
    // worktree 群的基线是主项目当前分支（收尾据此判断是否已合并）；修正旧记录里基线等于分支本身的。
    let main_branch = super::git::current_branch(main);
    for (name, env) in groups.iter_mut() {
        if let Some(base) = main_branch.as_deref().filter(|base| {
            env.base_branch == env.branch
                && *base != env.branch
                && !super::git::same_path(Path::new(&env.worktree), main)
        }) {
            env.base_branch = base.to_owned();
            set_env(main, name, Some(env))?;
        }
    }
    let mut checkouts = super::git::worktrees(main);
    if checkouts.is_empty() {
        checkouts.push(super::git::Worktree {
            path: main.to_path_buf(),
            branch: super::git::current_branch(main),
        });
    }
    for checkout in &checkouts {
        if !checkout.path.is_dir() {
            continue;
        }
        if groups
            .iter()
            .any(|(_, env)| super::git::same_path(Path::new(&env.worktree), &checkout.path))
        {
            continue;
        }
        let name = if super::git::same_path(&checkout.path, main) {
            MAIN_GROUP.to_owned()
        } else {
            format!("checkout-{}", uuid::Uuid::new_v4())
        };
        register_checkout(main, &name)?;
        let branch = checkout.branch.clone().unwrap_or_default();
        let base_branch = if name == MAIN_GROUP {
            branch.clone()
        } else {
            main_branch.clone().unwrap_or_else(|| branch.clone())
        };
        let env = GroupEnv {
            base_branch,
            branch,
            worktree: checkout.path.to_string_lossy().into_owned(),
        };
        set_env(main, &name, Some(&env))?;
        groups.push((name, env));
    }
    // 一次性转换旧任务引用（`tasks.json` 版本 1）；此后任务只读显式的项目群组引用。
    if legacy_state.version < 2 {
        super::state::update(main, |state| {
            if state.version >= 2 {
                return Ok(());
            }
            for live in state.tasks.values_mut() {
                let old_env = live
                    .group
                    .as_ref()
                    .and_then(|name| legacy_meta["groups"].get(name))
                    .and_then(env_of);
                let path = live
                    .worktree
                    .as_deref()
                    .map(Path::new)
                    .or_else(|| old_env.as_ref().map(|env| Path::new(&env.worktree)))
                    .or_else(|| {
                        checkouts
                            .iter()
                            .find(|checkout| {
                                checkout.branch.as_deref() == live.branch.as_deref()
                                    && live.branch.is_some()
                            })
                            .map(|checkout| checkout.path.as_path())
                    });
                let group = path
                    .and_then(|path| {
                        groups
                            .iter()
                            .find(|(_, env)| super::git::same_path(Path::new(&env.worktree), path))
                    })
                    .or_else(|| {
                        live.group
                            .as_ref()
                            .and_then(|name| groups.iter().find(|(group, _)| group == name))
                    })
                    .map(|(group, _)| group.clone())
                    .unwrap_or_else(|| MAIN_GROUP.to_owned());
                live.group = Some(group);
            }
            state.version = 2;
            Ok(())
        })?;
    }
    Ok(groups)
}

/// 当前目录的唯一群组。
pub fn checkout_group(root: &Path) -> TaskResult<(String, GroupEnv)> {
    let super::hub::Scope { checkout, main } = super::hub::resolve(root)?;
    checkout_groups(&main)?
        .into_iter()
        .find(|(_, env)| super::git::same_path(Path::new(&env.worktree), &checkout))
        .ok_or_else(|| TaskError::new("not_found", "Checkout has no group"))
}

/// 解析活动项目群组的内部键或目录显示名。
pub fn project_group(main: &Path, name: &str) -> TaskResult<(String, GroupEnv)> {
    let matches: Vec<_> = checkout_groups(main)?
        .into_iter()
        .filter(|(key, env)| {
            key == name
                || Path::new(&env.worktree)
                    .file_name()
                    .is_some_and(|part| part == name)
        })
        .collect();
    if matches.len() != 1 {
        return Err(TaskError::new(
            "invalid_group",
            "Choose an existing project group",
        ));
    }
    Ok(matches
        .into_iter()
        .next()
        .expect("one matching project group"))
}

pub fn events(main: &Path, name: &str) -> TaskResult<Vec<Value>> {
    read_events(&events_path(main, name))
}

fn read_events(path: &Path) -> TaskResult<Vec<Value>> {
    if !path.exists() {
        return Ok(Vec::new());
    }
    let text = fsutil::read_text(path, MAX_GROUP_BYTES)?;
    let mut out = Vec::new();
    for line in text.lines().filter(|line| !line.trim().is_empty()) {
        let value: Value = serde_json::from_str(line).map_err(|error| {
            TaskError::new(
                "invalid_json",
                format!("Malformed group event: {}: {error}", path.display()),
            )
        })?;
        if value.is_object() {
            out.push(value);
        }
    }
    Ok(out)
}

/// 新建群；已存在报 `already_exists`。返回 `created` 事件。
pub fn create(main: &Path, name: &str) -> TaskResult<Value> {
    let _guard = fsutil::lock(&dir(main).join(".lock"))?;
    let mut meta = meta(main)?;
    let groups = meta["groups"].as_object_mut().expect("checked object");
    if groups.contains_key(name) {
        return Err(TaskError::new("already_exists", "Group already exists"));
    }
    groups.insert(name.to_owned(), json!({"createdAt": now()}));
    fsutil::write_json(&meta_path(main), &meta)?;
    Ok(append_locked(main, name, json!({"kind": "created"}))?.0)
}

/// 删除群（群收尾、撤销开工中途新建的群）：账本与 `runtime/` 下的投递标记、成员 hook 状态删掉，
/// 在 `retired` 里留一行（[`retired_entry`]）。
pub fn remove(main: &Path, name: &str) -> TaskResult<()> {
    let _guard = fsutil::lock(&dir(main).join(".lock"))?;
    let mut meta = meta(main)?;
    let path = events_path(main, name);
    let events = read_events(&path).unwrap_or_default();
    let entry = meta["groups"]
        .as_object_mut()
        .and_then(|groups| groups.remove(name));
    let worktree = entry
        .as_ref()
        .and_then(|entry| entry.pointer("/env/worktree"))
        .and_then(Value::as_str);
    if let Some(line) = retired_entry(worktree, &events) {
        if !meta["retired"].is_object() {
            meta["retired"] = json!({});
        }
        meta["retired"][name] = line;
    }
    fsutil::write_json(&meta_path(main), &meta)?;
    forget_runtime(main, name, &events);
    let _ = fs::remove_file(path);
    Ok(())
}

/// 追加事件，补 `schema_version` / `seq` / `timestamp_ms`。
pub fn append(main: &Path, name: &str, event: Value) -> TaskResult<Value> {
    Ok(append_new(main, name, event)?.0)
}

/// 同 [`append`]；带 `idempotency_key` 且已有同键事件时不再写，返回旧事件与 `false`。
pub fn append_new(main: &Path, name: &str, event: Value) -> TaskResult<(Value, bool)> {
    let _guard = fsutil::lock(&dir(main).join(".lock"))?;
    append_locked(main, name, event)
}

fn append_locked(main: &Path, name: &str, event: Value) -> TaskResult<(Value, bool)> {
    let mut event: Map<String, Value> = match event {
        Value::Object(map) => map,
        _ => {
            return Err(TaskError::new(
                "invalid_input",
                "group event must be an object",
            ))
        }
    };
    let existing = events(main, name)?;
    if let Some(key) = event
        .get("idempotency_key")
        .and_then(Value::as_str)
        .filter(|key| !key.is_empty())
    {
        if let Some(previous) = existing
            .iter()
            .find(|previous| previous.get("idempotency_key").and_then(Value::as_str) == Some(key))
        {
            return Ok((previous.clone(), false));
        }
    }
    event.insert("schema_version".into(), json!(1));
    event.insert("seq".into(), json!(last_seq(&existing) + 1));
    event.insert(
        "timestamp_ms".into(),
        json!(chrono::Utc::now().timestamp_millis()),
    );
    let line = serde_json::to_string(&event)
        .map_err(|error| TaskError::new("io_error", error.to_string()))?;
    let mut handle = OpenOptions::new()
        .create(true)
        .append(true)
        .open(events_path(main, name))?;
    handle.write_all(format!("{line}\n").as_bytes())?;
    Ok((Value::Object(event), true))
}

pub fn seq(event: &Value) -> u64 {
    event.get("seq").and_then(Value::as_u64).unwrap_or(0)
}

pub fn last_seq(events: &[Value]) -> u64 {
    events.iter().map(seq).max().unwrap_or(0)
}

/// 群主未读：已读位置之后、别人发给群主或全体的消息条数（项目行角标）。`seen` 把已读位置推进到该 seq；
/// 没有已读记录的群从当前末尾算起，历史不算未读。已读位置存在本机运行态，不进 git。
pub fn unread(main: &Path, name: &str, seen: Option<u64>) -> TaskResult<usize> {
    let events = events(main, name)?;
    let path = runtime_dir(main).join("read.json");
    let _guard = fsutil::lock(&runtime_dir(main).join("read.json.lock"))?;
    let mut marks = fsutil::read_json(&path)?
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    let stored = marks.get(name).and_then(Value::as_u64);
    let read = stored
        .unwrap_or_else(|| last_seq(&events))
        .max(seen.unwrap_or(0));
    if stored != Some(read) {
        marks[name] = json!(read);
        fsutil::write_json(&path, &marks)?;
    }
    Ok(events
        .iter()
        .filter(|event| {
            seq(event) > read
                && text(event, "kind") == Some("message")
                && text(event, "author") != Some(USER)
                && text(event, "to").is_none_or(|to| to == USER)
        })
        .count())
}

fn text<'a>(event: &'a Value, key: &str) -> Option<&'a str> {
    event
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
}

/// 群里的一位成员（专家）：可以同时有几个终端（[`Body`]）在干活，群里仍是一个成员。
/// 第一个终端入群算入群，最后一个终端离群算离群。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Member {
    pub name: String,
    /// 在群的终端，按入群先后；不在终端里 `join --as` 的成员没有，只能自己 `read`。
    pub bodies: Vec<Body>,
    pub joined_seq: u64,
    pub joined_at: Option<i64>,
    /// 群主起的显示名（[`rename`]）；离群再入群仍保留。
    pub label: Option<String>,
}

/// 成员的一个终端：`joined` 事件带 `target_ref` 时登记，同一终端的 `left` 时去掉。
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Body {
    pub target_ref: String,
    /// Agent 插件 id（Berth 识别出的 Agent pane）。
    pub agent: Option<String>,
    pub cwd: Option<String>,
    /// 一轮结束由 Berth 收集回复贴回群（派生的成员、spawn 的 worker、自己 join 的 Agent）。
    pub collect: bool,
    /// 由后台进程按 worktree 派生（离开 worktree / pane 消失即离群）。
    pub derived: bool,
    pub joined_seq: u64,
    pub joined_at: Option<i64>,
}

impl Member {
    pub fn body(&self, target_ref: &str) -> Option<&Body> {
        self.bodies.iter().find(|body| body.target_ref == target_ref)
    }
}

/// 当前在群的成员，按入群先后。
pub fn members(events: &[Value]) -> Vec<Member> {
    roster(events)
        .into_iter()
        .filter(|(_, left_at)| left_at.is_none())
        .map(|(member, _)| member)
        .collect()
}

/// 终端（`target_ref`）所属的在群成员。
pub fn member_of(events: &[Value], target_ref: &str) -> Option<Member> {
    members(events)
        .into_iter()
        .find(|member| member.body(target_ref).is_some())
}

/// 来过群的全部成员（含已离群的）及离群时间（在群为 `None`），按最近一次入群先后。
/// 离群的成员保留离群前最后的终端，供成员详情显示。
pub fn roster(events: &[Value]) -> Vec<(Member, Option<i64>)> {
    let mut latest: BTreeMap<String, (Member, Option<i64>)> = BTreeMap::new();
    for event in events {
        let Some(author) = text(event, "author") else {
            continue;
        };
        let at = event.get("timestamp_ms").and_then(Value::as_i64);
        let target_ref = text(event, "target_ref");
        match event.get("kind").and_then(Value::as_str) {
            Some("joined") => {
                let entry = latest.entry(author.to_owned()).or_insert_with(|| {
                    let member = Member {
                        name: author.to_owned(),
                        bodies: Vec::new(),
                        joined_seq: 0,
                        joined_at: None,
                        label: None,
                    };
                    (member, Some(0))
                });
                if entry.1.is_some() {
                    entry.0.bodies.clear();
                    entry.0.joined_seq = seq(event);
                    entry.0.joined_at = at;
                    entry.1 = None;
                }
                if let Some(target_ref) = target_ref {
                    let flag = |key| event.get(key).and_then(Value::as_bool).unwrap_or(false);
                    entry.0.bodies.retain(|body| body.target_ref != target_ref);
                    entry.0.bodies.push(Body {
                        target_ref: target_ref.to_owned(),
                        agent: text(event, "agent").map(str::to_owned),
                        cwd: text(event, "cwd").map(str::to_owned),
                        collect: flag("collect"),
                        derived: flag("derived"),
                        joined_seq: seq(event),
                        joined_at: at,
                    });
                }
            }
            Some("left") => {
                let Some(entry) = latest.get_mut(author).filter(|entry| entry.1.is_none()) else {
                    continue;
                };
                // 带终端的只走这个终端；最后一个终端走了（或不带终端）成员才离群。
                let rest = match target_ref {
                    Some(target_ref) => entry.0.bodies.iter().filter(|body| body.target_ref != target_ref).cloned().collect(),
                    None => Vec::new(),
                };
                if rest.is_empty() {
                    entry.1 = Some(at.unwrap_or(0));
                } else {
                    entry.0.bodies = rest;
                }
            }
            _ => {}
        }
    }
    for (member, label) in labels(events) {
        if let Some(entry) = latest.get_mut(&member) {
            entry.0.label = Some(label);
        }
    }
    let mut out: Vec<(Member, Option<i64>)> = latest.into_values().collect();
    out.sort_by_key(|(member, _)| member.joined_seq);
    out
}

/// 成员名 → 显示名：每人以最近一条 `renamed` 为准，空显示名表示改回成员名。
fn labels(events: &[Value]) -> BTreeMap<String, String> {
    let mut out = BTreeMap::new();
    for event in events {
        if event.get("kind").and_then(Value::as_str) != Some("renamed") {
            continue;
        }
        let Some(member) = text(event, "member") else {
            continue;
        };
        match text(event, "label").filter(|label| *label != member) {
            Some(label) => out.insert(member.to_owned(), label.to_owned()),
            None => out.remove(member),
        };
    }
    out
}

/// 群主给来过群的成员起显示名（`label` 为空或等于成员名则改回成员名），记一条 `renamed` 事件。
/// 显示名不能含空白或 `@`（输入框按 `@显示名 ` 点名），不能与其他成员的名字或显示名相同。
pub fn rename(main: &Path, name: &str, member: &str, label: Option<&str>) -> TaskResult<Value> {
    // 起成自己的成员名等于改回原名。
    let label = label
        .map(str::trim)
        .filter(|label| !label.is_empty() && *label != member);
    if let Some(label) = label {
        if label.chars().count() > LABEL_MAX
            || label
                .chars()
                .any(|c| c.is_whitespace() || c.is_control() || c == '@')
        {
            return Err(TaskError::new(
                "invalid_input",
                format!("显示名最多 {LABEL_MAX} 个字符，不能含空白或 @"),
            ));
        }
    }
    let _guard = fsutil::lock(&dir(main).join(".lock"))?;
    let events = events(main, name)?;
    let roster = roster(&events);
    if !roster.iter().any(|(entry, _)| entry.name == member) {
        return Err(TaskError::new(
            "not_found",
            format!("{member} 不是这个群的成员"),
        ));
    }
    if let Some(label) = label {
        let taken = label == USER
            || roster.iter().any(|(entry, _)| {
                entry.name != member
                    && (entry.name == label || entry.label.as_deref() == Some(label))
            });
        if taken {
            return Err(TaskError::new(
                "already_exists",
                format!("显示名 {label} 已被其他成员使用"),
            ));
        }
    }
    Ok(append_locked(
        main,
        name,
        json!({"kind": "renamed", "author": USER, "member": member, "label": label}),
    )?
    .0)
}

/// 任务契约（prd.md）当前版本：最近一条 `spec` 事件的 rev，没有则为 1。
pub fn spec_rev(events: &[Value]) -> u64 {
    events
        .iter()
        .filter(|event| event.get("kind").and_then(Value::as_str) == Some("spec"))
        .filter_map(|event| event.get("rev").and_then(Value::as_u64))
        .max()
        .unwrap_or(1)
}

/// 发给 `participant` 的消息（`kind: message` 且 `to` 是它）。
pub fn messages_to<'a>(
    events: &'a [Value],
    participant: &'a str,
) -> impl Iterator<Item = &'a Value> {
    events.iter().filter(move |event| {
        event.get("kind").and_then(Value::as_str) == Some("message")
            && text(event, "to") == Some(participant)
    })
}

/// `read`：`after` 之后、发给所有人或 `to` 的事件（最多 500 条）与下一个游标。
pub fn read(events: &[Value], after: u64, to: Option<&str>) -> Value {
    let selected: Vec<&Value> = events
        .iter()
        .filter(|event| seq(event) > after)
        .filter(|event| match to {
            None => true,
            Some(to) => text(event, "to").is_none_or(|target| target == to),
        })
        .collect();
    let start = selected.len().saturating_sub(500);
    json!({
        "events": selected[start..],
        "nextAfter": last_seq(events).max(after),
    })
}

fn delivery_key(target_ref: &str, name: &str, participant: &str) -> String {
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(format!("{target_ref}\0{name}\0{participant}").as_bytes());
    digest
        .iter()
        .take(16)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// 投递标记与投递锁的路径前缀（同一 pane、群、成员一组）。
pub fn delivery_path(main: &Path, name: &str, participant: &str, target_ref: &str) -> PathBuf {
    runtime_dir(main)
        .join("doorbell")
        .join(delivery_key(target_ref, name, participant))
}

/// 已送达该 pane 的最大 seq（没有为 0）。GUI 据此显示「已送达 / 排队中」。
pub fn delivered_seq(main: &Path, name: &str, participant: &str, target_ref: &str) -> u64 {
    fs::read_to_string(delivery_path(main, name, participant, target_ref).with_extension("seq"))
        .ok()
        .and_then(|text| text.trim().parse().ok())
        .unwrap_or(0)
}

pub fn set_delivered(
    main: &Path,
    name: &str,
    participant: &str,
    target_ref: &str,
    seq: u64,
) -> TaskResult<()> {
    fsutil::atomic_write(
        &delivery_path(main, name, participant, target_ref).with_extension("seq"),
        seq.to_string().as_bytes(),
    )
}

/// 发给成员的消息的送达状态（GUI 时间线用），按 seq：
/// `delivered` 已投进它的 pane；`queued` 它还在群、还没投到（忙、停在对话框、后台进程没在跑）；
/// `undelivered` 它已离群，或这条消息早于它最近一次入群（不会再投）。hook 贴回的汇报与发给群主的不算。
/// 成员从哪条之后的消息开始该收：上次全部离群的位置（离线时发给它的，回来后照投），从没离过群就是入群位置。
pub fn delivery_floor(events: &[Value], member: &Member) -> u64 {
    events
        .iter()
        .filter(|event| event.get("kind").and_then(Value::as_str) == Some("left"))
        .filter(|event| text(event, "author") == Some(member.name.as_str()))
        .map(seq)
        .filter(|left| *left < member.joined_seq)
        .max()
        .unwrap_or(member.joined_seq)
}

pub fn delivery_states(main: &Path, name: &str, events: &[Value]) -> BTreeMap<u64, &'static str> {
    let current: BTreeMap<String, Member> = members(events)
        .into_iter()
        .map(|member| (member.name.clone(), member))
        .collect();
    // 每次入群（可能换过 pane）各有一段投递区间：上次离群（没离过就是入群）之后、投递标记之前的消息已送达。
    let mut delivered: BTreeMap<&str, Vec<(u64, u64)>> = BTreeMap::new();
    let mut last_left: BTreeMap<&str, u64> = BTreeMap::new();
    for event in events {
        if event.get("kind").and_then(Value::as_str) == Some("left") {
            if let Some(author) = text(event, "author") {
                last_left.insert(author, seq(event));
            }
            continue;
        }
        if event.get("kind").and_then(Value::as_str) != Some("joined") {
            continue;
        }
        let (Some(author), Some(target_ref)) = (text(event, "author"), text(event, "target_ref"))
        else {
            continue;
        };
        delivered
            .entry(author)
            .or_default()
            .push((
                last_left.get(author).copied().unwrap_or(seq(event)),
                delivered_seq(main, name, author, target_ref),
            ));
    }
    events
        .iter()
        .filter(|event| event.get("kind").and_then(Value::as_str) == Some("message"))
        .filter(|event| text(event, "source") != Some("transcript"))
        .filter_map(|event| {
            let to = text(event, "to").filter(|to| *to != USER)?;
            let seq = seq(event);
            let ranges = delivered.get(to).map(Vec::as_slice).unwrap_or_default();
            let state = if ranges
                .iter()
                .any(|(joined, marker)| *joined < seq && seq <= *marker)
            {
                "delivered"
            } else {
                match current.get(to) {
                    Some(member) if !member.bodies.is_empty() && delivery_floor(events, member) < seq => {
                        "queued"
                    }
                    _ => "undelivered",
                }
            };
            Some((seq, state))
        })
        .collect()
}

fn short_hash(text: &str) -> String {
    use sha2::{Digest, Sha256};
    Sha256::digest(text.as_bytes())
        .iter()
        .take(8)
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// 后台进程 `berth group watch` 的单实例锁：每个主项目 × termd 端点一个。
pub fn watch_lock_path(main: &Path, socket: &Path) -> PathBuf {
    runtime_dir(main).join(format!(
        "watch-{}.lock",
        short_hash(&socket.to_string_lossy())
    ))
}

/// 后台进程是否在跑（锁被占用）。
pub fn watch_running(main: &Path, socket: &Path) -> bool {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(watch_lock_path(main, socket))
        .is_ok_and(|handle| handle.try_lock().is_err())
}
