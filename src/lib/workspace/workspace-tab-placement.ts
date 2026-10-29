import {
  workspaceTabDefinition,
  type WorkspacePane,
  type WorkspaceTabCollection,
  type WorkspaceTabType,
} from "@/lib/workspace/workspace-tab-registry"
import {
  fileTabIsInFolderScope,
  fileTabsForFolderScope,
  primaryTabIsInFolderScope,
  tabsForFolderScope,
  type FolderPathEntry,
  type TabFolderScope,
} from "@/lib/workspace/tab-scope"

export type { WorkspacePane } from "@/lib/workspace/workspace-tab-registry"

/** Feature-owned ids for tabs that are global rather than folder-scoped. */
export type GlobalWorkspaceTabId = string

export interface GlobalWorkspaceTab {
  kind: "global"
  id: GlobalWorkspaceTabId
  type?: "global"
}

export type WorkspaceTabRef =
  | { kind: "primary"; id: string; type?: WorkspaceTabType }
  | { kind: "file"; id: string; type?: WorkspaceTabType }
  | GlobalWorkspaceTab

export type WorkspaceTabPlacement = Record<string, WorkspacePane>

interface WorkspaceTabWithId {
  id: string
  kind?: string
}

interface FolderScopedWorkspaceTab extends WorkspaceTabWithId {
  kind: string
  folderId: TabFolderScope
  path?: string | null
}

export interface WorkspaceTabsByPane<
  TPrimary extends WorkspaceTabWithId,
  TFile extends WorkspaceTabWithId,
> {
  primaryTabsByPane: Record<WorkspacePane, TPrimary[]>
  fileTabsByPane: Record<WorkspacePane, TFile[]>
}

/**
 * Merge a reorder from one pane back into the complete visible list. Tabs in
 * the other pane keep their existing slots, so a display-only move never
 * changes the underlying folder or cross-pane projection order.
 */
export function mergePaneReorder<T extends WorkspaceTabWithId>(
  visibleTabs: readonly T[],
  paneTabs: readonly T[],
  reorderedPaneTabs: readonly T[]
): T[] {
  if (paneTabs.length !== reorderedPaneTabs.length) return [...visibleTabs]

  const paneIds = new Set(paneTabs.map((tab) => tab.id))
  const reorderedIds = new Set(reorderedPaneTabs.map((tab) => tab.id))
  if (
    paneIds.size !== paneTabs.length ||
    reorderedIds.size !== reorderedPaneTabs.length ||
    paneIds.size !== reorderedIds.size ||
    [...paneIds].some((id) => !reorderedIds.has(id))
  ) {
    return [...visibleTabs]
  }

  let reorderedIndex = 0
  return visibleTabs.map((tab) => {
    if (!paneIds.has(tab.id)) return tab
    const replacement = reorderedPaneTabs[reorderedIndex]
    reorderedIndex += 1
    return replacement ?? tab
  })
}

/** Return the stable, kind-qualified key used by a placement map. */
export function workspaceTabKey(tab: WorkspaceTabRef): string {
  return `${tab.kind}:${tab.id}`
}

/** Return the registered pane used only when the tab has no saved placement. */
export function defaultPane(tab: WorkspaceTabRef): WorkspacePane {
  const type =
    tab.type ??
    (tab.kind === "primary"
      ? "terminal"
      : tab.kind === "file"
        ? "file"
        : "global")
  const definition = workspaceTabDefinition(type)
  if (definition.collection !== tab.kind) {
    throw new Error(
      `Workspace tab type ${type} cannot use ${tab.kind} collection`
    )
  }
  return definition.defaultPane
}

/** Resolve a tab's temporary pane without changing either underlying tab store. */
export function paneForTab(
  tab: WorkspaceTabRef,
  placement: Readonly<WorkspaceTabPlacement>
): WorkspacePane {
  return placement[workspaceTabKey(tab)] ?? defaultPane(tab)
}

/**
 * The right split group only exists beside a non-empty left group. Once the
 * left group empties, the split's tabs fold back into it (like VS Code closing
 * an empty editor group). Returns `placement` itself when nothing folds.
 */
export function foldEmptySplit(
  placement: Readonly<WorkspaceTabPlacement>,
  openTabs: readonly WorkspaceTabRef[]
): Readonly<WorkspaceTabPlacement> {
  let left = false
  let right = false
  for (const tab of openTabs) {
    const pane = paneForTab(tab, placement)
    if (pane === "files") left = true
    else if (pane === "files-split") right = true
  }
  if (left || !right) return placement
  const next: WorkspaceTabPlacement = {}
  for (const [key, pane] of Object.entries(placement)) {
    next[key] = pane === "files-split" ? "files" : pane
  }
  // 默认停在右侧的 tab（群组页）没有显式位置：独处时同样并回左侧显示。
  for (const tab of openTabs) {
    const key = workspaceTabKey(tab)
    if (!(key in placement) && defaultPane(tab) === "files-split") {
      next[key] = "files"
    }
  }
  return next
}

/**
 * Partition already scope-filtered tabs into their display panes. The input
 * order is retained independently for primary and file tabs.
 */
export function partitionTabsByPane<
  TPrimary extends WorkspaceTabWithId,
  TFile extends WorkspaceTabWithId,
