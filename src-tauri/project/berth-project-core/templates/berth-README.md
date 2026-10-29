# `.berth/`

这个目录由 Berth 管理，把项目、Agent 与 Berth 工具连起来。由 `berth project init`（或 Berth 里的「启用 Berth」）创建，
不要手工新建其他目录或文件。规则与命令用法随 Berth 发布：`berth guide`。

| 位置 | 内容 | 谁来写 | 进 git |
|---|---|---|---|
| `tasks/` | 任务：每个任务一个目录，`prd.md`（要做什么、怎么验收）+ `task.json`（标题、优先级、创建人与日期），可选 `research/` | `berth task` | 是，主项目一份，在主项目提交 |
| `knowledge/` | 项目知识库 | Agent 按 `berth guide knowledge` 维护，用户审阅 | 是，同上 |
| `presets.json` | 可选：项目启动预设（`berth group spawn --preset`） | 用户 | 是 |
| `local/` | 本机运行态：`tasks.json` 任务状态、`groups/` 群组账本、`runtime/` 送达与成员会话对应 | `berth task`、`berth group` | 否（自带 `.gitignore`） |

放哪一层：要随代码审阅、换机器还要的进 `tasks/` / `knowledge/`；本机实时协作状态进 `local/`；
能从源头重建的索引（如各 Agent 的会话列表）在 Berth 应用数据里，不进 `.berth/`。
