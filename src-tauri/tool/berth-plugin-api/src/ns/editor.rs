//! editor@1（无需权限，写文件的方法要 `fs`）：本插件编辑器在 Berth 窗口里的能力。
//!
//! `render`：请窗口用本插件声明了 `embed` 的编辑器页面把文件渲染成图片，写到 `out`。窗口通道由
//! 运行脚本的一方注入（[`set_desktop`]，berth-cli 的 `tools run|call`）；没注入（GUI 自己跑视图脚本）
//! 就是 `unsupported`，不会 GUI → CLI → GUI 回环。

use std::sync::OnceLock;

use serde_json::{json, Value};

use crate::rpc::{opt_str_param, str_param, ApiError, ApiResult, Host, Reason};

/// 窗口通道：收到 `{plugin, path, format, out}`，返回 `{out, mime, bytes}`。
pub type DesktopRender = Box<dyn Fn(Value) -> ApiResult + Send + Sync>;

static DESKTOP: OnceLock<DesktopRender> = OnceLock::new();

/// 注入窗口通道；进程内只生效第一次。
pub fn set_desktop(render: DesktopRender) {
    let _ = DESKTOP.set(render);
}

pub fn call(host: &Host, name: &str, params: &Value) -> Option<ApiResult> {
    match name {
        "render" => Some(render(host, params)),
        _ => None,
    }
}

fn absolute(params: &Value, key: &str) -> Result<String, ApiError> {
    let path = crate::ns::fs::expand(str_param(params, key)?);
    if !path.is_absolute() {
        return Err(ApiError::invalid(format!("{key} must be absolute or start with ~")));
    }
    Ok(path.to_string_lossy().into_owned())
}

fn render(host: &Host, params: &Value) -> ApiResult {
    if !host.permissions.contains("fs") {
        return Err(ApiError::new(
            Reason::Denied,
            "editor.render writes a file and needs permission \"fs\" in tool.json",
        ));
    }
    let path = absolute(params, "path")?;
    let out = absolute(params, "out")?;
    let format = opt_str_param(params, "format")?.unwrap_or("png");
    // 只用本插件自己的嵌入编辑器：按后缀判定，与窗口里选编辑器同一规则（最长后缀）。
    let asset = berth_tool_core::repository::load_tool_asset(&host.plugin_id)
        .ok()
        .flatten()
        .ok_or_else(|| ApiError::new(Reason::NotFound, "plugin tool.json is unreadable"))?;
    let lower = path.to_lowercase();
    let covered = berth_tool_core::editors::parse(asset.raw())
        .0
        .iter()
        .filter(|editor| editor.embed)
        .any(|editor| editor.suffixes.iter().any(|suffix| lower.ends_with(&suffix.to_lowercase())));
    if !covered {
        return Err(ApiError::new(
            Reason::NotFound,
            format!("plugin {} has no embed editor for {path}", host.plugin_id),
        ));
    }
    let desktop = DESKTOP.get().ok_or_else(|| {
        ApiError::new(
            Reason::Unsupported,
            "editor.render needs the Berth window; call it from `berth tools run|call`",
        )
    })?;
    desktop(json!({ "plugin": host.plugin_id, "path": path, "format": format, "out": out }))
}
