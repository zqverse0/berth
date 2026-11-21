# Agent Tool Asset Contract

Berth 以 `~/.berth/tools/<id>/tool.json`（`berth.tool/1`）作为 Agent 身份、
会话资源和 provider 注入的声明来源。启动栏 UI 直读同目录 `launchbar.json`，
目标 CLI argv 由同目录 `launch.js` 拼接（`docs/plugin-development.md`）。旧 `~/.berth/agents/*.json`、
`cli-tools/*.json`、`agent.json` 已退出运行时，不能作为回退入口。

## 数据流

```text
tools/<id>/tool.json
  → asset repository：开放解析、未知字段保留、逐 action/扩展诊断
  → agent projection：identity / launch / provider / resources
  → 功能模块：Terminal、模型、Skills/MCP、配置、资源
  → CLI 或 Tauri/GUI adapter
```

Contract 层只“读懂资产”，不启动进程、不写配置、不建软链接、不请求网络。各功能模块
消费所需投影并负责自己的校验和副作用。新增 Agent 原则上只新增 JSON；只有多个 Agent
都需要且能形成长期通用语义时，才扩展 Rust/React。

## 最小结构

```json
{
  "protocol": "berth.tool/1",
  "id": "demo",
  "identity": {
    "name": "Demo Agent",
    "roles": ["agent"]
  },
  "views": {},
  "extensions": {
    "org.berth.agent": {
      "sessions": "session-spec"
    }
  },
  "resources": {
    "session-spec": {
      "kind": "file",
      "locator": {"base": "package", "path": "sessions.json"},
      "purpose": "session-parser-spec"
    }
  }
}
```

`sessions.json` 是可选的、无版本的字段声明：它只描述 `jsonl`、`json` 或普通 `sqlite` 的
存储路径、表关系和 key/JSON Pointer selector。`json` 是一个文件一份会话文档：`records`
指向消息数组，`sessionDocument`（可选，同目录文件名模板，可用 `{@path.parent.name}` 这类路径投影）
指向记会话字段的文档，缺省为文档本身；读取时展开成「会话记录 + 各条消息」，其余与 JSONL 相同。
`jsonl` 的会话信息不在文件里、而在 SQLite 表里时（如 agy），声明 `sessionIndex`
（`path`、`table`、`key`、`match`：`match` 是 `@path.…` 投影，取出会话文件对应的键）：reader 按键只读查出
那一行放在记录流最前作为会话记录，`session.*` 读它的列（此时不写 `session.record`）。selector 后缀
`|file_path` 把 `file://` URI 转成本地路径（如 `workspace_uris#/0|file_path`：JSON 文本列取第一项再解码）。
Berth 固定投影用户/助手文本、thinking、tool call/result 与 usage；声明不执行脚本、任意 SQL，也不会为该来源注册常驻 watcher。
JSONL 可以省略 `message.record`，用 `role` 或 `variant` + `roleMap` 归一化混合事件流；
session selector 还允许受限的 `@path.parent.name`、`@path.parent.parent.url_decode.name`
文件路径元数据投影。它们不提供表达式或任意文件扫描能力。
`message.injected`（`flag` JSON Pointer 为真，或正文以 `textPrefixes` 任一前缀开头）
把 Agent 注入的 user 记录（环境上下文、AGENTS.md、本地命令回显等）改按 system 读取，
不算提问也不作标题；SQLite 只支持 `textPrefixes`。顶层 `skills.toolNames` / `nameKey`
声明专用技能工具，reader 给命中的工具调用写 `meta["berth.skills"]`；读取
`skills/<名字>/SKILL.md` 的调用按路径约定自动标注，无需声明。
顶层 `context` 是一组声明，说明启动时注入的上下文（系统提示、指令文件、技能 / MCP 目录、hook 输出…）
在哪些记录里：每条按 `record` + `kind`（缺省读 `type`）认记录，可选 `textPrefixes` 只认正文以前缀开头的，
`items` 指向数组时每个元素一项，`name` / `path` / `text` 先对元素取值再对整条记录取；`source` 是来源类别，
原样交给会话详情的「启动输入」，宿主不解释。同一内容只留一份；只算首次报回用量之前的记录；仅 JSONL / JSON 文档读取。
顶层 `tools` 按原始工具名声明工具参数里各项在哪（JSON pointer，可给 fallback 列表；参数是 JSON 字符串时先解开，
`""` 指整份参数）：`kind`（原样交给界面，如 `command` / `read` / `edit` / `search` / `fetch` / `plan` /
`question` / `delegate` / `skill`）、`title`、`text`、`command`、`path`、`old` / `new`（按行算增删）、`patch`
（`*** Begin Patch` 或统一 diff，取路径与增删行数）、`background`（真即后台调用）；`items` 指向数组时其余字段逐项先在
元素里取、取不到再从参数根上取，`kind: "plan"` 的元素按 `text` / `status` 成为计划条目。reader 用完整参数据此算出
可直接显示的 Part（`role`、`kind`、`tool`、`call`、`title`、`text`、`cut`、`paths`、`added`、`removed`、`plan`、
`background`），单块文字最多 8000 字，截掉的字数写在 `cut`。没有声明的工具 `kind` 为 `tool`，标题是工具名，
正文是截断后的参数原文。`tools` 随插件包整体更新，宿主不合并用户改动。
顶层 `locate` 是带 `{id}` 的文件模式（语法同 `files`，如 `**/*-{id}.jsonl`、`**/{id}/chat_history.jsonl`），
声明会话 id 在路径里的位置：按 id 打开会话时只核对路径对得上的文件（再用文件头里的 id 确认）；
缺省时要逐个读文件头，会话目录大时明显变慢。GUI 与 CLI 共用这一份定位。
未声明或声明无效时，历史读取能力明确不可用，不回退到 Agent 专用 parser；因此 Cursor
未来只需提供可投影的 JSONL/普通 SQLite 资源即可接入，当前 protobuf/blob-DAG 不在宿主内解码。

