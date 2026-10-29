"use client"

import "@excalidraw/excalidraw/index.css"
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
} from "react"
import { useTheme } from "next-themes"
import { useTranslations } from "next-intl"
import {
  convertToExcalidrawElements,
  Excalidraw,
  getSceneVersion,
  serializeAsJSON,
  viewportCoordsToSceneCoords,
} from "@excalidraw/excalidraw"
import type {
  ExcalidrawImperativeAPI,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  findOwningFolder,
  isPathUnderRoot,
  joinRootRel,
  splitAbsPath,
} from "@/lib/files/file-open-target"
import { isAbsoluteFilePath } from "@/lib/files/file-path-display"
import {
  hasFileTreeDragType,
  readFileTreeDragPayload,
} from "@/lib/files/file-tree-dnd"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { openUrl } from "@/lib/platform"
import { loadEmbeddedFiles } from "@/lib/files/excalidraw-assets"
import {
  parseExcalidrawFile,
  serializeExcalidrawFile,
} from "@/lib/files/excalidraw-file"
import type { TextFileWorkspaceTab } from "@/lib/files/file-workspace-tab"

const SAVE_DEBOUNCE_MS = 300

/**
 * `.excalidraw` / Obsidian `.excalidraw.md` 文件的画板编辑，走文本 tab 的保存链路。
 * Obsidian 引用的库内图片（Embedded Files）打开时读入显示，写回时不进场景 JSON。
 */
