import { findOwningFolder } from "@/lib/files/file-open-target"

export type TabFolderScope = number | null

interface FolderScopedTab {
  kind: string
  folderId: number | null
  isPinned?: boolean
}

export interface FolderPathEntry {
  id: number
  path: string
}

interface FolderScopedFileTab {
  id: string
  kind?: string
  folderId: number | null
  path?: string | null
  lifetime?: "global" | "project"
  openedInFolderId?: number | null
}

/**
 * Resolve the scope of a file tab. Older file tabs intentionally have a null
 * folderId because their identity is an absolute path; derive their owning
 * folder here so they participate in folder scoping without mutating their
 * dirty/editor state during a folder switch.
 *
 * Never use this to decide whether a tab is VISIBLE on its own: a null
 * result can mean a folderless ad-hoc file (visible only in the null
 * scope). Global config tabs use `lifetime: "global"` and are decided by
 * `fileTabIsInFolderScope`.
 */
export function fileTabFolderScope(
  tab: FolderScopedFileTab,
  folders: readonly FolderPathEntry[]
): TabFolderScope {
  if (tab.folderId != null) return tab.folderId
  if (!tab.path) return null
  return findOwningFolder(tab.path, folders)?.folderId ?? null
}

/**
 * 钉住（lifetime: "global"）的 tab 在所有项目显示；其余只在文件所属的项目显示，
 * 与在哪个项目打开无关。不属于任何项目的文件显示在打开它的项目。
 */
export function fileTabIsInFolderScope(
  tab: FolderScopedFileTab,
  folderId: TabFolderScope,
  folders: readonly FolderPathEntry[] = []
): boolean {
  if (tab.lifetime === "global") return true
  const owner = fileTabFolderScope(tab, folders)
  if (owner != null) return owner === folderId
  return (tab.openedInFolderId ?? null) === folderId
}

/**
 * 判断 primary tab 是否属于当前文件夹的显示 scope。
 *
 * 只有钉住的 tab 全局显示；其余只在自己的项目显示，不串到别的项目。
 * 无项目终端（本机 / 设备下的）只在无项目 scope 显示，打开时会离开当前项目。
 */
export function primaryTabIsInFolderScope(
  tab: FolderScopedTab,
  folderId: TabFolderScope
): boolean {
  if (tab.isPinned === true) return true
  return tab.folderId === folderId
}

/** pinned tab 全局显示，其余按项目过滤。 */
export function tabsForFolderScope<T extends FolderScopedTab>(
  tabs: readonly T[],
  folderId: TabFolderScope
): T[] {
  return tabs.filter((tab) => primaryTabIsInFolderScope(tab, folderId))
}

/**
 * Sort a folder's visible tabs: pinned (global) tabs first, then the rest in
 * their existing order.
 */
export function sortFolderTabs<T extends FolderScopedTab>(
  tabs: readonly T[]
): T[] {
  return [...tabs].sort((a, b) => {
    const rank = (tab: FolderScopedTab) => (tab.isPinned === true ? 0 : 1)
    return rank(a) - rank(b)
  })
}

/**
 * 当前项目可见的文件 tab：钉住的 tab 加上在本项目打开的 tab（规则见
 * `fileTabIsInFolderScope`）。
 */
export function fileTabsForFolderScope<T extends FolderScopedFileTab>(
  tabs: readonly T[],
  folderId: TabFolderScope,
  folders: readonly FolderPathEntry[] = []
): T[] {
  return tabs.filter((tab) => fileTabIsInFolderScope(tab, folderId, folders))
}

/**
 * Merge a reordered visible file-tab subset back into the complete tab list.
 * A stale or malformed reorder payload is rejected rather than deleting tabs.
 */
export function mergeFileTabsForFolderScope<T extends FolderScopedFileTab>(
  tabs: readonly T[],
  reorderedVisibleTabs: readonly T[],
  folderId: TabFolderScope,
  folders: readonly FolderPathEntry[] = []
): T[] {
  const visibleTabs = fileTabsForFolderScope(tabs, folderId, folders)
  if (visibleTabs.length !== reorderedVisibleTabs.length) return [...tabs]

  const visibleIds = new Set(visibleTabs.map((tab) => tab.id))
  const reorderedIds = new Set(reorderedVisibleTabs.map((tab) => tab.id))
  if (
    visibleIds.size !== visibleTabs.length ||
    reorderedIds.size !== reorderedVisibleTabs.length ||
    visibleIds.size !== reorderedIds.size ||
    [...visibleIds].some((id) => !reorderedIds.has(id))
  ) {
    return [...tabs]
  }

  let nextVisibleIndex = 0
  return tabs.map((tab) => {
    if (!fileTabIsInFolderScope(tab, folderId, folders)) return tab
    const replacement = reorderedVisibleTabs[nextVisibleIndex]
    nextVisibleIndex += 1
    return replacement ?? tab
  })
}
