# 插件开发指南

写、调、发布一个 Berth 插件的操作手册。约定本身（不变的骨架、版本规则、命名空间表）见
`docs/plugin-architecture.md`；每个接入点的字段见 `docs/contribution-points.md`；接口签名只以
`plugins/berth-plugin.d.ts` 为准。本文与它们冲突时以它们为准。

## 1. 插件是什么

一个目录，目录名 = `tool.json` 的 `id`：

| 位置 | 用途 |
|---|---|
| `plugins/<id>/`（本仓库） | 官方插件源码；不随 Berth 安装，用 `berth tools install` 装 |
| `$BERTH_HOME/tools/<id>/` | 运行时读取的位置（正式版 `~/.berth`，dev 实例 `~/.berth-dev`） |
| `$BERTH_HOME/state/<id>/` | 插件自己的数据（`berth.storage.dir`），第一次写入时创建；**插件包目录只读，不往里写** |

脚本是 JavaScript（ES2023 模块），由 berth-cli 内嵌的 QuickJS 运行：用户不用装 Node / Python，
下载即用。脚本能做的事只有两类：JS 内置对象，和全局 `berth.*`（宿主接口）。

**没有**：Node API（`require`、`fs`、`path`、`child_process`、`Buffer`、`process.env`）、npm 包、
`fetch`。只能 `import` 本包内的相对路径文件。

## 2. 目录结构

```text
plugins/<id>/
├── tool.json          # 清单（必需）
├── launchbar.json     # 启动栏控件（Agent 插件）
├── launch.js          # 启动脚本（Agent 插件）
├── icon.svg|png
├── install.sh|ps1     # 安装目标 CLI（org.berth.install）
├── usage.md           # 给 Agent 看的用法（guide 接入点）
├── usage.json         # 用量窗口（可选）
├── sessions.json      # 会话来源声明（tool.json resources 引用）
└── private/           # 包内辅助脚本与数据，只给本插件用
```

只允许约定文件和 `tool.json` `resources` 里 `base: "package"` 声明过的文件，其余 `berth tools check` 会报出。
调研笔记写进知识库，不放进包。

## 3. 清单 `tool.json`

```json
{
  "$schema": "urn:berth:tool-asset:1",
  "protocol": "berth.tool/1",
  "id": "aider",
  "version": "1.0.0",
  "engines": { "berth": ">=0.37" },
  "requires": { "process": 1, "fs": 1 },
  "permissions": ["process", "fs"],
  "contributes": {
    "identity": { "name": "Aider", "roles": ["agent"], "description": "Aider coding agent." },
    "agent": { "projectType": "aider" },
    "install": { "bin": "aider", "version": ["--version"] }
  }
}
```

- `version`：插件自己的版本（semver），每次改行为就升；用户报问题时据此对照。
- `engines.berth`：要求的 Berth 版本范围。本 Berth 不满足时插件**不加载**（不进启动栏、会话、用量），
  `berth tools check` 与设置页「工具」显示原因；不写即任何版本都加载。
- `requires`：脚本用到的命名空间 → 主版本。宿主不满足时启动前报 `unsupported`，不会跑到一半才失败。
- `permissions`：`process`（起子进程）、`fs`（读写本机文件）等。没声明就调用 → 报 `denied`。
  `storage`、`env`、`data` 不需要权限。
- `contributes.<接入点>`：字段与 `docs/contribution-points.md` 里 `extensions["org.berth.<接入点>"]` 完全相同。
  旧写法（`revision` + `identity` + `extensions`）照常能读，两种写在一起时旧键优先。
- `resources`（如会话声明 `sessions.json`）照旧放顶层。

## 4. Agent 插件：`launchbar.json` + `launch.js`

### 4.1 最小例子

`launchbar.json`（控件只在这里声明，宿主按它校验输入）：

