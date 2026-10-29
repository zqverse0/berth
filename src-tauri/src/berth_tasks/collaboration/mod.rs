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
        "group.unread" => group::unread(&root, &params),
        "group.watch" => {
            let launch = launch.ok_or("Berth terminal is unavailable")?;
            group::ensure_watch(&root, &cli()?, &launch)
        }
        "group.post" => post(&root, &params, launch.as_ref()),
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

/// 以群主身份发消息（`replyTo` 为引用回复）。GUI 不在终端里：发给成员的消息排队，
/// 由后台进程在成员空闲时送达（发后确保它在跑）。
fn post(root: &Path, params: &Value, launch: Option<&CliLaunch>) -> Result<Value, String> {
    let ctx = berth_group::Ctx::new(
        root,
        launch.map(|launch| launch.socket.clone()),
        None,
        cli()?,
        None,
    )
    .map_err(|error| error.message)?;
    let written = berth_group::post(
        &ctx,
        None,
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

fn text<'a>(params: &'a Value, key: &str) -> Option<&'a str> {
    params
        .get(key)
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
}

fn required<'a>(params: &'a Value, key: &str) -> Result<&'a str, String> {
    text(params, key).ok_or_else(|| format!("{key} is required"))
}
