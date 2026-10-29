# Pi

交互式编码 Agent CLI。启动栏只投影高频开关；其余用原生命令或改配置文件。

## 配置文件

| 范围 | 路径 |
|---|---|
| 全局设置 | `~/.pi/agent/settings.json` |
| 项目设置 | `.pi/settings.json`（覆盖全局） |
| 自定义模型 | `~/.pi/agent/models.json` |
| MCP | `~/.pi/agent/mcp.json` |
| 会话 | `~/.pi/agent/sessions/` |
| 项目信任 | `~/.pi/agent/trust.json` |
| 用户指令 | `~/.pi/agent/AGENTS.md` |
| 项目指令 | `AGENTS.md`（工作区根） |

持久默认模型 / 思考强度：编辑 `settings.json` 的 `defaultProvider`、`defaultModel`、`defaultThinkingLevel`，或在 Pi 里 `/model`、`/thinking` 后 Ctrl+S。

## 启动栏 → 原生命令

启动栏服务商/模型与 Claude、Codex 相同：选 Berth 档案后下拉模型，发射 `--model <id>`。空着跟随 Pi `settings.json`。

`Pi Native` 官方列表是本机 `pi --list-models` 的快照（不含 黑白 等大目录），id 为 `provider/model`。Berth 不会实时读 `~/.pi/agent/models.json`。中转站要单独建一条 Agent 类型 `pi` 的档案，不能直接共用 Claude/Codex 那条（`agent_type` 创建后不可改）。

```bash
pi --model qwen3.7-plus
pi --thinking high
pi --continue
pi --resume          # TUI 选会话（未进启动栏）
pi --approve
pi --list-models
```

## 不要用 Berth 包装的

`pi install` / `remove` / `update` / `auth` 直接跑原生命令。`root` 动作是完整 flag 清单，不是启动入口。