```json
{
  "version": 1,
  "items": [
    { "id": "mode", "component": "select", "label": "模式",
      "options": [{ "value": "code", "label": "写代码" }, { "value": "ask", "label": "只问答" }] },
    { "id": "expert", "component": "select", "label": "专家", "optionsFrom": "experts" }
  ]
}
```

`launch.js`：

```js
// @ts-check
/// <reference path="../berth-plugin.d.ts" />

/** @type {import("berth").AgentHooks} */
export default {
  // 启动栏输入 → CLI 参数（输入已按 launchbar.json 校验）
  args: (inputs) => (inputs.mode ? ["--chat-mode", String(inputs.mode)] : []),

  async launch(ctx) {
    const args = []
    if (ctx.expert?.prompt) args.push("--system-prompt", ctx.expert.prompt)
    if (ctx.brief) args.push("--append-system-prompt", ctx.brief)
    ctx.plan({ expert: ctx.expert?.id ?? null })
    return await berth.process.run("aider", [...args, ...ctx.args])
  },
}
```

`launch` 返回的数字就是终端里 Agent 的退出码。

### 4.2 宿主替你做了什么

点启动后终端执行 `berth-cli tools launch <tools>/<id>/launch.js --berth-launch-inputs <json>`。插件拿到
`ctx` 之前，宿主已经：

- 按 `launchbar.json` 拒绝未声明的输入键、校验 select 取值；
- 读好专家表（`ctx.expert`）：`prompt` 是正文、`skills` / `plugins` 是 `{name, path}`、`mcp` 里的
  `$ENV` 已展开、`plugins` 已按你的 `isNativePlugin` 筛过；
- 读取并删除一次性服务商档案（`ctx.provider`）；
- 加载 `$BERTH_HOME/.env`、导出 `BERTH_AGENT_TTY`、取好 Berth 能力索引（`ctx.brief`）；
- 建好 0700 临时目录 `ctx.paths.tmp`，`launch` 结束后删除。

所以插件只写「这个 CLI 怎么接收这些东西」。

### 4.3 钩子与 `ctx`

| 钩子 | 何时调用 | 返回 |
|---|---|---|
| `args(inputs)` | 启动前 | 该 CLI 的参数数组；拼进 `ctx.args` 最前面 |
| `isNativePlugin(dir)` | 有专家插件时，逐个问 | 本 Agent 能否原生加载这个目录；不导出 = 全部跳过 |
| `launch(ctx)` | 启动 | 退出码 |

`ctx` 常用字段（完整定义看 d.ts 的 `LaunchContext`）：

| 字段 | 内容 |
|---|---|
| `ctx.args` | `args()` 结果 + 用户手动追加的参数，原样放在命令最后 |
| `ctx.inputs` | 启动栏原始输入；`args()` 拿不到 `ctx`，要结合服务商等信息时在 `launch` 里读它 |
| `ctx.expert` | 专家或 `null` |
| `ctx.provider` | 服务商或 `null`（`null` = 用 Agent 自己的登录）。`models[0]` 是选中模型；`endpoint("chat")` 取地址和 Key |
| `ctx.brief` | 追加进系统提示词的 Berth 说明，可能为空串 |
| `ctx.unattended` | 定时任务无人值守启动 |
| `ctx.paths` | `package`（只读）、`tmp`、`cwd`、`home` |
| `ctx.hookCommand(event)` | 接到 Agent 原生 hook 上的命令（群组状态）；静默、永不失败 |
| `ctx.remote` | 远程项目时 `{ target, hookCommand, execCommand }`，本地项目 `null`；接线见 `docs/agent-contracts.md`「远程项目」 |
| `ctx.plan({...})` | 往 stderr 打一行 `berth-<id>-plan: {...}`，记录本次装配了什么，排查用 |

### 4.4 隔离：只做会话级

