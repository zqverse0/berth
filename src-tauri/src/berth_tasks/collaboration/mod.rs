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
        // `chat: true`：聊天群列表；否则是 checkout（任务分配用）。
        "group.list" if params.get("chat") == Some(&json!(true)) => {
            ctx(&root, launch.as_ref())
                .and_then(|ctx| berth_group::groups(&ctx).map_err(|error| error.message))
        }
        "group.list" => group::list(&root, &params),
        "group.create" | "group.rename" | "group.delete" | "group.settings" => {
            manage(&root, &method, &params, launch.as_ref())
        }
        "group.watch" => {
            let launch = launch.ok_or("Berth terminal is unavailable")?;
            group::ensure_watch(&root, &cli()?, &launch)
        }
        "group.post" => post(&root, &params, launch.as_ref()),
        "group.approve" => approve(&root, &params, launch.as_ref()),
        "group.member.control" => control(&root, &params, launch.as_ref()),
        "group.experts" => ctx(&root, launch.as_ref())
            .and_then(|ctx| berth_group::experts(&ctx, None).map_err(|error| error.message)),
        "group.expert.set" => set_expert(&root, &params, launch.as_ref()),
        "group.dm" => ctx(&root, launch.as_ref())
            .and_then(|ctx| berth_group::dm(&ctx, required(&params, "expert")?).map_err(|error| error.message)),
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

/// 例行发群（automation `group_message_v1`）：发给成员并确保后台进程在跑；成员正忙返回 `None`。
pub async fn routine(
    root: PathBuf,
    member: String,
    text: String,
    key: String,
    launch: CliLaunch,
) -> Result<Option<u64>, String> {
    tokio::task::spawn_blocking(move || {
        let ctx = ctx(&root, Some(&launch))?;
        let seq = berth_group::routine(&ctx, &member, &text, &key).map_err(|error| error.message)?;
        if seq.is_some() {
            group::ensure_watch(&root, &ctx.cli, &launch)?;
        }
        Ok(seq)
    })
    .await
    .map_err(|error| format!("task worker failed: {error}"))?
}

fn ctx(root: &Path, launch: Option<&CliLaunch>) -> Result<berth_group::Ctx, String> {
    berth_group::Ctx::new(root, launch.map(|launch| launch.socket.clone()), None, cli()?, None)
        .map_err(|error| error.message)
}

/// 专家页保存专家用的 Agent / 服务商 / 模型（`expert`、`agent`、`inputs`、`provider`、`model`），它所在的群下一条消息生效。
fn set_expert(root: &Path, params: &Value, launch: Option<&CliLaunch>) -> Result<Value, String> {
    let ctx = ctx(root, launch)?;
    let inputs = params.get("inputs").and_then(Value::as_object).cloned().unwrap_or_default();
    let provider = params
        .get("provider")
        .and_then(Value::as_i64)
        .map(|id| (id, text(params, "model").map(str::to_owned)));
    berth_group::set_expert(&ctx, required(params, "expert")?, required(params, "agent")?, inputs, provider)
        .map_err(|error| error.message)
}

/// 群列表的新建、改名、删除与群设置（`berth group create|rename|delete|settings` 同一实现）。
/// `group.settings` 的 `cwd` 为 null 时改回主项目，不给则不改。
fn manage(root: &Path, method: &str, params: &Value, launch: Option<&CliLaunch>) -> Result<Value, String> {
    let ctx = ctx(root, launch)?;
    let name = required(params, "name")?;
    let result = match method {
        "group.create" => berth_group::create_group(&ctx, name, text(params, "title"), text(params, "cwd").map(Path::new)),
        "group.rename" => berth_group::rename_group(&ctx, name, text(params, "title")),
        "group.delete" => berth_group::delete_group(&ctx, name),
        _ => {
            let cwd = params.get("cwd").map(|cwd| cwd.as_str().filter(|cwd| !cwd.trim().is_empty()).map(Path::new));
            berth_group::configure_group(&ctx, name, cwd)
        }
    }
    .map_err(|error| error.message)?;
    if let Some(launch) = launch {
        group::ensure_watch(root, &ctx.cli, launch)?;
    }
    Ok(result)
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
