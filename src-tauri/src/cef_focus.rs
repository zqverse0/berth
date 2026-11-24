//! X11 下补齐 CEF 嵌入窗口的焦点转发与 `WM_CLASS`。
//!
//! 1. 焦点：CEF 在 Linux 上把浏览器嵌成顶层窗口里的 X11 子窗口（顶层 → CEF 宿主 → 渲染窗口），
//!    窗口管理器把输入焦点给顶层窗口，按键不会转到子窗口，页面一个键都收不到。
//!    顶层窗口得到焦点时，沿窗口树找到最里层的渲染窗口，把输入焦点设过去。
//! 2. `WM_CLASS`：CEF / GTK4 顶层窗口默认 `WM_CLASS` 为空（tauri#16474），导致任务栏图标分组与
//!    `.desktop` 的 `StartupWMClass=berth-gui` 对不上；创建后经 `XSetClassHint` 补上。
//!
//! Wayland 不走这里。ponytail: tauri-runtime-cef 修复 #16251/#16351/#16474 后删除本模块。

use std::ffi::CString;

use raw_window_handle::{HasWindowHandle, RawWindowHandle};
use x11_dl::xlib;

fn x11_toplevel_window(window: &impl HasWindowHandle) -> Option<xlib::Window> {
    let handle = window.window_handle().ok()?;
    match handle.as_raw() {
        RawWindowHandle::Xlib(handle) => Some(handle.window),
        RawWindowHandle::Xcb(handle) => Some(handle.window.get().into()),
        _ => None,
    }
}

/// X11 下给顶层窗口设置 `WM_CLASS`（与 `tauri.conf.json` 的 `mainBinaryName` / `.desktop` 的
/// `StartupWMClass=berth-gui` 对齐）。ponytail: tauri#16474 修复后删除。
pub fn apply_wm_class(window: &impl HasWindowHandle) {
    let Some(toplevel) = x11_toplevel_window(window) else {
        return;
    };
    let Ok(xlib) = xlib::Xlib::open() else {
        return;
    };
    let class_name = CString::new("berth-gui").expect("static WM_CLASS contains no NUL");
    unsafe {
        let display = (xlib.XOpenDisplay)(std::ptr::null());
        if display.is_null() {
            return;
        }
        let hint = (xlib.XAllocClassHint)();
        if !hint.is_null() {
            (*hint).res_name = class_name.as_ptr().cast_mut();
            (*hint).res_class = class_name.as_ptr().cast_mut();
            (xlib.XSetClassHint)(display, toplevel, hint);
            (xlib.XFree)(hint.cast());
        }
        (xlib.XFlush)(display);
        (xlib.XCloseDisplay)(display);
    }
}

pub fn focus_browser<R: tauri::Runtime>(window: &tauri::Window<R>) {
    let Some(toplevel) = x11_toplevel_window(window) else {
        return;
    };
    let Ok(xlib) = xlib::Xlib::open() else {
        return;
    };
    unsafe {
        let display = (xlib.XOpenDisplay)(std::ptr::null());
        if display.is_null() {
            return;
        }
        let target = innermost_child(&xlib, display, toplevel);
        if target != toplevel {
            (xlib.XSetInputFocus)(display, target, xlib::RevertToParent, xlib::CurrentTime);
        }
        (xlib.XCloseDisplay)(display);
    }
}

/// 每层取面积最大的已映射子窗口往下走（顶层里还有 winit 的 1x1 辅助窗口），返回路径上最深的
/// 订阅了 KeyPress 的窗口：渲染窗口下面还会冒出 GPU 进程的绘制窗口，它不收按键，不能给它焦点。
unsafe fn innermost_child(
    xlib: &xlib::Xlib,
    display: *mut xlib::Display,
    mut window: xlib::Window,
) -> xlib::Window {
    let toplevel = window;
    let mut target = toplevel;
    loop {
        let (mut root, mut parent) = (0, 0);
        let mut children: *mut xlib::Window = std::ptr::null_mut();
        let mut count = 0;
        if (xlib.XQueryTree)(display, window, &mut root, &mut parent, &mut children, &mut count) == 0
            || children.is_null()
        {
            return target;
        }
        let mut best = None;
        let mut best_area = 0i64;
        for &child in std::slice::from_raw_parts(children, count as usize) {
            let mut attrs: xlib::XWindowAttributes = std::mem::zeroed();
            if (xlib.XGetWindowAttributes)(display, child, &mut attrs) == 0
                || attrs.map_state != xlib::IsViewable
            {
                continue;
            }
            let area = i64::from(attrs.width) * i64::from(attrs.height);
            if area > best_area {
                best = Some((child, attrs.all_event_masks & xlib::KeyPressMask != 0));
                best_area = area;
            }
        }
        (xlib.XFree)(children.cast());
        match best {
            Some((child, takes_keys)) => {
                if takes_keys {
                    target = child;
                }
                window = child;
            }
            None => return target,
        }
    }
}
