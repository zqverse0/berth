---
name: excalidraw-diagram
description: 用 Excalidraw 画结构图（流程、架构、时序、思维导图、ER、状态、泳道等）、照参考图重画，或按用户在「改图」面板提的意见修改画板：写结构 JSON → layout.js 排版成箭头已绑定的画板 → render.js 出图自检一轮 → 经 history.js apply 写入（自动存档旧版）。
---

# Excalidraw 结构图

下文 `<library>` 是素材库目录（`berth tools call excalidraw private/library.js --input '{"action":"list"}'`
返回的 `dir`）。

## 1. 定图类型

先判断哪种图最能表达需求，读对应规范：`<library>/prompts/smart-excalidraw/chart-types/<类型>.md`
（flowchart、architecture、sequence、mindmap、orgchart、class、er、state、swimlane、dataflow、network、
tree、timeline、gantt、concept、fishbone、swot、pyramid、funnel、venn、matrix、infographic）。
规范里的形状、配色、布局约定照着用。拿不准时读 `<library>/prompts/smart-excalidraw/system-prompt.md`
的「可选图表类型」与通用规则。

## 2. 写结构 JSON

只写结构，坐标交给 layout.js：

```json
{
  "direction": "LR",
  "nodes": [
    { "id": "enc", "label": "Encoder", "shape": "rectangle", "color": "#a5d8ff" },
    { "id": "z", "label": "Latent z", "shape": "diamond", "color": "#d0bfff" },
    { "id": "fig", "label": "示意", "image": "/tmp/fig.png", "width": 320, "height": 200 }
  ],
  "edges": [
    { "from": "enc", "to": "z", "label": "μ, σ" },
    { "from": "z", "to": "fig", "dashed": true }
  ]
}
```

- `direction`：`LR`（流水线、数据流）或 `TB`（层级、流程、组织）。
- `shape`：`rectangle`（步骤、模块）、`ellipse`（开始 / 结束 / 数据）、`diamond`（判断）。
- `color`：同一类节点同一个色；整张图不超过 4 种填充色。
- `x` / `y`：只在要精确摆位时给（照图重画）；给了就不再自动排。
- `image`：位图节点（照片、生成的插图），`width` / `height` 按原图比例给，否则会变形。
- 标签短：一行 2–4 个词；长说明放到图注里，不塞进节点。

```bash
berth tools run excalidraw private/layout.js /tmp/<名字>.json figures/<名字>.excalidraw
```

layout.js 会修好代码围栏、尾逗号、没闭合的括号；未知节点的连线会被跳过并在 stderr 报出。

## 3. 渲染自检（只一轮）

```bash
berth tools run excalidraw private/render.js figures/<名字>.excalidraw /tmp/<名字>.png
```

读这张 PNG，逐条查：

1. 内容：节点、连线和需求一一对应，没有漏的、多的。
2. 连线：没有箭头穿过节点，没有交叉成团，方向符合阅读顺序。
3. 文字：没有溢出框、没有重叠，字号一致。
4. 布局：对齐、间距均匀，整体比例不过宽或过高（过宽就换 `TB` 或分两行）。
5. 风格：配色符合图类型规范，强调色只用在关键路径。

有问题就改结构 JSON（或直接改画板里的少量元素）重新 layout 一次，**不再循环渲染**。交付时告诉用户：
文件路径、改了哪些问题、还剩哪些问题。渲染报错就跳过这步，并说明没有自检。

## 照图重画

用户给了一张图（或图库里的参考图）要重画成可编辑的：

1. 读图，列出所有框、文字、箭头和分组，估每个框的位置和大小（以图宽 1000px 为基准）。
2. 写结构 JSON，每个节点都给 `x` / `y` / `width` / `height`，颜色取图里的主色。
3. layout → render，把渲染图和原图并排对比，按上面的清单查，改一次后交付。

## 改已有画板：一律经 history.js apply

**不要直接写已有的画板文件。** 把新版写到 `/tmp`，再用 apply 写入：它先把当前版本存档，再写新版并记下你
的说明，用户在Excalidraw 侧栏的「改图」页签里能看到每一版、对比、一键回到任意一版。新建画板也可以这样写入。

```bash
berth tools run excalidraw private/history.js apply <画板> /tmp/<名字>.excalidraw "<一句话：改了什么>"
berth tools run excalidraw private/history.js list <画板>   # 看历次要求与改动
```

- 只改文字、颜色、少量位置：复制画板 JSON 到 `/tmp` 改那几个元素。文字在 `type: "text"` 元素的 `text` 与
  `originalText`；保持 `startBinding` / `endBinding` 与节点的 `boundElements` 一致；改过的元素把 `version`
  加 1、`versionNonce` 换个随机数。
- 大改结构：重写结构 JSON，layout 到 `/tmp/<名字>.excalidraw`，再 apply。
- apply 会拒绝不是场景 JSON 的内容；报错就修好再 apply，不要绕过它直接写。

## 按用户意见改图

用户在「改图」面板点击「保存要求并复制给 Agent」后，会手动把完整说明粘贴给你；其中包含画板绝对路径、修改要求和选中元素（id、类型、文字）。面板不自动投递、不启动 Agent：

1. 读画板 JSON；看不清布局时先 render 一张 PNG 读图。
2. 用户选了元素就只改这些元素（要求里另有说明除外），其余元素的 id、位置、样式保持不变——用户在对比
   新旧版，无关的变动会让人看不出改了什么。
3. 改动尽量小：要求没提到的布局不重排，不顺手「优化」。
4. 新版写到 `/tmp`，按上一节 apply，说明写成一句用户看得懂的话（如「编码器移到左侧，两条反馈线改虚线」）。
5. 能 render 就自检一轮；回复里只说改了什么、哪些没照做及原因。用户觉得不对会在面板里回到旧版再提要求，
   不用你回退。
