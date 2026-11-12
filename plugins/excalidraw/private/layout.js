// berth tools run excalidraw private/layout.js <结构.json> <输出.excalidraw>
// 把 Agent 写的结构 JSON 排成箭头已绑定到节点的 Excalidraw 文件，之后可在画板里继续拖动调整。
//
// 结构 JSON：
//   {
//     "direction": "LR" | "TB",              // 默认 LR（从左到右）
//     "nodes": [{ "id", "label", "shape"?: "rectangle" | "ellipse" | "diamond",
//                 "color"?: "#a5d8ff", "x"?, "y"?, "width"?, "height"?,
//                 "image"?: "/绝对路径/图.png" }],     // 位图节点：作为图片元素放进画板，label 写在图下方
//     "edges": [{ "from", "to", "label"?, "dashed"?: true }]
//   }
// 节点没给 x / y 时按连线分层自动排布；给了就用给的。箭头从朝向对方的那条边的中点连出，
// 直连会穿过别的节点时从侧面绕行；两端都绑定到节点（拖动节点时箭头跟着走）。输入可以带 ```json 围栏、尾逗号或没闭合的括号，会先修好。

import { absolute } from "./paths.js"

const NODE_GAP = 60
const RANK_GAP = 120
const MIN_WIDTH = 140
const MIN_HEIGHT = 64
const FONT_SIZE = 20
const ARROW_GAP = 4
const DEFAULT_COLOR = "#a5d8ff"
const IMAGE_SIZE = { width: 320, height: 240 }
const IMAGE_MIME = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  webp: "image/webp",
  gif: "image/gif",
  svg: "image/svg+xml",
}

/** 修复 Agent 常见的坏 JSON：代码围栏、注释、尾逗号、没闭合的字符串与括号。 */
export function repairJson(text) {
  let source = text.trim()
  const fenced = source.match(/```(?:json)?\s*([\s\S]*?)(```|$)/)
  if (fenced) source = fenced[1].trim()
  try {
    return JSON.parse(source)
  } catch {
    // 继续修
  }
  // 逐字扫描：去掉字符串外的注释，记下没闭合的括号
  let out = ""
  const stack = []
  let inString = false
  for (let i = 0; i < source.length; i++) {
    const char = source[i]
    if (inString) {
      out += char
      if (char === "\\") out += source[++i] ?? ""
      else if (char === '"') inString = false
      continue
    }
    if (char === "/" && source[i + 1] === "/") {
      while (i < source.length && source[i] !== "\n") i++
      continue
    }
    if (char === "/" && source[i + 1] === "*") {
      const end = source.indexOf("*/", i + 2)
      i = end < 0 ? source.length : end + 1
      continue
    }
    if (char === '"') inString = true
    else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]")
    else if (char === "}" || char === "]") stack.pop()
    out += char
  }
  if (inString) out += '"'
  out = out.replace(/,\s*$/, "") + stack.reverse().join("")
  return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"))
}

/** 估算文字宽度：CJK 按一个字号宽，其余按 0.6 个字号。 */
function textWidth(text, fontSize) {
  let width = 0
  for (const char of text)
    width += /[⺀-￿]/.test(char) ? fontSize : fontSize * 0.6
  return width
}

function textSize(text, fontSize) {
  const lines = String(text).split("\n")
  return {
    width: Math.max(...lines.map((line) => textWidth(line, fontSize))),
    height: lines.length * fontSize * 1.25,
  }
}

let seed = 1
function base(id, type, x, y, width, height) {
  seed += 1
  return {
    id,
    type,
    x,
    y,
    width,
    height,
    angle: 0,
    strokeColor: "#1e1e1e",
    backgroundColor: "transparent",
    fillStyle: "solid",
    strokeWidth: 2,
    strokeStyle: "solid",
    roughness: 1,
    opacity: 100,
    groupIds: [],
    frameId: null,
    roundness: null,
    seed,
    version: 1,
    versionNonce: seed,
    isDeleted: false,
    boundElements: [],
    updated: 1,
    link: null,
    locked: false,
  }
}

function text(id, container, label, center) {
  const size = textSize(label, FONT_SIZE)
  return {
    ...base(
      id,
      "text",
      center.x - size.width / 2,
      center.y - size.height / 2,
      size.width,
      size.height
    ),
    boundElements: null,
    text: label,
    originalText: label,
    fontSize: FONT_SIZE,
    fontFamily: 5,
    textAlign: "center",
    verticalAlign: "middle",
    containerId: container,
    autoResize: true,
    lineHeight: 1.25,
  }
}

/** 按连线分层（最长路径），环里的回边不参与分层。 */
function ranks(nodes, edges) {
  const out = new Map(nodes.map((node) => [node.id, []]))
  for (const edge of edges) out.get(edge.from)?.push(edge.to)
  const rank = new Map()
  const visiting = new Set()
  const visit = (id) => {
    if (rank.has(id)) return rank.get(id)
    visiting.add(id)
    let best = 0
    for (const [from, targets] of out)
      if (targets.includes(id) && !visiting.has(from))
        best = Math.max(best, visit(from) + 1)
    visiting.delete(id)
    rank.set(id, best)
    return best
  }
  for (const node of nodes) visit(node.id)
  return rank
}

