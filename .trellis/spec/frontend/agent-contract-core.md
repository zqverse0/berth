# Agent Tool Asset Frontend Contract

## 1. Scope / Trigger

修改 Agent 发现、启动栏、模型服务商、配置/资源、Skills/MCP、专家包投影或项目 Agent
页面前阅读。Agent 身份、会话资源和 provider 注入来自
`$BERTH_HOME/tools/<id>/tool.json`（`berth.tool/1`）。启动栏 UI 直读同目录
`launchbar.json`；目标 CLI argv 由同目录 `launch.py` 拼接。不得恢复
`agents/<id>.json`、`cli-tools/<id>.json` 或 `agent.json` 的运行时读取。

同时阅读跨层 [Tool Runtime Surface Contract](../guides/tool-runtime-surfaces.md)。

## 2. Public Seams

前端只通过 `src/lib/transport/` 调用后端。现有 Agent 启动链为：

```text
tools/<id>/launchbar.json
  → 通用控件 + 宿主 optionsFrom
  → typed agentLaunchInputs
  → terminal transport
  → python3 launch.py --berth-launch-inputs <json>
  → berth-term-sdk → termd
```

配置、资源、Skills/MCP 与 provider 模块分别消费
`extensions.org.berth.agent` 或通用 resource 投影并执行自己的操作。Contract
parser 只解析、诊断与投影，不执行软链接、进程、网络或文件写入。

## 3. Contracts

- `protocol`、`id`、`identity`、`views` 和
  `extensions.org.berth.agent` 来自同一 `tool.json`。
- 会话历史是 Agent 扩展的可选资源：`extensions.org.berth.agent.sessions` 只能引用
  同一工具包内的 `sessions.json`。该文件只声明 JSONL/普通 SQLite 的路径、表关系和
  字段 selector；JSONL 混合事件可用 `variant` + `roleMap` 声明固定角色，session 元数据
  可用受限 `@path.*` selector 取文件名/父目录。会话业务语义仍由 Berth 固定投影，不能放
  脚本、任意 SQL、watcher 或版本矩阵。
- `$schema`、revision 和未知字段是资产元数据；未知内容保留并可读，不作为整份资产的
  加载总开关。
- 会话资源缺失或无效时只报告该 Agent 的历史能力不可用；禁止回退到品牌 parser、扫描
  默认目录或注册 filesystem watcher。未来 Cursor 等复杂存储必须先提供 JSONL/普通
  SQLite 投影，再通过同一 `sessions.json` 接入。
- 启动栏只读 `launchbar.json` 的 `items`。动态来源与模型协议名单由宿主冻结；
  Agent 只填条目和 `protocols`。argv 不进入 React。`tool.json` 不投影启动栏。
- 服务商可见性只有一条规则：设置页协议栏与启动栏共用 `resolveProviderProtocolUrls`
  （`discovery_json.endpoints` 优先，缺失时回退 `api_url` + `agent_allowlist`），
  与启动注入 `injection.rs` 的回退顺序一致；禁止第二套判定或按 Agent 品牌分支。
- 项目 Agent 页只读展示当前选中资产的 `tool.json`、`research.md` 与模型服务商；
  修改通过打开目录/文件或委托 Agent 完成，不再维护内嵌第二套 JSON 编辑器。
- Agent-specific 优化只改资产。多个 Agent 都需要的新 field/control/projection 才能扩展核心，
  且 Rust/React 禁止按 `id` 或品牌分支。
- Pi 专家表是 Pi 工具资产自己的普通启动输入；核心投影不提供 Expert DTO、绑定或
  品牌分支。见 [Pi 专家表约定](../guides/expert-package-persona.md)。

## 4. Validation / Error Matrix

| 场景 | 前端行为 |
|---|---|
| 资产局部 action/扩展损坏 | 保留资产与其他可用投影；在对应位置显示诊断 |
| launchbar 字段 control 已支持 | 渲染通用控件并提交 typed value |
| optionsFrom 已支持 | 显示动态选项；`experts` 从 `$BERTH_HOME/experts` 读取 |
| optionsFrom 未支持且无静态 options | 跳过该项并显示字段诊断 |
| 必需字段无法用已有控件表达 | 禁用启动并显示字段诊断 |
| capability/runtime unavailable | 禁用唯一真实操作并显示短原因 |
| 未知字段 | 通用只读展示/原文保留，不自动生成按钮 |
| 保存外部 tool.json | focus/现有 saved-path 机制重载，不增加常驻轮询 |

