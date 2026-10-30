//! `plugin_views(request)` — 插件视图（docs/plugin-architecture.md §4.1 第 1 层）：列出启用插件声明的
//! 视图、运行视图脚本的 `render` 拿视图数据、执行 `script` 动作。脚本在本进程的后台线程里由
//! berth-plugin-api 运行（与 `berth tools call` 同一实现），视图数据由前端原生组件渲染。

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
    /// 视图动作 `script`：运行包内脚本的默认导出函数。
    Action {
        plugin: String,
        script: String,
        #[serde(default)]
        input: Value,
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
    List { views: Vec<PluginView> },
    Rendered { view: Value },
    Done { result: Value },
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
        PluginViewsRequest::List => Ok(PluginViewsResponse::List { views: list() }),
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
                .map(|item| item.script)
                .ok_or_else(|| {
                    AppCommandError::not_found(format!("plugin {plugin} has no view {view}"))
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
    }
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

fn list() -> Vec<PluginView> {
    crate::tool::asset_repository::list_tool_asset_ids()
        .into_iter()
        .filter_map(|plugin| {
            let asset = crate::tool::asset_repository::load_tool_asset(&plugin).ok()??;
            let dir = crate::tool::asset_repository::tool_package_dir(&plugin).ok()?;
            let views = berth_tool_core::views::parse(asset.raw()).0;
            Some(views.into_iter().map(move |view| {
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
                }
            }))
        })
        .flatten()
        .collect()
}