完整字段、binding、capability 与 result envelope 见
`.trellis/tasks/09-08-tool-asset-protocol/protocol.md`。`protocol`/`$schema`/revision
描述文件解释与维护状态，不绑定 Berth 版本，也不把整份资产判为不可读。未知字段原样
保留；未知动作或扩展只局部不可用。

## 包边界

`tools/<id>/` 是插件包：约定文件（`tool.json`、`launch.js`、`launchbar.json`、`usage.json`、
`usage.md`、`icon.svg|png`、`private/`、`README.md`、`LICENSE`、`.gitignore`）加 `base: package` 声明资源，其余文件不属于插件；
tools 根下只应有带 `tool.json` 的目录。`berth tools check [<id>] [--json]` 只读报告越界项
（`clean`、`rootFindings`、`tools[].findings`），发现问题不改退出码。会话级部署不变量与
扩展阶梯见 `src-tauri/tool/AGENTS.md`。

启用状态与安装来源记在 `$BERTH_HOME/plugins.json`：
`{"version":1,"plugins":{"<id>":{"enabled":false,"source":"<git>","rev":"<sha>"}}}`，缺条目即启用，
未知字段保留。停用的插件仍在设置页与 `berth tools list/check` 中（标记停用），但不进启动栏、
会话读取、用量轮询，`berth terminal create --agent`、`berth provider run --agent` 与 GUI 启动报错。
`berth tools install <git>[#<子目录>]` 克隆到 `$BERTH_HOME/.plugin-staging/`、去掉 `.git`、要求根（或给定子目录）有合法
`id` 的 `tool.json` 且声明资源齐全，再 rename 进 `tools/<id>/`；`update` 按记录的来源重装，
新包无效时保留旧包；`remove` 删目录与条目。只接 git 来源；非 git 目录直接拷进 `tools/` 即安装。

## GUI 投影