不改 Agent 的全局配置。通行做法：建一个会话目录，把用户目录里**非用户级资产**逐项软链进去，
用户级的 skills / MCP / 插件去掉，再放入专家资产，用环境变量（如 `CODEX_HOME`、`GROK_HOME`、
`CLINE_DIR`）指过去：

```js
const session = `${ctx.paths.home}/.berth-x-session-${berth.process.pid}-${Date.now()}`
await berth.fs.mkdir(session, { mode: 0o700 })
try {
  // …软链、写配置…
  return await berth.process.run("x", ctx.args, { env: { X_HOME: session } })
} finally {
  await berth.fs.remove(session)
}
```

关闭终端时宿主会直接结束进程，`finally` 不一定执行：目录名带上 `berth.process.pid`，启动时用
`berth.process.alive(pid)` 清掉进程已不在的旧目录（`plugins/codex/launch.js` 的 `sweepStaleSessions`）。
不需要放在家目录的临时文件直接用 `ctx.paths.tmp`，不用自己清理。完整写法参考
`plugins/codex/launch.js`（TOML 配置、会话 marketplace）、`plugins/grok/launch.js`、`plugins/cline/launch.js`。

### 4.5 会话来源 `sessions.json`

Berth 直接读 Agent **自己写的**会话文件，插件不转写、不复制。字段见 `docs/agent-contracts.md`；
照 `plugins/*/sessions.json` 抄最接近的一份。写之前回答两个问题：

1. **消息存在哪？** 决定 `storage`，答案唯一：
   一行一条的文件 → `jsonl`；一个会话一份 JSON 文档 → `json`；数据库表 → `sqlite`。
2. **会话信息（项目路径、标题）和消息在一起吗？** 在一起什么都不加；不在一起时声明它在哪：
   `json` 用 `sessionDocument`（同目录另一个文件），`jsonl` 用 `sessionIndex`（SQLite 表，按路径里的 id 对上，
   例子见 `plugins/agy/sessions.json`）。

还表达不了的存储形态，扩展声明格式（宿主改一次，所有插件可用），不要在插件里写同步脚本。
写完用 `berth project <项目> session ls --agent <id>` 和 `session show <会话 id>` 核对。

## 5. 包内脚本：`berth tools run`

状态栏、用量快照、登录模型列表这类「由宿主或 Agent 调起的小程序」写成包内脚本，默认导出一个函数：

```js
// private/usage-snapshot.js
export default async function (argv) {
  const text = await berth.fs.readText("~/.x/usage.log", { tailBytes: 1 << 20 })
  console.log(JSON.stringify({ used: parse(text) }))
  return 0 // 退出码
}
```

调用方式：

- Agent 侧（如状态栏命令）：`berth tools run <id> private/statusline.js`；
- tool.json 里的命令（`usage.command`、`logins[].models.command`）：
  `["${berth}", "tools", "run", "<id>", "private/x.js", "参数"]`。`${berth}` 由宿主换成同版本的 berth-cli，
  不依赖 PATH。

`argv` 是命令行余下的参数；`console.log` 写 stdout，`console.error` 写 stderr；
`berth.process.stdin()` 读完整个 stdin。脚本必须在包内，不能运行包外文件。

## 6. 接口速查

全部返回 Promise，**每个调用都要 `await`**。失败抛出带 `reason` 的错误（`invalid-params` / `denied` /
`not-found` / `unsupported` / …）。

| 命名空间 | 常用 |
|---|---|
| `process` | `run`（交互、继承终端）、`exec`（取输出，可带 `stdin` / `timeoutMs`）、`open`（常驻程序逐行对话，如 stdio JSON-RPC）、`which`、`alive`、`pid`、`stdin` |
| `fs` | `readText`（`tailBytes`）、`writeText`（原子写，`mode`）、`stat`、`list`、`mkdir`、`remove`、`symlink`、`copy`、`rename`、`resolve` |
| `data` | `parseToml` / `stringifyToml`（JSON 用内置 `JSON`） |
| `env` | `vars`（环境变量快照）、`platform`、`project()` |
| `storage` | `get` / `set` / `remove`，`dir` = 插件数据目录 |

