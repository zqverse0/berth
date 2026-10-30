# 插件架构（固定约定）

本文是 Berth 插件体系的根约定：插件作者与宿主实现都以它为准（上手写插件看 `docs/plugin-development.md`）。改动本文 = 改兼容性承诺，
只能按 §7 的流程进行。接口类型见 `plugins/berth-plugin.d.ts`。

## 1. 目标

- 插件下载即用：不要求用户另装解释器或运行时。
- 接口稳定：宿主内部重构不影响插件；能力只增不破。
- 改动局部：任何一次改动只落在一个命名空间或一个接入点上。

不做：npm 依赖、插件之间互相调用、插件直接访问 Tauri IPC 或宿主 React。

## 2. 永不改变的三样

### 2.1 清单骨架（`tool.json`）

```json
{
  "id": "excalidraw",
  "version": "1.2.0",
  "engines": { "berth": ">=0.37" },
  "requires": { "files": 1, "ui": 1 },
  "permissions": ["project.files"],
  "contributes": { "editor": [] }
}
```

| 键 | 含义 |
|---|---|
| `id` | `[a-z0-9][a-z0-9._-]*`，等于目录名 |
| `version` | 插件自身版本，semver |
| `engines.berth` | 要求的 Berth 版本范围（semver range） |
| `requires` | 用到的命名空间 → 主版本号 |
| `permissions` | 申请的权限（§5），安装 / 启用时展示 |
| `contributes` | 接入点 → 声明（§4） |

骨架只有这六个键，永不增删、不改含义。展示用的信息（名字、描述、图标、主页）放
`contributes.identity`。宿主忽略不认识的键；`berth tools check` 报出但不拒绝加载。

### 2.2 消息格式（JSON-RPC 2.0）

插件与宿主之间的一切往来都是一种消息：

```
请求  {"jsonrpc":"2.0","id":7,"method":"tasks.create","params":{...}}
回复  {"jsonrpc":"2.0","id":7,"result":{...}}
错误  {"jsonrpc":"2.0","id":7,"error":{"code":-32001,"message":"...","data":{"reason":"denied"}}}
通知  {"jsonrpc":"2.0","method":"files.changed","params":{...}}   （无 id，不回复）
```

- 方法名 = `<命名空间>.<方法>`。插件调宿主走命名空间（§3）；宿主调插件走接入点钩子（§4），
  方法名为 `<接入点>.<钩子>`，如 `agent.launch`、`editor.externalChange`。
- `params` / `result` 只用 JSON 值。二进制用 base64 字符串，字段名以 `Base64` 结尾。
- 错误 `data.reason` 是固定集合，只增不改：
  `invalid-params`、`denied`（缺权限）、`not-found`、`conflict`、`unsupported`（命名空间或版本不满足）、
  `cancelled`、`internal`。
- `berth.*` JS 对象只是这套消息的薄包装，两种运行环境（§2.4）同一份签名，全部返回 Promise。

### 2.3 版本规则

- 每个命名空间单独编主版本：`files@1`、`tasks@1`……
- 同一主版本内只允许：新增方法、新增可选参数、新增返回字段、新增错误 reason 之外的提示信息。
  不允许：删除、改名、改语义、把可选改成必填、收窄返回值。
- 不兼容的改动只能出新主版本 `tasks@2`。宿主为 `tasks@1` 保留转换层，至少保留到之后
  两个 Berth 次版本；期间 `berth tools check` 提示迁移。
- 插件在 `requires` 里声明主版本；宿主不满足时不加载该插件，并指明哪一项不满足。
- 接入点（§4）同样只加不改；声明格式要不兼容地改，就新开一个接入点键。

### 2.4 运行环境

| 环境 | 是什么 | 生命周期 | 可用命名空间 |
|---|---|---|---|
| 脚本 | berth-cli 内嵌 QuickJS（ES2023），包内 `.js` 模块 | 每次调用一个进程，跑完退出 | 除 `ui` 外全部 |
| 页面 | 工作区标签页里的沙箱 iframe，包内 `.html` | 随标签页 | 除 `process`、`fs` 外全部 |

两种环境说同一种消息。页面的「后端」逻辑写成脚本，用 `scripts.run` 调用。

### 2.5 界面两层

插件的界面只有两种写法，按需要选，能用第 1 层就不用第 2 层：

| 层 | 插件提供 | 谁来画 | 适合 |
|---|---|---|---|
| 1. 声明式视图 | 脚本返回视图数据（§4.1） | 宿主用自己的组件 | 列表、详情、少量操作——绝大多数工具 |
| 2. 页面 | 包内 `.html`（§2.4 页面环境） | 插件自己 | 需要自绘的界面（画布、编辑器） |

第 1 层与宿主原生界面无差别（主题、快捷键、右键菜单、焦点都是宿主的），插件只依赖 §4.1
的数据格式。第 2 层宿主负责把割裂压到最低：注入宿主 CSS 变量、字体与基础样式，iframe 无边框
透明背景；主题变化经 `ui.onTheme` 推送；iframe 内按键转发给宿主快捷键；菜单、确认框、通知由
宿主画（`ui` 命名空间）。插件不进主窗口的 JS 环境（不做 Obsidian 式进程内加载）。

