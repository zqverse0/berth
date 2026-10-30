//! 任务监控视图（群组）的进程内读写：单任务派生视图、开工、群时间线 + 成员 + 送达状态。
//! 发消息见 [`super::call`]（`berth_group::post`）：GUI 发的消息排队，由后台进程 `berth group watch`
//! 在成员空闲时送达，这里负责拉起它。

use std::collections::HashMap;
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use berth_project_core::tasks::{self, group, FinishOptions};
use serde_json::{json, Value};

/// 以 pane 同款身份运行 berth-cli 所需：termd 端点与启动环境。
pub struct CliLaunch {
    pub socket: PathBuf,
    pub env: HashMap<String, String>,
}

fn text<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
}

fn required<'a>(params: &'a Value, key: &str) -> Result<&'a str, String> {
    text(params, key).ok_or_else(|| format!("{key} is required"))
}

/// 任务摘要列表（含归档；读不了的进 `diagnostics`），与 `berth task list --archived` 同一实现。
pub fn task_list(root: &Path) -> Result<Value, String> {
    tasks::list(root, true, 500).map_err(|error| error.message)
}

/// 单个任务的派生视图（不跑全量 `task views`）。
pub fn task_view(root: &Path, params: &Value) -> Result<Value, String> {
    let view = tasks::show(root, Some(required(params, "task")?)).map_err(|error| error.message)?;
    serde_json::to_value(view).map_err(|error| error.to_string())
}

/// 开工：只改任务状态（`begin`）；环境属于群，新建 worktree 即新建群。
pub fn start(root: &Path, params: &Value) -> Result<Value, String> {
    tasks::begin(root, required(params, "task")?).map_err(|error| error.message)
}

/// 任务页保存：`steps` 改步骤；`body` + `baseBody` 改正文（磁盘正文与 baseBody 不同则冲突）。
pub fn save(root: &Path, params: &Value) -> Result<Value, String> {
    let steps = params
        .get("steps")
        .filter(|steps| !steps.is_null())
        .map(|steps| serde_json::from_value(steps.clone()))
        .transpose()
        .map_err(|error| format!("Invalid steps: {error}"))?;
    let raw = |key: &str| params.get(key).and_then(Value::as_str);
    let body = raw("body").map(|body| {
        (
            raw("baseBody").unwrap_or_default().to_owned(),
            body.to_owned(),
        )
    });
    tasks::save(root, required(params, "task")?, steps, body).map_err(|error| error.message)
}

fn flag(params: &Value, key: &str) -> bool {
    params.get(key).and_then(Value::as_bool).unwrap_or(false)
}

/// 收尾（`abandon` 时为放弃，`keepBranch` 保留分支）：`dryRun` 时只返回检查结果（`ready`、`dirty`）
/// 给确认框；成员 pane 由前端先关，worktree 子项目由前端随后对账移除。
pub fn finish(root: &Path, params: &Value) -> Result<Value, String> {
    let options = FinishOptions {
        dry_run: flag(params, "dryRun"),
        abandon: flag(params, "abandon"),
        keep_branch: flag(params, "keepBranch"),
    };
    let result = if let Some(group) = text(params, "group") {
        tasks::finish_group(root, group, options)
    } else {
        let task = required(params, "task")?;
        match text(params, "operation") {
            Some("reopen") => tasks::reopen(root, task),
            Some("cancel") => tasks::archive(root, task, text(params, "reason").or(Some(""))),
            None | Some("complete") => tasks::finish(root, task, options),
            Some(operation) => return Err(format!("Unknown task operation: {operation}")),
        }
    };
    result.map_err(|error| error.message)
}

/// 当前 checkout 的唯一群组；`all` 时列出项目全部群组（主目录 + 各 worktree，分配任务用）。
/// 历史频道不进入项目群导航。
pub fn list(root: &Path, params: &Value) -> Result<Value, String> {
    let groups = if flag(params, "all") {
        let main = tasks::resolve(root).map_err(|error| error.message)?.main;
        group::checkout_groups(&main).map_err(|error| error.message)?
    } else {
        vec![group::checkout_group(root).map_err(|error| error.message)?]
    };
    let names: Vec<&String> = groups.iter().map(|(name, _)| name).collect();
    let worktrees: serde_json::Map<String, Value> = groups
        .iter()
        .map(|(name, env)| (name.clone(), Value::from(env.worktree.clone())))
        .collect();
    Ok(json!({ "groups": names, "worktrees": worktrees }))
}