启动栏直读 `tools/<id>/launchbar.json` 生成控件；选中值作为 typed inputs 提交。
Berth 终端只执行 `berth-cli tools launch <tools>/<id>/launch.js`，React 不拼 argv，不按 Agent 品牌分支。没有启动脚本
时返回明确错误，指向 `tools/<id>/`，不回落 tool.json emit。
服务商只走一次性启动档案：选中自定义档案时 Berth 写一份 `berth.provider/1` JSON（0600，
`$XDG_RUNTIME_DIR/berth-provider/`），以 `--berth-provider <文件>` 追加在启动参数尾部；
宿主（`berth-plugin-api` agent.rs）读完即删，各 `launch.js` 经 `ctx.provider` / `ctx.provider.endpoint()`
取端点（协议名 → 无 `/v1` 根地址与 Key），按该 CLI 最原生的方式落进本次会话（会话配置文件或
子进程环境）。没有这个参数 = 用 Agent 自己的登录。Berth 不往 pane 环境写任何服务商变量：termd
把会话首个 pane 的环境当后续窗口的基底，环境变量会串到别的 Agent。`providerInjection` 只声明
`agentType`（档案栏）、`slots`（模型档位）与 `apis`（该 CLI 会说的模型接口，偏好序：
`openai-chat` / `openai-responses` / `anthropic` / `gemini`）。

兼容的最小单位是「模型 × 接口」：同一个 OpenAI 兼容地址背后有 Chat Completions 与 Responses
两种接口，模型可能只开通其中一种。档案的每个模型记录 `apis`（获取模型列表时取 new-api 的
`supported_endpoint_types`，或在设置页勾选）；启动时 Berth 给每个模型取 Agent 偏好里第一个它也
支持的接口，写进档案 `models[].api` / `models[].endpoint`，没有交集的模型不进档案，选中它则启动前
报错。模型没记录接口时用档案默认 `discovery_json.defaultApis`（中转站一般所有模型同一种接口），
两者都没有才按 Agent 第一偏好尝试并标 `unconfirmed`。启动栏只列 Agent 能用的模型。模型还可带
`contextWindow` / `maxOutput`（token，原样进 `models[]`）：中转站的模型名 Agent 不认识，由
`launch.js` 按 CLI 自己的配置项落下（如 Pi 的 `models.json`），CLI 没有对应项就忽略。
哪个 Agent 能用一份档案只由端点 × 模型接口决定；设置页不再写 `agent_allowlist` 与逐 Agent
的 overlay 副本（保存时清空），读取侧仍回退旧档案的这两项。
协作页「打断」读 `tool.json` 的 `extensions["org.berth.agent"].interruptKey`：tmux
`send-keys` 按键名（如 `Escape`、`C-c`），不经 attach 发给该 pane；未声明时用 `Escape`。
pane 属于哪个 Agent 由启动 argv 中的 `tools/<id>/launch.js` 得出，普通 shell 也按 `Escape`。
账户用量 `usage` 声明 `path`（`${home}` 下由 CLI 自己写出的 JSON 快照，如 Claude
statusline 经 `tools/claude/private/statusline.js` 落盘）、`command`（包内脚本从 CLI 自己的本地
记录里摘额度，如 Codex 会话 `rate_limits`、Grok 日志 `billing`；stdout 为 JSON，可带顶层
`updatedAt` 毫秒）或 `request`（联网，只留给 API Key 余额类，订阅登录不再使用），三选一。
`path` / `command` 不出网、不读凭证。
登录凭证卡完全由 `logins` 声明生成、不落库：每条声明一个该 Agent 可用的登录来源
（`id` / `label` / `credentialFile` / 可选 `credentialKey` JSON 指针 / 可选 `models`），
跨包同 `id` 在设置页并为一张卡，与 API 服务商并列。Berth 只回答凭证在不在，不读取、
不返回、不转发 token，也不联网验证；`models` 只接受 `path`（CLI 自己写的 `${home}` 下
JSON）或 `command`（包内脚本 / CLI 自带命令，argv 不经 shell，`${package}` 展开为包目录，
超时 20s、stdout 须为 JSON）。用户可为每个登录添加预选模型，存于包目录
`login-presets.json`（`{loginId: [{id, name}]}`，只有模型 id、不含凭证、不进数据库），
与读到的模型合并（预选在前）；来源读取失败时仍返回预选项并附原因。启动栏选登录卡 = 不注入（`providerId = null`），模型 id
自带来源前缀即可区分同一 CLI 的多个登录（如 Pi 的 `openai-codex/gpt-5.5`）。
设置页「工具」只读展示当前资产的 `tool.json`、`usage.md` 和模型服务商；编辑通过既有
文件/目录入口或委托 Agent 完成。

