# 终端（`src-tauri/terminal/`）

- 布局：`shared/`、`daemon/`、`sdk/`、`cli/`；宿主侧接入在 `src-tauri/src/terminal/`。
- **termd 拥有 session / window / pane、PTY 与流状态**；CLI 与 GUI 都经 `berth-term-sdk`
  连接，不得各自复制终端生命周期。
- 这些 crates 额外 `forbid(unsafe_code)` + `deny(missing_docs)`。
- 来源于上游 RMUX（已改名 `berth-term-*`，LICENSE 在 `src-tauri/vendor/rmux/`）；
  不从上游 merge / rebase / cherry-pick。
- **线上协议字段名、持久化键名不得在普通 PR 里改值**，包括从上游继承的名字。例：
  `berth-term-proto/src/response/server.rs` 的 `#[serde(rename = "rmux_version")]`
  （Rust 字段已改名 `terminal_version`，只保留线上名）。
