"use client"

import { useCallback, type ComponentType } from "react"
import {
  Activity,
  Brain,
  Files,
  FolderGit2,
  FolderKanban,
  ListTodo,
  Users,
} from "lucide-react"
import { useLocale, useTranslations } from "next-intl"
import { create } from "zustand"
import {
  localizedTitle,
  pluginSidebarViewId,
  usePluginViewsStore,
} from "@/lib/plugins/plugin-views"

export type SidebarView =
  | "projects"
  | "files"
  | "git"
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
  labelKey:
    | "projects"
    | "files"
    | "git"
    | "group"
    | "tasks"
    | "memory"
    | "trajectory"
}

export const SIDEBAR_VIEWS: SidebarViewItem[] = [
  { id: "projects", icon: FolderKanban, labelKey: "projects" },
  { id: "files", icon: Files, labelKey: "files" },
  { id: "git", icon: FolderGit2, labelKey: "git" },
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
 * 当前项目面板的标签与收起（界面状态，存本地）。最大化不在这里：侧栏视图为 `files` / `git`
 * 即下方最大化，`projects` 即默认分割——活动栏、命令、文件搜索沿用原来的视图入口。
 */
export const useProjectPanelStore = create<{
  tab: ProjectPanelTab
  collapsed: boolean
  setTab: (tab: ProjectPanelTab) => void
  setCollapsed: (collapsed: boolean) => void
}>((set) => ({
  ...loadPanel(),
  setTab: (tab) => set({ tab }),
  setCollapsed: (collapsed) => set({ collapsed }),
}))

useProjectPanelStore.subscribe(({ tab, collapsed }) => {
  try {
    localStorage.setItem(PANEL_KEY, JSON.stringify({ tab, collapsed }))
  } catch {
    // 存不下只影响重启后的标签
  }
})

/** 下方最大化时的视图：文件标签对应 `files`，Git 各标签对应 `git`。 */
export function panelView(tab: ProjectPanelTab): SidebarView {
  return tab === "files" ? "files" : "git"
}

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
