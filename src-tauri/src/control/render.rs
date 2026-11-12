//! `editor.render`：插件脚本（`berth.editor.render`）请主窗口用插件的嵌入页面把文件渲染成图片。
//!
//! 与 `file.open` 同一交接方式：登记 → 事件唤醒主窗口 → 主窗口渲染后回执 data URL →
//! 这里解码写到 `out`。图片不经控制通道回传（单帧上限 1 MiB）。仅内存态，迟到的回执无害。

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

use base64::Engine as _;
use berth_control_proto::{EditorRenderParams, EditorRenderResult, ErrorKind, RpcRequest};
use tauri::Manager;
use tokio::sync::oneshot;

use super::ControlContext;

type HandlerResult = Result<serde_json::Value, (ErrorKind, String)>;

/// 主窗口订阅的唤醒事件。
pub(crate) const EDITOR_RENDER_EVENT: &str = "plugin://editor-render";
/// 等主窗口回执的上限：首次渲染要加载插件页面。
const RENDER_TIMEOUT: Duration = Duration::from_secs(30);
/// 同时等待的渲染请求上限。
const MAX_PENDING: usize = 8;

type Outcome = Result<String, String>;

struct Registry {
    next_id: u64,
    waiters: HashMap<u64, oneshot::Sender<Outcome>>,
}

fn registry() -> &'static Mutex<Registry> {
    static REGISTRY: OnceLock<Mutex<Registry>> = OnceLock::new();
    REGISTRY.get_or_init(|| {
        Mutex::new(Registry {
            next_id: 0,
            waiters: HashMap::new(),
        })
    })
}

/// 主窗口回执：`Ok(data URL)` 或 `Err(原因)`；未知或已超时的 id 忽略。
pub(crate) fn complete(request_id: u64, outcome: Outcome) {
    let waiter = registry()
        .lock()
        .expect("render registry lock")
        .waiters
        .remove(&request_id);
    if let Some(waiter) = waiter {
        let _ = waiter.send(outcome);
    }
}

/// `data:<mime>;base64,<数据>` → (mime, 字节)；插件返回别的形式就报错。
fn decode_data_url(url: &str) -> Result<(String, Vec<u8>), String> {
    let (head, data) = url
        .strip_prefix("data:")
        .and_then(|rest| rest.split_once(','))
        .ok_or("plugin did not return an image data URL")?;
    let mime = head
        .strip_suffix(";base64")
        .ok_or("plugin returned an image that is not base64-encoded")?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| format!("plugin returned invalid base64: {error}"))?;
    Ok((mime.to_owned(), bytes))
}

pub(crate) async fn editor_render(request: &RpcRequest, context: &ControlContext) -> HandlerResult {
    let params: EditorRenderParams = serde_json::from_value(request.params.clone())
        .map_err(|error| (ErrorKind::InvalidParams, error.to_string()))?;
    let path = std::path::Path::new(&params.path);
    let out = std::path::Path::new(&params.out);
    if !path.is_absolute() || !out.is_absolute() {
        return Err((ErrorKind::InvalidParams, "path and out must be absolute".into()));
    }
    if !path.is_file() {
        return Err((ErrorKind::NotFound, format!("{} is not a file", params.path)));
    }
    let deps = context
        .deps
        .as_ref()
        .ok_or((ErrorKind::Internal, "editor.render requires runtime dependencies".into()))?;
    if deps.app.get_webview_window("main").is_none() {
        return Err((ErrorKind::NotFound, "the main Berth window is not open".into()));
    }
    let (id, receiver) = {
        let mut registry = registry().lock().expect("render registry lock");
        registry.waiters.retain(|_, waiter| !waiter.is_closed());
        if registry.waiters.len() >= MAX_PENDING {
            return Err((ErrorKind::Rejected, "too many renders in flight; retry later".into()));
        }
        registry.next_id += 1;
        let (sender, receiver) = oneshot::channel();
        let id = registry.next_id;
        registry.waiters.insert(id, sender);
        (id, receiver)
    };
    crate::event_bridge::emit_event(
        &deps.emitter,
        EDITOR_RENDER_EVENT,
        &serde_json::json!({
            "request_id": id,
            "plugin": params.plugin,
            "path": params.path,
            "format": params.format,
        }),
    );
    let url = match tokio::time::timeout(RENDER_TIMEOUT, receiver).await {
        Ok(Ok(Ok(url))) => url,
        Ok(Ok(Err(message))) => return Err((ErrorKind::Internal, message)),
        Ok(Err(_)) => return Err((ErrorKind::Internal, "render request was dropped".into())),
        Err(_) => {
            complete(id, Err(String::new()));
            return Err((ErrorKind::Timeout, "the Berth window did not finish rendering in time".into()));
        }
    };
    let (mime, bytes) = decode_data_url(&url).map_err(|message| (ErrorKind::Internal, message))?;
    if let Some(parent) = out.parent() {
        std::fs::create_dir_all(parent)
            .map_err(|error| (ErrorKind::Internal, format!("{}: {error}", parent.display())))?;
    }
    std::fs::write(out, &bytes)
        .map_err(|error| (ErrorKind::Internal, format!("{}: {error}", params.out)))?;
    serde_json::to_value(EditorRenderResult {
        out: params.out,
        mime,
        bytes: bytes.len() as u64,
    })
    .map_err(|error| (ErrorKind::Internal, error.to_string()))
}

/// 主窗口交回 `editor.render` 的渲染结果（`image` 为 data URL，失败时给 `message`）。
/// 只服务这一个交接，不是任意动作执行器；仅 `main` 窗口可调用。
#[tauri::command]
pub(crate) async fn editor_render_complete(
    window: crate::WebviewWindow,
    request_id: u64,
    image: Option<String>,
    message: Option<String>,
) -> Result<(), crate::app_error::AppCommandError> {
    if window.label() != "main" {
        return Err(crate::app_error::AppCommandError::permission_denied(
            "only the main window may settle render requests",
        ));
    }
    complete(
        request_id,
        image.ok_or_else(|| message.unwrap_or_else(|| "plugin returned no image".into())),
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn data_url_must_be_base64_image() {
        let (mime, bytes) = decode_data_url("data:image/png;base64,iVBORw==").unwrap();
        assert_eq!(mime, "image/png");
        assert_eq!(bytes, [0x89, b'P', b'N', b'G']);
        assert!(decode_data_url("data:image/svg+xml;charset=utf-8,%3Csvg").is_err());
        assert!(decode_data_url("not a url").is_err());
    }

    #[test]
    fn completion_reaches_the_waiter_once() {
        let (sender, mut receiver) = oneshot::channel();
        registry().lock().unwrap().waiters.insert(9_999, sender);
        complete(9_999, Ok("data:image/png;base64,".into()));
        complete(9_999, Err("late".into()));
        assert_eq!(receiver.try_recv().unwrap(), Ok("data:image/png;base64,".into()));
    }
}
