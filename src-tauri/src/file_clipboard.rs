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
pub async fn clipboard_read_files(window: tauri::Window) -> Result<Vec<ClipboardFile>, String> {
    let paths = read(&window).await?;
    Ok(paths.iter().filter_map(|path| describe(path)).collect())
}

#[tauri::command]
pub async fn clipboard_write_files(
    window: tauri::Window,
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

#[cfg(target_os = "linux")]
const GNOME_COPIED: &str = "x-special/gnome-copied-files";

#[cfg(target_os = "linux")]
fn system_clipboard() -> gtk::Clipboard {
    gtk::Clipboard::get(&gtk::gdk::SELECTION_CLIPBOARD)
}

#[cfg(target_os = "linux")]
async fn read(window: &tauri::Window) -> Result<Vec<PathBuf>, String> {
    let (done, result) = tokio::sync::oneshot::channel();
    let to_paths = |uris: Vec<String>| -> Vec<PathBuf> {
        uris.iter()
            .filter_map(|uri| gtk::glib::filename_from_uri(uri).ok())
            .map(|(path, _)| path)
            .collect()
    };
    window
        .run_on_main_thread(move || {
            system_clipboard().request_contents(
                &gtk::gdk::Atom::intern(GNOME_COPIED),
                move |clipboard, data| {
                    // 没有这种格式时长度为负。
                    let uris = if data.length() > 0 {
                        gnome_copied_uris(&data.data())
                    } else {
                        Vec::new()
                    };
                    if !uris.is_empty() {
                        let _ = done.send(to_paths(uris));
                        return;
                    }
                    clipboard.request_uris(move |_, uris| {
                        let uris = uris.iter().map(|uri| uri.to_string()).collect();
                        let _ = done.send(to_paths(uris));
                    });
                },
            );
        })
        .map_err(|error| error.to_string())?;
    result.await.map_err(|error| error.to_string())
}

#[cfg(target_os = "linux")]
async fn write(window: &tauri::Window, paths: Vec<PathBuf>) -> Result<(), String> {
    let uris = paths
        .iter()
        .map(|path| gtk::glib::filename_to_uri(path, None).map(|uri| uri.to_string()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| error.to_string())?;
    let (done, result) = tokio::sync::oneshot::channel();
    window
        .run_on_main_thread(move || {
            let copied = format!("copy\n{}", uris.join("\n"));
            let targets = [
                gtk::TargetEntry::new(GNOME_COPIED, gtk::TargetFlags::empty(), 0),
                gtk::TargetEntry::new("text/uri-list", gtk::TargetFlags::empty(), 1),
            ];
            let owned = system_clipboard().set_with_data(&targets, move |_, data, info| {
                if info == 0 {
                    data.set(&data.target(), 8, copied.as_bytes());
                } else {
                    let refs: Vec<&str> = uris.iter().map(String::as_str).collect();
                    data.set_uris(&refs);
                }
            });
            let _ = done.send(owned);
        })
        .map_err(|error| error.to_string())?;
    match result.await {
        Ok(true) => Ok(()),
        Ok(false) => Err("failed to own the clipboard".to_owned()),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(not(target_os = "linux"))]
async fn read(_window: &tauri::Window) -> Result<Vec<PathBuf>, String> {
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
async fn write(_window: &tauri::Window, paths: Vec<PathBuf>) -> Result<(), String> {
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
}