## 5. Good / Base / Bad Cases

- Good：新增 Agent 增加 `tool.json` + `launchbar.json` + `launch.py`；现有启动栏
  按 launchbar.json 显示选项，终端 exec 启动脚本。
- Base：普通工具无 `org.berth.agent` 扩展，仍可由 CLI 发现和调用，不出现在 Agent UI。
- Bad：`if (agent.id === "claude")`、为某品牌新增 Tauri command，或让宿主
  按 `launchbar.json` 的 argv 字段拼目标 CLI。

## 6. Tests Required

- Rust projection：无品牌样本、局部失败、未知字段保留、launch action 与资源引用。
- plan：桌面与 CLI 共享 golden vector，typed inputs 产生逐字节相同 argv/cwd/env。
- frontend：通用 label/options/default/optionsFrom、unsupported 字段诊断、runtime
  unavailable、项目 Agent 只读资产入口和保存后重载。
- provider/Skills/MCP 只测各功能消费的投影和真实副作用边界，不把副作用塞进 parser。
- 新增 command 时按 `AGENTS.md` 红线记录注册数与长期 seam 理由。

## 7. Wrong vs Correct

Wrong：

```ts
if (agent.id === "claude") args.push("--model", selectedModel)
```

Correct：

```text
React submits { model: selectedModel }
  → launch.py --berth-launch-inputs maps to the Agent CLI
```

Wrong：为每个新启动栏字段改 Rust/React，或从 `tool.json` views 投影启动栏。

Correct：静态字段写进 `~/.berth/tools/<id>/launchbar.json` 并由 `launch.py` 消费；
多个 Agent 都需要的新动态来源才扩展一个 `optionsFrom`。

## 8. 隔离启动资产的缓存与配置安全

### Scope / Trigger

`launch.py` 为单次 Agent 会话构造临时 HOME、模型目录或配置，并从用户
HOME 软链运行时文件时适用。Berth 宿主不负责修复品牌启动脚本。

### Signatures

```text
launch.py --berth-launch-inputs <json>
  → isolated session home → exec Agent CLI
```

### Contracts

- 用户原始 `config.toml` / `models_cache.json` 为输入，不得被临时会话写入、
  `chmod` 或通过软链接覆盖。
- 为本次会话生成的缓存先写入仅自己可读写的临时文件，再用原子 replace
  替换**会话目录内**的软链接；Agent CLI 需要更新缓存时，会话文件应可写。
- TOML 顶层 `model`、`model_catalog_json` 不可在未知末尾 table 后盲目追加；
  优先用本次进程 `-m` / `-c model_catalog_json=...` 覆盖。

### Validation / Error Matrix

| 条件 | 要求 |
|---|---|
| 临时缓存是软链接且原始文件只读 | 替换链接本身，原始文件字节/权限不变 |
| 原配置末尾是 `[[skills.config]]` 等 table | 有效 TOML，不生成重复键或错放顶层键 |
| 生成缓存失败 | 启动失败并给出路径级诊断，不退回修改用户缓存 |

### Good / Base / Bad Cases

- Good：隔离会话生成自己的 cache，向 Agent CLI 传 `-c/-m`。
- Base：无需自定义模型目录时，直接启动 Agent CLI，不复制 HOME。
- Bad：对软链目标 `write_text/chmod`；直接在 TOML 最后追加顶层键。

### Tests Required

在隔离临时目录中将 `models_cache.json` 链接到只读 fixture：启动准备后
fixture 的字节/hash/权限不变，临时文件是权限 `0600` 的常规文件；
原 config 尾部有 table 时可正常解析，且 CLI 收到所选模型参数。

### Wrong vs Correct

```python
# Wrong：软链接会写到原始 HOME；末尾可能处于任意 TOML table
cache_path.write_text(payload)
config_path.write_text(config_path.read_text() + "\nmodel = 'x'\n")

# Correct：仅替换私有临时目录的链接，参数留在启动进程中
staged_cache.write_text(payload)
os.chmod(staged_cache, 0o600)
os.replace(staged_cache, cache_path)
argv.extend(["-m", model_id])
```