function place(nodes, edges, direction) {
  const rank = ranks(nodes, edges)
  const layers = []
  for (const node of nodes) (layers[rank.get(node.id)] ??= []).push(node)
  const across = direction === "TB" ? "width" : "height"
  const along = direction === "TB" ? "height" : "width"
  const spans = layers.map(
    (layer) =>
      layer.reduce((sum, node) => sum + node[across], 0) +
      NODE_GAP * (layer.length - 1)
  )
  const widest = Math.max(...spans)
  let offset = 0
  layers.forEach((layer, index) => {
    const depth = Math.max(...layer.map((node) => node[along]))
    let cursor = (widest - spans[index]) / 2
    for (const node of layer) {
      if (node.x === undefined || node.y === undefined) {
        const alongPos = offset + (depth - node[along]) / 2
        if (direction === "TB") Object.assign(node, { x: cursor, y: alongPos })
        else Object.assign(node, { x: alongPos, y: cursor })
      }
      cursor += node[across] + NODE_GAP
    }
    offset += depth + RANK_GAP
  })
}

/** 朝向对方那条边的中点，向外让出 gap（矩形、椭圆、菱形的四个边中点都在轮廓上）。 */
function anchor(node, toward) {
  const cx = node.x + node.width / 2
  const cy = node.y + node.height / 2
  const dx = toward.x + toward.width / 2 - cx
  const dy = toward.y + toward.height / 2 - cy
  if (Math.abs(dx) * node.height >= Math.abs(dy) * node.width) {
    const side = Math.sign(dx) || 1
    return { x: cx + side * (node.width / 2 + ARROW_GAP), y: cy }
  }
  const side = Math.sign(dy) || 1
  return { x: cx, y: cy + side * (node.height / 2 + ARROW_GAP) }
}

/** 线段是否穿过 nodes 里任一节点（按 24 段采样，节点外扩 8px）。 */
function crosses(start, end, nodes) {
  for (let step = 1; step < 24; step++) {
    const x = start.x + ((end.x - start.x) * step) / 24
    const y = start.y + ((end.y - start.y) * step) / 24
    for (const node of nodes)
      if (
        x > node.x - 8 &&
        x < node.x + node.width + 8 &&
        y > node.y - 8 &&
        y < node.y + node.height + 8
      )
        return true
  }
  return false
}

/**
 * 连线的折点（相对起点前的绝对坐标）：直连会穿过别的节点时，从两端节点垂直于排布方向的一侧
 * （LR 走上方、TB 走左侧）连出，经过一个越过沿途节点的拐点弯过去。
 */
function route(from, to, others, direction) {
  const start = anchor(from, to)
  const end = anchor(to, from)
  if (!crosses(start, end, others)) return [start, end]
  if (direction === "TB") {
    const a = { x: from.x - ARROW_GAP, y: from.y + from.height / 2 }
    const b = { x: to.x - ARROW_GAP, y: to.y + to.height / 2 }
    const low = Math.min(a.y, b.y)
    const high = Math.max(a.y, b.y)
    const left = Math.min(
      a.x,
      b.x,
      ...others
        .filter((n) => n.y + n.height > low && n.y < high)
        .map((n) => n.x)
    )
    return [a, { x: left - RANK_GAP / 2, y: (a.y + b.y) / 2 }, b]
  }
  const a = { x: from.x + from.width / 2, y: from.y - ARROW_GAP }
  const b = { x: to.x + to.width / 2, y: to.y - ARROW_GAP }
  const low = Math.min(a.x, b.x)
  const high = Math.max(a.x, b.x)
  const top = Math.min(
    a.y,
    b.y,
    ...others.filter((n) => n.x + n.width > low && n.x < high).map((n) => n.y)
  )
  return [a, { x: (a.x + b.x) / 2, y: top - NODE_GAP }, b]
}

