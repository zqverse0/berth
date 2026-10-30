# 插件接入点（Contribution Points）

Berth 插件（`$BERTH_HOME/tools/<id>/`）只能往本表列出的位置接入；宿主只通过这些位置读插件。
表外的声明不生效，`berth tools check` 会报出。新增接入点必须同时落地三方：本表的定义、
插件的声明、宿主的消费代码（见 `src-tauri/tool/AGENTS.md`「插件包」）。

`berth tools check [<id>]` 每个插件输出 `contributes …`，即它实际接入了哪些位置；`berth tools list`
与设置页「工具」列表显示同一结果。

**Berth 不执行插件声明的命令。** Agent 需要某个程序（`gh`、`officecli`…）就直接调用它，用法写在
包内 `usage.md`；Agent 启动只认 `launch.js`。`tool.json` 的 `actions` / `examples` 已于 2026-10-03
退役，带这两个键的插件会被 `tools check` 报出（宿主不读）。

## 已开放

| 接入点 | 插件提供 | 宿主消费 |
|---|---|---|
| `launchbar` | `launch.js` + `launchbar.json` | 启动栏控件与启动命令（`src-tauri/src/commands/terminal.rs`、`launchbar.rs`） |
| `agent` | `extensions["org.berth.agent"].projectType` | 侧栏 Agent 列表、项目会话归属（`src-tauri/src/tool/agent_projection.rs`） |
| `agent.sessions` | `…sessions` → `resources` 中的 `sessions.json` | 项目会话列表与回放（`src-tauri/src/sessions/declarative.rs`）、`berth session last` |
| `agent.usage` | `…usage`（可引用 `usage.json`） | 账户用量轮询（`src-tauri/src/model_provider/usage.rs`） |
| `agent.providerInjection` | `…providerInjection` | 模型服务商注入环境变量（`berth-tool-core/src/provider_injection.rs`） |
| `agent.logins` | `…logins` | 设置页登录凭证卡（`src-tauri/src/model_provider/login.rs`） |
| `agent.capabilityStores` | `…capabilityStores` | 设置页 Skills / MCP 状态（`src-tauri/src/tool/agent_projection.rs`） |
| `agent.promptInput` | `…promptInput` | 协作派发的首条 prompt（`berth group spawn`、宿主启动时交给 `launch.js` 的输入） |
| `agent.interruptKey` | `…interruptKey` | 终端打断键（`src/lib/terminal/agent-panes.ts`） |
| `guide` | `usage.md` | 设置页「工具」详情、`berth tools show <id>`；非 Agent 插件启用时列进 `berth guide --brief`，各 Agent 的 `launch.js` 把它（`ctx.brief`）追加进系统提示词 |
| `preview` | `extensions["org.berth.preview"]`：`extensions`（后缀）、`argv`、`protocol`、可选 `script`（包内文件） | 文件标签页实时预览（`src-tauri/src/preview_watch/`） |
| `extract` | `extensions["org.berth.extract"]`：`extensions`、`argv` | 当前文档文本抽取，给 Agent 的上下文（`workspace_state/current_document.rs`） |
| `install` | `extensions["org.berth.install"]`：`bin`、`paths.unix/windows`、`version`，可选 `update`、`latest`；包内 `install.sh` / `install.ps1` | 预览缺程序时的一键安装；设置 → 工具 的安装状态、检查更新与更新（`commands/preview_tools.rs`） |
| `view` | `contributes.view`：`id`、`title`、`icon`、`location`（`sidebar` / `tab`）、`script`（第 1 层；`page` 尚未实现） | 侧栏活动栏入口与原生渲染（`src-tauri/src/commands/plugin_views.rs`、`src/components/plugins/plugin-view-panel.tsx`）；视图数据格式见 `docs/plugin-architecture.md` §4.1，调试用 `berth tools call <id> <脚本> --hook render` |

封闭键表在 `berth-tool-core/src/package.rs` 的 `AGENT_KEYS` / `KNOWN_EXTENSIONS`，改动时与本表同步。

### 文件工具（preview / extract / install）