/// 项目行未读数：项目群的未读条数，键是主目录路径（一个项目一个群，worktree 行不单独计）。
/// 带 `seen: {group, seq}` 时先推进该群已读位置。
///
/// 侧栏对每个根项目每 5 秒调一次：未启用 Berth 的项目直接返回空。
pub fn unread(root: &Path, params: &Value) -> Result<Value, String> {
    let main = match tasks::resolve(root) {
        Ok(scope) => scope.main,
        Err(error) if error.code == "not_initialized" => return Ok(json!({ "worktrees": {} })),
        Err(error) => return Err(error.message),
    };
    let seen = params.get("seen");
    let seen_group = seen.and_then(|seen| text(seen, "group"));
    let seen_seq = seen
        .and_then(|seen| seen.get("seq"))
        .and_then(Value::as_u64);
    let name = group::MAIN_GROUP;
    let seen = seen_seq.filter(|_| seen_group == Some(name));
    let count = group::unread(&main, name, seen).map_err(|error| error.message)?;
    Ok(json!({ "worktrees": { main.to_string_lossy(): count } }))
}

/// 把任务分配给群组（`group` 为 `main` 或已有群组）。
pub fn assign(root: &Path, params: &Value) -> Result<Value, String> {
    tasks::assign(root, required(params, "task")?, required(params, "group")?)
        .map_err(|error| error.message)
}

/// 任务群组：`after` 之后的事件、来过群的全部成员、发给成员的消息的送达状态。还没有群组时 `channel` 为 null。
pub fn read(root: &Path, params: &Value) -> Result<Value, String> {
    let after = params.get("after").and_then(Value::as_u64).unwrap_or(0);
    let main = tasks::resolve(root).map_err(|error| error.message)?.main;
    // 一个项目一个群：主目录和各 worktree 打开的都是项目群；旧 tab 的群名不能把它切到别的群。
    let name = group::MAIN_GROUP.to_owned();
    let events = group::events(&main, &name).map_err(|error| error.message)?;
    // 成员名是专家 id：附上专家的显示名（`experts/<id>.json` 的 `name`）。
    let experts: std::collections::HashMap<String, String> =
        berth_tool_core::paths::experts(&crate::platform::paths::berth_home_dir())
            .unwrap_or_default()
            .into_iter()
            .collect();
    let members: Vec<Value> = group::roster(&events)
        .into_iter()
        .map(|(member, left_at)| {
            let mut row = serde_json::to_value(&member).unwrap_or_default();
            row["leftAt"] = json!(left_at);
            row["expertName"] = json!(experts.get(&member.name));
            // 各终端绑定的 Agent 会话：收集器确认的，否则它最近一次入群或汇报带的。
            if left_at.is_none() {
                for (index, body) in member.bodies.iter().enumerate() {
                    row["bodies"][index]["sessionId"] = json!(group::bound_session_in(
                        &main,
                        &name,
                        &events,
                        &body.target_ref
                    ));
                }
            }
            row
        })
        .collect();
    let mut delivery: serde_json::Map<String, Value> =
        group::delivery_states(&main, &name, &events)
            .into_iter()
            .map(|(seq, state)| (seq.to_string(), json!(state)))
            .collect();
    super::berth_member::mark_delivered(&main, &events, &mut delivery);
    let mut read = group::read(&events, after, None);
    read["name"] = json!(name);
    read["members"] = json!(members);
    read["delivery"] = Value::Object(delivery);
    // 内置成员 Berth：没有终端，前端固定显示；`busy` 为它正在回答（或有消息排队），
    // `log` 为正在回答的提问与执行过程。
    read["builtin"] = json!({
        "name": berth_group::builtin::BERTH,
        "busy": super::berth_member::busy(&main),
        "log": super::berth_member::live_log(&main),
    });
    read["env"] = group::env(&main, &name)
        .map_err(|error| error.message)?
        .map(|env| json!({"branch": env.branch, "baseBranch": env.base_branch, "worktree": env.worktree}))
        .unwrap_or(Value::Null);
    Ok(read)
}

/// 后台进程没在跑就拉起（与 CLI 的 `ensure_running` 同一把锁、同一日志）。
pub fn ensure_watch(root: &Path, cli: &Path, launch: &CliLaunch) -> Result<Value, String> {
    let main = tasks::resolve(root).map_err(|error| error.message)?.main;
    group::prepare(&main).map_err(|error| error.message)?;
    if group::watch_running(&main, &launch.socket) {
        return Ok(json!({ "running": true, "started": false }));
    }
    let runtime = group::runtime_dir(&main);
    std::fs::create_dir_all(&runtime).map_err(|error| error.to_string())?;
    let log = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(true)
        .open(runtime.join("watch.log"))
        .map_err(|error| error.to_string())?;
    let err = log.try_clone().map_err(|error| error.to_string())?;
    let mut command = Command::new(cli);
    command
        .arg("-S")
        .arg(&launch.socket)
        .args(["group", "--workspace"])
        .arg(&main)
        .arg("watch")
        .envs(&launch.env)
        .stdin(Stdio::null())
        .stdout(log)
        .stderr(err);
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    // 不等它退出（常驻）；回收放到后台线程，免得留下僵尸进程。
    std::thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(json!({ "running": true, "started": true }))
}
