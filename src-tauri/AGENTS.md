# Rust 宿主（`src-tauri/`）

## 写码约定

- `#[cfg(feature = "tauri-runtime")]`：仅桌面模式编译。
- `#[cfg_attr(feature = "tauri-runtime", tauri::command)]`：始终可用，桌面模式才注册为命令。
- `_core` 后缀函数接受普通引用参数（`&AppDatabase`、`&EventEmitter`），供 Tauri 命令复用。
- 新增 Entity / Service 必须在对应 `mod.rs` 注册。
- 错误类型用 `thiserror`；**敏感信息必须经 `src/platform/keyring_store.rs`。**
- Rust 编译资源约束见 `docs/verification.md`「Rust 编译资源约束」。

## 依赖方向

```text
tool.json → berth-tool-core / 领域 service → CLI adapter
                                         └→ Tauri adapter → GUI
CLI / GUI → berth-term-sdk → termd
CLI → berth-control-proto → 已运行的 GUI（仅桌面专属动作）
```

- 纯 Rust 核心不依赖 Tauri / React / clap。
- CLI 是 shell 与 Agent 的外部入口，不得成为 GUI 内部正常调用的唯一实现。
- GUI 经薄 Tauri adapter 进入同一领域 service；不得启动 `berth` 子进程复用业务逻辑，
  不得 GUI → CLI → GUI 回环。
- CLI 需要桌面专属能力时用 `berth-control-proto` typed RPC；只读发现 / 检查不得偷偷拉起 GUI。

## 数据目录

解析入口统一在 `src-tauri/src/platform/paths.rs`，勿在别处手拼：

- `~/.berth/`（`berth_home_dir()`，可用 `BERTH_HOME` 覆盖）：用户资源
  `skills/`、`prompts/`、`mcp/`、`experts/`、`tools/`、`guides/`（`berth guide` 的用户补充，附在内置说明之后），**不跟随** `BERTH_DATA_DIR`。
- app 数据目录：正式版 `~/.local/share/app.berth/`（`berth.db`）；dev 实例由
  `scripts/dev-instance-env.mjs` 设为 `~/.berth-dev`（`berth-dev.db`），与正式版隔离。
  **不要**把这里的内容拷进 `~/.berth`。
- `BERTH_DATA_DIR` 是数据目录变量；只设旧 `CODEG_*` 会启动失败。

## 红线：Command 是公开契约

默认复用、合并或扩展已有命令（变体用参数 / 已有 operation 分发）。新增须同时满足并写进提交说明：

1. 最小用户需求已写成一句话结果，没有顺手功能
2. 扩现有命令会让它变成杂烩，或不再是一件事
3. 名字按长期契约起（禁止 `tmp_*`、`*_v2`、`*_for_<task>`、一次性探测命令）
4. 落在「读 / 配 / 跑 / 收」主线，或是主线上可独立维护的卫星
5. 写清为什么这是缝合点、复用为什么不够、删除时如何登记 `REMOVED.md`

禁止一次性入口、拆命令凑 PR、无调用方的命令。
改动前后各跑 `rg -c '^\s*[a-z_]+::[a-z_]+,' src-tauri/src/lib.rs`，在提交说明里解释差额。

## 红线：Tauri 正式版 CSP 改写

`tauri.conf.json` 必须保留 `dangerousDisableAssetCspModification: ["style-src", "script-src"]`。
打包时 Tauri 给内联资源算哈希追加进 CSP，一旦带哈希 `'unsafe-inline'` 就失效：
- `style-src`：CodeMirror、xterm、Sonner 运行时插入的 `<style>` 被拦，`.deb` 中 `style.sheet` 为 `null`，
  编辑器布局和终端 ANSI 颜色失效。
- `script-src`：`srcdoc` 预览框继承父页面 CSP，预览注入的 nonce 脚本（插件 `org.berth.preview.script`、
  元素拾取桥）被拦，officecli 预览不缩放、拾取失效；dev（Vite）不改写，所以只在正式版出现。

改 CSP 或 asset 配置后必须用启用 `tauri/custom-protocol` 的正式构建验证（裸 `cargo build` 会连
`devUrl`，不代表打包行为）：检查动态 `<style>` 的 `sheet !== null`，`.xterm-fg-*` 计算颜色不是默认前景色，
pptx 预览侧栏隐藏且幻灯片按宽度缩放。

## 常见落点

| 任务 | 落点 |
|---|---|
| 新增会话来源 | 优先 `$BERTH_HOME/tools/<id>/sessions.json` 声明；reader 在 `src/sessions/`，禁止新增品牌 parser |
| 修改事件系统 | `src/event_bridge.rs` |
| CLI 控制面 | `src/control/` + `control/berth-control-proto/` |
| runtime bridge method | `src/commands/runtime_bridge.rs` 分发到各模块 `dispatch` |

会话来源（`sessions.json` + reader）与工具契约（`tool.json`）是两条独立的线，互不读取。

## 高风险区域

改动前格外谨慎：`src/lib.rs`（启动与公开 command）· `src/event_bridge.rs`（事件枢纽）·
`src/sessions/`（声明式 reader、项目索引与 reconcile）· `terminal/` crates ·
`project/berth-project-core/src/migration/`（不可逆）· `keyring_store.rs`。