**边界**：哪些格式算「文档」、怎么打开（标签页、工具栏、刷新、自动预览）、沙箱与脚本注入、拾取元素交给
Agent、当前文档进上下文、缺程序时提示安装，都归 Berth；插件只提供实现：用哪个程序、`watch/1` 服务、
渲染器的 DOM 适配脚本、文本抽取命令、安装脚本。格式目录是宿主的 `file_tools::DOCUMENT_FORMATS`
（docx / xlsx / pptx，前端 `OFFICE_EXTENSIONS` 同步）——没装插件时也要按文档打开并提示安装，所以不能
由插件注册。插件的 `extensions` 只在目录内挑格式；写了目录外的后缀，`tools check` 报出。支持新格式是
宿主的产品决定（加进目录），不是插件声明。

解析在 `berth-tool-core/src/file_tools.rs`，只看**启用**的插件，按文件后缀取第一个提供者；停用插件即
没有提供者（预览显示「未启用 Office 预览插件」，抽取返回说明，不报错）。停用时已在运行的预览进程
立即回收（设置页开关；CLI 停用由每分钟的 sweep 兜底），打开着的标签收到 `closed` 推送后重启预览。`argv` 不含程序名，程序由
`install.bin` 解析（先 PATH，再 `paths`）；整段 `{file}`、`{port}`、`{maxLines}` 占位符由宿主替换。
`preview` / `extract` 必须同时声明 `install`，否则不算接入。安装行为只在包内脚本里，宿主负责执行、
流式输出、600s 总超时（杀整棵进程树）与互斥。

```json
"org.berth.preview": { "extensions": ["docx", "xlsx", "pptx"], "argv": ["watch", "{file}", "--port", "{port}"], "protocol": "watch/1", "script": "preview.js" },
"org.berth.extract": { "extensions": ["docx", "xlsx", "pptx"], "argv": ["view", "{file}", "text", "--max-lines", "{maxLines}"] },
"org.berth.install": { "bin": "officecli", "paths": { "unix": ["~/.local/bin/officecli"], "windows": ["%LOCALAPPDATA%/OfficeCLI/officecli.exe"] }, "version": ["--version"] }
```

**预览协议 `watch/1`**（宿主只实现这一种，其他值报 `PROTOCOL`）：

1. 启动后在 stdout 打印就绪行 `Watch: http://<host>:<port>`，监听宿主给的 `{port}`（仅 127.0.0.1）。
2. `GET /` 返回自包含 HTML 快照；可拾取元素带 `data-path`，值是插件自己的元素路径（宿主原样交给 Agent，
   Agent 再用插件的程序按路径读写，如 `/slide[1]/shape[@id=12]`）。表格单元格的路径以 `/<工作表>/<列><行>`
   结尾（如 `/Sheet1/B3`，工作表名可含 `/`）：宿主据此支持 Shift 框选，上报区域 `/Sheet1/B3:D7`。
3. `GET /events` 是 SSE，`event: update` 的 JSON `action`：
   - 其他值（如 `replace`）：内容变了，宿主重新 `GET /`；
   - `mark-update`：`marks` 为完整标注列表，每项 `{ path, color?, note?, find?, tofix?, stale? }`
     （`path` 对应 `data-path`，`stale` 表示元素已不存在，`find` / `tofix` 显示为「原文 → 改为」）；
   - `scroll`：`scrollTo` 为快照里的 HTML 锚点（`#id`）；
   - `selection-update`：忽略。
4. 快照在严格 CSP 的沙箱 iframe 里显示，渲染器自带脚本不执行；需要的 DOM 适配（版式、工作表切换、
   滚动恢复）写在包内 `script`，宿主随启动结果交给前端注入。除以上约定外，宿主不认识任何渲染器的 HTML 结构。

## 写一个插件

插件就是 `$BERTH_HOME/tools/<id>/` 一个目录，目录名等于 `tool.json` 的 `id`。下面两个例子各接入一组
位置，写完用 `berth tools check <id>` 自检（见文末）。目录里只能有约定文件（`tool.json`、`launch.js`、
`launchbar.json`、`install.sh|ps1`、`usage.md`、`usage.json`、`icon.svg`）和 `tool.json` 声明过的资源。

