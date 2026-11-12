"use client"

import { useEffect, useRef, useState, lazy, Suspense, memo } from "react"
import { useAppUiStore } from "@/stores/app-ui-store"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { SidebarProjectList } from "@/components/conversations/sidebar/sidebar-project-list"
import { useIsMobile } from "@/hooks/use-mobile"
import { usePlatform } from "@/hooks/use-platform"
import { useZoomLevel } from "@/hooks/use-appearance"
import { isDesktop } from "@/lib/platform"
import { leftChromeReserve } from "@/lib/window-chrome"
import { cn } from "@/lib/utils"
import {
  SettingsPageNav,
  SidebarViewNav,
} from "@/components/layout/sidebar/activity-bar"
import {
  useProjectPanelStore,
  useSidebarViewLabel,
  useSidebarViewStore,
} from "@/components/layout/sidebar/views"
import { ProjectPanel } from "@/components/layout/sidebar/project-panel"
import {
  SplitHandle,
  SplitPane,
  SplitView,
  type SplitViewHandle,
} from "@/components/ui/split-view"
import { SidebarHeader } from "@/components/layout/sidebar/sidebar-header"
import {
  pluginSidebarViewId,
  usePluginViewsStore,
} from "@/lib/plugins/plugin-views"
import { AuxPanelNoFolderEmpty } from "@/components/layout/aux-panel/aux-panel-no-folder-empty"
import {
  SettingsSidebar,
  useSettingsTitle,
} from "@/components/settings/settings-sidebar"

const LazyTasksPage = lazy(() =>
  import("@/components/project-management/pages/berth-tasks").then((m) => ({
    default: m.BerthTasksPage,
  }))
)
const LazyGroupPanel = lazy(() =>
  import("@/components/project-management/berth-tasks/group-members-panel").then(
    (m) => ({ default: m.GroupMembersPanel })
  )
)
const LazyTrajectorySidebar = lazy(() =>
  import("@/components/workspace/project-home/trajectory").then((m) => ({
    default: m.TrajectorySidebar,
  }))
)

const LazyMemoryPage = lazy(() =>
  import("@/knowledge/pages/knowledge-sidebar").then((m) => ({
    default: m.KnowledgeSidebar,
  }))
)

const LazyPluginViewPanel = lazy(() =>
  import("@/components/plugins/plugin-view-panel").then((m) => ({
    default: m.PluginViewPanel,
  }))
)
const LazyPluginSidebarPage = lazy(() =>
  import("@/components/plugins/plugin-page-frame").then((m) => ({
    default: m.PluginSidebarPage,
  }))
)

/** 上下分栏：上方项目列表的高度占比（%），存本地。 */
const SPLIT_KEY = "berth.sidebar.projectSplit"
const DEFAULT_TOP = 60
/** 下方最大化时上方只剩一行工作区摘要。 */
const SUMMARY_PX = 30
const MIN_PANE_PX = 96

function loadTopRatio(): number {
  const saved = Number(localStorage.getItem(SPLIT_KEY))
  return saved > 0 && saved < 100 ? saved : DEFAULT_TOP
}

/**
 * 项目视图：上为项目列表，下为当前项目面板。`maximized` 时上方收成一行摘要，
 * 面板收起时整块隐藏（由状态栏项目段展开）；拖动分隔条调整并记住，双击在默认分割与下方最大化间切换。
 */
