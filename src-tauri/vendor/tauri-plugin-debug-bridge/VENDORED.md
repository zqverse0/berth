# tauri-plugin-debug-bridge（vendor）

来源：crates.io `tauri-plugin-debug-bridge` 0.6.0（MIT，https://github.com/thrashr888/tauri-browser）。

上游还没有 Tauri 3 版本；这里只把 `tauri` / `tauri-plugin` 依赖改到 3.0 alpha，
并让 macOS 的 WKWebView 原生路径在 CEF 下退回 `eval`（`webview.rs` / `target.rs` 里原 macOS 分支改为 `#[cfg(any())]` 停用，
删掉了 objc2 系依赖；截图在所有平台都返回 501）。上游发布 Tauri 3 版本后删除本目录，改回 crates.io 依赖。
仅 dev（`debug-bridge` feature）使用，不进正式版。