export function ExcalidrawFileSurface({
  tab,
  onContentChange,
}: {
  tab: TextFileWorkspaceTab
  onContentChange: (content: string) => void
}) {
  const t = useTranslations("Folder.fileWorkspacePanel")
  const { resolvedTheme } = useTheme()
  const allFolders = useAppWorkspaceStore((state) => state.allFolders)
  const { openFilePreview } = useWorkspaceRuntimeActions()
  const projectRoot = useMemo(
    () => findOwningFolder(tab.path, allFolders)?.rootPath ?? null,
    [allFolders, tab.path]
  )
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null)
  // 文件当前文本（自己写回或外部重载），写回 `.excalidraw.md` 时据此保留外壳
  const written = useRef(tab.content)
  // onChange 每帧都触发（指针移动、平移缩放、选中、拖动）：只比元素版本号与图片 id，
  // 没变就跳过；首次回调只记基线，不标脏
  const lastVersion = useRef<string | null>(null)
  // 真有改动时，序列化 + 压缩攒到停手后再做，拖动中不碰
  const pending = useRef<(() => void) | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const flush = useCallback(() => {
    clearTimeout(timer.current)
    const run = pending.current
    pending.current = null
    run?.()
  }, [])
  // 切走 / 关闭 tab、窗口失焦、Ctrl+S 前先把攒着的改动写进 buffer。
  // 本组件的 effect 先于父级 useFileTabSave 注册，捕获阶段的 Ctrl+S 也先到这里。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "s") flush()
    }
    window.addEventListener("keydown", onKeyDown, true)
    window.addEventListener("blur", flush)
    return () => {
      window.removeEventListener("keydown", onKeyDown, true)
      window.removeEventListener("blur", flush)
      flush()
    }
  }, [flush])
  // 内容不是自己写回的（外部改动后重载）→ 换代重建画板；自己的保存不重建，保留撤销历史
  const [generation, setGeneration] = useState(0)
  useEffect(() => {
    if (tab.content === written.current) return
    written.current = tab.content
    clearTimeout(timer.current)
    pending.current = null
    lastVersion.current = null
    setGeneration((value) => value + 1)
  }, [tab.content])

  const parsed = useMemo(() => {
    try {
      return {
        ok: true as const,
        ...parseExcalidrawFile(tab.path, tab.content),
      }
    } catch {
      return { ok: false as const }
    }
    // 只在挂载 / 换代时取初始场景
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab.id, generation])

  // Obsidian 库内图片：打开时读入显示
  const embeddedFiles = parsed.ok ? parsed.embeddedFiles : null
  useEffect(() => {
    if (!api || !embeddedFiles || !Object.keys(embeddedFiles).length) return
    let cancelled = false
    void loadEmbeddedFiles(tab.path, embeddedFiles, projectRoot).then(
      (files) => {
        if (!cancelled && files.length) api.addFiles(files)
      }
    )
    return () => {
      cancelled = true
    }
  }, [api, embeddedFiles, tab.path, projectRoot])

  // 从文件树拖入文件：放一个带链接的卡片，链接用 Obsidian 的 `[[项目相对路径]]`
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    if (!api || tab.readonly || !hasFileTreeDragType(event.dataTransfer)) return
    event.preventDefault()
    event.stopPropagation()
    const payload = readFileTreeDragPayload(event.dataTransfer)
    if (!payload || payload.kind !== "file") return
    const link =
      projectRoot && isPathUnderRoot(payload.absPath, projectRoot)
        ? `[[${payload.absPath.slice(projectRoot.replace(/\/+$/, "").length + 1)}]]`
        : payload.absPath
    const { x, y } = viewportCoordsToSceneCoords(event, api.getAppState())
    api.updateScene({
      elements: [
        ...api.getSceneElementsIncludingDeleted(),
        ...convertToExcalidrawElements([
          {
            type: "rectangle",
            x,
            y,
            width: Math.max(160, payload.name.length * 11 + 40),
            height: 56,
            roundness: { type: 3 },
            label: { text: payload.name },
            link,
          },
        ]),
      ],
    })
  }

  // 元素链接：网址交给系统浏览器；`[[x]]` / 相对路径按项目根解析，在 Berth 里打开
  const handleLinkOpen = (
    element: { link: string | null },
    event: CustomEvent<unknown>
  ) => {
    const link = element.link?.trim()
    if (!link) return
    event.preventDefault()
    if (/^[a-z][a-z0-9+.-]*:/i.test(link)) {
      void openUrl(link)
      return
    }
    let target = /^\[\[([^\]|#]+)/.exec(link)?.[1]?.trim() ?? link
    // Obsidian 笔记链接省略 `.md`
    if (link.startsWith("[[") && !/\.[^/]+$/.test(target)) target += ".md"
    const base = projectRoot ?? splitAbsPath(tab.path)?.rootPath
    if (isAbsoluteFilePath(target)) void openFilePreview(target)
    else if (base) void openFilePreview(joinRootRel(base, target))
  }

  if (!parsed.ok) {
    return (
      <div className="flex h-full items-center justify-center px-6">
        <p className="max-w-md text-center text-sm text-destructive">
          {t("excalidrawParseError")}
        </p>
      </div>
    )
  }

  return (
    <div
      className="h-full w-full"
      onDragOverCapture={(event) => {
        if (tab.readonly || !hasFileTreeDragType(event.dataTransfer)) return
        event.preventDefault()
        event.stopPropagation()
        event.dataTransfer.dropEffect = "copy"
      }}
      onDropCapture={handleDrop}
    >
      <Excalidraw
        key={`${tab.id}:${generation}`}
        excalidrawAPI={setApi}
        initialData={parsed.scene as ExcalidrawInitialDataState | null}
        theme={resolvedTheme === "dark" ? "dark" : "light"}
        viewModeEnabled={tab.readonly}
        onLinkOpen={handleLinkOpen}
        onChange={(elements, appState, files) => {
          if (tab.readonly) return
          const version = `${getSceneVersion(elements)}:${Object.keys(files).join()}`
          if (version === lastVersion.current) return
          const first = lastVersion.current === null
          lastVersion.current = version
          if (first) return
          pending.current = () => {
            const scene = serializeAsJSON(elements, appState, files, "local")
            const next = serializeExcalidrawFile(
              tab.path,
              written.current,
              scene
            )
            if (next === written.current) return
            written.current = next
            onContentChange(next)
          }
          clearTimeout(timer.current)
          timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS)
        }}
      />
    </div>
  )
}