function ProjectSplit({
  visible,
  maximized,
}: {
  visible: boolean
  maximized: boolean
}) {
  const collapsed = useProjectPanelStore((s) => s.collapsed)
  const setMaximized = useProjectPanelStore((s) => s.setMaximized)
  const splitRef = useRef<SplitViewHandle>(null)
  const topRatio = useRef<number | null>(null)
  topRatio.current ??= loadTopRatio()
  const mode = maximized ? "max" : collapsed ? "collapsed" : "split"
  useEffect(() => {
    const top = topRatio.current ?? DEFAULT_TOP
    splitRef.current?.setLayout(
      mode === "split" ? [top, 100 - top] : mode === "max" ? [0, 100] : [100, 0]
    )
  }, [mode])

  return (
    <div className="h-full min-h-0">
      <SplitView
        ref={splitRef}
        direction="vertical"
        className="h-full"
        onLayout={(layout) => {
          if (mode !== "split" || layout.length !== 2) return
          topRatio.current = layout[0]
          try {
            localStorage.setItem(SPLIT_KEY, String(layout[0]))
          } catch {
            // 存不下只影响重启后的高度
          }
        }}
      >
        <SplitPane
          order={1}
          defaultSize={topRatio.current}
          minSizePx={mode === "split" ? MIN_PANE_PX : 0}
          collapsed={mode === "max"}
          collapsedSizePx={SUMMARY_PX}
        >
          <div className="flex h-full min-h-0 flex-col overflow-hidden pt-1.5">
            <SidebarProjectList
              visible={visible}
              summaryOnly={mode === "max"}
            />
          </div>
        </SplitPane>
        <SplitHandle
          className={mode === "collapsed" ? "hidden" : undefined}
          onDoubleClick={() => setMaximized(!maximized)}
        />
        <SplitPane
          order={2}
          defaultSize={100 - topRatio.current}
          minSizePx={mode === "split" ? MIN_PANE_PX : 0}
          collapsed={mode === "collapsed"}
        >
          <ProjectPanel visible={visible} maximized={maximized} />
        </SplitPane>
      </SplitView>
    </div>
  )
}

const tabFallback = (
  <div className="h-full w-full animate-pulse bg-card/40" aria-hidden="true" />
)

