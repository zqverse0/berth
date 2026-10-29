import type { BinaryFileData, DataURL } from "@excalidraw/excalidraw/types"
import { joinRootRel, splitAbsPath } from "@/lib/files/file-open-target"
import { parseExcalidrawFile } from "@/lib/files/excalidraw-file"
import { loadLocalImageDataUrl } from "@/lib/files/local-image"

// 字体由 scripts/sync-pdfjs-assets.mjs 拷到 public/excalidraw/（CSP 不放行 CDN 字体）；
// 画板与导出 SVG 都按这里取字体
if (typeof window !== "undefined") {
  ;(window as { EXCALIDRAW_ASSET_PATH?: string }).EXCALIDRAW_ASSET_PATH =
    "/excalidraw/"
}

/** Obsidian `## Embedded Files` 引用的库内图片：相对本文件目录，找不到再相对库根。 */
export async function loadEmbeddedFiles(
  path: string,
  embeddedFiles: Record<string, string>,
  vaultRoot: string | null
): Promise<BinaryFileData[]> {
  const dir = splitAbsPath(path)?.rootPath ?? null
  const loaded = await Promise.all(
    Object.entries(embeddedFiles).map(async ([id, target]) => {
      for (const base of [dir, vaultRoot]) {
        if (!base) continue
        const dataURL = await loadLocalImageDataUrl(joinRootRel(base, target))
        if (!dataURL) continue
        return {
          id: id as BinaryFileData["id"],
          dataURL: dataURL as DataURL,
          mimeType: dataURL.slice(
            5,
            dataURL.indexOf(";")
          ) as BinaryFileData["mimeType"],
          created: Date.now(),
        }
      }
      return null
    })
  )
  return loaded.filter((file) => file !== null)
}

// ponytail: 按文件文本缓存渲染结果、不限量；嵌入极多的文档再加 LRU
const svgCache = new Map<string, Promise<string | null>>()

/** 把画板文件渲染成 SVG data URL（字体内联），供 markdown 嵌入当图片显示。 */
export function excalidrawSvgDataUrl(
  path: string,
  text: string,
  vaultRoot: string | null
): Promise<string | null> {
  const dark = document.documentElement.classList.contains("dark")
  const key = `${dark}\n${path}\n${text}`
  let pending = svgCache.get(key)
  if (!pending) {
    pending = (async () => {
      const { scene, embeddedFiles } = parseExcalidrawFile(path, text)
      if (!scene) return null
      const [{ exportToSvg, restore }, extra] = await Promise.all([
        import("@excalidraw/excalidraw"),
        loadEmbeddedFiles(path, embeddedFiles, vaultRoot),
      ])
      const data = restore(scene as Parameters<typeof restore>[0], null, null)
      const files = { ...data.files }
      for (const file of extra) files[file.id] = file
      const svg = await exportToSvg({
        elements: data.elements,
        appState: {
          ...data.appState,
          exportBackground: false,
          exportWithDarkMode: dark,
        },
        files,
      })
      return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg.outerHTML)}`
    })()
    pending.catch(() => svgCache.delete(key))
    svgCache.set(key, pending)
  }
  return pending
}
