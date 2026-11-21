# 想法（`.berth/ideas/`）

用户随手记的想法 / 问题（侧栏「想法」），全项目只有主项目的 `.berth/ideas/` 一份。worktree 等其他 checkout
里没有这个目录（不检出），有也是旧副本：不读不写当前目录的 `.berth/ideas/`，路径一律从下面的 `list` 取。一条一个文件 `<创建时间>.idea.md`，id 就是文件名（不含 `.idea.md`）；
关闭的在 `.berth/ideas/归档/`。

```markdown
---
type: 想法
status: 待讨论        # 待讨论 | 讨论中 | 已落地 | 已放下
tags: [性能]          # 可选
---

用户原话（不改）

## 讨论

- 10-17 Agent：先测量再说
- 10-17 用户：同意

## 结论

→ 任务 10-17-cache
```

- 列出想法：`berth tools call ideas ui/api.js --input '{"action":"list"}'`，返回 `main`（主项目目录）和每条的
  `id`、`path`（相对 `main`）、`status`；读写用 `<main>/<path>` 的绝对路径。
- 原话不动；讨论与结论只追加到对应小节末尾，每条一行。
- 关闭和重开只走下面的 `setStatus` 命令；`待讨论` / `讨论中` 之间可以直接改 `status`。

## 处理想法

侧栏「和 Agent 讨论」发来，或用户让你看某条想法。用户提想法和意见，笔记由你写。

1. 读想法文件的原话。
2. 对照代码与已有笔记给判断，和用户讨论；每个要点在 `## 讨论` 下追加 `- MM-DD Agent：一句话`
   （用户说的写 `用户：`）；状态是待讨论就改成 `讨论中`。
3. 有结论就关闭，三种出口选一个，在 `## 结论` 下写一行：
   - 直接落地：一次提交能做完 → 做完提交，写 `→ 提交 <短 hash>`；只是认识 → 写进知识库 决策 / 经验 / 模块 笔记
     （`sources` 加 `idea:<id>`，见 `berth guide knowledge`），写 `→ [[笔记标题]]`。状态改 `已落地`。
   - 升级成任务：要多次提交或分阶段 → `berth project . task --json create <标题> --idea <id> --description <正文>`，
     正文按任务骨架写，「背景」放原话和讨论；写 `→ 任务 <taskDirName>`，状态改 `已落地`。之后进度只看任务。
   - 放下：写 `放下：<理由>`，状态改 `已放下`。
   写好结论后用这条命令改状态，不要手动改 `status` 或 `mv`，否则进不了知识库的待入库清单：
   `berth tools call ideas ui/api.js --input '{"action":"setStatus","id":"<id>","status":"已落地"}'`。
   它把文件移进 `.berth/ideas/归档/`（侧栏默认不再显示）并生成待入库；结论写了 `→ 任务` 的随任务归档时一起处理，不单独生成。
   重开也用它（`status` 给 `讨论中`），会移回来并移除待入库。结果里有 `inboxError` 就告诉用户。笔记里不要链接想法。
