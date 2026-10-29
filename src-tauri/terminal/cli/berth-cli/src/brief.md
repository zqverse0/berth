# Berth

你运行在 Berth 管理的项目里，`berth` 命令直接可用。这是 Berth 命令的唯一清单；规则见 `berth guide`，参数见各命令的 --help。下面这些事优先用 Berth，不要自己另想办法：

项目级命令（任务、群组、会话、知识库）写作 berth project <项目> …：`.` 是当前目录所在项目，操作别的项目换成 `berth project ls` 里的名称或 ID。

{berth}
- 给用户看文件或某一行 → `berth open <路径>:<行号>`（不要用 xdg-open 或外部浏览器）
- 读用户在编辑器里正在看的内容 → `berth project current-file`
- 查看其他终端 → `berth terminal ls`、`berth terminal capture -t <终端>`
- 在其他终端里执行 → `berth terminal send -t <终端> --text <命令>`，回车另发 `berth terminal send -t <终端> --key Enter`；多行加 `--paste`
- 新开 Agent 终端 → `berth terminal create --project <项目> --agent <工具>`；关闭终端 → `berth terminal close -t <终端>`
- 任务 → `berth project . task --json create <标题> --slug <slug>`、`berth project . task --json show <任务>`、`berth project . task --json step <任务> S<n>`、`berth project . task --json assign <任务> --group <worktree>`、`berth project . task --json finish <任务>`
- 群组 → `berth project . group --json who <群>`、`berth project . group --json read <群>`、`berth project . group --json post <群> --to <成员> --text <消息>`、`berth project . group --json spawn <目录> --agent <工具> --expert <专家> --text <简报>`
- 专家 → `berth project . expert ls`（全部专家与它们在群里的终端数）、`berth project . expert show <id>`（它的终端和规矩）
- 读其他会话 → `berth project . session ls`、`berth project . session show <会话id>`
- 知识库 → `berth project . knowledge for <路径>`（改文件前查）、`berth project . knowledge search <词>`、`berth project . knowledge show <标题>`；写之前先读 `berth guide knowledge`
- 接手之前的工作、或用户问起之前做过什么 → 先读 `.berth/knowledge/交接/索引.md`（各专家最近一次会话），再打开对应专家的索引看当前状态与待办，不够再看某一次的详情；不需要时不读
- 用户的想法 / 问题 → `berth project . knowledge idea ls`、`berth project . knowledge idea show <id>`（讨论按 `berth guide knowledge`「处理想法」）
{tools}