### Agent 插件：接入 launchbar、agent

```text
tools/aider/
├── tool.json
├── launchbar.json
└── launch.js
```

`tool.json` 声明身份与 `org.berth.agent`，`requires` / `permissions` 写用到的命名空间；`launchbar.json`
声明控件（选项可加 `"unattended": "<取值>"`：任务定时无人值守启动时用这个值，一项都没声明的 Agent 不能设定时，
见 `commands/launchbar.rs` `unattended_inputs`）；`launch.js` 默认导出 `{ args, isNativePlugin, launch }` 钩子。
宿主先按 `launchbar.json` 校验输入、读好专家与服务商，插件只写「取值 → 目标 CLI argv」与专家资产投递。
完整例子、`ctx` 字段与调试方法见 `docs/plugin-development.md` §4。会话列表、用量、服务商注入等再按上表加
`org.berth.agent` 的键。

### 文件工具插件：接入 extract、install

```text
tools/pandoc/
├── tool.json
└── install.sh
```

```json
{
  "$schema": "urn:berth:tool-asset:1",
  "protocol": "berth.tool/1",
  "id": "pandoc",
  "revision": "1",
  "identity": { "name": "Pandoc", "description": "Plain-text extraction for .docx." },
  "extensions": {
    "org.berth.extract": { "extensions": ["docx"], "argv": ["{file}", "-t", "plain"] },
    "org.berth.install": { "bin": "pandoc" }
  }
}
```

`install.sh` 写安装步骤（宿主只负责执行与流式输出）；`install.paths` / `version` 可省。

更新与最新版本（都可省）：

- `"update": ["update"]`：程序自带的更新参数。更新时宿主运行 `<程序> update`——它知道自己是从 npm 还是
  原生安装器装的，不会另装一份被 PATH 遮住。省略时更新 = 重跑 `install.sh`，脚本应在已装位置原地升级。
- `"latest": { "npm": "<包名>" }` 或 `{ "github": "<owner>/<repo>" }`：查最新版本的公开来源（npm registry
  的 `latest` / GitHub `releases/latest` 的 tag）。宿主取两边第一个形如 `1.2.3` 的数字段比较；省略时不显示
  “有新版本”，只给更新按钮。加预览就再声明
`org.berth.preview`，按上面的 `watch/1` 协议实现服务。

`extensions` 只能取 Berth 的文档格式（docx / xlsx / pptx，见上文「边界」），目录外的后缀 `tools check` 会报出；
同一后缀有多个启用的提供者时取 id 排序的第一个（上例与 officecli 同时启用时，docx 由 officecli 处理）。

### 自检

```bash
berth tools check aider
# aider: contributes launchbar, agent
# clean: 1 plugin(s) in ~/.berth/tools
```

`contributes` 应列出你想接入的每个位置；缺了说明声明没被宿主认出（如 `preview` 缺 `install`、
`launchbar` 缺 `launch.js`）。只有末行出现 `clean:` 才算通过；每条 `<id>/<位置>: …` 都是宿主不读或找不到
的东西（退役键、未知命名空间、未声明的文件、缺失的包内资源）。`--json` 输出同样的结果，看 `clean` 字段。
`check` 只读，不执行插件；`tool.json` 本身写坏时直接报加载错误。

## 共享资源（不属于某个插件）

`skills/`、`mcp/`、`prompts/`、`experts/`、`plugins/`（Agent 原生插件）在 `$BERTH_HOME` 顶层，
由专家表引用、各 Agent 的 `launch.js` 装配，见 `docs/expert-runtime.md`。

## 宿主内置，未开放

| 能力 | 现状 | 计划 |
|---|---|---|
| PDF 文本抽取 | `current_document.rs` 写死 `pdftotext` | 按需改走 `extract` |
| 启动栏选项来源 | `optionsFrom`：`experts`、`projectSessions`、`providerModels`、`providerVendor` | 按需 |

前端按 Berth 的文档格式目录把 docx / xlsx / pptx 归为 Office 文档（标签页类型、拾取单元 `office`），这是
宿主的格式分类，不是工具选择；由哪个插件、哪个程序预览只由上面的声明决定。
