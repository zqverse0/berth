# Excalidraw：画图与图库

用 Excalidraw 画示意图、架构图、流程图、论文方法图，或按参考图重画。产物是项目里可继续编辑的
`.excalidraw` 文件，用户在 Berth 里直接打开调整。

## 先读 skill

`berth tools show excalidraw` 列出 skill 的绝对路径，画图前读 `excalidraw-diagram`。

## 命令

```bash
# 结构 JSON → 箭头已绑定的画板（格式见 excalidraw-diagram）
berth tools run excalidraw private/layout.js <structure.json> <out.excalidraw>
# 画板 → 白底 PNG，读这张图自检（要求 Berth 窗口开着）
berth tools run excalidraw private/render.js <drawing.excalidraw> <out.png>
# 改已有画板：先存档当前版再写入新版（不要直接写画板文件）；list 看每一版
berth tools run excalidraw private/history.js apply <drawing.excalidraw> <new.excalidraw> "<改了什么>"
berth tools run excalidraw private/history.js list <drawing.excalidraw>
# 素材库：列表、单条详情
berth tools call excalidraw private/library.js --input '{"action":"list"}'
berth tools call excalidraw private/library.js --input '{"action":"get","id":"<id>"}'
```

路径可以是相对当前目录的路径。

## 素材库

在插件数据目录 `$BERTH_HOME/state/excalidraw/library/`（`list` 返回的 `dir` 就是它，`BERTH_HOME` 缺省
`~/.berth`）。插件只自带几份起手模板；参考图、风格、提示词都是用户自己加的，图库里作为可选的「附加」
随模板一起交给你。

用户说「把这张图 / 这个画板 / 这段提示词加进图库」时：

```bash
# 文件入库（复制进素材库）：图片 → 参考，.excalidraw → 模板，.md / .txt → 提示词
berth tools call excalidraw private/library.js --input '{"action":"add","path":"<绝对路径>","title":"<标题>","tags":["<标签>"]}'
# 一段文字存成提示词
berth tools call excalidraw private/library.js --input '{"action":"addText","title":"<标题>","text":"<正文>"}'
# 移出图库 / 放回（文件不删）
berth tools call excalidraw private/library.js --input '{"action":"remove","id":"<id>"}'
```

用户自己加的条目带 `mine` 标签，检索参考时优先用。

## 产物与自检

- 画板默认放项目 `figures/<名字>.excalidraw`（用户指定了位置就用用户的）；结构 JSON、渲染 PNG 放 `/tmp`。
- 每张图只自检一轮：渲染 → 读图 → 按清单找问题 → 有问题改一次 → 交付。交付时说明改了什么、还剩什么，
  剩下的由用户在画板里调整。渲染报错（Berth 没开等）就跳过自检，并告诉用户这次没有自检。

## 改图记录

用户在 Excalidraw 侧栏的「改图」页签里写要求、选中元素，点击「保存要求并复制给 Agent」，
再手动粘贴到能访问项目文件的 Agent。说明包含画板绝对路径、要求、选区和存档操作；按 skill
`excalidraw-diagram` 的「按用户意见改图」做。每次经 apply 写入的版本存在
`$BERTH_HOME/state/excalidraw/history/`，用户自己在面板里对比、回退，你不用替用户回退。
面板明确显示当前画板，一次请求只针对该文件；切换画板标签页即可换目标，草稿在当前页面会话中按
绝对文件路径暂存，切回来继续写，不合并成多文件批量修改。复制不清空要求，也不自动投递或执行；
剪贴板不可用时，面板会展示完整说明供手动复制。最近保存的要求仍是单条最新要求，不是执行队列。同一画板可多选元素，选区不再截断为 30 个。

## 图形素材库

Excalidraw 左侧「素材库」保存可重复插入的图形组合，与「图库」中的参考图片、模板和提示词分开。
「浏览公开素材库 · 添加素材」读取官方公开目录，可按名称、说明、作者搜索，直接添加选中的素材库；
不必先去网页下载再导入。联网失败可重试，也可「打开官网」或从本地导入 `.excalidrawlib`。
插件为此使用 `network` 权限，只从官方 `excalidraw/excalidraw-libraries` 仓库读取目录与素材文件。
选中图形后点「收藏选中元素」，点缩略图插入当前画板；复选框可多选 / 全选，再插入、导出或确认移除。
素材标注为个人 / 公开，移除不会删除画板中已经插入的图形。界面适配 Berth 左侧，不是原生右侧面板的直接搬运。
「导出到项目」写到当前项目 `figures/library.excalidrawlib`（重名自动编号，不覆盖原文件）。
素材经 Excalidraw 原生持久化适配器保存在插件 storage 的 `shape-library` 键，跨画板和项目共用。
保存失败会提示，可「重试」或先导出备份；图片和嵌入内容仍放「图库」，不作为图形组合收藏。
