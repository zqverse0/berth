# 专家资产组合表约定

## 适用场景

修改 `$BERTH_HOME/{experts,prompts,skills,mcp,plugins}` 或 Agent
专家启动脚本前阅读。

## 契约

- Expert 不是 Berth 领域模块，只是 `experts/<id>.json` 中的资产组合表。
- 表只允许 `name`、`prompt`、`skills`、`mcp`、`plugins`，文件名即 ID；表与 Agent 无关，
  不为某个 Agent 加字段。`plugins` 经 `route_plugins` 分流（有原生清单才加载，否则跳过；不挑 skills 跨 Agent 用）。通用能力放顶层 `skills/`。
- 资产直接读取当前文件，不计算 hash，不保存 revision，不建立快照或项目绑定。
- 专家选择是各 Agent `launchbar.json` 的普通启动输入（`optionsFrom: "experts"`）；
  Rust/React 不按 Agent 品牌分支。禁止把 ID/名称复制为各工具 `tool.json` 的静态 `oneOf`。
- 宿主只把完整 typed inputs 序列化给 `launch.py`；目标 Agent CLI 的 argv 映射只在
  脚本中维护，禁止 Berth emit 与脚本各维护一份 flag 拼接逻辑。
- MCP 密钥只允许完整 `$ENV_NAME` 引用；临时合并文件权限为 `0600`，Pi 退出后删除。
- 路径必须留在对应资产目录内；缺失引用、坏 JSON 或缺失环境变量直接阻止本次启动。
- 各脚本只消费该 Agent 支持的资产类型，无关字段跳过。

详细格式见 `docs/expert-runtime.md`。
