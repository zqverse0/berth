"use client"

import { useCallback, type ComponentType } from "react"
import { Activity, Brain, FolderKanban, ListTodo, Users } from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { create } from "zustand"
import {
  localizedTitle,
  pluginSidebarViewId,
  usePluginViewsStore,
} from "@/lib/plugins/plugin-views"

export type SidebarView =
  | "projects"
  | "group"
  | "tasks"
  | "memory"
  /** 今天各 Agent 会话的每一问与工具调用（原首页「Agent 轨迹」） */
  | "trajectory"
  /** 设置标签页激活时的列表视图，由活动栏的设置按钮进入。 */
  | "settings"
  /** 插件贡献的侧栏视图（`plugin:<插件>/<视图>`），由宿主原生渲染。 */
  | `plugin:${string}`

export interface SidebarViewItem {
  id: SidebarView
  icon: ComponentType<{ className?: string }>
  labelKey: "projects" | "group" | "tasks" | "memory" | "trajectory"
}

export const SIDEBAR_VIEWS: SidebarViewItem[] = [
  { id: "projects", icon: FolderKanban, labelKey: "projects" },
  { id: "group", icon: Users, labelKey: "group" },
  { id: "tasks", icon: ListTodo, labelKey: "tasks" },
  { id: "memory", icon: Brain, labelKey: "memory" },
  { id: "trajectory", icon: Activity, labelKey: "trajectory" },
]

/** 侧栏下方「当前项目面板」的标签。 */
export type ProjectPanelTab = "files" | "changes" | "commits" | "branches"

const PANEL_KEY = "berth.sidebar.projectPanel"

function loadPanel(): { tab: ProjectPanelTab; collapsed: boolean } {
  try {
    const saved = JSON.parse(localStorage.getItem(PANEL_KEY) ?? "{}")
    return {
      tab: ["files", "changes", "commits", "branches"].includes(saved.tab)
        ? saved.tab
        : "files",
      collapsed: saved.collapsed === true,
    }
  } catch {
    return { tab: "files", collapsed: false }
  }
}

/**
 * 当前项目面板的标签、收起与最大化（界面状态；标签与收起存本地）。最大化时上方项目列表收成一行。
 */
export const useProjectPanelStore = create<{
  tab: ProjectPanelTab
  collapsed: boolean
  maximized: boolean
  setTab: (tab: ProjectPanelTab) => void
  setCollapsed: (collapsed: boolean) => void
  setMaximized: (maximized: boolean) => void
  /** 展开面板并切到这个标签（命令、文件搜索、文件定位），不改变最大化。 */
  showPanel: (tab: ProjectPanelTab) => void
}>((set) => ({
  ...loadPanel(),
  maximized: false,
  setTab: (tab) => set({ tab }),
  setCollapsed: (collapsed) => set({ collapsed }),
  setMaximized: (maximized) => set({ maximized }),
  showPanel: (tab) => set({ tab, collapsed: false }),
}))

useProjectPanelStore.subscribe(({ tab, collapsed }) => {
  try {
    localStorage.setItem(PANEL_KEY, JSON.stringify({ tab, collapsed }))
  } catch {
    // 存不下只影响重启后的标签
  }
})

/** Current sidebar view; shared by the activity bar and the sidebar body. */
export const useSidebarViewStore = create<{
  view: SidebarView
  setView: (view: SidebarView) => void
}>((set) => ({
  view: "projects",
  setView: (view) => set({ view }),
}))

export function useSidebarViewLabel() {
  const t = useTranslations("Folder.sidebar")
  const tTabs = useTranslations("Folder.auxPanel.tabs")
  const locale = useLocale()
  const pluginViews = usePluginViewsStore((state) => state.views)
  return useCallback(
    (id: SidebarView) => {
      const item = SIDEBAR_VIEWS.find((view) => view.id === id)
      if (item) return tTabs(item.labelKey)
      const plugin = pluginViews.find(
        (view) => pluginSidebarViewId(view) === id
      )
      return plugin ? localizedTitle(plugin.title, locale) : t("title")
    },
    [t, tTabs, locale, pluginViews]
  )
}
