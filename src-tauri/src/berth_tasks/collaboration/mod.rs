pub mod berth_member;
pub mod group;

use std::path::{Path, PathBuf};

use serde_json::{json, Value};

pub use group::CliLaunch;

/// 任务 / 群组方法全部进程内处理，与 `berth task` / `berth group` 同一实现（`berth_group`）。
pub async fn call(
    method: &str,
    project_root: &Path,
    params: &Value,
    launch: Option<CliLaunch>,
) -> Result<Value, String> {
    let root = project_root.to_path_buf();
    let method = method.to_owned();
    let params = params.clone();
    tokio::task::spawn_blocking(move || match method.as_str() {
        "task.list" => group::task_list(&root),
        "task.views" => berth_project_core::tasks::views(&root)
            .map(|views| json!({ "tasks": views }))
            .map_err(|error| error.message),
        "task.view" => group::task_view(&root, &params),
        "task.start" => group::start(&root, &params),
        "task.save" => group::save(&root, &params),
        "task.finish" => group::finish(&root, &params),
        "group.read" => group::read(&root, &params),
        "group.assign" => group::assign(&root, &params),
        "group.list" => group::list(&root, &params),
        "group.watch" => {
            let launch = launch.ok_or("Berth terminal is unavailable")?;
            group::ensure_watch(&root, &cli()?, &launch)
        }
        "group.post" => post(&root, &params, launch.as_ref()),
        "group.join" => join(&root, &params, launch.as_ref()),
        "group.approve" => approve(&root, &params, launch.as_ref()),
        "group.member.control" => control(&root, &params, launch.as_ref()),
        "group.stopBerth" => berth_member::stop(&root),
        "group.berthSessions" => berth_member::sessions(&root),
        "group.berthRecord" => berth_member::record(&root, &params),
        "group.berthNew" => berth_member::new_session(&root),
        _ => Err(format!("unsupported method: {method}")),
    })
    .await
    .map_err(|error| format!("task worker failed: {error}"))?
}

/// berth CLI：写给 Agent 粘贴的命令、拉起后台进程都用它。
fn cli() -> Result<PathBuf, String> {
    crate::terminal::manager::runtime::resolve_cli_binary()
        .ok_or_else(|| "Berth CLI (berth group) is unavailable".to_owned())
}

/// 以群主身份发消息（`replyTo` 为引用回复）：发给 ACP 成员的消息由后台进程送达（发后确保它在跑）。
fn post(root: &Path, params: &Value, launch: Option<&CliLaunch>) -> Result<Value, String> {
    let ctx = ctx(root, launch)?;
    let written = berth_group::post(
        &ctx,
        required(params, "name")?,
        required(params, "author")?,
        required(params, "text")?,
        text(params, "to").map(str::to_owned),
        params.get("replyTo").and_then(Value::as_u64),
        text(params, "idempotencyKey").map(str::to_owned),
    )
    .map_err(|error| error.message)?;
    if let Some(launch) = launch {
        group::ensure_watch(root, &ctx.cli, launch)?;
    }
    Ok(written)
}

fn ctx(root: &Path, launch: Option<&CliLaunch>) -> Result<berth_group::Ctx, String> {
    berth_group::Ctx::new(root, launch.map(|launch| launch.socket.clone()), None, cli()?, None)
        .map_err(|error| error.message)
}

/// 群页「加成员」：声明了 `agent.acp` 的插件以 ACP 成员入群（`berth group join --acp` 同一实现）。
/// `inputs` 是启动栏的选择，`provider` / `model` 同终端启动的服务商与模型。
fn join(root: &Path, params: &Value, launch: Option<&CliLaunch>) -> Result<Value, String> {
    let ctx = ctx(root, launch)?;
    let inputs = params.get("inputs").and_then(Value::as_object).cloned().unwrap_or_default();
    let provider = params
        .get("provider")
        .and_then(Value::as_i64)
        .map(|id| (id, text(params, "model").map(str::to_owned)));
    let joined = berth_group::join_acp(
        &ctx,
        required(params, "name")?,
        required(params, "as")?,
        required(params, "agent")?,
        inputs,
        provider,
        None,
    )
    .map_err(|error| error.message)?;
    if let Some(launch) = launch {
        group::ensure_watch(root, &ctx.cli, launch)?;
    }
    Ok(joined)
}

/// 审批卡片的应答（`berth group approve` 同一实现）；不给 `option` 即取消。
fn approve(root: &Path, params: &Value, launch: Option<&CliLaunch>) -> Result<Value, String> {
    let ctx = ctx(root, launch)?;
    let request = params.get("request").and_then(Value::as_u64).ok_or("request is required")?;
    let written = berth_group::approve(&ctx, required(params, "name")?, request, text(params, "option").map(str::to_owned))
        .map_err(|error| error.message)?;
    if let Some(launch) = launch {
        group::ensure_watch(root, &ctx.cli, launch)?;
    }
    Ok(written)
}

/// 成员条上的「停止 / 新会话 / 移出」（`berth group member` 同一实现）。
fn control(root: &Path, params: &Value, launch: Option<&CliLaunch>) -> Result<Value, String> {
    let ctx = ctx(root, launch)?;
    let written = berth_group::control(
        &ctx,
        required(params, "name")?,
        required(params, "member")?,
        required(params, "action")?,
        text(params, "terminal").map(str::to_owned),
    )
    .map_err(|error| error.message)?;
    if let Some(launch) = launch {
        group::ensure_watch(root, &ctx.cli, launch)?;
    }
    Ok(written)
}

fn text<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn required<'a>(params: &'a Value, key: &str) -> Result<&'a str, String> {
    text(params, key).ok_or_else(|| format!("{key} is required"))
}
