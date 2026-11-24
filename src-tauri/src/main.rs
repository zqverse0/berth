// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// CEF 的渲染、GPU、工具子进程也跑这个可执行文件（带 `--type=`），宏在进入下面的代码前就把它们分流走。
#[tauri_runtime_cef::cef_entry_point]
fn main() {
    // When called as a git credential helper, handle it immediately and exit.
    // This avoids starting the full Tauri GUI runtime.
    if std::env::args().any(|a| a == "--credential-helper") {
        // Subprocess mode, before the desktop logging init in `run()`: install a
        // stderr-only subscriber so helper diagnostics aren't dropped, while
        // stdout stays the git credential protocol channel.
        let _log_guard = berth_lib::logging::init::init_stderr_only();
        berth_lib::git::credential::run_credential_helper();
        return;
    }

    berth_lib::run()
}
