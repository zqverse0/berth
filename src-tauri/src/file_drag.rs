//! 把本机文件作为系统拖动发起（对方设备的文件拖到文件管理器），拖动结束后返回。
//!
//! Linux 不用 `drag` crate：它在 drop-performed 时就断开 drag-data-get，而放下的一方这之后才来要
//! 数据，于是文件管理器什么也收不到。这里等 drag-end（对方取完数据或拖动失败）才清理。

use std::path::{Path, PathBuf};

use base64::Engine;
use tokio::sync::oneshot;

#[tauri::command]
pub async fn start_file_drag(
    window: tauri::Window,
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
fn begin(
    window: &tauri::Window,
    path: &Path,
    image: Vec<u8>,
    ended: oneshot::Sender<()>,
) -> Result<(), String> {
    use std::cell::RefCell;
    use std::rc::Rc;

    use gtk::gdk_pixbuf::prelude::PixbufLoaderExt;
    use gtk::glib::prelude::ObjectExt;
    use gtk::prelude::{DragContextExtManual, WidgetExt};

    let gtk_window = window.gtk_window().map_err(|error| error.to_string())?;
    let uri = gtk::glib::filename_to_uri(path, None).map_err(|error| error.to_string())?;
    let targets = gtk::TargetList::new(&[]);
    targets.add_uri_targets(0);

    let handlers = Rc::new(RefCell::new(Vec::new()));
    handlers
        .borrow_mut()
        .push(gtk_window.connect_drag_data_get(move |_, _, data, _, _| {
            data.set_uris(&[uri.as_str()]);
        }));
    let disconnect = {
        let handlers = handlers.clone();
        move |widget: &gtk::ApplicationWindow| {
            for handler in handlers.borrow_mut().drain(..) {
                widget.disconnect(handler);
            }
        }
    };
    let ended = RefCell::new(Some(ended));
    let on_end = disconnect.clone();
    let end = gtk_window.connect_drag_end(move |widget, _| {
        if let Some(ended) = ended.borrow_mut().take() {
            let _ = ended.send(());
        }
        on_end(widget);
    });
    handlers.borrow_mut().push(end);

    let Some(context) = gtk_window.drag_begin_with_coordinates(
        &targets,
        gtk::gdk::DragAction::COPY,
        1,
        None,
        -1,
        -1,
    ) else {
        disconnect(&gtk_window);
        return Err("failed to start the drag".to_owned());
    };
    let loader = gtk::gdk_pixbuf::PixbufLoader::new();
    if loader.write(&image).and_then(|()| loader.close()).is_ok() {
        if let Some(icon) = loader.pixbuf() {
            context.drag_set_icon_pixbuf(&icon, 0, 0);
        }
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
fn begin(
    window: &tauri::Window,
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