路径必须是绝对路径或 `~` 开头。

## 7. 调试与验证

```bash
berth tools check <id>                                   # 静态自检：接入了哪些位置、有没有多余文件
berth tools launch <tools>/<id>/launch.js --plugins <专家>  # 专家的插件各自 native / skipped
berth terminal create --project <项目> --agent <id> --input expert=<专家>   # 真实启动，与启动栏同一路径
berth terminal capture -t <终端>                         # 看 plan 行和 Agent 输出
berth tools run <id> private/x.js [参数]                 # 单独跑包内脚本
```

开发本仓库的官方插件时，**不要直接改正式版 `~/.berth/tools`**：

1. 改 `plugins/<id>/`；
2. 备份并替换 dev 实例的副本：`cp -a ~/.berth-dev/tools/<id> /tmp/<id>-backup && rm -rf ~/.berth-dev/tools/<id> && cp -a plugins/<id> ~/.berth-dev/tools/<id>`；
3. 用 `scripts/dev-trial berth …` 跑上面的命令（走 dev 实例的 CLI 与 termd）；
4. 改了宿主接口（`src-tauri/tool/berth-plugin-api/`）后先 `pnpm tauri:prepare-sidecars` 重建 dev 的 berth-cli。

验收至少覆盖：`check` clean；`plan` 行里 skills / MCP / 插件正确；发一句话能收到回复；退出后会话目录已删除。

## 8. 常见坑

- **忘了 `await`**：`berth.*` 都是异步的，漏掉会在脚本结束后才执行，或静默不生效。
- **`exec` 会关掉 stdin**：要和程序来回对话（如 `codex app-server`）用 `process.open`。
- **往包目录写文件**：包目录只读（更新会覆盖）；生成的数据放 `berth.storage.dir`。
- **改 Agent 的全局配置**：只有 Agent 没有会话级入口时才不得已为之（如 agy 的 statusLine），
  且只在用户没配时写，不覆盖用户已有设置。
- **`args()` 里需要服务商**：`args()` 只拿到输入；要看 `ctx.provider` 的参数在 `launch` 里用 `ctx.inputs` 算。
- **接口不够用**：不要绕路（拼 shell、读别的插件文件）。按 `plugin-architecture.md` §7 给命名空间加可选字段或方法
  （只增不改），同时更新 d.ts、prelude、变更记录。
- **按 Agent 名在宿主里写分支**：不允许。差异都写在插件自己的脚本里。

## 9. 发布与安装

- 最简单：插件目录放进 `$BERTH_HOME/tools/` 就能用，设置 → 工具点「刷新」即出现；没有 `plugins.json` 条目即启用。
  设置 → 工具 → 某插件「打包」生成 `<id>-<version>.zip`（条目都在 `<id>/` 下，保留文件权限，跳过 `.git`），
  对方解压进插件目录（页头「打开插件目录」）即可。
- 官方插件：源码在 berth 仓库 `plugins/<id>/`，`scripts/publish-plugins` 同步到公开的插件仓库
  zqverse0/berth-plugins（根下每个子目录一个插件）。Berth 不自带插件，用户在设置 → 工具「插件仓库」点选，
  或 `berth tools install <id>`（= `<插件仓库>#<id>`；`#<子目录>` 适用于任何一个仓库放多个插件的情况）。
  改了 `plugins/` 并发布 Berth 后要再跑一次 `scripts/publish-plugins`。
- 第三方：插件目录放进一个 git 仓库，用户 `berth tools install <git 地址>`；`berth tools update` / `remove` /
  `enable` / `disable` 管理生命周期，状态记在 `$BERTH_HOME/plugins.json`。
- 发布前：`berth tools check` clean；`requires` 写全；密钥不进包（MCP 里写 `$ENV_NAME`）。
