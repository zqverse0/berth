# Berth 项目说明

Berth 是一个以**项目 × Agent**为主线的本地桌面工作台。项目是容器，Agent
通过 `berth-termd` 管理的原生 CLI / PTY 在项目目录中工作；Berth 负责读取历史、
选择资产与启动参数，并把文件、Git、任务和知识产出收回同一个工作区。

## 产品循环

```text
读  tools/<id>/sessions.json → Rust sessions domain → transcript 文件页
配  tool.json + launchbar.json + provider / expert 用户资产
跑  typed inputs → launch.js → berth-term-sdk → termd → PTY
收  文件 / Git / Trellis tasks / Automation / Knowledge
```

当前不提供生产 Web/server、ACP GUI 对话、Chat Channels、Agent 品牌配置中心、
内置 Skills/MCP 管理矩阵或第二套终端 runtime。

## 当前技术结构

```text
Next.js 16 / React 19 static export
  → src/lib/transport/
  → Tauri 2 commands
  → Rust domain services
  → SQLite / filesystem / keyring / berth-term-sdk
                                      ↓
                                  berth-termd
                                      ↓
                                     PTY
```

主要运行单元：

| 单元 | 职责 |
|---|---|
| `berth-gui` | Tauri 桌面应用 |
| `berth-termd` | terminal session/window/pane 与 PTY 权威 |
| `berth-cli` / `berth` | terminal、Tool action 与 GUI control CLI |
| `berth-tool-core` | Tool Asset 解析、校验和 plan |
| `berth-control-proto` | CLI ↔ GUI 的 typed 本地控制协议 |

## 用户资产

```text
$BERTH_HOME/
├── tools/<id>/
│   ├── tool.json
│   ├── launchbar.json
│   ├── launch.js
│   ├── sessions.json        # 可选
│   ├── research.md          # 可选
│   └── usage.md             # 可选
├── experts/
├── prompts/
├── skills/
├── mcp/
├── plugins/
└── extensions/
```

`BERTH_HOME` 默认是 `~/.berth`。会话目录不由 Berth 品牌代码硬编码，是否支持历史读取
以及实际路径都以对应 Tool 包的 `sessions.json` 为准。

## 文档地图

| 文档 | 权威内容 |
|---|---|
| [`../AGENTS.md`](../AGENTS.md) | 产品规则、红线、开发工作流 |
| [`architecture.md`](./architecture.md) | 当前模块边界、框架结构和端到端数据流 |
| [`agent-contracts.md`](./agent-contracts.md) | Tool Asset / Agent 契约 |
| [`plugin-development.md`](./plugin-development.md) | 插件开发指南：写、调试、发布 |
| [`plugin-architecture.md`](./plugin-architecture.md) | 插件接口固定约定 |
| [`expert-runtime.md`](./expert-runtime.md) | Expert 资产组合表 |
| [`model-providers.md`](./model-providers.md) | 在脚本、外部工具、外部 Agent 里使用已存服务商 |
| [`verification.md`](./verification.md) | 局部检查和资源约束 |
| [`REMOVED.md`](./REMOVED.md) | 历史删除和恢复方式，只作历史证据 |
| [`.trellis/spec/`](../.trellis/spec/) | 修改具体模块前读取的可执行契约 |

## 架构图

- [框架结构图](./diagrams/framework.svg)
- [工作区布局图](./diagrams/workspace-layout.svg)
- [核心数据流图](./diagrams/data-flow.svg)

## 开发

要求 Node.js 22+、pnpm、Rust stable 和 Tauri 2 平台依赖。

```bash
pnpm install
pnpm dev          # 用户运行：前端开发服务器
pnpm tauri dev    # 用户运行：完整桌面实例
pnpm tauri:prepare-sidecars
```

在正式版 Berth 终端里启动 dev 时，终端注入的 `BERTH_*` 指向正式数据，脚本会拒绝
启动；先去掉它们：

```bash
env -u BERTH_HOME -u BERTH_DATA_DIR -u BERTH_DATA_FILE \
  -u BERTH_TMPDIR -u BERTH_GUI_ENDPOINT pnpm tauri dev
```

Agent 日常验证只运行直接相关的 Vitest、目标 ESLint、过滤 Rust 测试和
`git diff --check`。禁止把全量 build/test 当作普通迭代基线，详情见
[`verification.md`](./verification.md)。

## 数据位置

- `$BERTH_HOME`：用户可维护资产；
- `$BERTH_DATA_DIR`：数据库、uploads、logs、cache；
- 项目 `.trellis/`：Trellis specs 与 tasks；
- 项目 `.berth/`：knowledge、canvas 等项目状态；
- termd 本地 IPC：live terminal runtime。

正式版资产默认在 `~/.berth`、应用数据在 `~/.local/share/app.berth`；
开发版从已有的 `~/.berth-dev` 读取自身资产与应用数据（`berth-dev.db`），
仓库 `bin/berth` 也指向该库与开发版 socket。两版可共享 Agent 原生会话历史，
但不会自动复制或同步 Berth 资产；开发版 keyring 使用独立服务名，已有密钥
若只存于原服务需在开发版手动重录。环境修改需重启开发实例才生效。

## 文档可信度

1. 当前能力必须能定位到活跃注册、调用方或实现。
2. migrations、兼容 DTO、redirect、孤立组件和历史任务不能单独证明能力存在。
3. `docs/REMOVED.md` 中的路径默认已经删除。
4. 源码与文档冲突时，检查源码并更新对应权威文档，不保留两套说法。

## 上游血缘与参考项目

Berth 吸收了两个上游，产品身份、版本号、发布节奏独立，来源说明见 `NOTICE`：

- **Codeg**（Apache-2.0）→ 主体应用框架
- **RMUX**（MIT / Apache-2.0）→ 终端运行时；已改名为 `berth-term-*`，LICENSE 在 `src-tauri/vendor/rmux/`

不从上游 merge / rebase / cherry-pick；新功能按 Berth 当前架构重新设计。

Orca（另一个多 Agent 桌面工具）是长期只读参考：读前先看它根目录的 `AGENTS.md`，
可借鉴需求边界、数据流与交互原则，实现必须按 Berth 架构重写。禁止整模块照搬、引入第二套
入口、加 submodule / 软链接 / 包依赖，或在 Berth 任务中修改 Orca。
