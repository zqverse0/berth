# 写 Berth 插件

插件是 `$BERTH_HOME/tools/<id>/` 下的一个目录（默认 `~/.berth`，先 `echo "${BERTH_HOME:-$HOME/.berth}"` 确认），
目录名 = `tool.json` 的 `id`（`[a-z0-9-]+`）。放进去就能用：设置 → 插件 点「刷新」即出现。接口签名只以
`berth guide plugin-api` 为准；写之前先读一个同类插件当样例（`berth tools list`、`berth tools show <id>`）。

**改完任何插件文件都要运行 `berth tools check <id>`，结果 clean 才算完成。**

## 先选接入点

| 用户想要 | 用 | 要写的文件 |
|---|---|---|
| 让 Agent 会用某个命令行程序 | `guide` + `install` | `usage.md`（给 Agent 看的用法）、`install.sh` / `install.ps1` |
| 侧栏里一个列表 / 详情（数据来自命令、文件、网络） | `view`，`script` | 视图脚本（第 1 层，宿主原生渲染） |
| 侧栏里一个自己画的网页 | `view`，`page` | 包内 html（第 2 层） |
| 用自己的界面打开某类文件（画板、表格、图） | `editor` | 包内 html |
| 接入一个新的 Agent CLI | `agent` + `launchbar` | `launchbar.json`、`launch.js`（照 `tools/claude/`、`tools/pi/` 改） |

一个插件可以同时接多个位置。

## `tool.json`

```json
{
  "$schema": "urn:berth:tool-asset:1",
  "protocol": "berth.tool/1",
  "id": "todo-board",
  "version": "1.0.0",
  "requires": { "process": 1, "storage": 1 },
  "permissions": ["process"],
  "contributes": {
    "identity": { "name": "Todo board", "description": "Project todos in the sidebar." },
    "view": [
      { "id": "todos", "title": { "en": "Todos", "zh-CN": "待办" }, "icon": "icon.svg",
        "location": "sidebar", "script": "views/todos.js" }
    ]
  }
}
```

- `version`：插件自己的版本，改了行为就升。
- `requires`：脚本用到的命名空间 → 主版本；`permissions`：要用的权限，没声明就调用会报 `denied`。

| 权限 | 放行 |
|---|---|
| `process` | 脚本起子进程（`berth.process.*`） |
| `fs` | 脚本读写本机文件（`berth.fs.*`） |
| `network` | 脚本联网（`berth.http.*`） |
| `project.files` | 页面读当前项目的文件（`berth.files.*`） |

`storage`、`env`、`data` 不需要权限。
- 包里只能有约定文件（`tool.json`、`launch.js`、`launchbar.json`、`install.sh` / `install.ps1`、`usage.md`、
  `usage.json`、`icon.svg` / `icon.png`、`private/`、`README.md`、`LICENSE`）、视图 / 编辑器引用的脚本与页面（所在的
  顶层目录整个放行）。其他文件 `check` 会报出。
- 包目录只读（更新会整个覆盖）：插件自己的数据用 `berth.storage`（`get` / `set`），文件放 `berth.storage.dir`。

## 脚本（视图、动作、`berth tools run`）

JavaScript（ES2023 模块），由 Berth 内嵌的 QuickJS 运行，用户不用装 Node。能用的只有 JS 内置对象和全局
`berth.*`：`process`（`run` / `exec` / `open` / `which`）、`fs`、`http`、`storage`、`env`（`vars`、`platform`、
`project()`）、`data`（TOML）。**没有** Node API、npm 包、`fetch`；只能 `import` 本包内的相对路径。
`berth.*` 全部返回 Promise，**每个调用都要 `await`**。

要用 Berth 自己的数据（任务、知识库、群组）就在脚本里调命令：
`await berth.process.exec("berth", ["project", project.root, "task", "--json", "list"])`。

### 第 1 层视图：`render(req)`

脚本默认导出 `{ render(req) }`，返回 `list` 或 `detail`，宿主按主题原生渲染（类型 `ViewResult`）：

