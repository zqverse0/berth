"use client"

import { useEffect, lazy, Suspense, memo } from "react"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
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
  useSidebarViewLabel,
  useSidebarViewStore,
} from "@/components/layout/sidebar/views"
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

const LazyGitTab = lazy(() =>
  import("@/components/layout/aux-panel/aux-panel-git-tab").then((m) => ({
    default: m.AuxPanelGitTab,
  }))
)
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
  const explorerPane =
    currentView === "projects" || currentView === "files" ? currentView : null
  const projectCount = useAppWorkspaceStore((s) => s.folders.length)
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

  // Command-palette / shortcut file search targets the file pane.
  useEffect(() => {
    if (fileSearchRequest > 0) setView("files")
  }, [fileSearchRequest, setView])

  // 插件视图：插件被停用或删掉后回到项目视图。
  const pluginViews = usePluginViewsStore((s) => s.views)
  const pluginView = currentView.startsWith("plugin:")
    ? pluginViews.find((view) => pluginSidebarViewId(view) === currentView)
    : undefined
  useEffect(() => {
    if (currentView.startsWith("plugin:") && !pluginView) setView("projects")
  }, [currentView, pluginView, setView])

  // A pending file-tree reveal also targets the file pane.
  const pendingRevealPath = useAppUiStore((s) => s.pendingRevealPath)
  useEffect(() => {
    if (pendingRevealPath) setView("files")
  }, [pendingRevealPath, setView])

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
        title={
          <>
            {currentViewLabel}
            {currentView === "projects" && projectCount > 0 ? (
              <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                {projectCount}
              </span>
            ) : null}
          </>
        }
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {/* Desktop hosts the view icons in the window-level ActivityBar so
            they survive a collapsed sidebar; the mobile sheet keeps its own. */}
        {isMobile ? (
          <div className="flex w-12 shrink-0 flex-col items-center justify-between border-r border-border/50 py-2">
            <SidebarViewNav />
            {currentView === "settings" ? <SettingsPageNav /> : null}
          </div>
        ) : null}

        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {explorerPane && (
            <div className="flex flex-col flex-1 min-h-0 overflow-hidden pt-1.5">
              <SidebarProjectList
                pane={explorerPane}
                onOpenFiles={() => setView("files")}
                visible={isOpen}
              />
            </div>
          )}

          {currentView === "git" && (
            <div className="h-full min-h-0 overflow-hidden">
              <Suspense fallback={tabFallback}>
                <LazyGitTab />
              </Suspense>
            </div>
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

          {currentView === "settings" && <SettingsSidebar open={isOpen} />}

          {pluginView && (
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
