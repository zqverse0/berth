# Berth

## 验证

- 用户常驻 `pnpm tauri dev --features debug-bridge`，改动自动重编；不另起、不杀。
- Rust 编译结果：`berth terminal capture -t <dev 终端> --lines 60`。不对 `berth-gui` / workspace 跑 cargo。
- 可以跑：单文件 `pnpm vitest run <file>`、`pnpm exec eslint <file>`、`cargo test -p <小 crate>`、pytest。一次一个。
- 运行时：`tauri-browser errors` / `console` → `snapshot` → `run-js` → `invoke`。不截图，纯视觉问题除外。
- worktree 里只跑 pytest、`git diff --check`、`scripts/dev-trial cargo check|test -p <crate>`；运行时验证用 `scripts/dev-trial` 合进 dev 测。
- 细则：`docs/verification.md`。

## 红线

- Agent 启动失败不改 Berth，查 `~/.berth/tools/<id>/launch.js`、`launchbar.json`、`experts/`。
- 不按 Agent id / 品牌名在 Rust 或 React 里分支；扩展契约字段。会话来源用插件 `sessions.json` 声明。
- 删除模块登记 `docs/REMOVED.md`；平时不读它。
- 密钥不硬编码，敏感信息经 `src-tauri/src/platform/keyring_store.rs`。
- 用户能点到的操作必须走得完，不留死入口。
- 新增依赖或能力前先查现有依赖 / 平台 / 后端是否已覆盖。
- 同一份数据只有一个权威来源；缓存写明从哪派生、谁让它失效。长得像的代码不强行合并。
- 只做用户要的；能扩展现有入口就不开新入口。无 UI 的能力做成 MCP。

## 前端 `src/`

- 静态导出：禁止动态路由 `[param]`，用查询参数。
- 用户可见文本双语：`src/i18n/messages/en.json` + `zh-CN.json`。
- 调后端走 `src/lib/transport/`，不直接 `fetch` / `invoke`。
- 模板字符串里 NUL 写 `\u0000`，不写 `\0` / `\x00`（SWC 会压成非法 `\00`，0.38.7 卡启动页）。
- 侧栏视图选项只放顶栏：`SidebarHeaderTabs` / `SidebarHeaderActions` / `SidebarHeaderButton`。
- 列表用文件列表行，不用卡片；样式用主题 token。
- 新增设置页先考虑并入现有页；要加就同时改 `catalog.ts`、`settings-tab.ts`、`SETTINGS_PAGE_LOADERS`、双语 i18n。
- 新增命令：`commands.ts` 登记、`command-controller.tsx` 实现、补 `WorkspaceCommands.<id>` 双语。
- 启动 Agent / 新建终端都经 `openLaunchShelf`，不另做入口。

## Rust `src-tauri/`

- `tauri.conf.json` 保留 `dangerousDisableAssetCspModification: ["style-src", "script-src"]`；改 CSP 用正式构建验证。
- GUI 不启动 `berth` 子进程复用逻辑，不做 GUI → CLI → GUI 回环；CLI 要桌面能力用 `berth-control-proto`。
- 路径只从 `src-tauri/src/platform/paths.rs` 取。dev 数据在 `~/.berth-dev`，不拷进 `~/.berth`。
- 优先扩展已有 command；不新增 `tmp_*`、`*_v2`、`*_for_<task>`、一次性或无调用方的 command。
- 已执行的迁移不改，新增迁移 `m{YYYYMMDD}_{NNN}_{description}.rs`。

## 终端 `src-tauri/terminal/`

- PTY 和终端生命周期只归 termd；GUI / CLI 经 `berth-term-sdk` 调用。群成员 ACP 进程只归 `berth group watch`。
- 删协议命令：变体原位改 `Reserved<N>`，不删行、不复用编号（bincode 按位置编号）。
- 线上协议字段名、持久化键名不改。

## 插件 `src-tauri/tool/`

- 新能力优先 skill / MCP，其次现有接入点的 JSON + 脚本，最后才改 Rust/React。
- 新增启动栏静态控件只改 `launchbar.json` + `launch.js`。
- 解析不丢未识别字段；保存不用 DTO 重写整份文件。
- parser 里不放软链接、进程启动、网络请求。
- `launch.js` 只写会话临时目录，不写 Agent 全局配置。
- 枚举 / 启动插件走 `list_tool_asset_ids()` 与 `plugins::ensure_enabled`，不自己扫 `tools/`。

## 工作方式

- 注释用简体中文。
- 在 `~/Project/berth-dev`（dev 分支）改；`~/Project/berth`（main）只合并发布。
- 不擅自新建 worktree；没有对应方向就直接在 berth-dev 改。
- 知识库只在用户指定时读写，不主动写笔记。
- 发布流程：`docs/releasing/workflow.md`。