```js
/** @type {import("berth").ViewHooks} */
export default {
  async render(req) {
    const project = await berth.env.project()
    if (!project) return { type: "detail", markdown: "先打开一个项目。" }
    return {
      type: "list",
      searchable: true,
      items: [{ id: "a", title: "第一项", subtitle: project.name,
                actions: [{ type: "copy", title: "复制", text: "第一项" }] }],
      empty: "没有内容",
    }
  },
}
```

- `req`：`view`、`params`（`open-view` 动作带来的）、`filter` / `dropdown`（当前选中的分段 / 下拉项 id，没选过为
  null）、`locale`（`zh-CN` / `en`，按它给出文字）、`refresh`（用户点了刷新，应绕过自己的缓存）。
- `list` 可带 `filters`（顶栏分段）、`dropdown`、`note`；每项可带 `icon`、`accessories`、`actions`。
- 动作 `type`：`open-url`、`open-view`（打开本插件 `location: "tab"` 的视图）、`script`（运行包内脚本，`refresh: true`
  完成后重渲染）、`copy`、`clone`、`send-to-agent`。点行执行第一个动作，带 `inline` 的画成行尾按钮。
- 调试：`berth tools call <id> views/todos.js --hook render --input '{"view":"todos","params":{},"filter":null}'`
  打印 `render` 的返回值。

## 第 2 层页面（`view.page`、`editor.page`）

页面就是普通网页：一个目录里放 `index.html` 和它的 js / css（如 `page/index.html`），`page` 字段写这个 html。
宿主在沙箱 iframe 里打开它，并注入全局 `berth`：

- 先 `await berth.ready`，再读 `berth.ui.context`（侧栏视图是 `ViewContext`，编辑器是 `EditorContext`）。
- 可用：`files.readText` / `readBase64` / `open`（需要 `project.files`，路径相对项目根）、`storage`、`data`、
  `scripts.run(包内脚本, 输入)`（要起进程、联网时交给脚本做）、`ui.theme()` / `ui.onTheme`、`ui.notify`、
  `ui.openUrl`、`ui.locale`、`env.project()`。
- 页面不能联网、不能再嵌 iframe；只能加载自己所在顶层目录里的文件。宿主主题色以 `--berth-*` CSS 变量给出。
- 不需要构建：直接写 html + js 即可。要用 npm 库时自己在别处构建好，把产物放进页面目录（Berth 不构建）。

### 编辑器（`editor`）

```json
"editor": [
  { "id": "board", "title": "Kanban", "suffixes": [".kanban.md"], "page": "page/index.html",
    "new": [{ "title": "Kanban board", "name": "board.kanban.md" }], "embed": false }
]
```

- `suffixes` 以 `.` 开头，可多段；几个编辑器都匹配时后缀最长的胜出。插件停用后这些文件按文本打开。
- 读写、自动保存、Ctrl/⌘+S、外部修改都归宿主，页面只收发文本：`const text = await berth.ui.context.load()`
  取内容，改了调 `context.change(新文本)`；防抖中的改动在 `context.onFlush(() => …)` 里立即交出；
  `context.onExternalChange(text => …)` 接外部修改；`context.readOnly` 为真时不要交改动。
- `new`：新建文件菜单里多一项，在项目根建空文件 `name`（重名加序号）。页面要能打开空文件。
- `embed: true`：Markdown 里 `![[文件]]` 由页面出图；页面在 `context.mode === "embed"` 时用
  `context.onRender(({ path, content, theme }) => 图片 data URL)` 渲染，不画编辑界面。
- `context.onDrop(({ name, kind, path, x, y }) => …)`：从文件树拖进来的文件。

## 分享

- 设置 → 插件 → 某插件「打包」生成 zip，对方解压进插件目录即可。
- 放进一个 git 仓库：对方 `berth tools install <仓库地址>`（一个仓库放多个插件时写 `<仓库地址>#<子目录>`），
  之后 `berth tools update <id>` 跟进。
- 密钥不进包。
