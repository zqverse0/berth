# Berth 规则

命令清单只在上面一处；这里是用它们时要守的规则。

## 项目与 `.berth/`

- 未启用时任务、群组命令报 `not_initialized`。
- 任务、群组、知识库全项目只有一份，都在主项目的 `.berth/`：worktree 里用 `berth project . task` / `berth project . group` 读写的也是这一份，效果一样。
  例外：worker 按自己 worktree 里那份 prd（开工时的合同）干活，改需求走 `change`。
- 知识库全项目只有一份，在主项目：路径用 `berth project . knowledge root` 取，不要写 worktree 里的 `.berth/knowledge/`。维护方法：`berth guide knowledge`。

## 任务

- 默认在当前目录直接做：不自己建任务、不开 worktree，用户要求时才建。要分到某个 worktree 实现时，任务建在主目录，用 `assign --group <worktree 目录名>` 分过去（一个 worktree 可以放多个任务）。
- 一次提交能做完的事直接做；要多次提交或分阶段的才建任务。
- 想法 → 规划 → 执行：要规划的想法用 `berth project . knowledge idea promote <id>` 升级成任务（原话和讨论进「背景」，想法归档）；任务处于规划中时写方案，用户确认后开工。
- 任务是一个文件 `.berth/tasks/<MM-DD-slug>.md`（`create` / `promote` 生成骨架）。步骤在 frontmatter 的 `steps`，每步四个字段，照这个格式写（值里有 `: ` 就加引号）：

  ```yaml
  steps:
  - id: S1
    do: 一句话说清做什么
    change: 文件与函数
    verify: 一条能直接运行的命令
  ```

  写不出 `change` 和 `verify` 说明还没想清楚；`commit` 由命令写。正文：「目标」一句话结果；「背景」来源想法；「不做」划清边界；「验收」端到端可检查的结果；「记录」只写中途偏离计划的地方和原因。旧任务（目录里的 prd.md）不迁移。
- 照任务执行：
  1. `start <任务>`：每步都填全才能开工，返回任务文件和第一步。先把任务文件完整读一遍。
  2. 一次只做一步：只读这步 `change` 里的文件，按 `do` 改，只跑这步的 `verify`；通过才提交，正文末尾写 `Task: <任务> S<n>`。
  3. `step <任务> S<n>` 记下提交，返回下一步、全部步骤一览和「记录」末几行；照返回的下一步继续。
  4. 做法和计划不一样（换了文件、改了接口）先在「记录」写一行再提交；后面的步骤不对就直接改 `steps`。验证修两次仍不过，写进「记录」后停下问用户。
  5. 最后一步返回验收项：逐条确认后再 `finish`。上下文丢了用 `show <任务>` 重新对齐。
- frontmatter 的 `status`（规划中 / 进行中 / 已完成 / 已放弃）只由命令改：开工 `start`，完成 `finish`（放弃加 `--abandon --reason <原因>`，只在用户要求时用）。不要手写状态和 `commit`。
- 合并（只在用户要求时）：先提交全部改动，再在 worktree 里执行 `berth lock merge -- git -C <主项目> merge --no-ff <分支>`。主目录有未提交改动碰到这些文件，或合并冲突，就 `git -C <主项目> merge --abort` 并如实报告；绝不 `stash`、`reset`、`checkout` 掉用户的改动。项目自己的规则（`AGENTS.md`）可能另有试合并步骤。合并后由用户在任务页收尾，不要自己删 worktree 或分支。

## 群组

- 一个项目一个群：主目录和各 worktree 共用，命令里的群名写 `main` 或任何目录名都指这个群。群成员是专家：在本项目任何目录里启动、选了专家的 Agent 终端自动入群，成员名是专家名；同一专家开几个终端仍是一个成员，`who` 列出它的各个终端（`terminal` 是编号）。没选专家的 Agent 不入群，不能被 `--to`，回答也不贴回群。在自己的终端里发消息不用写 `--as`。
- 发给专家的消息投给它的一个终端：回复它某条结果的，回到出这条结果的终端；否则投给空闲的那个；都在忙就排队。专家没有终端在群（离线）时消息只存进群，它下次启动入群后照投；不要替用户拉起它。
- 每条消息都是委托：送达就会让对方开始一轮。只在需要对方做事时 `post`，不要发感谢、收到之类的回复。你完成被委托的一轮后直接在自己会话里回答，Berth 会把最终回答贴回群，不要再 `post` 一遍。
- `post` 结果里的 `doorbell.status`：`rung` 已送达，`deferred` / `queued` 对方忙、空闲后由后台送达，`waiting` 粘贴没落地（比如对方停在确认框）稍后重试，`stale` 对方终端已关，`skipped` 对方没登记终端，`failed` 终端服务不可用。消息本身总会存进群。
- 你的终端里出现一行 `read` 命令时，执行它。
- 查看成员用 `who`，不要去读别人的终端。`who` 也在 `terminals` 里列出本项目里不是成员的终端（shell、没选专家的 Agent）：收不到群消息，要操作就用 `berth terminal send` / `berth terminal capture`。
- `spawn <目录名>` 在主目录或指定 worktree 里启动 worker，`--expert <专家>` 必填（预设里已选专家时可省）；`--task` 只提供上下文，必须是分到该 worktree 的任务。worker 在自己的分支提交；简报里如果带了汇报命令，完成后执行它。
- 读别人的会话：`berth project . session show <会话id>` 默认最多 16 KB，长会话先加 `--tail 20`，再按需 `--grep <词>`；`--user-only` 只看用户发言。
