"use client"

import { useEffect, useMemo, useRef, useState, type DragEvent } from "react"
import { useLocale } from "next-intl"
import { toast } from "@/lib/notify"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { useSendToAgent } from "@/hooks/use-send-to-agent"
import { localizedTitle, type PluginView } from "@/lib/plugins/plugin-views"
import {
  connectPluginPage,
  pluginAssetUrl,
  pluginFrameSandbox,
  type PageConnection,
  type PageHost,
} from "@/lib/plugins/plugin-page"
import {
  hasFileTreeDragType,
  readFileTreeDragPayload,
} from "@/lib/files/file-tree-dnd"
import {
  isPathUnderRoot,
  openInPlaceOptions,
} from "@/lib/files/file-open-target"
import { cn } from "@/lib/utils"

/**
 * 插件页面（第 2 层）的 iframe：无边框透明背景，主题变量、按键、调用由 `connectPluginPage` 接上。
 * 编辑器页面另有：外部改写时发 `editor.externalChange`；从文件树拖进来时盖一层接住 drop，转成 `editor.drop`
 * （iframe 里收不到宿主文档的拖放）。
 */
export function PluginPageFrame({
  page,
  host,
  externalContent,
  acceptFileDrop = false,
  deferReveal = false,
  title,
}: {
  /** 包内 html 路径。 */
  page: string
  host: PageHost
  /** 编辑器：文件当前内容；不是页面自己交来的就推给页面。 */
  externalContent?: string
  acceptFileDrop?: boolean
  /** 页面画好首屏才显示，加载中的空白（主题下发前还可能是不透明底色）不露出来。 */
  deferReveal?: boolean
  title: string
}) {
  const [revealed, setRevealed] = useState(!deferReveal)
  const frameRef = useRef<HTMLIFrameElement | null>(null)
  const connection = useRef<PageConnection | null>(null)
  const hostRef = useRef(host)
  // 页面最近交来的内容（与外部改写区分）
  const lastPageContent = useRef<string | null>(
    host.context.kind === "editor" ? host.context.content : null
  )

  useEffect(() => {
    const frame = frameRef.current
    if (!frame) return
    const linked = connectPluginPage(
      frame,
      {
        ...hostRef.current,
        onChange: (content) => {
          lastPageContent.current = content
          hostRef.current.onChange?.(content)
        },
      },
      () => setRevealed(true)
    )
    connection.current = linked
    return () => {
      linked.dispose()
      connection.current = null
    }
  }, [host.plugin, page])

  useEffect(() => {
    hostRef.current = host
    connection.current?.update({
      ...host,
      onChange: (content) => {
        lastPageContent.current = content
        hostRef.current.onChange?.(content)
      },
    })
  }, [host])

  useEffect(() => {
    if (externalContent === undefined) return
    if (externalContent === lastPageContent.current) return
    lastPageContent.current = externalContent
    connection.current?.send("editor.externalChange", {
      content: externalContent,
    })
  }, [externalContent])

  // 文件树拖动期间才盖层，平时鼠标事件直达页面
  const [treeDragging, setTreeDragging] = useState(false)
  useEffect(() => {
    if (!acceptFileDrop) return
    const start = (event: globalThis.DragEvent) => {
      if (hasFileTreeDragType(event.dataTransfer)) setTreeDragging(true)
    }
    const end = () => setTreeDragging(false)
    window.addEventListener("dragstart", start)
    window.addEventListener("dragend", end)
    window.addEventListener("drop", end)
    return () => {
      window.removeEventListener("dragstart", start)
      window.removeEventListener("dragend", end)
      window.removeEventListener("drop", end)
    }
  }, [acceptFileDrop])

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    setTreeDragging(false)
    const payload = readFileTreeDragPayload(event.dataTransfer)
    const rect = frameRef.current?.getBoundingClientRect()
    if (!payload || !rect) return
    event.preventDefault()
    const root = hostRef.current.root
    const path =
      root && isPathUnderRoot(payload.absPath, root)
        ? payload.absPath.slice(root.replace(/[\\/]+$/, "").length + 1)
        : payload.absPath
    connection.current?.send("editor.drop", {
      name: payload.name,
      kind: payload.kind,
      path,
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    })
  }

  return (
    <div className="relative h-full w-full">
      <iframe
        ref={frameRef}
        title={title}
        src={pluginAssetUrl(host.plugin, page)}
        sandbox={pluginFrameSandbox()}
        className={cn(
          "block h-full w-full border-0 bg-transparent",
          !revealed && "invisible"
        )}
      />
      {treeDragging && (
        <div
          className="absolute inset-0"
          onDragOver={(event) => {
            if (!hasFileTreeDragType(event.dataTransfer)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = "copy"
          }}
          onDrop={handleDrop}
        />
      )}
    </div>
  )
}

/** 侧栏的第 2 层视图：`files.*` 与 `env.project` 取当前项目。 */
export function PluginSidebarPage({ view }: { view: PluginView }) {
  const { activeFolder } = useActiveFolder()
  const locale = useLocale()
  const { openFilePreview } = useWorkspaceRuntimeActions()
  const { send: sendToAgent } = useSendToAgent()
  const host = useMemo<PageHost>(
    () => ({
      plugin: view.plugin,
      permissions: view.permissions,
      root: activeFolder?.path ?? null,
      project: activeFolder
        ? {
            id: String(activeFolder.id),
            name: activeFolder.name,
            root: activeFolder.path,
          }
        : null,
      locale,
      context: { kind: "view", id: view.id, params: {} },
      openFile: (path) =>
        void openFilePreview(
          path,
          openInPlaceOptions(path, activeFolder?.path)
        ),
      notify: (message, kind) =>
        kind === "error" ? toast.error(message) : toast(message),
      sendToAgent: (text) => void sendToAgent(text),
    }),
    [view, activeFolder, locale, openFilePreview, sendToAgent]
  )
  return (
    // 页面只在载入时读项目：换项目要重新载入
    <PluginPageFrame
      key={activeFolder?.id ?? ""}
      page={view.page ?? ""}
      host={host}
      deferReveal
      title={localizedTitle(view.title, locale)}
    />
  )
}
