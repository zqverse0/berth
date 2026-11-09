import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { paneAtPoint } from "@/hooks/workspace/workspace-tab-drag-hit-test"
import { readWorkspaceLayoutProjection } from "@/hooks/workspace/use-workspace-layout"
import { quotePathForShell } from "@/lib/content-reference/serialize"
import { cssDropPoint, isOwnNativeDrag } from "@/lib/files/file-tree-dnd"
import { toast } from "@/lib/notify"
import { isDesktop } from "@/lib/transport"
import { isTerminalTab } from "@/lib/workspace/primary-tabs"
import type { WorkspacePane } from "@/lib/workspace/workspace-tab-placement"
import { useTabStore } from "@/stores/tab-store"
import { useTerminalRuntimeStore } from "@/stores/terminal-runtime-store"
import {
  useWorkspaceLayoutStore,
  type TreeDropOver,
} from "@/stores/workspace-layout-store"

function activeTerminalOf(pane: WorkspacePane) {
  const active = readWorkspaceLayoutProjection().activeTabByPane[pane]
  if (active?.kind !== "primary") return null
  const tab = useTabStore.getState().tabs.find((item) => item.id === active.id)
  return tab && isTerminalTab(tab) ? tab : null
}

/**
 * 文件拖到分栏上时放下会发生什么：这一栏正显示终端就粘贴路径（文件和目录都行），否则在这一栏打开
 * （只有文件能打开，目录不接收）。坐标是 CSS 像素。
 */
export function treeDropOverAt(
  x: number,
  y: number,
  kind: "file" | "dir"
): TreeDropOver | null {
  const hit = paneAtPoint(x, y)
  if (!hit) return null
  const { splitActive, tabsByPane } = readWorkspaceLayoutProjection()
  // 主区右侧三分之一提议拆分时命中的是还不存在的右栏，脚下其实是左栏。
  const proposedSplit = hit === "files-split" && !splitActive
  const under = proposedSplit ? "files" : hit
  if (activeTerminalOf(under)) return { pane: under, action: "paste" }
  if (kind === "dir") return null
  // 左栏没有 tab 时拆不出右栏，直接开在左栏。
  const pane = proposedSplit && tabsByPane.files.length === 0 ? "files" : hit
  return { pane, action: "open" }
}

/** 系统文件拖进来：只有终端接收，高亮规则与文件树的拖动一致。 */
export function osDropOverAt(x: number, y: number): TreeDropOver | null {
  const over = treeDropOverAt(x, y, "dir")
  return over?.action === "paste" ? over : null
}

/** 把路径粘贴进这一栏当前的终端（按它的 shell 加引号，留一个空格，不回车）并聚焦。 */
export async function pastePathsIntoPane(
  pane: WorkspacePane,
  paths: readonly string[]
): Promise<boolean> {
  const tab = activeTerminalOf(pane)
  if (!tab) return false
  // pasteText 只认当前活动 tab。
  useWorkspaceLayoutStore
    .getState()
    .selectWorkspaceTab({ kind: "primary", id: tab.id })
  const text = paths
    .map((path) => quotePathForShell(tab.shell, path).text)
    .join(" ")
  const result = await useTerminalRuntimeStore
    .getState()
    .pasteText(tab.terminalId, `${text} `, {
      submit: false,
      source: "document-context",
      tabId: tab.id,
      backendInstanceId: tab.backendInstanceId,
    })
  return result.ok
}

/** 桌面端：系统文件管理器拖来的文件放到终端上，粘贴路径。 */
export function useOsFileDropToTerminals() {
  const t = useTranslations("Folder.fileTreeTab")
  useEffect(() => {
    if (!isDesktop()) return
    let disposed = false
    let osDrag = false
    const unlisteners: Array<() => void> = []
    const setOver = useWorkspaceLayoutStore.getState().setTreeDropOver
    const overAt = (position: { x: number; y: number }) => {
      const { x, y } = cssDropPoint(position)
      return osDropOverAt(x, y)
    }
    void (async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview")
      const { TauriEvent } = await import("@tauri-apps/api/event")
      const webview = getCurrentWebview()
      type Position = { position: { x: number; y: number } }
      const offs = await Promise.all([
        webview.listen<{ paths: string[] }>(TauriEvent.DRAG_ENTER, (event) => {
          const first = event.payload.paths[0]
          osDrag = first !== undefined && !isOwnNativeDrag(first)
        }),
        webview.listen<Position>(TauriEvent.DRAG_OVER, (event) => {
          if (osDrag) setOver(overAt(event.payload.position))
        }),
        webview.listen(TauriEvent.DRAG_LEAVE, () => {
          if (osDrag) setOver(null)
        }),
        webview.listen<Position & { paths: string[] }>(
          TauriEvent.DRAG_DROP,
          ({ payload }) => {
            if (!osDrag) return
            osDrag = false
            setOver(null)
            const over = overAt(payload.position)
            if (!over) return
            void pastePathsIntoPane(over.pane, payload.paths).then((ok) => {
              if (!ok) toast.error(t("toasts.dropPathFailed"))
            })
          }
        ),
      ])
      if (disposed) offs.forEach((off) => off())
      else unlisteners.push(...offs)
    })()
    return () => {
      disposed = true
      for (const off of unlisteners.splice(0)) off()
    }
  }, [t])
}
