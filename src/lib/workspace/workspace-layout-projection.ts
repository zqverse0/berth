import {
  fileTabsForFolderScope,
  tabsForFolderScope,
  type FolderPathEntry,
} from "@/lib/workspace/tab-scope"
import {
  foldEmptySplit,
  hasCrossPanePlacement,
  paneForTab,
  partitionTabsByPane,
  workspaceTabKey,
  type GlobalWorkspaceTab,
  type WorkspacePane,
  type WorkspaceTabPlacement,
  type WorkspaceTabRef,
  type WorkspaceTabsByPane,
} from "@/lib/workspace/workspace-tab-placement"
import {
  reconcileWorkspaceTabOrder,
  type OrderedWorkspaceTab,
} from "@/lib/workspace/workspace-tab-order"
import {
  reconcilePaneActiveTab,
  workspaceTabRefEqual,
} from "@/lib/workspace/workspace-pane-model"
import type { TabItem } from "@/stores/tab-store"
import type { FileWorkspaceTab } from "@/lib/files/file-workspace-tab"
import type { WorkspaceLayoutState } from "@/stores/workspace-layout-store"

export type WorkspaceMode = "conversation" | "fusion"

export interface WorkspaceLayoutProjection extends WorkspaceTabsByPane<
  TabItem,
  FileWorkspaceTab
> {
  mode: WorkspaceMode
  /** The main area is split into a left (`files`) and right (`files-split`) group. */
  splitActive: boolean
  activePane: WorkspacePane
  placement: WorkspaceTabPlacement
  activeWorkspaceTab: WorkspaceTabRef | null
  activeTabByPane: Record<WorkspacePane, WorkspaceTabRef | null>
  tabsByPane: Record<WorkspacePane, WorkspaceTabRef[]>
  orderedTabsByPane: Record<WorkspacePane, WorkspaceTabRef[]>
  orderedWorkspaceTabs: readonly WorkspaceTabRef[]
  globalTabs: readonly GlobalWorkspaceTab[]
  paneForTab: (tab: WorkspaceTabRef) => WorkspacePane
  dragging: WorkspaceTabRef | null
  dragOverPane: WorkspacePane | null
  dragInsertIndex: number | null
}

export interface WorkspaceLayoutProjectionInput {
  primaryTabs: readonly TabItem[]
  rawPrimaryTabs: readonly TabItem[]
  fileTabs: readonly FileWorkspaceTab[]
  activeFolderId: number | null
  allFolders: readonly FolderPathEntry[]
}

const WORKSPACE_PANES: readonly WorkspacePane[] = [
  "conversation",
  "files",
  "files-split",
]

function refsVisible(
  ref: WorkspaceTabRef,
  refs: readonly WorkspaceTabRef[]
): boolean {
  return refs.some(
    (candidate) => workspaceTabKey(candidate) === workspaceTabKey(ref)
  )
}

function activeTabFallback(
  state: WorkspaceLayoutState,
  tabsByPane: Record<WorkspacePane, WorkspaceTabRef[]>
): WorkspaceTabRef | null {
  const remembered = state.activeTabByPane[state.activePane]
  const activePaneTab = reconcilePaneActiveTab(
    remembered,
    tabsByPane[state.activePane]
  )
  if (activePaneTab) return activePaneTab
  for (const pane of WORKSPACE_PANES) {
    const tab = reconcilePaneActiveTab(
      state.activeTabByPane[pane],
      tabsByPane[pane]
    )
    if (tab) return tab
  }
  return null
}

/** Every open tab of the current scope, as layout refs. */
// 投影每次重算都要这批 ref；源 tab 对象没变就复用同一个 ref，tab 条里 memo 的
// TabItem 才不会因为 ref 换了身份而全部重渲染。WeakMap 随 tab 关闭自动回收。
const refByTab = new WeakMap<object, WorkspaceTabRef>()

function internRef(tab: object, build: () => WorkspaceTabRef): WorkspaceTabRef {
  let ref = refByTab.get(tab)
  if (!ref) {
    ref = build()
    refByTab.set(tab, ref)
  }
  return ref
}