>(
  primaryTabs: readonly TPrimary[],
  fileTabs: readonly TFile[],
  placement: Readonly<WorkspaceTabPlacement>
): WorkspaceTabsByPane<TPrimary, TFile> {
  const primaryTabsByPane: Record<WorkspacePane, TPrimary[]> = {
    conversation: [],
    files: [],
    "files-split": [],
  }
  const fileTabsByPane: Record<WorkspacePane, TFile[]> = {
    conversation: [],
    files: [],
    "files-split": [],
  }

  for (const tab of primaryTabs) {
    primaryTabsByPane[
      paneForTab(
        { kind: "primary", id: tab.id, type: tab.kind as WorkspaceTabType },
        placement
      )
    ].push(tab)
  }
  for (const tab of fileTabs) {
    fileTabsByPane[
      paneForTab(
        { kind: "file", id: tab.id, type: tab.kind as WorkspaceTabType },
        placement
      )
    ].push(tab)
  }

  return { primaryTabsByPane, fileTabsByPane }
}

/**
 * Merge a reordered visible scope back into the raw tab list. Hidden folder
 * tabs remain in their existing slots, and malformed/stale reorder payloads
 * are rejected without changing the raw collection.
 *
 * Primary and file tabs have different scope rules: primary tabs use their
 * explicit folder id, while legacy file tabs may derive ownership from their
 * path. Keep that distinction here instead of making callers reimplement the
 * folder projection before reordering.
 */
export function mergeVisibleReorder<T extends FolderScopedWorkspaceTab>(
  tabs: readonly T[],
  reorderedVisibleTabs: readonly T[],
  folderId: TabFolderScope,
  collection: Exclude<WorkspaceTabCollection, "global">,
  folders: readonly FolderPathEntry[] = []
): T[] {
  const visibleTabs =
    collection === "primary"
      ? tabsForFolderScope(tabs, folderId)
      : fileTabsForFolderScope(tabs, folderId, folders)
  const isVisible =
    collection === "primary"
      ? (tab: T) => primaryTabIsInFolderScope(tab, folderId)
      : (tab: T) => fileTabIsInFolderScope(tab, folderId, folders)

  if (visibleTabs.length !== reorderedVisibleTabs.length) return [...tabs]

  const visibleIds = new Set(visibleTabs.map((tab) => tab.id))
  const reorderedIds = new Set(reorderedVisibleTabs.map((tab) => tab.id))
  const visibleTabsById = new Map(visibleTabs.map((tab) => [tab.id, tab]))
  if (
    visibleIds.size !== visibleTabs.length ||
    reorderedIds.size !== reorderedVisibleTabs.length ||
    visibleIds.size !== reorderedIds.size ||
    [...visibleIds].some((id) => !reorderedIds.has(id)) ||
    reorderedVisibleTabs.some(
      (tab) => !isVisible(tab) || visibleTabsById.get(tab.id) !== tab
    )
  ) {
    return [...tabs]
  }

  let nextVisibleIndex = 0
  return tabs.map((tab) => {
    if (!isVisible(tab)) return tab
    const replacement = reorderedVisibleTabs[nextVisibleIndex]
    nextVisibleIndex += 1
    const currentTab = replacement
      ? visibleTabsById.get(replacement.id)
      : undefined
    return currentTab ?? tab
  })
}

/**
 * Remove placement entries only for tabs that no longer exist. Tabs hidden by
 * the active-folder projection are deliberately still considered open.
 */
export function removeClosedPlacements(
  placement: Readonly<WorkspaceTabPlacement>,
  primaryTabs: readonly WorkspaceTabWithId[],
  fileTabs: readonly WorkspaceTabWithId[]
): WorkspaceTabPlacement {
  const openKeys = new Set<string>()
  for (const tab of primaryTabs) {
    openKeys.add(workspaceTabKey({ kind: "primary", id: tab.id }))
  }
  for (const tab of fileTabs) {
    openKeys.add(workspaceTabKey({ kind: "file", id: tab.id }))
  }

  const next: WorkspaceTabPlacement = {}
  let changed = false
  for (const [key, pane] of Object.entries(placement)) {
    if (!openKeys.has(key)) {
      changed = true
      continue
    }
    next[key] = pane
  }

  return changed ? next : placement
}

/**
 * Whether the live projection needs both pane geometries even when no file tab
 * is open. Resolve each semantic type through the registry plus saved placement;
 * collection names alone do not imply a pane.
 */
export function hasCrossPanePlacement(
  placement: Readonly<WorkspaceTabPlacement>,
  primaryTabs?: readonly WorkspaceTabWithId[],
  fileTabs?: readonly WorkspaceTabWithId[]
): boolean {
  if (primaryTabs && fileTabs) {
    return (
      primaryTabs.some(
        (tab) =>
          paneForTab(
            {
              kind: "primary",
              id: tab.id,
              type: tab.kind as WorkspaceTabType | undefined,
            },
            placement
          ) !== "conversation"
      ) ||
      fileTabs.some(
        (tab) =>
          paneForTab(
            {
              kind: "file",
              id: tab.id,
              type: tab.kind as WorkspaceTabType | undefined,
            },
            placement
          ) === "conversation"
      )
    )
  }

  return Object.entries(placement).some(([key, pane]) => {
    if (key.startsWith("primary:")) return pane !== "conversation"
    if (key.startsWith("file:")) return pane === "conversation"
    return false
  })
}
