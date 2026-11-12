---
name: research-figure
description: 画论文 / 报告里的学术图（方法图、框架图、数据图）：检索参考 → 规划 → 定风格 → 出图（矢量走 Excalidraw、数据图走 matplotlib、插图走自己的出图能力）→ 渲染自检一轮 → 交付。步骤取自 PaperBanana，原版提示词在素材库里。
---

# 学术图

下文 `<library>` 是素材库目录（`berth tools call excalidraw private/library.js --input '{"action":"list"}'`
返回的 `dir`；`missing: true` 时告诉用户先运行 `private/collect.py`）。`<pb>` 是
`<library>/prompts/paperbanana`。每一步写明了对应的原版提示词：读它，把它当作这一步的要求，不要把它
原样贴给用户。

## 0. 收集输入

需要：图要表达的内容（通常是方法章节原文）和图的意图（图注、想强调什么）。缺哪个就问用户，不要猜。
再确认图的类型：

| 类型 | 出图路线 |
|---|---|
| 示意图（diagram）：方法、框架、流水线、模块关系 | 矢量：Excalidraw（读 `excalidraw-diagram` skill） |
| 数据图（plot）：柱、线、散点、热力、雷达、饼、树图 | matplotlib 代码出 PNG / PDF |
| 插图：照片、渲染图、图标式插画 | 你自己的出图能力生成位图，再作为图片节点放进 Excalidraw；没有出图能力就告诉用户并跳过 |

一张图可以混用：示意图主体走矢量，里面的插图走位图。

## 1. 检索参考（Retriever）

原版提示词：`<pb>/retriever_agent/DIAGRAM_RETRIEVER_AGENT_SYSTEM_PROMPT.md`（数据图换 `PLOT_`）。

参考集是 `<library>/bench/{diagram,plot}/ref.json`（每条有 `content` 方法原文、`visual_intent` 图注、
`category`、`path_to_gt_image` 图片，图片在同目录 `images/`）。类别：

- diagram：`agent_reasoning`、`vision_perception`、`generative_learning`、`science_applications`
- plot：`bar`、`line`、`scatter`、`heatmap`、`radar`、`tree_pie`、`misc`

先按类别筛，再按内容和图注的相近程度挑 2–3 条，读它们的图片，记下可借鉴的布局与配色。用户指定了参考
（图库里点「按这个画」带来的条目，或给了图片）就以用户的为准。

## 2. 规划（Planner）

原版提示词：`<pb>/planner_agent/DIAGRAM_PLANNER_AGENT_SYSTEM_PROMPT.md`（数据图 `PLOT_PLANNER_…`；
想用隐喻表达时加读 `DIAGRAM_PLANNER_METAPHOR_SUPPLEMENT.md`）。

写一段详细的图描述：有哪些模块、各自含义、数据怎么流动、分几个区域、每个区域的视觉元素。示意图不写
图标题。这段描述是后面出图的唯一依据。

## 3. 定风格（Stylist）

原版提示词：`<pb>/stylist_agent/DIAGRAM_STYLIST_AGENT_SYSTEM_PROMPT.md`；风格指南：
`<library>/styles/neurips2025_diagram_style_guide.md`（数据图 `…_plot_style_guide.md`）。

按风格指南修改上一步的描述：配色（柔和底色 + 一个强调色）、字体、线条、留白、图例。用户的论文已有
配色或模板时以它为准。

## 4. 出图（Visualizer）

- **矢量**：把描述转成结构 JSON，按 `excalidraw-diagram` skill 用 `layout.js` 排版。模块分区用不同的浅色
  填充，主流程方向 `LR`。产物 `figures/<名字>.excalidraw`。
- **数据图**：原版提示词 `<pb>/visualizer_agent/PLOT_VISUALIZER_AGENT_SYSTEM_PROMPT.md`。写 matplotlib
  脚本（放 `figures/<名字>.py`，数据从用户给的文件读，不手抄数字），按 plot 风格指南设字体、配色、网格，
  同时输出 PNG（看）和 PDF（论文用）。
- **插图**：原版提示词 `<pb>/visualizer_agent/DIAGRAM_VISUALIZER_AGENT_SYSTEM_PROMPT.md` 是写给图像模型的，
  可当生成提示词的模板。生成的图片放 `figures/assets/`，在结构 JSON 里作为 `image` 节点放进画板。

## 5. 自检一轮（Critic + Polish）

原版提示词：`<pb>/critic_agent/DIAGRAM_CRITIC_AGENT_SYSTEM_PROMPT.md`；评审维度：
`<pb>/diagram_eval_prompts/` 的 FAITHFULNESS（忠实）、CONCISENESS（简洁）、READABILITY（易读）、
AESTHETICS（美观）四份（数据图看 `plot_eval_prompts/`）；润色建议：`<pb>/polish_agent/`。

1. 出图：矢量用 `berth tools run excalidraw private/render.js <画板> /tmp/<名字>.png`，数据图直接读 PNG。
2. 读图，按四个维度各列出问题：忠实——和方法原文有没有出入、漏模块；简洁——有没有多余的文字和装饰；
   易读——箭头、分区、阅读顺序是否清楚；美观——配色、对齐、留白。
3. 一次改完能改的问题，**不再循环渲染**。
4. 交付：文件路径；改了什么；还剩哪些问题（留给用户在画板或脚本里调整）。渲染报错就跳过这一步，并说明
   这次没有自检。
