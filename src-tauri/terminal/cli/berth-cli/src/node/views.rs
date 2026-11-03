//! 节点的视图：设备概览、启动栏、浏览目录、添加项目（对方 GUI 不运行时也要用的）。

use std::path::PathBuf;

use berth_control_proto::ProjectScope;
use berth_node::api::ApiError;
use berth_project_core::instance::{DataInstance, InstanceState};
use berth_project_core::service::catalog::CatalogEntry;
use serde_json::{json, Value};

use super::api_error;

/// 对方库里的全部项目；还没有库（只装了 CLI、没添加过项目）时为空。
///
/// 库待升级时由节点完成升级再读：只装 CLI 的设备没有 GUI 来升级，节点是它的常驻入口
/// （两端由用户统一升级，节点与 GUI 是同一版本）。
pub(crate) async fn catalog() -> Result<Vec<CatalogEntry>, ApiError> {
    read_db(|instance| async move { crate::project::catalog_entries(&instance, ProjectScope::All).await })
        .await
}

async fn read_db<T, F, Fut>(read: F) -> Result<Vec<T>, ApiError>
where
    F: Fn(DataInstance) -> Fut,
    Fut: std::future::Future<Output = Result<Vec<T>, InstanceState>>,
{
    let instance = match crate::project::resolve_instance(true) {
        Ok(instance) => instance,
        Err(_) => return Ok(Vec::new()),
    };
    let unavailable = |state: InstanceState| ApiError::new("unavailable", state.message());
    match read(instance).await {
        Err(InstanceState::UpgradeRequired { .. }) => {
            let writable = crate::project::writable_instance().map_err(unavailable)?;
            read(writable).await.map_err(unavailable)
        }
        other => other.map_err(unavailable),
    }
}

pub(crate) async fn device() -> Result<Value, ApiError> {
    // 打开的项目，与对方侧栏同一份数据（层级、别名、分支、排序）。
    let projects = read_db(|instance| async move { crate::project::open_folders(&instance).await })
        .await?;
    // GUI 的远程访问在数据目录下监听的设备 socket（`remote::DEVICE_SOCKET`）；连得上才报，
    // 本机 Berth 据此连对方 GUI 用它的项目，连不上即 GUI 未运行。
    let socket = super::data_dir().join("remote.sock");
    let window = std::os::unix::net::UnixStream::connect(&socket)
        .is_ok()
        .then(|| socket.display().to_string());
    // GUI 没在运行、但这里能起无界面宿主：本机 Berth 照样连，打开项目时由隧道拉起（只读概览不拉起）。
    let hostable = window.is_none() && crate::gui_launch::can_launch_host();
    Ok(json!({
        "window": window,
        "hostable": hostable,
        "host": rustix::system::uname().nodename().to_string_lossy(),
        "os": std::env::consts::OS,
        "arch": std::env::consts::ARCH,
        "version": env!("CARGO_PKG_VERSION"),
        "protocol": berth_node::PROTOCOL_VERSION,
        "home": std::env::var("HOME").unwrap_or_default(),
        "projects": projects,
    }))
}

fn internal(error: impl ToString) -> ApiError {
    ApiError::new("internal", error.to_string())
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
