// Excalidraw 画板（Berth 插件页面）：`.excalidraw` / Obsidian `.excalidraw.md` 的编辑与 Markdown 嵌入渲染。
// 读写、自动保存、Ctrl+S、外部修改都归宿主；这里只把场景与文件文本互转（docs/plugin-architecture.md §4.2）。
/// <reference path="../../berth-plugin.d.ts" />
import "@excalidraw/excalidraw/index.css"
import { useEffect, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import {
  convertToExcalidrawElements,
  Excalidraw,
  exportToSvg,
  getSceneVersion,
  restore,
  serializeAsJSON,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw"
import { parseExcalidrawFile, serializeExcalidrawFile } from "./format.js"

const SAVE_DEBOUNCE_MS = 300

const MIME_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  bmp: "image/bmp",
}

const dirname = (path) =>
  path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : ""
const join = (dir, path) => (dir ? `${dir}/${path}` : path)

/** Obsidian `## Embedded Files` 引用的库内图片：相对画板所在目录，找不到再相对根。 */
async function loadEmbeddedFiles(path, embeddedFiles) {
  const dir = dirname(path)
  const loaded = await Promise.all(
    Object.entries(embeddedFiles).map(async ([id, target]) => {
      const mimeType =
        MIME_BY_EXT[target.split(".").pop()?.toLowerCase() ?? ""] ?? "image/png"
      for (const candidate of new Set([join(dir, target), target])) {
        try {
          const base64 = await berth.files.readBase64(candidate)
          return {
            id,
            mimeType,
            dataURL: `data:${mimeType};base64,${base64}`,
            created: Date.now(),
          }
        } catch {
          // 换下一个位置
        }
      }
      return null
    })
  )
  return loaded.filter(Boolean)
}

function parse(path, text) {
  try {
    return { ok: true, ...parseExcalidrawFile(path, text) }
  } catch {
    return { ok: false }
  }
}

function Editor({ context, initialContent, initialTheme }) {
  const [theme, setTheme] = useState(initialTheme)
  useEffect(() => berth.ui.onTheme(setTheme), [])
  const [api, setApi] = useState(null)
  // 文件当前文本（自己交出的或外部改写的），写回 `.excalidraw.md` 时据此保留外壳
  const written = useRef(initialContent)
  // 外部改写 → 换代重建画板；自己交出的不重建，保留撤销历史
  const [generation, setGeneration] = useState(0)
  const [content, setContent] = useState(initialContent)
  // onChange 每帧都触发：只比元素版本号与图片 id，没变就跳过；首次回调只记基线
  const lastVersion = useRef(null)
  // 真有改动时，序列化 + 压缩攒到停手后再做，拖动中不碰
  const pending = useRef(null)
  const timer = useRef(undefined)
  const flush = () => {
    clearTimeout(timer.current)
    const run = pending.current
    pending.current = null
    run?.()
  }
  useEffect(() => context.onFlush(flush), [context])
  useEffect(
    () =>
      context.onExternalChange((next) => {
        if (next === written.current) return
        written.current = next
        clearTimeout(timer.current)
        pending.current = null
        lastVersion.current = null
        setContent(next)
        setGeneration((value) => value + 1)
      }),
    [context]
  )

  const parsed = useMemo(
    () => parse(context.path, content),
    [context.path, content]
  )

  const embeddedFiles = parsed.ok ? parsed.embeddedFiles : null
  useEffect(() => {
    if (!api || !embeddedFiles || !Object.keys(embeddedFiles).length) return
    let cancelled = false
    void loadEmbeddedFiles(context.path, embeddedFiles).then((files) => {
      if (!cancelled && files.length) api.addFiles(files)
    })
    return () => {
      cancelled = true
    }
  }, [api, embeddedFiles, context.path])

  // 从文件树拖入文件：放一个带链接的卡片，根内的链接用 Obsidian 的 `[[相对路径]]`
  useEffect(() => {
    if (!api || context.readOnly) return
    return context.onDrop(({ name, kind, path, x, y }) => {
      if (kind !== "file") return
      const link =
        path.startsWith("/") || /^[a-z]:/i.test(path) ? path : `[[${path}]]`
      const point = viewportCoordsToSceneCoords(
        { clientX: x, clientY: y },
        api.getAppState()
      )
      api.updateScene({
        elements: [
          ...api.getSceneElementsIncludingDeleted(),
          ...convertToExcalidrawElements([
            {
              type: "rectangle",
              x: point.x,
              y: point.y,
              width: Math.max(160, name.length * 11 + 40),
              height: 56,
              roundness: { type: 3 },
              label: { text: name },
              link,
            },
          ]),
        ],
      })
    })
  }, [api, context])

  // 元素链接：网址交给系统浏览器；`[[x]]` / 相对路径按根解析，在 Berth 里打开
  const handleLinkOpen = (element, event) => {
    const link = element.link?.trim()
    if (!link) return
    event.preventDefault()
    if (/^[a-z][a-z0-9+.-]*:/i.test(link)) {
      void berth.ui.openUrl(link).catch(() => {})
      return
    }
    let target = /^\[\[([^\]|#]+)/.exec(link)?.[1]?.trim() ?? link
    // Obsidian 笔记链接省略 `.md`
    if (link.startsWith("[[") && !/\.[^/]+$/.test(target)) target += ".md"
    void berth.files
      .open(target)
      .catch((error) => berth.ui.notify(error.message, "error"))
  }

  if (!parsed.ok) {
    return (
      <div className="berth-error">
        {berth.ui.locale.startsWith("zh")
          ? "不是有效的 Excalidraw 场景文件（JSON 解析失败）。"
          : "This file is not a valid Excalidraw scene (JSON parse failed)."}
      </div>
    )
  }

  return (
    <Excalidraw
      key={generation}
      excalidrawAPI={setApi}
      initialData={parsed.scene}
      theme={theme}
      langCode={berth.ui.locale}
      viewModeEnabled={context.readOnly}
      onLinkOpen={handleLinkOpen}
      onChange={(elements, appState, files) => {
        if (context.readOnly) return
        const version = `${getSceneVersion(elements)}:${Object.keys(files).join()}`
        if (version === lastVersion.current) return
        const first = lastVersion.current === null
        lastVersion.current = version
        if (first) return
        pending.current = () => {
          const scene = serializeAsJSON(elements, appState, files, "local")
          const next = serializeExcalidrawFile(
            context.path,
            written.current,
            scene
          )
          if (next === written.current) return
          written.current = next
          context.change(next)
        }
        clearTimeout(timer.current)
        timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS)
      }}
    />
  )
}

// ponytail: 按 (主题, 路径, 文本) 缓存渲染结果、不限量；嵌入极多的文档再加 LRU
const svgCache = new Map()

/** 嵌入：把画板文件渲染成 SVG data URL（字体内联），宿主当图片显示。 */
function renderEmbed({ path, content, theme }) {
  const key = `${theme}\n${path}\n${content}`
  let result = svgCache.get(key)
  if (!result) {
    result = (async () => {
      const { scene, embeddedFiles } = parseExcalidrawFile(path, content)
      if (!scene) return null
      const data = restore(scene, null, null)
      const files = { ...data.files }
      for (const file of await loadEmbeddedFiles(path, embeddedFiles))
        files[file.id] = file
      const svg = await exportToSvg({
        elements: data.elements,
        appState: {
          ...data.appState,
          exportBackground: false,
          exportWithDarkMode: theme === "dark",
        },
        files,
      })
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.outerHTML)}`
    })()
    result.catch(() => svgCache.delete(key))
    svgCache.set(key, result)
  }
  return result
}

void (async () => {
  await berth.ready
  const context = berth.ui.context
  if (context.kind !== "editor") return
  if (context.mode === "embed") {
    context.onRender(renderEmbed)
    return
  }
  // 取最新内容：页面脚本运行前宿主可能已推过外部改写
  const [theme, content] = await Promise.all([berth.ui.theme(), context.load()])
  createRoot(document.getElementById("root")).render(
    <Editor context={context} initialContent={content} initialTheme={theme} />
  )
})()
