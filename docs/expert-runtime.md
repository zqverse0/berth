# 专家资产组合表

Expert 不是 Berth 的独立领域模块。专家是一份位于
`$BERTH_HOME/experts/<id>.json` 的资产组合表，由各 Agent 的包内启动脚本读取；
没有 revision、hash、项目绑定或快照。

## 目录

```text
$BERTH_HOME/
├── prompts/<id>.md
├── skills/<id>/SKILL.md
├── mcp/<id>.json            # 路径用 ${BERTH_HOME}/…，不写死设备路径
├── mcp/<id>/                # 自带 MCP 服务的源码（可选）
├── plugins/<id>/            # Agent 插件（上游原样）：自带哪家原生清单就给哪家用
├── experts/<id>.json
├── state/<agent>/           # 插件自己的数据（berth.storage.dir），第一次写入时创建
└── tools/<agent>/
    ├── tool.json
    ├── launchbar.json
    ├── launch.js
    ├── icon.svg|png
    ├── sessions.json / usage.json   # 可选，宿主读取
    └── private/             # Agent 专属文件（如 pi global.json 与 extensions/、claude base-settings.json）
```

`BERTH_HOME` 未设置时默认为 `~/.berth`。`pnpm tauri dev` 和本仓库 `bin/berth`
均使用已有的 `~/.berth-dev` 作为资产及数据根（数据库固定为 `berth-dev.db`），
不自动从正式版复制或同步工具、专家资产；Agent 原生会话历史仍在用户主目录。

## 专家表

文件名就是专家 ID。`name` 必填；`prompt`、`skills`、`mcp`、`plugins` 可省略。
专家表与 Agent 无关：Agent 之间的差异只写在各自 `launch.js` 里，**不为某个 Agent
往专家表加字段**。

```json
{
  "name": "架构顾问",
  "prompt": "arch-advisor",
  "skills": ["arch-review-method"],
  "mcp": ["context7"],
  "plugins": ["ponytail"]
}
```

通用与专属按目录区分，专家表写什么就加载什么，Berth 不猜：

| 目录 | 含义 | 专家字段 |
|---|---|---|
| `skills/`、`mcp/`、`prompts/` | 通用：所有 Agent 都加载 | `skills`、`mcp`、`prompt` |
| `plugins/<id>/` | Agent 原生包：插件自带哪家清单，哪家才加载 | `plugins` |

`plugins` 的每一项由宿主按本 Agent 的 `isNativePlugin(dir)` 钩子分流：有本 Agent
的原生清单就原生加载，否则跳过（不报错，启动计划 `plugins` 注明 `native` / `skipped`）。
**不从插件里挑 skills 给别的 Agent**——上游插件常混装各家专属内容。要让插件里的某个 skill
对所有 Agent 生效，把它放进顶层 `skills/` 并写进专家 `skills`。

各 `launch.js` 只提供「什么算我的原生插件」（`isNativePlugin`，不导出 = 全部跳过）。
配置专家时看某个 Agent 实际加载什么（判定只写在 launch.js 一处）：

```bash
berth tools launch ~/.berth/tools/<agent>/launch.js --plugins <expert-id>
# {"ponytail":"native"}
```

| Agent | 原生判定 | 加载方式 |
|---|---|---|
| claude | `.claude-plugin/plugin.json` | `--plugin-dir` |
| codex | `.codex-plugin/plugin.json` | 会话 marketplace |
| grok | `.grok-plugin`、`.claude-plugin`、`plugin.json`、`skills/`、`commands/`、`agents/`、`hooks/hooks.json`、`.mcp.json` 任一 | `grok plugin install` |
| pi | `package.json` 有 `pi` 键，或有 `extensions/` | `-e <目录>`（Pi 按 packages.md 规则读） |
| agy、cline | 无原生格式 | 跳过 |

只给一个 Agent 的扩展也放成 `plugins/<id>/`（如 Pi 的 `extensions/x.ts`），其他 Agent
自动跳过。按 Agent 对所有会话生效、由 Berth 提供的东西（如 Pi 的
`berth-agent-status.ts`）不归专家，放 `tools/<agent>/private/`。

所有引用都是同类目录下的安全 ID，不允许绝对路径、`..` 或内嵌资产正文。

`tools/<agent>/private/global.json` 记录该 Agent 对所有专家共用的配置（例如 Pi 保留的原生包
与 Berth 自带扩展）。启动脚本读取它，不再把同一套全局扩展写进每个专家表，也不在每次
专家启动时重新挂载这些包。

## 启动栏与启动输入

Berth 只读 `tools/<id>/launchbar.json` 的 `items`。格式由宿主定，Agent 往里填；
加一项前端就多显示一项，不从 `tool.json` 再投影栏。

动态来源只有四种：`experts`、`projectSessions`、`providerVendor`、`providerModels`。
`projectSessions` 项可声明 `"assignNew": true`：表示 launch.js 能用指定 id 新建会话。用户没选会话时，
宿主在启动前填一个新 id（`berth_tool_core::paths::assign_launch_session`，桌面与 CLI 同一处），
终端启动命令里就带着会话 id，群组按它把终端与会话一一对应，不按目录猜。
模型服务是栏上的一项：Berth 提供 `claude` / `chat` / `gemini` 三种协议，Agent 在
`providerVendor` 上写 `protocols`，宿主只显示在该协议上有 URL 的服务商。这个「有
URL」与设置页协议栏是同一套取值：`discovery_json.endpoints` 优先，缺失时回退档案
的 `api_url` + `agent_allowlist`（启动注入 `injection.rs` 按同样顺序回退），不维护
第二套判定。没声明协议就不显示服务商（与 Agent 名字无关）。官方卡用该 Agent 自己
文件里的身份字段认领，Berth 不维护 Agent 类型名单。

```text
launchbar.json items
  → 用户选择
  → --berth-launch-inputs { expert, model, 模式… }
  → berth-cli tools launch：校验输入、读专家表与服务商档案
  → tools/<id>/launch.js 拼该 CLI 的 argv
服务商 URL/Key 由 Berth 写成一次性启动档案（--berth-provider <文件>），不进 JSON、不进 pane 环境。
```

CLI（`berth terminal create --agent <id> --input k=v`、`berth provider run <服务商> --agent <id>`）
走同一条命令：`berth-cli tools launch <tools>/<id>/launch.js --berth-launch-inputs <全部输入 JSON>`。
`tool.json` 不声明启动动作；启动参数只在 `launchbar.json` 声明，宿主按它拒绝未声明的输入键、校验
select 取值，并读取（随即删除）服务商启动档案；各 `launch.js` 只写取值到目标 CLI argv 的映射与专家资产投递
（`docs/plugin-development.md`）。

`optionsFrom: "experts"` 在加载时读取 `$BERTH_HOME/experts/*.json`。前端只提交
选择值。同一 JSON 也写入 `BERTH_LAUNCH_INPUTS`。Claude 用 `--settings` 叠加
modelPicker，**不**改 `CLAUDE_CONFIG_DIR`。

专家表与资产引用在启动时由宿主校验，出错即拒绝启动。MCP 敏感值只能写成完整的
`$ENV_NAME`；变量缺失应阻止本次启动，禁止明文密钥和旧 `secretRef`。