export const Sidebar = memo(function Sidebar() {
  const isOpen = useAppUiStore((state) => state.sidebarOpen)
  const { activeFolder } = useActiveFolder()
  const { isMac: platformIsMac } = usePlatform()
  const { zoomLevel } = useZoomLevel()
  const isMobile = useIsMobile()
  const currentView = useSidebarViewStore((state) => state.view)
  const setView = useSidebarViewStore((state) => state.setView)
  const panelMaximized = useProjectPanelStore((s) => s.maximized)
  const showPanel = useProjectPanelStore((s) => s.showPanel)
  const fileSearchRequest = useAppUiStore((s) => s.projectFileSearchRequest)
  const getViewLabel = useSidebarViewLabel()
  // On desktop the header's top-left is owned by the fixed window-chrome overlay
  // (sidebar toggle + folder); reserve exactly its width so the view
  // controls and drag region clear it. The reserve scales
  // with the app zoom to track the rem-sized overlay buttons. Mobile has no
  // overlay (the sidebar is a Sheet).
  const leftReserve = leftChromeReserve(platformIsMac && isDesktop(), zoomLevel)

  const settingsTitle = useSettingsTitle()
  const currentViewLabel =
    currentView === "settings" ? settingsTitle : getViewLabel(currentView)

  // 命令面板 / 快捷键的文件搜索：回到项目视图，下方面板切到文件
  useEffect(() => {
    if (fileSearchRequest === 0) return
    setView("projects")
    showPanel("files")
  }, [fileSearchRequest, setView, showPanel])

  // 插件视图：插件被停用或删掉后回到项目视图。
  const pluginViews = usePluginViewsStore((s) => s.views)
  const pluginView = currentView.startsWith("plugin:")
    ? pluginViews.find((view) => pluginSidebarViewId(view) === currentView)
    : undefined
  useEffect(() => {
    if (currentView.startsWith("plugin:") && !pluginView) setView("projects")
  }, [currentView, pluginView, setView])
  // 打开过的页面视图保持挂载、切走只隐藏：切回来不用重建 iframe，也不会闪。
  const [visitedPages, setVisitedPages] = useState<readonly string[]>([])
  if (pluginView?.page && !visitedPages.includes(currentView)) {
    setVisitedPages([...visitedPages, currentView])
  }

  // 文件树定位同样只切到文件标签，项目列表留着
  const pendingRevealPath = useAppUiStore((s) => s.pendingRevealPath)
  useEffect(() => {
    if (!pendingRevealPath) return
    setView("projects")
    showPanel("files")
  }, [pendingRevealPath, setView, showPanel])

  // Keep the lightweight project-list shell mounted on desktop so disclosure
  // state survives the slide, but let SidebarProjectList unmount its
  // heavy file-tree child while closed. That boundary is important: a hidden
  // panel must not keep a workspace watcher alive. On mobile the wrapping
  // Sheet already manages mount/unmount, so the early return is preserved.
  if (!isOpen && isMobile) return null

  return (
    <aside
      className={cn(
        "@container/sidebar flex h-full min-h-0 flex-col overflow-hidden text-sidebar-foreground select-none",
        !isOpen && "pointer-events-none invisible"
      )}
      aria-hidden={!isOpen || undefined}
      inert={!isOpen || undefined}
    >
      <SidebarHeader
        mobile={isMobile}
        reserve={leftReserve}
        title={currentViewLabel}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Desktop hosts the view icons in the window-level ActivityBar so
            they survive a collapsed sidebar; the mobile sheet keeps its own. */}
        {isMobile ? (
          <div className="flex w-12 shrink-0 flex-col items-center justify-between border-r border-border/50 py-2">
            <SidebarViewNav />
            <SettingsPageNav />
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {currentView === "projects" && (
            <ProjectSplit visible={isOpen} maximized={panelMaximized} />
          )}

          {currentView === "group" && (
            <div className="flex h-full min-h-0 flex-col overflow-hidden">
              {activeFolder ? (
                <Suspense fallback={tabFallback}>
                  <LazyGroupPanel
                    folderId={activeFolder.id}
                    active={isOpen && currentView === "group"}
                  />
                </Suspense>
              ) : (
                <AuxPanelNoFolderEmpty />
              )}
            </div>
          )}

          {currentView === "tasks" && (
            <div className="h-full min-h-0 overflow-hidden">
              {activeFolder ? (
                <Suspense fallback={tabFallback}>
                  <LazyTasksPage
                    folderId={activeFolder.id}
                    folderPath={activeFolder.path}
                    visible={isOpen && currentView === "tasks"}
                    active={currentView === "tasks"}
                    selectedAgent={activeFolder.default_agent_type ?? "claude"}
                    onSelectAgent={() => {}}
                  />
                </Suspense>
              ) : (
                <AuxPanelNoFolderEmpty />
              )}
            </div>
          )}

          {currentView === "memory" && (
            <div className="h-full min-h-0 overflow-hidden">
              {activeFolder ? (
                <Suspense fallback={tabFallback}>
                  <LazyMemoryPage
                    folderId={activeFolder.id}
                    folderPath={activeFolder.path}
                    active={isOpen && currentView === "memory"}
                  />
                </Suspense>
              ) : (
                <AuxPanelNoFolderEmpty />
              )}
            </div>
          )}

          {currentView === "trajectory" && (
            <div className="h-full min-h-0 overflow-hidden">
              {activeFolder ? (
                <Suspense fallback={tabFallback}>
                  <LazyTrajectorySidebar
                    key={activeFolder.id}
                    folder={activeFolder}
                  />
                </Suspense>
              ) : (
                <AuxPanelNoFolderEmpty />
              )}
            </div>
          )}

          {currentView === "settings" && <SettingsSidebar open={isOpen} />}

          {pluginViews
            .filter(
              (view) =>
                view.page && visitedPages.includes(pluginSidebarViewId(view))
            )
            .map((view) => {
              const id = pluginSidebarViewId(view)
              return (
                <div
                  key={id}
                  hidden={id !== currentView}
                  className="h-full min-h-0 overflow-hidden"
                >
                  <Suspense fallback={tabFallback}>
                    <LazyPluginSidebarPage view={view} />
                  </Suspense>
                </div>
              )
            })}

          {pluginView && !pluginView.page && (
            <div className="h-full min-h-0 overflow-hidden">
              <Suspense fallback={tabFallback}>
                <LazyPluginViewPanel
                  key={currentView}
                  plugin={pluginView.plugin}
                  view={pluginView.id}
                />
              </Suspense>
            </div>
          )}
        </div>
      </div>
    </aside>
  )
})
