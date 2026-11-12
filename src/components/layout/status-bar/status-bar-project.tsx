"use client"

import { useTranslations } from "next-intl"
import {
  ChevronDown,
  ChevronUp,
  FolderGit2,
  GitBranch,
  Server,
} from "lucide-react"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useSettingsWorkspace } from "@/contexts/settings-workspace-context"
import {
  useProjectPanelStore,
  useSidebarViewStore,
} from "@/components/layout/sidebar/views"
import { parseDeviceFolderId } from "@/lib/transport/device"
import { useAppUiStore } from "@/stores/app-ui-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"

/**
 * 状态栏的项目段，同时是侧栏下方当前项目面板的标题与开关：显示「项目 ⎇ 分支」，点击收起或展开面板。
 * 不在项目视图或侧栏已收起时，点击先回到项目视图再展开，面板收起后这里是唯一的展开入口。
 */
export function StatusBarProject() {
  const t = useTranslations("ProjectPanel")
  const { activeFolder } = useActiveFolder()
  const root = useAppWorkspaceStore((s) =>
    activeFolder?.parent_id == null
      ? null
      : s.allFolders.find((f) => f.id === activeFolder.parent_id)
  )
  const branch = useAppWorkspaceStore((s) =>
    activeFolder
      ? (s.branches.get(activeFolder.id) ?? activeFolder.git_branch ?? null)
      : null
  )
  const sidebarOpen = useAppUiStore((s) => s.sidebarOpen)
  const toggleSidebar = useAppUiStore((s) => s.toggleSidebar)
  const view = useSidebarViewStore((s) => s.view)
  const setView = useSidebarViewStore((s) => s.setView)
  const { collapsed, maximized, setCollapsed, setMaximized } =
    useProjectPanelStore()
  const { isActive: settingsActive, closeSettings } = useSettingsWorkspace()

  const named = root ?? activeFolder
  const name = named ? named.alias || named.name : t("noProject")
  const remote = activeFolder ? parseDeviceFolderId(activeFolder.id) : null
  const shown = sidebarOpen && view === "projects" && (!collapsed || maximized)
  const action = shown ? t("collapse") : t("expand")

  const toggle = () => {
    if (shown) {
      setMaximized(false)
      setCollapsed(true)
      return
    }
    if (!sidebarOpen) toggleSidebar()
    setView("projects")
    setCollapsed(false)
    // 设置是模式：切到别的视图就退出设置。
    if (settingsActive) closeSettings()
  }

  return (
    <button
      type="button"
      className="group flex h-5 min-w-0 max-w-full cursor-pointer items-center justify-center gap-1.5 rounded px-1.5 text-xs text-muted-foreground transition-colors select-none hover:bg-accent hover:text-foreground"
      title={activeFolder ? `${activeFolder.path} · ${action}` : action}
      aria-expanded={shown}
      onClick={toggle}
    >
      {remote ? (
        <Server
          aria-label={t("onDevice")}
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground"
        />
      ) : (
        <FolderGit2
          aria-hidden
          className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-colors group-hover:text-primary"
        />
      )}
      <span className="min-w-0 truncate font-medium text-foreground/90">
        {name}
      </span>
      {branch ? (
        <span className="flex min-w-0 shrink items-center gap-0.5">
          <GitBranch aria-hidden className="size-3 shrink-0" />
          <span className="truncate">{branch}</span>
        </span>
      ) : null}
      {shown ? (
        <ChevronDown aria-hidden className="size-3 shrink-0" />
      ) : (
        <ChevronUp aria-hidden className="size-3 shrink-0" />
      )}
    </button>
  )
}
