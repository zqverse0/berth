//! 节点的聚合视图与只读领域数据：与 `berth project / session / task / knowledge … --json` 同一实现、同一形状。

use std::path::{Path, PathBuf};

use berth_control_proto::ProjectScope;
use berth_node::api::ApiError;
use berth_project_core::instance::InstanceState;
use berth_project_core::service::catalog::CatalogEntry;
use berth_project_core::{knowledge, tasks};
use serde_json::{json, Value};

use super::{api_error, Ctx};
use crate::session::{ListOptions, ShowOptions};

/// 项目概览里的会话条数。
const OVERVIEW_SESSIONS: usize = 20;
/// 会话正文上限。
const SESSION_BYTES: usize = 64 * 1024;

/// 对方库里的全部项目；还没有库（只装了 CLI、没添加过项目）时为空。
///
/// 库待升级时由节点完成升级再读：只装 CLI 的设备没有 GUI 来升级，节点是它的常驻入口
/// （两端由用户统一升级，节点与 GUI 是同一版本）。
pub(crate) async fn catalog() -> Result<Vec<CatalogEntry>, ApiError> {
    let instance = match crate::project::resolve_instance(true) {
        Ok(instance) => instance,
        Err(_) => return Ok(Vec::new()),
    };
    let unavailable = |state: InstanceState| ApiError::new("unavailable", state.message());
    match crate::project::catalog_entries(&instance, ProjectScope::All).await {
        Err(InstanceState::UpgradeRequired { .. }) => {
            let writable = crate::project::writable_instance().map_err(unavailable)?;
            crate::project::catalog_entries(&writable, ProjectScope::All)
                .await
                .map_err(unavailable)
        }
        other => other.map_err(unavailable),
    }
}

pub(crate) async fn project_entry(id: i64) -> Result<CatalogEntry, ApiError> {
    catalog()
        .await?
        .into_iter()
        .find(|entry| i64::from(entry.id) == id)
        .ok_or_else(|| ApiError::new("not_found", format!("no project {id} on this device")))
}

fn entry_json(entry: &CatalogEntry) -> Value {
    json!({ "id": entry.id, "path": entry.path, "name": entry.name, "is_open": entry.is_open })
}

/// 子项失败不拖垮整个概览：该项换成 `{ "error": … }`。
fn part(result: Result<Value, ApiError>) -> Value {
    result.unwrap_or_else(|error| json!({ "error": error }))
}

pub(crate) async fn device(ctx: &Ctx) -> Result<Value, ApiError> {
    let projects: Vec<Value> = catalog().await?.iter().map(entry_json).collect();
    let terminals = part(super::terminals::list(ctx, None).await);
    Ok(json!({
        "host": rustix::system::uname().nodename().to_string_lossy(),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "version": env!("CARGO_PKG_VERSION"),
        "protocol": berth_node::PROTOCOL_VERSION,
        "home": std::env::var("HOME").unwrap_or_default(),
        "projects": projects,
        "terminals": terminals,
    }))
}

pub(crate) async fn project(ctx: &Ctx, id: i64, root_version: Option<&str>) -> Result<Value, ApiError> {
    let entry = project_entry(id).await?;
    let path = PathBuf::from(&entry.path);
    let root = super::files::list(&ctx.scope().await?, &entry.path, root_version)
        .and_then(|listing| serde_json::to_value(listing).map_err(internal));
    let terminals = super::terminals::list(ctx, Some(id)).await;
    let blocking = {
        let path = path.clone();
        tokio::task::spawn_blocking(move || {
            (
                part(launchbar()),
                part(sessions(&path, OVERVIEW_SESSIONS)),
                part(task_list(&path)),
                part(notes(&path)),
            )
        })
    };
    let (launchbar, sessions, tasks, notes) = blocking.await.map_err(internal)?;
    Ok(json!({
        "project": entry_json(&entry),
        "root": part(root),
        "terminals": part(terminals),
        "launchbar": launchbar,
        "sessions": sessions,
        "tasks": tasks,
        "notes": notes,
    }))
}

fn internal(error: impl ToString) -> ApiError {
    ApiError::new("internal", error.to_string())
}

/// 对方的启动栏：可启动的工具（原样的 tool.json 与 launchbar.json，投影由客户端做）与服务商摘要（不含 Key）。
pub(crate) fn launchbar() -> Result<Value, ApiError> {
    let tools_root = berth_tool_core::paths::tools_root();
    let experts: Vec<Value> = berth_tool_core::paths::experts(&berth_tool_core::paths::berth_home_dir())
        .unwrap_or_default()
        .into_iter()
        .map(|(value, label)| json!({ "value": value, "label": label }))
        .collect();
    let read_json = |path: &Path| -> Option<Value> {
        let meta = std::fs::metadata(path).ok()?;
        // 与本机启动栏同一上限。
        if meta.len() > 1024 * 1024 {
            return None;
        }
        serde_json::from_slice(&std::fs::read(path).ok()?).ok()
    };
    let mut agents = Vec::new();
    for id in berth_tool_core::repository::list_tool_asset_ids() {
        let dir = tools_root.join(&id);
        if !berth_tool_core::plugins::is_enabled(&id) || !dir.join("launch.js").is_file() {
            continue;
        }
        let Some(tool) = berth_tool_core::repository::tool_asset_file_path(&id)
            .ok()
            .and_then(|path| read_json(&path))
        else {
            continue;
        };
        let mut launchbar = read_json(&dir.join("launchbar.json"));
        // `optionsFrom: "experts"` 填对方的专家，与本机启动栏同一规则。
        if let Some(items) = launchbar
            .as_mut()
            .and_then(|config| config.get_mut("items"))
            .and_then(Value::as_array_mut)
        {
            for item in items {
                if item.get("optionsFrom").and_then(Value::as_str) == Some("experts") {
                    item["options"] = Value::Array(experts.clone());
                }
            }
        }
        agents.push(json!({ "id": id, "tool": tool, "launchbar": launchbar }));
    }
    let providers = match crate::project::resolve_instance(true) {
        Ok(instance) => tokio::runtime::Handle::current()
            .block_on(crate::provider_launch::summaries(&instance))
            .unwrap_or_default(),
        Err(_) => Vec::new(),
    };
    Ok(json!({ "agents": agents, "providers": providers }))
}