## 3. 命名空间

第一批（全部 @1）。方法清单以 `plugins/api/<命名空间>.schema.json` 为准，`berth-plugin.d.ts` 由它生成。

| 命名空间 | 环境 | 权限 | 内容 |
|---|---|---|---|
| `process` | 脚本 | `process` | 运行程序（交互 / 捕获输出）、`which`、pid、进程存活 |
| `fs` | 脚本 | `fs` | 本机任意路径读写（Agent 插件写会话配置用） |
| `files` | 两者 | `project.files` | 项目内文件：读、写、列、监听变化、在工作区打开 |
| `tasks` | 两者 | `tasks` | 项目任务：列、查、建、在任务页打开 |
| `knowledge` | 两者 | `knowledge` | 知识库搜索、记想法 |
| `agent` | 两者 | `agent` | 把内容作为引用交给当前 Agent（用户确认后发送） |
| `storage` | 两者 | 无 | 插件自己的键值数据（`$BERTH_HOME/state/<id>/`） |
| `scripts` | 页面 | 无 | 运行本包脚本，拿返回值 |
| `ui` | 页面 | 无 | 主题、通知、标签标题、打开本插件的其他页面 |
| `env` | 两者 | 无 | 平台、Berth 版本、当前项目 |
| `data` | 脚本 | 无 | TOML 解析 / 生成（JSON 用内置 `JSON`） |
| `http` | 脚本 | `network` | 发 HTTP 请求（`fetch`），拿状态、响应头与文本 |

## 4. 接入点（`contributes`）

| 键 | 声明 | 宿主调插件的钩子 | 宿主负责 |
|---|---|---|---|
| `identity` | 名字、描述、图标、主页、标签 | — | 设置页、列表展示 |
| `agent` | 启动栏（`launchbar`）、会话格式、用量、服务商注入、登录、能力目录、首条 prompt、打断键；入口 `launch.js` | `agent.args`、`agent.launch`、`agent.isNativePlugin` | 输入校验、专家、服务商档案、能力索引、hook、终端 |
| `command` | 标题、脚本 | `command.run` | 命令面板 |
| `view` | 标题、图标、位置；`script`（第 1 层）或 `page`（第 2 层）二选一 | `view.render`（第 1 层） | 侧栏 / 标签页入口、加载与错误态、刷新、执行动作（§4.1） |
| `editor` | 后缀、页面入口、可选「新建」模板 | `editor.externalChange` | 读写文件、保存、脏标记、外部修改冲突 |
| `preview` | 后缀、程序参数、协议 `watch/1` | — | 只读预览、元素拾取 |
| `extract` | 后缀、程序参数 | — | 文档文本进 Agent 上下文 |
| `install` | 程序名、路径、版本参数、更新来源；包内安装脚本 | — | 一键安装 / 更新 |
| `guide` | 包内 `usage.md` | — | Agent 提示词、`berth tools show` |

新增接入点 = 新增一个键 + 宿主一处消费，不动已有键。

### 4.1 视图（`view`）

```json
"contributes": {
  "view": [
    {
      "id": "discover",
      "title": { "en": "Discover", "zh-CN": "发现" },
      "icon": "icon.svg",
      "location": "sidebar",
      "script": "views/discover.js"
    }
  ]
}
```

| 键 | 含义 |
|---|---|
| `id` | 包内唯一，`[a-z0-9-]+` |
| `title` | 字符串，或按语言的对象（缺当前语言取 `en`） |
| `icon` | 包内 svg / png；省略用插件图标 |
| `location` | `sidebar`：侧栏活动栏一个入口；`tab`：只能被 `open-view` 动作打开，在工作区标签页显示 |
| `script` / `page` | 二选一；`script` 是第 1 层，`page` 是第 2 层 |

`script` 默认导出 `render(req)`，返回下列视图之一（类型见 `berth-plugin.d.ts` `ViewResult`）：

- `req`：`{ view, params, filter, dropdown, locale, refresh }`——`params` 来自 `open-view` 动作，`filter` / `dropdown`
  是当前选中的筛选项 / 下拉项 id（没选过为 null，插件按第一个渲染），`locale` 是界面语言（`zh-CN`、`en`），插件据此
  给出文字；`refresh` 为真表示用户点了刷新，插件应绕过自己的缓存。
- `list`：`filters?`（顶栏分段）、`dropdown?`（`{ items: [{ id, title }] }`，正文顶部的下拉选择）、`note?`（下拉旁的
  一行小字，如更新时间）、`searchable?`（宿主按标题 / 副标题本地筛选）、`items`、`empty?`。
  每项 `{ id, title, subtitle?, icon?, accessories?, actions? }`：`accessories` 每个 `{ text, icon?, tooltip? }`；
  点击行执行第一个动作，带 `inline` 的动作画成行尾图标按钮（`hover` 悬停时出现、`always` 常驻），其余进行尾「…」菜单。
- `detail`：`{ title?, markdown, actions? }`，Markdown 由宿主渲染。