GUI 不自动为全部 action 生成工具面板。Terminal action 的持续输出进入 Terminal；普通
结果使用 status/error/sessionRef/artifacts 与 text/markdown/JSON 通用展示。只有 capability
已经提供稳定 typed output 且主线确有需要时，才增加专门 renderer。

## 状态 hook

终端里 Agent 的状态（working / idle / attention）由 Agent 自己报告，Berth 不看画面、
不靠输出猜。`launch.js` 把该 CLI 的原生 hook 接到 `berth group hook <事件>`（命令由
`ctx.hookCommand(event)` 生成；静默、总是成功退出，hook 输出会进 Agent
上下文，非零退出会拦住 Agent）。stdin 是与 Claude Code / Codex 同形的 hook JSON：

| 事件 | 时机 | 读的字段 |
|---|---|---|
| `session-start` | 会话开始、恢复、`/clear`（`source: compact` 不改状态） | `session_id`、`transcript_path`、`source` |
| `turn-start` | 提交提示 | — |
| `turn-end` | 一轮结束 | `last_assistant_message`（缺省时读会话文件） |
| `attention` | 一轮中等用户（授权、选择） | `message`，或 `tool_name` |
| `idle` | 一轮被打断 / 出错结束，没有回答 | — |

`berth group hook` 往 `BERTH_AGENT_TTY`（宿主启动时从 stdin 的 `ttyname` 导出；hook 进程没有
控制终端）写 OSC 9;4 进度 / OSC 9 通知，termd 据此给出状态；报告过进度的 pane 不再用「近期有输出」
兜底，再经 `agent.changed` 唤醒 GUI 立即重读（GUI 没开就跳过）。hook 与群组无关：终端里的 Agent
不进群，群成员走下面的 ACP 模式。
接法：Claude 写进 `--settings` 的 `hooks`；Codex 写会话目录 `hooks.json`，并用
`codex app-server` 的 `hooks/list` 取得这几条的信任键与哈希写进会话 `config.toml`（不用
`--dangerously-bypass-hook-trust`，它连项目层 hook 一起放行）；Pi 用 `private/extensions/` 里的扩展。
没接 hook 的 Agent 仍显示终端信号给出的状态。

## 群组 ACP 模式

