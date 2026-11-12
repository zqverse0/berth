// 图库自带的起手模板：layout.js 的结构 JSON（格式见 private/layout.js）。图库「新建画板」用它在项目
// figures/ 下生成画板；缩略图 templates/<id>.png 由 render.js 预先渲染。改了这里要重新渲染缩略图。

export const TEMPLATES = [
  {
    id: "template-method-pipeline",
    title: "方法流水线",
    tags: ["template", "diagram", "pipeline"],
    structure: {
      direction: "LR",
      nodes: [
        { id: "input", label: "输入", shape: "ellipse", color: "#ffec99" },
        { id: "encoder", label: "编码器" },
        { id: "core", label: "核心模块", color: "#d0bfff" },
        { id: "decoder", label: "解码器" },
        { id: "output", label: "输出", shape: "ellipse", color: "#b2f2bb" },
        { id: "loss", label: "损失", color: "#ffc9c9" },
      ],
      edges: [
        { from: "input", to: "encoder" },
        { from: "encoder", to: "core", label: "特征" },
        { from: "core", to: "decoder" },
        { from: "decoder", to: "output" },
        { from: "output", to: "loss" },
        { from: "input", to: "loss", label: "监督", dashed: true },
      ],
    },
  },
  {
    id: "template-flowchart",
    title: "流程图",
    tags: ["template", "diagram", "flowchart"],
    structure: {
      direction: "TB",
      nodes: [
        { id: "start", label: "开始", shape: "ellipse", color: "#b2f2bb" },
        { id: "step", label: "处理步骤" },
        {
          id: "check",
          label: "条件成立？",
          shape: "diamond",
          color: "#ffd8a8",
        },
        { id: "yes", label: "分支 A" },
        { id: "no", label: "分支 B" },
        { id: "end", label: "结束", shape: "ellipse", color: "#ffc9c9" },
      ],
      edges: [
        { from: "start", to: "step" },
        { from: "step", to: "check" },
        { from: "check", to: "yes", label: "是" },
        { from: "check", to: "no", label: "否" },
        { from: "yes", to: "end" },
        { from: "no", to: "end" },
      ],
    },
  },
  {
    id: "template-architecture",
    title: "分层架构图",
    tags: ["template", "diagram", "architecture"],
    structure: {
      direction: "TB",
      nodes: [
        { id: "client", label: "客户端", color: "#ffec99" },
        { id: "gateway", label: "接入层" },
        { id: "svc-a", label: "服务 A" },
        { id: "svc-b", label: "服务 B" },
        { id: "db", label: "数据库", color: "#d0bfff" },
        { id: "cache", label: "缓存", color: "#d0bfff" },
      ],
      edges: [
        { from: "client", to: "gateway" },
        { from: "gateway", to: "svc-a" },
        { from: "gateway", to: "svc-b" },
        { from: "svc-a", to: "db" },
        { from: "svc-b", to: "cache" },
      ],
    },
  },
  {
    id: "template-comparison",
    title: "对比图（基线 vs 本文）",
    tags: ["template", "diagram", "comparison"],
    structure: {
      direction: "LR",
      nodes: [
        { id: "b-in", label: "输入", x: 0, y: 0, color: "#e9ecef" },
        { id: "b-model", label: "基线模型", x: 220, y: 0, color: "#e9ecef" },
        { id: "b-out", label: "结果", x: 440, y: 0, color: "#e9ecef" },
        { id: "o-in", label: "输入", x: 0, y: 140, color: "#ffec99" },
        { id: "o-new", label: "新增模块", x: 220, y: 140, color: "#ffc9c9" },
        { id: "o-model", label: "本文模型", x: 440, y: 140 },
        { id: "o-out", label: "更好的结果", x: 660, y: 140, color: "#b2f2bb" },
      ],
      edges: [
        { from: "b-in", to: "b-model" },
        { from: "b-model", to: "b-out" },
        { from: "o-in", to: "o-new" },
        { from: "o-new", to: "o-model" },
        { from: "o-model", to: "o-out" },
      ],
    },
  },
  {
    id: "template-tree",
    title: "模块分解（树）",
    tags: ["template", "diagram", "tree"],
    structure: {
      direction: "TB",
      nodes: [
        { id: "root", label: "系统", color: "#ffec99" },
        { id: "a", label: "模块 A" },
        { id: "b", label: "模块 B" },
        { id: "c", label: "模块 C" },
        { id: "a1", label: "子模块 A1", color: "#e7f5ff" },
        { id: "a2", label: "子模块 A2", color: "#e7f5ff" },
        { id: "c1", label: "子模块 C1", color: "#e7f5ff" },
      ],
      edges: [
        { from: "root", to: "a" },
        { from: "root", to: "b" },
        { from: "root", to: "c" },
        { from: "a", to: "a1" },
        { from: "a", to: "a2" },
        { from: "c", to: "c1" },
      ],
    },
  },
  {
    id: "template-loop",
    title: "闭环（训练 / 交互）",
    tags: ["template", "diagram", "loop"],
    structure: {
      direction: "LR",
      nodes: [
        { id: "agent", label: "智能体", x: 0, y: 0, color: "#d0bfff" },
        { id: "env", label: "环境", x: 360, y: 0, color: "#b2f2bb" },
        { id: "reward", label: "奖励", x: 360, y: 180, color: "#ffd8a8" },
        { id: "update", label: "策略更新", x: 0, y: 180 },
      ],
      edges: [
        { from: "agent", to: "env", label: "动作" },
        { from: "env", to: "reward" },
        { from: "reward", to: "update" },
        { from: "update", to: "agent" },
      ],
    },
  },
]