图标（`icon`，行尾信息与动作共用）只能取宿主的固定名字，由宿主用自己的图标画（随主题）；只增不改：
`star`、`star-filled`、`fork`、`external-link`、`copy`、`book`、`download`、`folder-input`、`link`、`send`。未知名字不画图标。

宿主按「视图 + 筛选 + 下拉」记住上次的渲染结果：切回时先显示它，同时在后台重新渲染。
- `detail`：`{ title?, markdown, actions? }`，Markdown 由宿主渲染。

动作（只增不改）：

| `type` | 字段 | 宿主行为 |
|---|---|---|
| `open-url` | `url` | 系统浏览器打开 |
| `open-view` | `view`、`params?` | 在工作区标签页打开本插件的另一个视图 |
| `script` | `script`、`input?`、`refresh?` | 运行包内脚本（默认导出函数收 `input`）；`refresh` 为真时完成后重新渲染当前视图 |
| `copy` | `text` | 复制到剪贴板 |
| `clone` | `url`、`pickDirectory?` | 用 Berth 的 Git 账号把仓库 clone 到「记住的目录/仓库名」（第一次或 `pickDirectory` 时先选目录），完成后作为项目打开 |
| `send-to-agent` | `text` | 把文字放进当前 Agent 终端的输入框（不提交）；没有 Agent 时复制到剪贴板。菜单文字由宿主给（带 Agent 名） |

每个动作还有 `title`，可选 `icon`、`inline`。脚本抛错时宿主显示错误与重试；渲染期间显示加载态；视图标题栏带刷新按钮。
未知的视图 `type` / 动作 `type` 宿主忽略并在 `tools check` 报出。

## 5. 权限

`process`、`fs`、`project.files`、`tasks`、`knowledge`、`agent`、`network`（脚本的 `http`、页面联网；默认 CSP 禁止）。
- 安装 / 启用时列给用户；新版本申请了新权限，更新时再确认一次。
- 未申请的调用一律回 `denied`。官方插件同样声明，不走后门。
- 权限名只增不改。

## 6. 代码落点

| 位置 | 内容 |
|---|---|
| `plugins/<id>/` | 官方插件（随安装包发布，用户 `~/.berth/tools/<id>` 可覆盖） |
| `plugins/api/<命名空间>.schema.json` | 接口唯一来源：方法、参数、返回、错误 |
| `plugins/api/fixtures/<命名空间>/` | 契约样例：请求 → 回复，CI 校验 |
| `plugins/berth-plugin.d.ts` | 由 schema 生成，给插件作者补全 |
| `src-tauri/tool/berth-plugin-api/` | 宿主接口层：每个命名空间一个文件，只做「消息 ↔ Berth 内部服务」转换；脚本环境（berth-cli）与页面环境（GUI）共用 |

宿主内部重构只改接口层里对应的那一个文件；接口层之外的代码不得被插件感知。

## 7. 变更流程

| 改动 | 要做的 |
|---|---|
| 给命名空间加方法 / 可选字段 | 改 schema → 加契约样例 → 重新生成 d.ts → 接口层实现 → 本表下方变更记录加一行 |
| 新增命名空间 | 新 schema + 接口层新文件 + §3 表加一行 |
| 新增接入点 | §4 表加一行 + 宿主消费处 + `tools check` 认识它 |
| 不兼容改动 | 新主版本 schema，旧版本转换层保留（§2.3），本文记下弃用版本与移除时间 |
| 改 §2 | 不允许 |

### 变更记录

| 日期 | 改动 |
|---|---|
| 2026-10-25 | 初版：第一批命名空间 @1，接入点 identity / agent / command / view / editor / preview / extract / install / guide |
| 2026-10-26 | process@1 加 `open`（常驻程序逐行对话）；fs@1 加 `mkdir`、`readText` 的 `tailBytes`；`ProviderModel` 加 `endpoint` |
| 2026-10-30 | 界面两层（§2.5）；`view` 接入点定义第 1 层声明式视图（§4.1，`list` / `detail`，动作 `open-url` / `open-view` / `script` / `copy`；`req.locale` / `refresh` / `dropdown`；`list.dropdown` / `note`；图标名与 `inline` 动作；动作 `clone` / `send-to-agent`）；新增 `http@1` |

## 8. 与现状的迁移

- `extensions["org.berth.<点>"]` → `contributes.<点>`，字段不变；`revision` → `version`。
  两种写法都认（`berth-tool-core::manifest::normalize` 加载时归一）；官方插件 2026-10-26 已改为新写法。
  `engines.berth` 不满足的插件不加载，`tools check` 与设置页显示原因。
- Python `launch.py` 与 `runtime/berth_launch.py` → `launch.js` 与 `agent.*` 钩子，`berth_launch.py`
  的逻辑并入宿主。2026-10-26 已完成，宿主不再运行 `launch.py`（`docs/REMOVED.md`）。
- 内置 Excalidraw → 官方 `editor` 插件，迁出后删除内置代码与依赖。
- 内置「发现」（GitHub 趋势 / 星标）→ 官方 `gh` 插件的 `view`（第 1 层），平台第一个实验；2026-10-30 用户确认后
  删除内置代码（`docs/REMOVED.md`）。