pub(crate) fn sessions(project: &Path, limit: usize) -> Result<Value, ApiError> {
    let main = tasks::main_project(project).unwrap_or_else(|_| project.to_path_buf());
    let links = crate::session::links_for(&main).map_err(api_error)?;
    let options = ListOptions {
        agent: None,
        group: None,
        live: false,
        limit,
    };
    let rows = crate::session::list_rows(&links, &options, true).map_err(api_error)?;
    Ok(json!({ "sessions": rows }))
}

pub(crate) fn session(id: &str, agent: Option<&str>, tail: Option<usize>) -> Result<Value, ApiError> {
    let (agent, spec, path, project) = crate::session::locate(id, agent, true).map_err(api_error)?;
    let options = ShowOptions {
        tail,
        user_only: false,
        grep: None,
        max_bytes: SESSION_BYTES,
        context: false,
    };
    Ok(crate::session::show_view(id, &agent, &spec, &path, project.as_deref(), &options))
}

fn task_error(error: tasks::TaskError) -> ApiError {
    ApiError::new("invalid", error.message)
}

pub(crate) fn task_list(project: &Path) -> Result<Value, ApiError> {
    tasks::list(project, false, 100).map_err(task_error)
}

pub(crate) fn task(project: &Path, reference: &str) -> Result<Value, ApiError> {
    let view = tasks::show(project, Some(reference)).map_err(task_error)?;
    serde_json::to_value(view).map_err(internal)
}

/// 笔记目录（不含正文）；正文用 `Note` 单独取。
pub(crate) fn notes(project: &Path) -> Result<Value, ApiError> {
    let root = knowledge::vault_project(project);
    let snapshot = knowledge::snapshot(&root).map_err(internal)?;
    let notes: Vec<Value> = snapshot
        .documents
        .iter()
        .map(|doc| {
            json!({
                "path": doc.path, "title": doc.title, "note_type": doc.note_type,
                "status": doc.status, "excerpt": doc.excerpt, "modified_at": doc.modified_at,
            })
        })
        .collect();
    Ok(json!({ "revision": snapshot.revision, "notes": notes }))
}

pub(crate) fn note(project: &Path, name: &str) -> Result<Value, ApiError> {
    let root = knowledge::vault_project(project);
    let view = knowledge::show(&root, name)
        .map_err(internal)?
        .ok_or_else(|| ApiError::new("not_found", format!("no note {name}")))?;
    serde_json::to_value(view).map_err(internal)
}

/// 添加项目时浏览对方目录：只列子目录名，限家目录之内。
pub(crate) fn dirs(path: Option<&str>) -> Result<Value, ApiError> {
    let home = std::env::var_os("HOME")
        .map(PathBuf::from)
        .and_then(|home| std::fs::canonicalize(home).ok())
        .ok_or_else(|| ApiError::new("unavailable", "HOME is not set"))?;
    let dir = match path {
        Some(path) => std::fs::canonicalize(path)
            .map_err(|error| ApiError::new("not_found", format!("{path}: {error}")))?,
        None => home.clone(),
    };
    if !dir.starts_with(&home) {
        return Err(ApiError::new("forbidden", "only directories under home can be browsed"));
    }
    let mut names: Vec<String> = std::fs::read_dir(&dir)
        .map_err(|error| ApiError::new("forbidden", format!("{}: {error}", dir.display())))?
        .filter_map(Result::ok)
        .filter(|item| item.path().is_dir())
        .map(|item| item.file_name().to_string_lossy().into_owned())
        .filter(|name| !name.starts_with('.'))
        .collect();
    names.sort();
    Ok(json!({ "path": dir, "home": home, "dirs": names }))
}

/// 在对方库里登记项目（直接写库，不经对方 GUI）。
pub(crate) fn project_add(path: &str) -> Result<Value, ApiError> {
    let entry = crate::project::add_entry(path, true).map_err(api_error)?;
    serde_json::to_value(entry).map_err(internal)
}

/// 概览之外的请求用：项目 id → 路径。
pub(crate) async fn project_path(id: i64) -> Result<PathBuf, ApiError> {
    Ok(PathBuf::from(project_entry(id).await?.path))
}

