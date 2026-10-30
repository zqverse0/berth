"use client"

import { useCallback, type ComponentType } from "react"
import {
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
  /** 设置标签页激活时的列表视图，由活动栏的设置按钮进入。 */
  | "settings"
  /** 插件贡献的侧栏视图（`plugin:<插件>/<视图>`），由宿主原生渲染。 */
  | `plugin:${string}`

export interface SidebarViewItem {
  id: SidebarView
  icon: ComponentType<{ className?: string }>
  labelKey: "projects" | "files" | "git" | "group" | "tasks" | "memory"
}

export const SIDEBAR_VIEWS: SidebarViewItem[] = [
  { id: "projects", icon: FolderKanban, labelKey: "projects" },
  { id: "files", icon: Files, labelKey: "files" },
  { id: "git", icon: FolderGit2, labelKey: "git" },
  { id: "group", icon: Users, labelKey: "group" },
  { id: "tasks", icon: ListTodo, labelKey: "tasks" },
  { id: "memory", icon: Brain, labelKey: "memory" },
]

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
