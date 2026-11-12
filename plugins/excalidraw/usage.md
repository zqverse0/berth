# Excalidraw：画图与图库

用 Excalidraw 画示意图、架构图、流程图、论文方法图，或按参考图重画。产物是项目里可继续编辑的
`.excalidraw` 文件，用户在 Berth 里直接打开调整。

## 先读哪个 skill

`berth tools show excalidraw` 列出 skill 的绝对路径，按场景读一个：

| 场景 | skill |
|---|---|
| 论文 / 报告里的图：方法图、框架图、数据图，要讲究学术风格 | `research-figure` |
| 一般的结构图：流程、架构、时序、思维导图等，或照一张图重画 | `excalidraw-diagram` |

`research-figure` 出矢量图时会再让你读 `excalidraw-diagram`。

## 命令

```bash
# 结构 JSON → 箭头已绑定的画板（格式见 excalidraw-diagram）
berth tools run excalidraw private/layout.js <structure.json> <out.excalidraw>
# 画板 → 白底 PNG，读这张图自检（要求 Berth 窗口开着）
berth tools run excalidraw private/render.js <drawing.excalidraw> <out.png>
# 素材库：列表（加 "bench": true 含 PaperBananaBench）、单条详情
berth tools call excalidraw private/library.js --input '{"action":"list"}'
berth tools call excalidraw private/library.js --input '{"action":"get","id":"<id>"}'
```

路径可以是相对当前目录的路径。

## 素材库

在插件数据目录 `$BERTH_HOME/state/excalidraw/library/`（`list` 返回的 `dir` 就是它，`BERTH_HOME` 缺省
`~/.berth`）。`styles/` 风格指南，`prompts/` 原版提示词与评审清单，`references/` 参考图，`bench/`
PaperBananaBench 全集（`{diagram,plot}/{ref,test}.json` + `images/`）。`list` 返回 `missing: true` 表示
还没收集，告诉用户运行插件包里的 `private/collect.py`，不要自己下载。

用户说「把这张图 / 这个画板 / 这段提示词加进图库」时：

```bash
# 文件入库（复制进素材库）：图片 → 参考，.excalidraw → 模板，.md / .txt → 提示词
berth tools call excalidraw private/library.js --input '{"action":"add","path":"<绝对路径>","title":"<标题>","tags":["<标签>"]}'
# 一段文字存成提示词
berth tools call excalidraw private/library.js --input '{"action":"addText","title":"<标题>","text":"<正文>"}'
# 移出图库 / 放回（文件不删，重跑 collect.py 也不会加回来）
berth tools call excalidraw private/library.js --input '{"action":"remove","id":"<id>"}'
```

用户自己加的条目带 `mine` 标签，检索参考时优先用。

## 产物与自检

- 画板默认放项目 `figures/<名字>.excalidraw`（用户指定了位置就用用户的）；结构 JSON、渲染 PNG 放 `/tmp`。
- 每张图只自检一轮：渲染 → 读图 → 按清单找问题 → 有问题改一次 → 交付。交付时说明改了什么、还剩什么，
  剩下的由用户在画板里调整。渲染报错（Berth 没开等）就跳过自检，并告诉用户这次没有自检。