群成员由群组运行时（`berth group watch`）以 [ACP](https://agentclientprotocol.com) 客户端身份起 Agent 的适配器进程。
Agent 不支持 ACP 就不进群；终端里的 Agent 不进群（`berth group spawn` 也以 ACP 成员入群，目录是所选 worktree）。Berth 不声明 `fs` / `terminal` 客户端能力，Agent 用自己的工具读写文件、跑命令。

**插件入口**：`tool.json` 声明 `contributes.agent.acp: true`（群页据此列出能进群的 Agent），`launch.js` 导出钩子 `acp(ctx)`，`ctx` 与 `launch` 同一份（没有 `hookCommand`、启动栏 `args`），返回：

| 字段 | 含义 |
|---|---|
| `argv` | 适配器命令（数组，不经 shell）；指向插件 `install.sh` 装好并锁版本的入口，不用 `npx -y` |
| `env` | 追加给适配器进程的环境（服务商、隔离目录、包装脚本） |
| `sessionMeta` | 每次 `session/new` / `load` / `resume` 原样放进 `_meta`；缺省不带 |
| `delegation` | 能否接收委托（运行时经 `mcpServers` 挂 Berth 的 stdio MCP）。**缺省 false**：stdio MCP 是 ACP 必备能力，initialize 里没有开关，适配器收下却不转交时无从得知 |
| `approvesAllTools` | 每个工具调用都先经 `session/request_permission`；缺省 false，群页在该成员处写明「工具调用不经审批」 |

版本门槛、适配器缺失由插件在 `acp()` 里自查并抛错，运行时把错误原文显示为「该 Agent 不可用」。
`ctx.paths.tmp` 活到该 ACP 进程组退出，由运行时删除。
运行时经 `berth tools launch <launch.js> --acp --berth-launch-inputs … [--berth-provider-id <id> [--berth-provider-model <模型>]]`
取得上表的 JSON，再用官方 crate `agent-client-protocol` 收发。`inputs` 是入群时在启动栏选的值（含 `expert`），原样进 `ctx.inputs`；
服务商只在群记录里存 id，CLI 每次启动按 id 写一次性启动档案（同终端启动的 `--berth-provider`），插件照常读 `ctx.provider`。

**交给终端 / 交回**（`berth group member <群> <成员> handoff|return`，群页「在终端打开 / 交回群里」）：同一会话同一时刻只在一处打开。
交接时运行时停掉该成员的进程，群消息留着；群页用入群时的启动栏值加上会话 id 开终端（填进启动栏 `optionsFrom: "projectSessions"` 那一项），
所以插件要满足：ACP 的 `sessionId` 就是 Agent 自己的会话 id，终端启动时用这一项能打开它（pi：`--session <id>`）。
终端关掉后交回，下一条群消息起新进程 `session/load` 同一会话，含终端里聊的。没有会话项的 Agent 不能交接。

**进程**：每个成员会话、每个工单会话各一个适配器进程，独立进程组；回收 / 重启杀整个组，确认退出后才起新的。
群成员的 ACP 进程只归群组运行时，手开终端只归 termd。

**恢复**：initialize 声明了 `sessionCapabilities.resume` 才用 `session/resume`，否则 `loadSession` 时用 `session/load`，
load 期间重放的 update 不写账本。只有 -32002 才新建会话并在群里写明「上下文已丢失」；其他错误（含适配器用别的码表示
会话不存在）原样报给用户，由用户点「开新会话」。

**通信**：

- 运行时 → GUI：一轮里的 update 归一后追加写运行时目录下该群的 live 文件（每轮开头截断，最多每 100 ms 刷一次），
  再发 `agent.changed` 唤醒（同样节流），GUI 按偏移续读；回答完成后整段写进群账本。
- GUI / CLI → 运行时：发消息、审批应答、取消都追加进群账本，再经 `kick` socket 叫醒运行时；运行时从上次偏移读新增行。
  没有 kick socket 的平台退回周期重读。

## CLI、GUI 与终端

CLI 和 GUI 是共享纯 Rust core 的并列适配器。GUI 通过 frontend transport 与薄 Tauri
adapter 直接调用共享 service，不启动 `berth` 子进程。两端都通过 `berth-term-sdk`
使用同一 termd 会话。CLI 需要文件、项目或窗口等桌面能力时，通过
`berth-control-proto` 请求可选 GUI provider；headless 发现与检查不拉起 GUI。

## 项目成员

Agent 的启动目录始终是项目里的一个真实目录：启动栏 / 「终端」默认是项目主成员（放 `.berth/` 的 checkout），
成员行可指定某个检出或参考目录。项目的成员每次都附带——`launch.js` 拿到 `ctx.project`
（`{ name, home, checkouts[], references[] }`，同 `berth project . member ls --json`），系统提示词只加一行指路
`berth project . member ls`。成员怎么用（`--add-dir`、参考只读、有 Agent 在跑的检出不写）由插件决定，
Berth 不按 Agent 分支，也不做沙箱。

## 安全与验证

- binding 生成 argv/env 数组，不经过 shell；program 不能来自不可信 action input。
- 资产不能加载任意 JavaScript、WASM、shell 或自定义 React component。
- 路径、secret、写入并发和 capability 授权在实际功能边界校验，声明本身不授予权限。
- 用无品牌自定义 Agent 验证加载、展示、typed input、同 plan 启动和同 termd 会话；加入
  未知字段后确认仍可见且往返不丢失。

跨层硬约束见 `.trellis/spec/guides/tool-runtime-surfaces.md`，前端细则见
`.trellis/spec/frontend/agent-contract-core.md`。
