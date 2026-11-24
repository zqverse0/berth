//! 系统剪贴板里的文件：读别的应用复制的文件，写本机文件给文件管理器粘贴。
//!
//! Linux 不用 `arboard`：它只提供 `text/uri-list`，GNOME 系文件管理器粘贴认的是
//! `x-special/gnome-copied-files`，这里两种都给（读也都认）。

use std::path::{Path, PathBuf};

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClipboardFile {
    abs_path: String,
    name: String,
    kind: &'static str,
}

fn describe(path: &Path) -> Option<ClipboardFile> {
    // 已不存在的文件（复制后被删）不算可粘贴。
    let meta = std::fs::metadata(path).ok()?;
    Some(ClipboardFile {
        abs_path: path.to_str()?.to_owned(),
        name: path.file_name()?.to_str()?.to_owned(),
        kind: if meta.is_dir() { "dir" } else { "file" },
    })
}

#[tauri::command]
pub async fn clipboard_read_files<R: tauri::Runtime>(
    window: tauri::Window<R>,
) -> Result<Vec<ClipboardFile>, String> {
    let paths = read(&window).await?;
    Ok(paths.iter().filter_map(|path| describe(path)).collect())
}

#[tauri::command]
pub async fn clipboard_write_files<R: tauri::Runtime>(
    window: tauri::Window<R>,
    paths: Vec<PathBuf>,
) -> Result<(), String> {
    write(&window, paths).await
}

/// `x-special/gnome-copied-files` 的内容：首行 `copy` / `cut`（都按复制处理，不删来源），其后每行一个 URI。
#[cfg(any(target_os = "linux", test))]
fn gnome_copied_uris(data: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(data)
        .lines()
        .skip(1)
        .filter(|line| !line.is_empty())
        .map(str::to_owned)
        .collect()
}

/// `text/uri-list`：每行一个 URI，CRLF 分隔，`#` 开头是注释。
#[cfg(any(target_os = "linux", test))]
fn uri_list(data: &[u8]) -> Vec<String> {
    String::from_utf8_lossy(data)
        .lines()
        .map(|line| line.trim_end_matches('\r'))
        .filter(|line| !line.is_empty() && !line.starts_with('#'))
        .map(str::to_owned)
        .collect()
}

#[cfg(target_os = "linux")]
const GNOME_COPIED: &str = "x-special/gnome-copied-files";
#[cfg(target_os = "linux")]
const URI_LIST: &str = "text/uri-list";

#[cfg(target_os = "linux")]
fn system_clipboard() -> Result<gtk4::gdk::Clipboard, String> {
    use gtk4::gdk::prelude::DisplayExt;
    gtk4::gdk::Display::default()
        .map(|display| display.clipboard())
        .ok_or_else(|| "no display".to_owned())
}

/// 在 GLib 主循环上读剪贴板（GDK4 的异步读取要靠主循环推进）。
#[cfg(target_os = "linux")]
async fn read_uris() -> Result<Vec<String>, String> {
    use gtk4::gio::prelude::InputStreamExt;
    use gtk4::glib::Priority;

    let clipboard = system_clipboard()?;
    // 两种格式都没有时报错，按空剪贴板处理。
    let Ok((stream, mime)) = clipboard.read_future(&[GNOME_COPIED, URI_LIST], Priority::DEFAULT).await
    else {
        return Ok(Vec::new());
    };
    let mut data = Vec::new();
    loop {
        let chunk = stream
            .read_bytes_future(64 * 1024, Priority::DEFAULT)
            .await
            .map_err(|error| error.to_string())?;
        if chunk.is_empty() {
            break;
        }
        data.extend_from_slice(&chunk);
    }
    Ok(if mime == GNOME_COPIED {
        gnome_copied_uris(&data)
    } else {
        uri_list(&data)
    })
}

#[cfg(target_os = "linux")]
async fn read<R: tauri::Runtime>(window: &tauri::Window<R>) -> Result<Vec<PathBuf>, String> {
    use tauri::Manager as _;

    let (done, result) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || {
            gtk4::glib::MainContext::default().spawn_local(async move {
                let _ = done.send(read_uris().await);
            });
        })
        .map_err(|error| error.to_string())?;
    let uris = result.await.map_err(|error| error.to_string())??;
    Ok(uris
        .iter()
        .filter_map(|uri| gtk4::glib::filename_from_uri(uri).ok())
        .map(|(path, _)| path)
        .collect())
}

#[cfg(target_os = "linux")]
async fn write<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    paths: Vec<PathBuf>,
) -> Result<(), String> {
    use gtk4::gdk::ContentProvider;
    use gtk4::glib::Bytes;
    use tauri::Manager as _;

    let uris = paths
        .iter()
        .map(|path| gtk4::glib::filename_to_uri(path, None).map(|uri| uri.to_string()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let (done, result) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || {
            let copied = format!("copy\n{}", uris.join("\n"));
            let list: String = uris.iter().map(|uri| format!("{uri}\r\n")).collect();
            let provider = ContentProvider::new_union(&[
                ContentProvider::for_bytes(GNOME_COPIED, &Bytes::from_owned(copied.into_bytes())),
                ContentProvider::for_bytes(URI_LIST, &Bytes::from_owned(list.into_bytes())),
            ]);
            let owned = system_clipboard().and_then(|clipboard| {
                clipboard
                    .set_content(Some(&provider))
                    .map_err(|error| error.to_string())
            });
            let _ = done.send(owned);
        })
        .map_err(|error| error.to_string())?;
    result.await.map_err(|error| error.to_string())?
}

#[cfg(not(target_os = "linux"))]
async fn read<R: tauri::Runtime>(_window: &tauri::Window<R>) -> Result<Vec<PathBuf>, String> {
    tokio::task::spawn_blocking(|| {
        match arboard::Clipboard::new().and_then(|mut clipboard| clipboard.get().file_list()) {
            Ok(paths) => Ok(paths),
            Err(arboard::Error::ContentNotAvailable) => Ok(Vec::new()),
            Err(error) => Err(error.to_string()),
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(not(target_os = "linux"))]
async fn write<R: tauri::Runtime>(
    _window: &tauri::Window<R>,
    paths: Vec<PathBuf>,
) -> Result<(), String> {
    tokio::task::spawn_blocking(move || {
        arboard::Clipboard::new()
            .and_then(|mut clipboard| clipboard.set().file_list(&paths))
            .map_err(|error| error.to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn gnome_copied_skips_the_operation_line() {
        assert_eq!(
            gnome_copied_uris(b"copy\nfile:///a%20b\nfile:///c\n"),
            ["file:///a%20b", "file:///c"]
        );
        assert!(gnome_copied_uris(b"").is_empty());
    }

    #[test]
    fn uri_list_skips_comments_and_crlf() {
        assert_eq!(
            uri_list(b"# comment\r\nfile:///a%20b\r\nfile:///c\r\n"),
            ["file:///a%20b", "file:///c"]
        );
        assert!(uri_list(b"").is_empty());
    }
}