/** images：节点 id → 图片 data URL（位图节点，由 main 读文件得到）。 */
export function layout(structure, images = {}) {
  const direction = structure.direction === "TB" ? "TB" : "LR"
  const nodes = (structure.nodes ?? []).map((node, index) => {
    if (!node.id) throw new Error(`node #${index + 1} has no id`)
    const label = String(node.label ?? node.id)
    if (images[node.id])
      return {
        ...node,
        label: node.label === undefined ? null : label,
        width: node.width ?? IMAGE_SIZE.width,
        height: node.height ?? IMAGE_SIZE.height,
      }
    const size = textSize(label, FONT_SIZE)
    return {
      ...node,
      label,
      width: node.width ?? Math.max(MIN_WIDTH, size.width + 48),
      height: node.height ?? Math.max(MIN_HEIGHT, size.height + 32),
    }
  })
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const edges = (structure.edges ?? []).filter((edge) => {
    const ok = byId.has(edge.from) && byId.has(edge.to) && edge.from !== edge.to
    if (!ok)
      console.error(
        `skipped edge ${edge.from} -> ${edge.to}: unknown node or self loop`
      )
    return ok
  })
  place(nodes, edges, direction)

  const elements = []
  const shapes = new Map()
  const files = {}
  for (const node of nodes) {
    const dataURL = images[node.id]
    if (dataURL) {
      const fileId = `file-${node.id}`
      files[fileId] = {
        id: fileId,
        mimeType: dataURL.slice(5, dataURL.indexOf(";")),
        dataURL,
        created: 1,
      }
      const image = {
        ...base(node.id, "image", node.x, node.y, node.width, node.height),
        fileId,
        status: "saved",
        scale: [1, 1],
      }
      shapes.set(node.id, image)
      elements.push(image)
      if (node.label) {
        const size = textSize(node.label, FONT_SIZE)
        elements.push({
          ...text(`${node.id}-label`, null, node.label, {
            x: node.x + node.width / 2,
            y: node.y + node.height + 8 + size.height / 2,
          }),
          verticalAlign: "top",
        })
      }
      continue
    }
    const shape = {
      ...base(
        node.id,
        ["ellipse", "diamond"].includes(node.shape) ? node.shape : "rectangle",
        node.x,
        node.y,
        node.width,
        node.height
      ),
      backgroundColor: node.color ?? DEFAULT_COLOR,
      roundness:
        node.shape === "rectangle" || !node.shape ? { type: 3 } : { type: 2 },
    }
    const label = text(`${node.id}-label`, node.id, node.label, {
      x: node.x + node.width / 2,
      y: node.y + node.height / 2,
    })
    shape.boundElements.push({ type: "text", id: label.id })
    shapes.set(node.id, shape)
    elements.push(shape, label)
  }
  edges.forEach((edge, index) => {
    const from = byId.get(edge.from)
    const to = byId.get(edge.to)
    const others = nodes.filter((node) => node !== from && node !== to)
    const points = route(from, to, others, direction)
    const start = points[0]
    const xs = points.map((point) => point.x)
    const ys = points.map((point) => point.y)
    const id = `edge-${index + 1}`
    const arrow = {
      ...base(
        id,
        "arrow",
        start.x,
        start.y,
        Math.max(...xs) - Math.min(...xs),
        Math.max(...ys) - Math.min(...ys)
      ),
      strokeStyle: edge.dashed ? "dashed" : "solid",
      roundness: { type: 2 },
      points: points.map((point) => [point.x - start.x, point.y - start.y]),
      startBinding: { elementId: edge.from, focus: 0, gap: ARROW_GAP },
      endBinding: { elementId: edge.to, focus: 0, gap: ARROW_GAP },
      startArrowhead: null,
      endArrowhead: "arrow",
      elbowed: false,
    }
    shapes.get(edge.from).boundElements.push({ type: "arrow", id })
    shapes.get(edge.to).boundElements.push({ type: "arrow", id })
    elements.push(arrow)
    if (edge.label) {
      const middle =
        points.length > 2
          ? points[1]
          : {
              x: (points[0].x + points[1].x) / 2,
              y: (points[0].y + points[1].y) / 2,
            }
      const label = text(`${id}-label`, id, String(edge.label), middle)
      arrow.boundElements.push({ type: "text", id: label.id })
      elements.push(label)
    }
  })
  return {
    type: "excalidraw",
    version: 2,
    source: "berth excalidraw layout.js",
    elements,
    appState: { viewBackgroundColor: "#ffffff", gridSize: null },
    files,
  }
}

/** 位图节点的图片读成 data URL。 */
async function readImages(structure) {
  const images = {}
  for (const node of structure.nodes ?? []) {
    if (!node.image) continue
    const path = absolute(String(node.image))
    const mime = IMAGE_MIME[path.split(".").pop().toLowerCase()]
    if (!mime) throw new Error(`${path}: unsupported image type`)
    images[node.id] = `data:${mime};base64,${await berth.fs.readBase64(path)}`
  }
  return images
}

export default async function main([input, out]) {
  if (!input || !out) {
    console.error(
      "usage: berth tools run excalidraw private/layout.js <structure.json> <out.excalidraw>"
    )
    return 2
  }
  try {
    const structure = repairJson(await berth.fs.readText(absolute(input)))
    const drawing = layout(structure, await readImages(structure))
    await berth.fs.writeText(
      absolute(out),
      JSON.stringify(drawing, null, 2) + "\n"
    )
    const arrows = drawing.elements.filter(
      (element) => element.type === "arrow"
    ).length
    console.log(
      `${absolute(out)}: ${structure.nodes?.length ?? 0} nodes, ${arrows} arrows`
    )
    return 0
  } catch (error) {
    console.error(`layout failed: ${error.message}`)
    return 1
  }
}
