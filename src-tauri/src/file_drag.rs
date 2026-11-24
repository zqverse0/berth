//! 把本机文件作为系统拖动发起（对方设备的文件拖到文件管理器），拖动结束后返回。
//!
//! Linux 不用 `drag` crate（只支持 GTK3，CEF 窗口是 GTK4）：直接 `gdk::Drag::begin`，内容由
//! ContentProvider 按需提供，等 dnd-finished / cancel（对方取完数据或拖动失败）才算结束。

use std::path::{Path, PathBuf};

use base64::Engine;
use tauri::Manager as _;
use tokio::sync::oneshot;

#[tauri::command]
pub async fn start_file_drag<R: tauri::Runtime>(
    window: tauri::Window<R>,
    path: PathBuf,
    image_png: String,
) -> Result<(), String> {
    let image = base64::engine::general_purpose::STANDARD
        .decode(image_png)
        .map_err(|error| error.to_string())?;
    let (started_tx, started) = oneshot::channel();
    let (ended_tx, ended) = oneshot::channel();
    let target = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = started_tx.send(begin(&target, &path, image, ended_tx));
        })
        .map_err(|error| error.to_string())?;
    started.await.map_err(|error| error.to_string())??;
    // 发送端随窗口一起销毁时也算结束。
    let _ = ended.await;
    Ok(())
}

#[cfg(target_os = "linux")]
fn begin<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    path: &Path,
    image: Vec<u8>,
    ended: oneshot::Sender<()>,
) -> Result<(), String> {
    use std::cell::RefCell;
    use std::rc::Rc;

    use gtk4::gdk;
    use gtk4::gdk::prelude::{DisplayExt, DragExt, SeatExt, SurfaceExt};
    use gtk4::gdk_pixbuf::prelude::PixbufLoaderExt;
    use gtk4::glib;
    use gtk4::prelude::NativeExt;

    let gtk_window = window.gtk_window().map_err(|error| error.to_string())?;
    let surface = gtk_window.surface().ok_or("window has no surface")?;
    let device = surface
        .display()
        .default_seat()
        .and_then(|seat| seat.pointer())
        .ok_or("no pointer device")?;
    let (x, y, _) = surface
        .device_position(&device)
        .unwrap_or((0.0, 0.0, gdk::ModifierType::empty()));
    let uri = glib::filename_to_uri(path, None).map_err(|error| error.to_string())?;
    let content = gdk::ContentProvider::for_bytes(
        "text/uri-list",
        &glib::Bytes::from_owned(format!("{uri}\r\n").into_bytes()),
    );
    let drag = gdk::Drag::begin(&surface, &device, &content, gdk::DragAction::COPY, x, y)
        .ok_or("failed to start the drag")?;

    let loader = gtk4::gdk_pixbuf::PixbufLoader::new();
    if loader.write(&image).and_then(|()| loader.close()).is_ok() {
        if let Some(icon) = loader.pixbuf() {
            #[allow(deprecated)]
            gtk4::DragIcon::set_from_paintable(&drag, &gdk::Texture::for_pixbuf(&icon), 0, 0);
        }
    }

    // 拖动期间自己持有 Drag 引用，结束（放下完成或取消）时放掉并通知等待方。
    let held = Rc::new(RefCell::new(Some((drag.clone(), ended))));
    let finish = move || {
        if let Some((_, ended)) = held.borrow_mut().take() {
            let _ = ended.send(());
        }
    };
    let on_finished = finish.clone();
    drag.connect_dnd_finished(move |_| on_finished());
    drag.connect_cancel(move |_, _| finish());
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn begin<R: tauri::Runtime>(
    window: &tauri::Window<R>,
    path: &Path,
    image: Vec<u8>,
    ended: oneshot::Sender<()>,
) -> Result<(), String> {
    let ended = std::sync::Mutex::new(Some(ended));
    drag::start_drag(
        window,
        drag::DragItem::Files(vec![path.to_path_buf()]),
        drag::Image::Raw(image),
        move |_, _| {
            if let Some(ended) = ended.lock().expect("drag lock").take() {
                let _ = ended.send(());
            }
        },
        drag::Options::default(),
    )
    .map_err(|error| error.to_string())
}
