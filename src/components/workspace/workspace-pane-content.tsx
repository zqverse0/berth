"use client"

import { lazy, Suspense, useEffect, useState } from "react"
import { cn } from "@/lib/utils"
import { useWorkspaceLayoutProjection } from "@/hooks/workspace/use-workspace-layout"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"
import { ConversationDetailPanel } from "@/components/conversations/conversation-detail-panel"
import { FileWorkspaceHeader } from "@/components/files/file-workspace-header"
import { FileWorkspacePanel } from "@/components/files/file-workspace-panel"
import { FileViewerRuntimeProvider } from "@/components/files/file-viewer-runtime"
import { PerfProfiler } from "@/lib/perf/profiler"
import {
  workspaceTabKey,
  type WorkspacePane,
} from "@/lib/workspace/workspace-tab-placement"
import { useAppUiStore } from "@/stores/app-ui-store"

const LazyProjectHome = lazy(() =>
  import("@/components/workspace/project-home/project-home").then((m) => ({
    default: m.ProjectHome,
  }))
)

const MAX_HOSTS = 3

/**
 * Content host for one tab group: shows whatever tab is active in `pane`,
 * whichever collection it comes from, so content follows the tab's placement.
 */
export function WorkspacePaneContent({
  pane,
  hidden = false,
}: {
  pane: WorkspacePane
  /** Another surface (settings) covers this pane. */
  hidden?: boolean
}) {
  const { activeKey, activeFileTabId, paneFileTabIds, otherPaneFileTabIds } =
    useWorkspaceLayoutProjection(({ activeTabByPane, tabsByPane }) => {
      const fileIds = (refs: readonly { kind: string; id: string }[]) =>
        refs
          .filter((tab) => tab.kind === "file")
          .map((tab) => tab.id)
          .join("\n")
      const active = activeTabByPane[pane]
      return {
        activeKey: active ? workspaceTabKey(active) : "",
        activeFileTabId:
          activeTabByPane[pane]?.kind === "file"
            ? activeTabByPane[pane].id
            : null,
        paneFileTabIds: fileIds(tabsByPane[pane]),
        otherPaneFileTabIds: fileIds(
          Object.entries(tabsByPane)
            .filter(([key]) => key !== pane)
            .flatMap(([, refs]) => refs)
        ),
      }
    })
  const storeActiveFileTabId = useWorkspaceFileStore(
    (state) => state.activeFileTabId
  )
  const openFileTabIds = useWorkspaceFileStore((state) =>
    state.fileTabs.map((tab) => tab.id).join("\n")
  )

  // 最近在本组显示过的文件保持挂载（隐藏）：终端 / 设置临时盖住时不丢状态，
  // 切项目再切回来也不用重建编辑器。
  // ponytail: 固定留 MAX_HOSTS 个，内存吃紧再按文档大小淘汰
  const [recentHostIds, setRecentHostIds] = useState<string[]>([])
  if (activeFileTabId && recentHostIds[0] !== activeFileTabId) {
    setRecentHostIds(
      [
        activeFileTabId,
        ...recentHostIds.filter((id) => id !== activeFileTabId),
      ].slice(0, MAX_HOSTS)
    )
  }
  const inPane = new Set(paneFileTabIds.split("\n"))
  const inOtherPane = new Set(otherPaneFileTabIds.split("\n"))
  const open = new Set(openFileTabIds.split("\n"))
  // 本组的 tab 照留；别的项目的 tab 只要还开着、且没被当前项目放进另一组（同一文档不挂两份）
  // 按 id 固定顺序渲染：按最近使用排会让 React 搬动编辑器 DOM（丢滚动、重排）
  const hostIds = recentHostIds
    .filter((id) => inPane.has(id) || (!inOtherPane.has(id) && open.has(id)))
    .sort()
  // 项目首页只在中间左栏：没有 tab 时自动显示；叫出后盖在当时的 tab 上，激活 tab 一变就让位
  const homeOver = useAppUiStore((state) => state.projectHomeOver)
  // 只由左栏判断：右栏 / 辅助面板的激活 tab 不同，若也参与会一叫出就被清掉
  useEffect(() => {
    if (pane === "files" && homeOver !== null && homeOver !== activeKey)
      useAppUiStore.setState({ projectHomeOver: null })
  }, [pane, activeKey, homeOver])
  const showHome =
    pane === "files" && !hidden && (activeKey === "" || homeOver === activeKey)
  const fileVisible = !hidden && !showHome && activeFileTabId !== null
  // Exactly one file panel owns save shortcuts and the document context.
  const fileActive = fileVisible && activeFileTabId === storeActiveFileTabId

  return (
    <div className="relative h-full min-h-0 overflow-hidden">
      {hostIds.map((tabId) => {
        const visible = fileVisible && tabId === activeFileTabId
        return (
          <div
            key={tabId}
            className={cn(
              "h-full w-full flex-col",
              visible ? "flex" : "hidden"
            )}
          >
            <FileViewerRuntimeProvider tabId={tabId}>
              <FileWorkspaceHeader tabId={tabId} />
              {/* flex-1, not h-full: with the header above, h-full overflows by the
                header height and the tail slides under the status bar. */}
              <div className="relative min-h-0 flex-1 overflow-hidden">
                <PerfProfiler id={`file-panel-${pane}`}>
                  <FileWorkspacePanel
                    tabId={tabId}
                    visible={visible}
                    active={visible && fileActive}
                  />
                </PerfProfiler>
              </div>
            </FileViewerRuntimeProvider>
          </div>
        )
      })}
      {/* Primary tabs stack here; only the visible one takes pointer events. */}
      <div className="pointer-events-none absolute inset-0">
        <ConversationDetailPanel pane={pane} />
      </div>
      {showHome && (
        <div className="absolute inset-0 z-10">
          <Suspense fallback={null}>
            <LazyProjectHome />
          </Suspense>
        </div>
      )}
    </div>
  )
}
