import LZString from "lz-string"

/**
 * Excalidraw 文件编解码：`.excalidraw` 是纯场景 JSON；`.excalidraw.md` 是 Obsidian
 * Excalidraw 插件格式（markdown 外壳 + `## Drawing` 代码块，可 LZString 压缩）。
 * 写回 `.excalidraw.md` 时只替换 Text Elements 正文与 Drawing 块，其余原样保留。
 */

export function isObsidianExcalidrawPath(path: string): boolean {
  return /\.excalidraw\.md$/i.test(path)
}

const DRAWING =
  /(\n##? Drawing\n[^`]*```(json|compressed-json)\n)([\s\S]*?)(```)/
// 小节正文止于下一个 `#`/`##` 标题或 `%%` 行
const sectionBody = (name: string) =>
  new RegExp(`(^##? ${name}\\n)([\\s\\S]*?)(?=^##? |^%%|(?![\\s\\S]))`, "m")
const EMBEDDED_FILE = /^([\w-]+):\s*!?\[\[([^\]|]*)(?:\|[^\]]*)?\]\]/gm

export interface ExcalidrawFileData {
  /** 场景 JSON 对象；空文件 / 新建的 `.excalidraw.md` 为 null（空画板） */
  scene: { files?: Record<string, unknown> } | null
  /** Obsidian `## Embedded Files`：fileId → 库内路径（图片存为独立文件） */
  embeddedFiles: Record<string, string>
}

/** 解析失败抛错（JSON 损坏 / 压缩数据损坏）。 */
export function parseExcalidrawFile(
  path: string,
  text: string
): ExcalidrawFileData {
  if (!isObsidianExcalidrawPath(path)) {
    return {
      scene: text.trim() ? JSON.parse(text) : null,
      embeddedFiles: {},
    }
  }
  const embeddedFiles: Record<string, string> = {}
  const embedded = text.match(sectionBody("Embedded Files"))?.[2] ?? ""
  for (const [, id, target] of embedded.matchAll(EMBEDDED_FILE)) {
    embeddedFiles[id] = target.trim()
  }
  const drawing = text.match(DRAWING)
  if (!drawing) return { scene: null, embeddedFiles }
  const raw =
    drawing[2] === "compressed-json"
      ? LZString.decompressFromBase64(drawing[3].replace(/[\r\n]/g, ""))
      : drawing[3]
  if (!raw) throw new Error("invalid compressed Excalidraw drawing")
  return {
    scene: JSON.parse(raw.slice(0, raw.lastIndexOf("}") + 1)),
    embeddedFiles,
  }
}

interface SceneElement {
  id: string
  type: string
  isDeleted?: boolean
  text?: string
  originalText?: string
}

/** 把场景 JSON 写回文件文本；`previous` 是当前文件内容（`.excalidraw.md` 保留其外壳）。 */
export function serializeExcalidrawFile(
  path: string,
  previous: string,
  sceneJson: string
): string {
  if (!isObsidianExcalidrawPath(path)) return sceneJson
  const scene = JSON.parse(sceneJson) as {
    source?: string
    elements?: SceneElement[]
    files?: Record<string, unknown>
  }
  const { embeddedFiles, scene: before } = parseExcalidrawFile(path, previous)
  // source 默认是页面 origin（dev 下是 localhost），沿用原文件的来源
  scene.source =
    (before as { source?: string } | null)?.source ?? OBSIDIAN_PLUGIN_SOURCE
  // 库内图片由 Embedded Files 引用，不写进场景 JSON
  if (scene.files) {
    for (const id of Object.keys(embeddedFiles)) delete scene.files[id]
  }
  const json = JSON.stringify(scene, null, "\t")
  // Text Elements 优先于 JSON 里的文本，必须同步；Obsidian 只认 8 位 id，
  // 新建元素（21 位 id）留给插件打开时从 JSON 补登
  const textBody = (scene.elements ?? [])
    .filter((e) => e.type === "text" && !e.isDeleted && e.id.length === 8)
    .map((e) => `${e.originalText ?? e.text ?? ""} ^${e.id}\n\n`)
    .join("")

  const drawing = previous.match(DRAWING)
  if (!drawing) return obsidianTemplate(textBody, compress(json))
  const body = drawing[2] === "compressed-json" ? compress(json) : json
  return previous
    .replace(
      DRAWING,
      (_m, head: string, _kind, _old, close: string) =>
        `${head}${body}\n${close}`
    )
    .replace(
      sectionBody("Text Elements"),
      (_m, head: string) => `${head}${textBody}`
    )
}

const OBSIDIAN_PLUGIN_SOURCE =
  "https://github.com/zsviczian/obsidian-excalidraw-plugin"

/** 与插件 compress 一致：base64 每 256 字符断一次空行。 */
function compress(json: string): string {
  const data = LZString.compressToBase64(json)
  let out = ""
  for (let i = 0; i < data.length; i += 256) {
    out += `${data.slice(i, i + 256)}\n\n`
  }
  return out.trim()
}

function obsidianTemplate(textBody: string, drawing: string): string {
  return `---

excalidraw-plugin: parsed
tags: [excalidraw]

---
==⚠  Switch to EXCALIDRAW VIEW in the MORE OPTIONS menu of this document. ⚠== You can decompress Drawing data with the command palette: 'Decompress current Excalidraw file'. For more info check in plugin settings under 'Saving'


# Excalidraw Data

## Text Elements
${textBody}%%
## Drawing
\`\`\`compressed-json
${drawing}
\`\`\`
%%`
}
