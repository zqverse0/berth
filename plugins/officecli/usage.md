# 在 Berth 里和用户一起改 Office 文件

用户在 Berth 里看预览、点选元素，你用 officecli 改，预览实时跟上。按下面的闭环工作。

## 1. 打开预览

```bash
berth open deck.pptx          # 在用户的 Berth 窗口里打开预览
```

预览由 `officecli watch` 驱动：你用 officecli 做的每次修改都会**立即**推到预览里，
不需要先 `save`/`close`。

## 2. 读用户指给你的元素

用户在预览里单击 / Ctrl+单击 / Shift+单击（表格区域）选中元素，右键「复制内容和来源」
后粘贴给你，格式是：

```
File: `/abs/path/deck.pptx`
Elements: `/slide[1]/picture[@id=2]`, `/slide[1]/shape[@id=19]` (preview element paths)
---
<元素文字；无文字的元素写成 [路径]>
```

`Elements` 里的路径就是 officecli 路径，直接用：

```bash
officecli get deck.pptx '/slide[1]/shape[@id=19]' --json
officecli set deck.pptx '/slide[1]/shape[@id=19]' --prop bold=true --prop color=FF0000
officecli set model.xlsx '/Sheet1/A1:C3' --prop bold=true      # 区域可整片 get/set
```

- 路径里的 `[@id=N]` 是稳定 id；`p[32]` 这类序号在增删后会变，改完结构后重新 `get`。
- 路径要加单引号（含 `[` `]` `@`）。

## 3. 改完自检

```bash
officecli view deck.pptx issues --json                 # 问题清单（JSON，带路径）；--type format|content|structure
officecli validate deck.pptx --json                    # OpenXML 校验
officecli view deck.pptx screenshot -o /tmp/deck.png --grid auto
```

截图后自己看一眼图片再交付；`--page 2-5` 只截部分页，`--range` 可只截一个元素或单元格区域。

## 4. 把改动指给用户看

```bash
officecli watch mark deck.pptx '/slide[2]/shape[@id=51]' --prop color=red --prop note="标签改成蓝色"
officecli watch mark report.docx '/body/p[33]' --prop find="计算机" --prop tofix="电脑" --prop note="用词"
officecli watch unmark report.docx --all          # 用户确认后清掉
officecli watch goto report.docx '/body/p[40]'     # 只支持 docx 的段落/表格路径
```

- 标注会实时出现在用户的 Berth 预览里（彩色框 + 备注标签），**新加的标注会自动滚到视野内**，
  pptx 也一样（officecli 的 `goto` 不支持 pptx，用 `mark` 代替跳转）。
- 想请用户确认的修改、拿不准的地方，用 `mark` 标出来再问，比只用文字描述位置清楚。
- 标注只在 watch 进程内存里，不写进文件。

## 5. 交付前

- 其他程序（Python、LibreOffice、上传）要读这个文件前，先 `officecli save <file>`
  或 `officecli close <file>`：officecli 的常驻进程会把修改先留在内存里，2–10 秒后
  才写盘。
- 不确定属性名或取值格式时先查 `officecli help <format> <element>`，不要猜。

## 场景技能

融资路演、学术论文、财务模型、数据看板、Morph 动画等，先加载对应的
`officecli-*` / `morph-ppt` 技能再动手。
