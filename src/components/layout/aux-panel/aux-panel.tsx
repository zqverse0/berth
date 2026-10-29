"use client"

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
  memo,
} from "react"
import { Users } from "lucide-react"
import { useAppUiStore } from "@/stores/app-ui-store"
import { useIsMobile } from "@/hooks/use-mobile"
import { usePlatform } from "@/hooks/use-platform"
import { useZoomLevel } from "@/hooks/use-appearance"
import { hasNativeWindowChrome, rightChromeReserve } from "@/lib/window-chrome"
import { cn } from "@/lib/utils"
import { TabBar } from "@/components/tabs/tab-bar"
import { WorkspacePaneContent } from "@/components/workspace/workspace-pane-content"
import { WorkspacePaneDropArea } from "@/components/workspace/workspace-pane-drop-area"
import { useGroupWorkspaceStore } from "@/stores/group-workspace-store"
import { useTranslations } from "next-intl"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store"
import { WorkspaceTabShell } from "@/components/tabs/workspace-tab-shell"
import { AgentLaunchMenu } from "@/components/layout/sidebar/agent-launch"
import { AuxPanelNoFolderEmpty } from "@/components/layout/aux-panel/aux-panel-no-folder-empty"

// 群消息用 Markdown 渲染（streamdown + mermaid + shiki，约 120KB gz），打开群面板时才加载。
const LazyGroupPanel = lazy(() =>
  import("@/components/project-management/berth-tasks/group-panel").then(
    (m) => ({ default: m.GroupPanel })
  )
)

export const AuxPanel = memo(function AuxPanel({
  present,
}: { present?: boolean } = {}) {
  const t = useTranslations("BerthTasks.workspace")
  const tView = useTranslations("Folder.auxPanel.views")
  const emptyMember = useGroupWorkspaceStore((state) => state.emptyMember)
  const isOpen = useAppUiStore((state) => state.auxPanelOpen)
  const view = useAppUiStore((state) => state.auxView)
  const showView = useAppUiStore((state) => state.showAuxView)
  const { activeFolder } = useActiveFolder()
  const folderId = activeFolder?.id ?? null
  // 同一项目里选中 / 新开终端时切到终端视图；切项目只换群，不抢视图。
  const terminalTab = useWorkspaceLayoutStore(
    (state) => state.activeTabByPane.conversation?.id ?? null
  )
  const seenTerminal = useRef({ folderId, terminalTab })
  useEffect(() => {
    const previous = seenTerminal.current
    seenTerminal.current = { folderId, terminalTab }
    if (
      previous.folderId === folderId &&
      previous.terminalTab !== terminalTab &&
      terminalTab &&
      view === "group"
    )
      showView("terminals")
  }, [folderId, terminalTab, view, showView])
  const showTerminals = useCallback(() => showView("terminals"), [showView])
  const isMobile = useIsMobile()
  const { isWindows, isLinux } = usePlatform()
  const { zoomLevel } = useZoomLevel()

  const winLinuxControls = hasNativeWindowChrome() && (isWindows || isLinux)
  // 手机没有右上角悬浮按钮（在标题栏里），不用让位
  const rightReserve = isMobile
    ? 0
    : rightChromeReserve(winLinuxControls, zoomLevel)

  // Once shown, stay mounted (inert) while closed: unmounting would dispose
  // its terminals and lose their screen, mode and scroll state.
  const shown = present ?? isOpen
  const [mounted, setMounted] = useState(shown)
  if (shown && !mounted) setMounted(true)
  if (!mounted) return null

  return (
    <aside
      className={cn(
        "group/aux-panel flex h-full min-h-0 flex-col overflow-hidden text-sidebar-foreground select-none",
        isMobile ? "bg-sidebar" : "",
        !isOpen && "pointer-events-none"
      )}
      aria-hidden={!isOpen || undefined}
      inert={!isOpen || undefined}
    >
      <div className="flex h-10 shrink-0 items-stretch border-b border-border/50 bg-muted ws-transparent-bg">
        <div
          className="flex min-w-0 flex-1 items-stretch"
          onPointerDownCapture={() =>
            useGroupWorkspaceStore.getState().clearEmpty()
          }
        >
          {/* 群组固定在最左、不可关闭；右侧是打开的 Agent / 终端。 */}
          <TabBar
            leadingActive={view === "group"}
            onTabSelected={showTerminals}
            leadingTabs={(tabListMenu) => (
              <div
                role="tablist"
                className="flex shrink-0 items-stretch pl-2 pt-1.5"
              >
                <WorkspaceTabShell
                  dataAttributes={{ "data-aux-group-tab": "" }}
                  active={view === "group"}
                  fit
                  icon={<Users aria-hidden className="size-3.5 shrink-0" />}
                  label={tView("group")}
                  title={tView("group")}
                  closeLabel=""
                  onSelect={() => showView("group")}
                  actions={
                    <>
                      {tabListMenu}
                      <AgentLaunchMenu />
                    </>
                  }
                />
              </div>
            )}
          />
        </div>
        {rightReserve > 0 && (
          <div
            data-tauri-drag-region
            className="h-full shrink-0 ws-strip-line"
            style={{ width: rightReserve }}
          />
        )}
      </div>

      {view === "group" ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          {activeFolder ? (
            <Suspense fallback={null}>
              <LazyGroupPanel
                key={activeFolder.id}
                folderId={activeFolder.id}
              />
            </Suspense>
          ) : (
            <AuxPanelNoFolderEmpty />
          )}
        </div>
      ) : null}
      {/* 终端一直挂载：卸载会丢掉屏幕、模式与滚动状态。 */}
      <WorkspacePaneDropArea
        pane="conversation"
        className={cn(
          "min-h-0 flex-1 overflow-hidden",
          view !== "terminals" && "hidden"
        )}
      >
        <div className={cn("h-full", emptyMember && "hidden")}>
          <WorkspacePaneContent pane="conversation" />
        </div>
        {emptyMember ? (
          <p className="px-4 py-6 text-sm text-muted-foreground">
            {t("noMemberSession", { member: emptyMember })}
          </p>
        ) : null}
      </WorkspacePaneDropArea>
    </aside>
  )
})
