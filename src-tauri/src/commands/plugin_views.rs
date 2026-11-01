//! `plugin_views(request)` — 插件界面（docs/plugin-architecture.md §2.5、§4.1、§4.2）：列出启用插件
//! 声明的视图与编辑器、运行视图脚本的 `render` 拿视图数据、执行 `script` 动作、替页面执行后端
//! 命名空间（`call`）。脚本在本进程的后台线程里由 berth-plugin-api 运行（与 `berth tools call`
//! 同一实现），第 1 层视图数据由前端原生组件渲染；第 2 层页面的资源经 [`page_asset`] 提供。

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::app_error::AppCommandError;

#[derive(Debug, Clone, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PluginViewsRequest {
    List,
    /// 运行视图脚本的 `render(req)`；`project` 是当前项目 `{id, name, root}`（`env.project`）。
    Render {
        plugin: String,
        view: String,
        #[serde(default)]
        params: Value,
        filter: Option<String>,
        /// 当前选中的下拉项（`req.dropdown`）。
        dropdown: Option<String>,
        /// 界面语言（`req.locale`）。
        #[serde(default)]
        locale: String,
        /// 用户点了刷新（`req.refresh`）。
        #[serde(default)]
        refresh: bool,
        project: Option<Value>,
    },
    /// 视图动作 `script` / 页面的 `scripts.run`：运行包内脚本的默认导出函数。
    Action {
        plugin: String,
        script: String,
        #[serde(default)]
        input: Value,
        project: Option<Value>,
    },
    /// 页面调用经宿主后端执行的命名空间（`storage`、`data`）。
    Call {
        plugin: String,
        method: String,
        #[serde(default)]
        params: Value,
        project: Option<Value>,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
pub enum PluginViewsResponse {
    List {
        views: Vec<PluginView>,
        editors: Vec<PluginEditor>,
    },
    Rendered {
        view: Value,
    },
    Done {
        result: Value,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginView {
    pub plugin: String,
    pub id: String,
    /// 字符串或 `{ "<语言>": "<标题>" }`，前端按当前语言挑。
    pub title: Value,
    /// 视图图标或插件图标的 data URL。
    pub icon: Option<String>,
    pub location: &'static str,
    /// 第 2 层页面（包内路径）；为 null 时是第 1 层脚本视图。
    pub page: Option<String>,
    /// tool.json `permissions`（页面里 `files` 等由前端实现的命名空间按它放行）。
    pub permissions: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PluginEditor {
    pub plugin: String,
    pub id: String,
    pub title: Value,
    pub suffixes: Vec<String>,
    pub page: String,
    pub new: Vec<PluginNewFile>,
    pub embed: bool,
    pub permissions: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
pub struct PluginNewFile {
    pub title: Value,
    pub name: String,
}

#[cfg_attr(feature = "tauri-runtime", tauri::command)]
pub async fn plugin_views(
    request: PluginViewsRequest,
) -> Result<PluginViewsResponse, AppCommandError> {
    tokio::task::spawn_blocking(move || handle(request))
        .await
        .map_err(|error| AppCommandError::task_execution_failed(error.to_string()))?
}

fn handle(request: PluginViewsRequest) -> Result<PluginViewsResponse, AppCommandError> {
    match request {
        PluginViewsRequest::List => {
            let (views, editors) = list();
            Ok(PluginViewsResponse::List { views, editors })
        }
        PluginViewsRequest::Render {
            plugin,
            view,
            params,
            filter,
            dropdown,
            locale,
            refresh,
            project,
        } => {
            let script = berth_tool_core::views::parse(&manifest(&plugin)?)
                .0
                .into_iter()
                .find(|item| item.id == view)
                .and_then(|item| match item.source {
                    berth_tool_core::views::Source::Script(script) => Some(script),
                    berth_tool_core::views::Source::Page(_) => None,
                })
                .ok_or_else(|| {
                    AppCommandError::not_found(format!("plugin {plugin} has no script view {view}"))
                })?;
            let params = if params.is_object() {
                params
            } else {
                json!({})
            };
            let req = json!({
                "view": view,
                "params": params,
                "filter": filter,
                "dropdown": dropdown,
                "locale": locale,
                "refresh": refresh,
            });
            let view = call(&plugin, &script, Some("render"), &req, project)?;
            Ok(PluginViewsResponse::Rendered { view })
        }
        PluginViewsRequest::Action {
            plugin,
            script,
            input,
            project,
        } => {
            manifest(&plugin)?;
            let result = call(&plugin, &script, None, &input, project)?;
            Ok(PluginViewsResponse::Done { result })
        }
        PluginViewsRequest::Call {
            plugin,
            method,
            params,
            project,
        } => {
            manifest(&plugin)?;
            let package = crate::tool::asset_repository::tool_package_dir(&plugin)?;
            let project = project.unwrap_or(Value::Null);
            let result = berth_plugin_api::page::call(
                &package,
                &method,
                params,
                Box::new(move || project.clone()),
            )
            .map_err(|error| {
                AppCommandError::invalid_input(format!(
                    "{}: {}",
                    error.reason.as_str(),
                    error.message
                ))
            })?;
            Ok(PluginViewsResponse::Done { result })
        }
    }
}

/// 页面资源 `/<插件>/<包内路径>`（百分号编码）：桌面 `berth-plugin` 协议与远程访问共用。
/// 停用或不存在的插件、声明的页面目录以外的路径都报错。
pub fn page_asset(path: &str, origin: &str) -> Result<berth_plugin_api::page::Asset, String> {
    let path = urlencoding::decode(path).map_err(|error| error.to_string())?;
    let (plugin, rest) = path
        .trim_start_matches('/')
        .split_once('/')
        .ok_or_else(|| format!("{path}: expected /<plugin>/<path>"))?;
    let raw = manifest(plugin).map_err(|error| error.to_string())?;
    let pages: Vec<String> = berth_tool_core::views::parse(&raw)
        .0
        .into_iter()
        .filter_map(|view| match view.source {
            berth_tool_core::views::Source::Page(page) => Some(page),
            berth_tool_core::views::Source::Script(_) => None,
        })
        .chain(berth_tool_core::editors::parse(&raw).0.into_iter().map(|editor| editor.page))
        .collect();
    let package = crate::tool::asset_repository::tool_package_dir(plugin)
        .map_err(|error| error.to_string())?;
    berth_plugin_api::page::asset(&package, &pages, rest, origin)
}

/// 桌面 `berth-plugin://localhost/<插件>/<路径>`（Windows `http://berth-plugin.localhost/…`）。
/// 与主窗口不同源，页面 iframe 可以带 allow-same-origin 而碰不到宿主。
#[cfg(feature = "tauri-runtime")]
pub fn page_protocol(request: tauri::http::Request<Vec<u8>>, responder: tauri::UriSchemeResponder) {
    let path = request.uri().path().to_owned();
    tauri::async_runtime::spawn_blocking(move || {
        let response = match page_asset(&path, "'self'") {
            Ok(asset) => {
                let mut builder = tauri::http::Response::builder()
                    .header("Content-Type", asset.mime)
                    .header("Cache-Control", "no-cache");
                if let Some(csp) = asset.csp {
                    builder = builder.header("Content-Security-Policy", csp);
                }
                builder.body(asset.bytes)
            }
            Err(error) => tauri::http::Response::builder()
                .status(404)
                .header("Content-Type", "text/plain; charset=utf-8")
                .body(error.into_bytes()),
        };
        if let Ok(response) = response {
            responder.respond(response);
        }
    });
}

/// 启用插件的 tool.json（已归一）；停用或不存在报错。
fn manifest(plugin: &str) -> Result<Value, AppCommandError> {
    berth_tool_core::plugins::ensure_enabled(plugin)
        .map_err(|error| AppCommandError::invalid_input(error.to_string()))?;
    crate::tool::asset_repository::load_tool_asset(plugin)?
        .map(|asset| asset.raw().clone())
        .ok_or_else(|| AppCommandError::not_found(format!("plugin {plugin} is not installed")))
}

fn call(
    plugin: &str,
    script: &str,
    hook: Option<&str>,
    input: &Value,
    project: Option<Value>,
) -> Result<Value, AppCommandError> {
    let package = crate::tool::asset_repository::tool_package_dir(plugin)?;
    let project = project.unwrap_or(Value::Null);
    berth_plugin_api::call_script(
        &package,
        script,
        hook,
        input,
        Box::new(move || project.clone()),
    )
    .map_err(AppCommandError::task_execution_failed)
}

fn list() -> (Vec<PluginView>, Vec<PluginEditor>) {
    let mut all_views = Vec::new();
    let mut all_editors = Vec::new();
    for plugin in crate::tool::asset_repository::list_tool_asset_ids() {
        let Some(asset) = crate::tool::asset_repository::load_tool_asset(&plugin)
            .ok()
            .flatten()
        else {
            continue;
        };
        let Ok(dir) = crate::tool::asset_repository::tool_package_dir(&plugin) else {
            continue;
        };
        let permissions: Vec<String> = asset.raw()["permissions"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| item.as_str().map(str::to_owned))
            .collect();
        all_editors.extend(
            berth_tool_core::editors::parse(asset.raw())
                .0
                .into_iter()
                .map(|editor| PluginEditor {
                    plugin: plugin.clone(),
                    id: editor.id,
                    title: editor.title,
                    suffixes: editor.suffixes,
                    page: editor.page,
                    new: editor
                        .new
                        .into_iter()
                        .map(|file| PluginNewFile {
                            title: file.title,
                            name: file.name,
                        })
                        .collect(),
                    embed: editor.embed,
                    permissions: permissions.clone(),
                }),
        );
        let views = berth_tool_core::views::parse(asset.raw()).0;
        all_views.extend(views.into_iter().map(|view| {
            let icon = view
                .icon
                .as_deref()
                .and_then(|icon| {
                    crate::commands::launchbar::image_data_url(&dir.join(icon))
                        .ok()
                        .flatten()
                })
                .or_else(|| {
                    crate::commands::launchbar::icon_data_url(&dir)
                        .ok()
                        .flatten()
                });
            PluginView {
                plugin: plugin.clone(),
                id: view.id,
                title: view.title,
                icon,
                location: view.location.as_str(),
                page: match view.source {
                    berth_tool_core::views::Source::Page(page) => Some(page),
                    berth_tool_core::views::Source::Script(_) => None,
                },
                permissions: permissions.clone(),
            }
        }));
    }
    (all_views, all_editors)
}