export function workspaceTabRefs(
  globalTabs: readonly GlobalWorkspaceTab[],
  primaryTabs: readonly TabItem[],
  fileTabs: readonly FileWorkspaceTab[]
): WorkspaceTabRef[] {
  return [
    ...globalTabs.map((tab) =>
      internRef(tab, () => ({ ...tab, type: "global" as const }))
    ),
    ...primaryTabs.map((tab) =>
      internRef(tab, () => ({
        kind: "primary" as const,
        id: tab.id,
        type: tab.kind,
      }))
    ),
    ...fileTabs.map((tab) =>
      internRef(tab, () => ({
        kind: "file" as const,
        id: tab.id,
        type: tab.kind,
      }))
    ),
  ]
}

export function projectWorkspaceLayout(
  state: WorkspaceLayoutState,
  input: WorkspaceLayoutProjectionInput
): WorkspaceLayoutProjection {
  const visiblePrimaryTabs = tabsForFolderScope(
    input.primaryTabs,
    input.activeFolderId
  )
  const visibleRawPrimaryTabs = tabsForFolderScope(
    input.rawPrimaryTabs,
    input.activeFolderId
  )
  const visibleFileTabs = fileTabsForFolderScope(
    input.fileTabs,
    input.activeFolderId,
    input.allFolders
  )
  const scope = state.placementScope(input.activeFolderId)
  const openRefs = workspaceTabRefs(
    state.globalTabs,
    visiblePrimaryTabs,
    visibleFileTabs
  )
  const placement = foldEmptySplit(
    state.placementByScope[scope] ?? {},
    openRefs
  )
  const crossPanePlacement = hasCrossPanePlacement(
    placement,
    visibleRawPrimaryTabs,
    visibleFileTabs
  )
  const mode: WorkspaceMode =
    visibleFileTabs.length > 0 || crossPanePlacement ? "fusion" : "conversation"

  const projectedTabs = partitionTabsByPane(
    visiblePrimaryTabs,
    visibleFileTabs,
    placement
  )
  const ordered = reconcileWorkspaceTabOrder(
    state.tabOrderByScope[scope] ?? [],
    openRefs
  )
  const tabsByPane: Record<WorkspacePane, WorkspaceTabRef[]> = {
    conversation: [],
    files: [],
    "files-split": [],
  }
  for (const entry of ordered) {
    tabsByPane[paneForTab(entry.ref, placement)].push(entry.ref)
  }

  const splitActive = tabsByPane["files-split"].length > 0
  // After a fold the left group inherits the split's remembered active tab.
  const rememberedActive = (pane: WorkspacePane) =>
    pane === "files" &&
    !splitActive &&
    !tabsByPane.files.some((tab) =>
      workspaceTabRefEqual(tab, state.activeTabByPane.files)
    )
      ? state.activeTabByPane["files-split"]
      : state.activeTabByPane[pane]
  const activeTabByPane = Object.fromEntries(
    WORKSPACE_PANES.map((pane) => [
      pane,
      reconcilePaneActiveTab(rememberedActive(pane), tabsByPane[pane]),
    ])
  ) as Record<WorkspacePane, WorkspaceTabRef | null>
  const activePane =
    !splitActive && state.activePane === "files-split"
      ? "files"
      : state.activePane
  const activeWorkspaceTab = refsVisible(
    state.activeWorkspaceTab ?? { kind: "primary", id: "" },
    openRefs
  )
    ? state.activeWorkspaceTab
    : activeTabFallback({ ...state, activePane, activeTabByPane }, tabsByPane)

  const orderedGlobalTabs: GlobalWorkspaceTab[] = ordered.flatMap(
    (entry: OrderedWorkspaceTab) => {
      if (entry.ref.kind !== "global") return []
      const tab = state.globalTabs.find(
        (candidate) => candidate.id === entry.ref.id
      )
      return tab ? [tab] : []
    }
  )

  return {
    mode,
    splitActive,
    activePane,
    placement,
    activeWorkspaceTab,
    activeTabByPane,
    tabsByPane,
    orderedTabsByPane: tabsByPane,
    orderedWorkspaceTabs: ordered.map((entry) => entry.ref),
    primaryTabsByPane: projectedTabs.primaryTabsByPane,
    fileTabsByPane: projectedTabs.fileTabsByPane,
    globalTabs: orderedGlobalTabs,
    paneForTab: (tab) => paneForTab(tab, placement),
    dragging: state.dragging,
    dragOverPane: state.dragOverPane,
    dragInsertIndex: state.dragInsertIndex,
  }
}
