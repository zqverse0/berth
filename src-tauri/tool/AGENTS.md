# Tool 契约（`src-tauri/tool/` 与 `~/.berth/tools/<id>/`）

核心最小化，JSON 数据驱动。

`~/.berth/tools/<id>/tool.json` 是用户可维护的声明式契约，服务两类对象：
`identity.roles: ["agent"]` 的编码 Agent，以及 `roles: []` 的普通 CLI 工具（jq、tree）。
Agent 身份来自 `tool.json`；启动栏选项来自 `launchbar.json`；启动命令由同目录
`launch.js` 根据前端选择拼接（写法见 `docs/plugin-development.md`）。**不写进 Agent 专属的前后端分支。**

## 原则

- 先扩展契约能表达的通用字段类型、区域或功能投影，再由 JSON 组合。
- 未识别字段原样保留并容错展示；解析不丢字段，保存不用已知 DTO 重写整份文件。
- `version` / `schema` 是文件自身的声明与诊断信息，不与 Berth 版本绑定，也不是
  「整份文件是否可读」的总开关；按能识别的字段渐进解析。
- Contract 模块只负责「读懂契约」：保留原文、解析、诊断、按功能投影。启动、Skills、
  MCP、配置文件、资源、账户用量各自由功能模块消费投影。**不得把软链接、进程启动、
  网络请求堆进 Contract parser。**
- 纯 Rust 核心（`berth-tool-core`）拥有解析、默认值、校验、能力选择、执行计划与统一
  结果语义。

## 插件包

`tools/<id>/` 就是 Berth 插件，入口只有 `tool.json`。包内只允许两类文件：

- **约定文件**（宿主按名读取，封闭列表见 `berth-tool-core/src/package.rs`）：`tool.json`、
  `launch.js`、`launchbar.json`、`install.sh|ps1`、`usage.json`、`usage.md`、`icon.svg|png`、`private/`，
  以及分发包常规的 `README.md`、`LICENSE`、`.gitignore`。
- **声明资源**：`resources.*.locator.base == "package"` 引用的路径（如 `sessions.json`）。

其余文件不是插件内容（调研写进知识库），`berth tools check` 会报出。
插件能接入宿主的位置只有 `docs/contribution-points.md` 列出的接入点；`check` 输出每个插件
`contributes …`，并报出宿主不认识的 `extensions` 命名空间与 agent 键。
**部署只做会话级**：`launch.js` 只在会话临时目录组装 skills / MCP / settings 并经 CLI
参数注入，不写 Agent 全局配置——停用插件即还原，不需要部署记账。

生命周期状态在 `$BERTH_HOME/plugins.json`（`enabled` / `source` / `rev`，缺条目即启用），
逻辑只在 `berth-tool-core::plugins`。运行入口（会话、用量、启动栏）用 `list_tool_asset_ids()`
（只含启用的），管理视图用 `list_installed_tool_asset_ids()`；启动与执行入口调
`plugins::ensure_enabled`。新增枚举或启动入口必须走同一闸口，不得自己扫 `tools/`。
CLI：`berth tools enable|disable|install <git>|update|remove`；GUI：设置页「工具」开关。

加新能力时停在第一个够用的：skill / MCP（Agent 直接调程序）→ 现有贡献点上的 JSON 与脚本 →
才改 Rust/React 新增贡献点，且定义、提供、消费三方同时落地。

## 启动栏与启动脚本分离

`launchbar.json` 只描述控件和选项，前端只负责选择。点启动时 Berth 终端 exec
`berth-cli tools launch <tools>/<id>/launch.js --berth-launch-inputs <json>`（同一 JSON 也写入
`BERTH_LAUNCH_INPUTS`），argv 由脚本拼接；没有 `launch.js` 就报错，不回落 tool.json emit。
**新增静态控件只改 `launchbar.json` + `launch.js`，不改 Berth**；只有新的宿主选项来源
（`optionsFrom`）才改 Rust/React。`optionsFrom: "experts"` 加载时读取
`$BERTH_HOME/experts/*.json`。

## 按需细则

| 需要 | 读 |
|---|---|
| 写 / 调试插件 | `docs/plugin-development.md` |
| 插件接口约定（不变项、版本、命名空间） | `docs/plugin-architecture.md` |
| 契约字段与数据流 | `docs/agent-contracts.md` |
| GUI 表单与结果投影（`inputSchema` / `views.berth` / 诊断降级） | `.trellis/spec/guides/tool-runtime-surfaces.md` |
| 前端契约与容错 | `.trellis/spec/frontend/agent-contract-core.md` |
| Pi 专家表 | `docs/expert-runtime.md`、`.trellis/spec/guides/expert-package-persona.md` |
