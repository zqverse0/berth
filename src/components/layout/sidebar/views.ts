"use client"

import { useCallback, type ComponentType } from "react"
import {
  Brain,
  Compass,
  Files,
  FolderGit2,
  FolderKanban,
  ListTodo,
  MessagesSquare,
  Users,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { create } from "zustand"

export type SidebarView =
  | "projects"
  | "files"
  | "git"
  | "group"
  | "sessions"
  | "tasks"
  | "memory"
  | "discover"
  /** 设置标签页激活时的列表视图，由活动栏的设置按钮进入。 */
  | "settings"

export interface SidebarViewItem {
  id: SidebarView
  icon: ComponentType<{ className?: string }>
  labelKey:
    | "projects"
    | "files"
    | "git"
    | "group"
    | "sessions"
    | "tasks"
    | "memory"
    | "discover"
}

export const SIDEBAR_VIEWS: SidebarViewItem[] = [
  { id: "projects", icon: FolderKanban, labelKey: "projects" },
  { id: "files", icon: Files, labelKey: "files" },
  { id: "git", icon: FolderGit2, labelKey: "git" },
  { id: "group", icon: Users, labelKey: "group" },
  { id: "sessions", icon: MessagesSquare, labelKey: "sessions" },
  { id: "tasks", icon: ListTodo, labelKey: "tasks" },
  { id: "memory", icon: Brain, labelKey: "memory" },
  { id: "discover", icon: Compass, labelKey: "discover" },
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
  return useCallback(
    (id: SidebarView) => {
      const item = SIDEBAR_VIEWS.find((view) => view.id === id)
      return item ? tTabs(item.labelKey) : t("title")
    },
    [t, tTabs]
  )
}
