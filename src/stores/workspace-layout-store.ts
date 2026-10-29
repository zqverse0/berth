import { create } from "zustand"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabStore, type TabItem } from "@/stores/tab-store"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"
import type { FileWorkspaceTab } from "@/lib/files/file-workspace-tab"
import { workspaceTabRefEqual } from "@/lib/workspace/workspace-pane-model"
import {
  fileTabsForFolderScope,
  tabsForFolderScope,
  type FolderPathEntry,
} from "@/lib/workspace/tab-scope"
import {
  defaultPane,
  foldEmptySplit,
  paneForTab,
  removeClosedPlacements,
  workspaceTabKey,
  type GlobalWorkspaceTab,
  type GlobalWorkspaceTabId,
  type WorkspacePane,
  type WorkspaceTabPlacement,
  type WorkspaceTabRef,
} from "@/lib/workspace/workspace-tab-placement"
import {
  loadWorkspaceTabOrderState,
  mergeWorkspacePaneOrder,
  WORKSPACE_TAB_ORDER_STATE_KEY,
  type WorkspaceTabOrderByScope,
} from "@/lib/workspace/workspace-tab-order"
import {
  loadWorkspaceTabPlacementState,
  serializeWorkspaceTabPlacementState,
  workspacePlacementScope,
  WORKSPACE_TAB_PLACEMENT_STATE_KEY,
  type WorkspaceTabPlacementByScope,
} from "@/lib/workspace/workspace-tab-placement-persistence"
import {
  projectWorkspaceLayout,
  workspaceTabRefs,
} from "@/lib/workspace/workspace-layout-projection"
import { registerBackendScopedStoreReset } from "@/stores/backend-scoped-store-reset"
import { orderAfterDrop } from "@/lib/workspace/workspace-tab-drop"

export interface WorkspaceLayoutState {
  activePane: WorkspacePane
  placementByScope: WorkspaceTabPlacementByScope
  tabOrderByScope: WorkspaceTabOrderByScope
  activeWorkspaceTab: WorkspaceTabRef | null
  globalTabReturn: WorkspaceTabRef | null
  activeTabByPane: Record<WorkspacePane, WorkspaceTabRef | null>
  globalTabs: GlobalWorkspaceTab[]
  dragging: WorkspaceTabRef | null
  /** Drop target of the tab being dragged. */
  dragOverPane: WorkspacePane | null
  /** Gap position in the target pane's strip; null = its content area. */
  dragInsertIndex: number | null

  placementScope: (folderId: number | null) => string
  setActivePane: (pane: WorkspacePane) => void
  activateConversationPane: (preserveGlobalTab?: boolean) => void
  activateFilePane: () => void
  activateFileTab: (tabId: string) => boolean
  /** 只应用布局侧副作用：文件域激活已由 runtime 完成（经注入回调执行）。 */
  adoptFileActivation: (tabId: string) => boolean
  /** 收敛 folder 切换后的选中 Tab，不改动 activePane。 */
  adoptFolderSelection: (folderId: number | null, tab: WorkspaceTabRef) => void
  selectWorkspaceTab: (tab: WorkspaceTabRef) => void
  openGlobalTab: (id: GlobalWorkspaceTabId) => void
  closeGlobalTab: (id: GlobalWorkspaceTabId) => void
  reorderWorkspaceTabs: (pane: WorkspacePane, tabs: WorkspaceTabRef[]) => void
  moveWorkspaceTab: (tab: WorkspaceTabRef, pane: WorkspacePane) => void
  beginWorkspaceTabDrag: (
    tab: WorkspaceTabRef,
    pane: WorkspacePane,
    index: number
  ) => void
  setWorkspaceTabDragOver: (
    pane: WorkspacePane | null,
    index?: number | null
  ) => void
  endWorkspaceTabDrag: () => void
  /** Move `tab` into `pane` at strip position `index` (null = append) and select it. */
  dropWorkspaceTab: (
    tab: WorkspaceTabRef,
    pane: WorkspacePane,
    index: number | null
  ) => void
  pruneClosedPlacements: (
    primaryTabs: readonly TabItem[],
    fileTabs: readonly { id: string }[]
  ) => void
  reset: () => void
}

const EMPTY_PLACEMENT: WorkspaceTabPlacement = {}
const DEFAULT_ACTIVE_TABS: Record<WorkspacePane, WorkspaceTabRef | null> = {
  conversation: null,
  files: null,
  "files-split": null,
}

function persistPlacement(scopes: WorkspaceTabPlacementByScope): void {
  try {
    window.localStorage.setItem(
      WORKSPACE_TAB_PLACEMENT_STATE_KEY,
      serializeWorkspaceTabPlacementState(scopes)
    )
  } catch {
    // 布局持久化失败时保留本次运行内存态。
  }
}

function persistOrder(scopes: WorkspaceTabOrderByScope): void {
  try {
    window.localStorage.setItem(
      WORKSPACE_TAB_ORDER_STATE_KEY,
      JSON.stringify(scopes)
    )
  } catch {
    // 顺序持久化失败时保留本次运行内存态。
  }
}

function currentFolderId(): number | null {
  return useAppWorkspaceStore.getState().activeFolderId
}

function currentFolders(): readonly FolderPathEntry[] {
  return useAppWorkspaceStore.getState().allFolders
}

function currentRefs(
  state: WorkspaceLayoutState,
  folderId: number | null = currentFolderId()
): WorkspaceTabRef[] {
  return workspaceTabRefs(
    state.globalTabs,
    tabsForFolderScope(useTabStore.getState().rawTabs, folderId),
    fileTabsForFolderScope(
      useWorkspaceFileStore.getState().fileTabs,
      folderId,
      currentFolders()
    )
  )
}

/** The scope's placement as rendered: an orphaned split folds into `files`. */
function scopePlacement(
  state: WorkspaceLayoutState,
  folderId: number | null = currentFolderId()
): Readonly<WorkspaceTabPlacement> {
  return foldEmptySplit(
    state.placementByScope[state.placementScope(folderId)] ?? EMPTY_PLACEMENT,
    currentRefs(state, folderId)
  )
}

function isVisibleTab(
  state: WorkspaceLayoutState,
  tab: WorkspaceTabRef
): boolean {
  return currentRefs(state).some(
    (candidate) => workspaceTabKey(candidate) === workspaceTabKey(tab)
  )
}

function setSelectedTab(
  set: (
    updater: (state: WorkspaceLayoutState) => Partial<WorkspaceLayoutState>
  ) => void,
  state: WorkspaceLayoutState,
  tab: WorkspaceTabRef
): void {
  const pane = paneForTab(tab, scopePlacement(state))
  set((current) => ({
    activeWorkspaceTab: tab,
    activePane: pane,
    activeTabByPane: { ...current.activeTabByPane, [pane]: tab },
  }))
}

function currentProjection(state: WorkspaceLayoutState) {
  return projectWorkspaceLayout(state, {
    primaryTabs: useTabStore.getState().tabs,
    rawPrimaryTabs: useTabStore.getState().rawTabs,
    fileTabs: useWorkspaceFileStore.getState().fileTabs,
    activeFolderId: currentFolderId(),
    allFolders: currentFolders(),
  })
}

/** 文件域激活依赖的唯一入参；语义实现在 workspace-file-runtime。 */
export interface WorkspaceLayoutFileActivatorInput {
  tabId: string
  scope: number | null
  folders: readonly FolderPathEntry[]
}

let fileTabActivator:
  | ((input: WorkspaceLayoutFileActivatorInput) => boolean)
  | null = null

/**
 * 注入文件域激活依赖（design §2.1 单向分层）。
 * 由 workspace-runtime 模块初始化时注册，使本 store 保持无 React、
 * 无 runtime 反向 import；传 null 可在测试中解绑。
 */
export function configureWorkspaceLayoutFileActivator(
  activate: ((input: WorkspaceLayoutFileActivatorInput) => boolean) | null
): void {
  fileTabActivator = activate
}

/** 激活的布局侧副作用：globalTabReturn 记忆与选中态收敛。 */
function applyFileActivationEffects(
  set: (
    next:
      | Partial<WorkspaceLayoutState>
      | ((state: WorkspaceLayoutState) => Partial<WorkspaceLayoutState>)
  ) => void,
  get: () => WorkspaceLayoutState,
  tab: FileWorkspaceTab,
  tabId: string
): boolean {
  if (get().activeWorkspaceTab?.kind === "global") {
    set({
      globalTabReturn: {
        kind: "file",
        id: tabId,
        type: tab.kind,
      },
    })
  }
  setSelectedTab(set, get(), {
    kind: "file",
    id: tabId,
    type: tab.kind,
  })
  return true
}

export function createInitialWorkspaceLayoutState(): Pick<
  WorkspaceLayoutState,
  | "activePane"
  | "placementByScope"
  | "tabOrderByScope"
  | "activeWorkspaceTab"
  | "globalTabReturn"
  | "activeTabByPane"
  | "globalTabs"
  | "dragging"
  | "dragOverPane"
  | "dragInsertIndex"
> {
  return {
    activePane: "conversation",
    placementByScope: loadWorkspaceTabPlacementState(),
    tabOrderByScope: loadWorkspaceTabOrderState(),
    activeWorkspaceTab: null,
    globalTabReturn: null,
    activeTabByPane: { ...DEFAULT_ACTIVE_TABS },
    globalTabs: [],
    dragging: null,
    dragOverPane: null,
    dragInsertIndex: null,
  }
}

export const useWorkspaceLayoutStore = create<WorkspaceLayoutState>()(
  (set, get) => ({
    ...createInitialWorkspaceLayoutState(),

    placementScope: workspacePlacementScope,

    setActivePane: (pane) => {
      if (get().activePane === pane) return
      set({ activePane: pane })
    },

    activateConversationPane: (preserveGlobalTab = false) => {
      const state = get()
      const activePrimary = useTabStore
        .getState()
        .rawTabs.find((tab) => tab.id === useTabStore.getState().activeTabId)
      const nextTab = activePrimary
        ? ({
            kind: "primary",
            id: activePrimary.id,
            type: activePrimary.kind,
          } as const)
        : null
      if (state.activeWorkspaceTab?.kind === "global") {
        set({ globalTabReturn: nextTab })
        if (preserveGlobalTab) return
      }
      set((current) => {
        const pane = nextTab
          ? paneForTab(nextTab, scopePlacement(current))
          : "conversation"
        return {
          activeWorkspaceTab: nextTab,
          globalTabReturn: null,
          activePane: pane,
          activeTabByPane: nextTab
            ? { ...current.activeTabByPane, [pane]: nextTab }
            : current.activeTabByPane,
        }
      })
    },

    activateFilePane: () => set({ activePane: "files" }),

    activateFileTab: (tabId) => {
      if (!fileTabActivator) return false
      const activated = fileTabActivator({
        tabId,
        scope: currentFolderId(),
        folders: currentFolders(),
      })
      if (!activated) return false
      const tab = useWorkspaceFileStore
        .getState()
        .fileTabs.find((candidate) => candidate.id === tabId)
      if (!tab) return false
      return applyFileActivationEffects(set, get, tab, tabId)
    },

    adoptFileActivation: (tabId) => {
      const tab = useWorkspaceFileStore
        .getState()
        .fileTabs.find((candidate) => candidate.id === tabId)
      if (!tab) return false
      return applyFileActivationEffects(set, get, tab, tabId)
    },

    adoptFolderSelection: (folderId, tab) => {
      const pane = paneForTab(tab, scopePlacement(get(), folderId))
      set((current) => ({
        activeWorkspaceTab: tab,
        activeTabByPane: workspaceTabRefEqual(
          current.activeTabByPane[pane],
          tab
        )
          ? current.activeTabByPane
          : { ...current.activeTabByPane, [pane]: tab },
      }))
    },

    selectWorkspaceTab: (tab) => {
      const state = get()
      if (!isVisibleTab(state, tab)) return
      if (tab.kind === "global") {
        set({
          globalTabReturn:
            state.activeWorkspaceTab?.kind === "global"
              ? state.globalTabReturn
              : state.activeWorkspaceTab,
        })
        setSelectedTab(set, state, tab)
        return
      }
      if (state.activeWorkspaceTab?.kind === "global") {
        set({ globalTabReturn: tab })
      }
      if (tab.kind === "primary") {
        useTabStore.getState().switchTab(tab.id)
        setSelectedTab(set, get(), tab)
      } else {
        get().activateFileTab(tab.id)
      }
    },

    openGlobalTab: (id) => {
      const nextTab: GlobalWorkspaceTab = { kind: "global", id }
      set((state) => ({
        globalTabs: state.globalTabs.some((tab) => tab.id === id)
          ? state.globalTabs
          : [...state.globalTabs, nextTab],
        globalTabReturn:
          state.activeWorkspaceTab?.kind === "global"
            ? state.globalTabReturn
            : state.activeWorkspaceTab,
        activeWorkspaceTab: nextTab,
        activeTabByPane: { ...state.activeTabByPane, files: nextTab },
        activePane: "files",
      }))
    },

    closeGlobalTab: (id) => {
      const state = get()
      const nextTabs = state.globalTabs.filter((tab) => tab.id !== id)
      if (nextTabs.length === state.globalTabs.length) return
      set({ globalTabs: nextTabs })
      if (
        state.activeWorkspaceTab?.kind !== "global" ||
        state.activeWorkspaceTab.id !== id
      ) {
        return
      }
      const fallback = state.globalTabReturn
      set({ globalTabReturn: null })
      if (fallback && isVisibleTab(get(), fallback)) {
        get().selectWorkspaceTab(fallback)
      } else {
        get().activateFilePane()
      }
    },

    reorderWorkspaceTabs: (pane, tabs) => {
      const state = get()
      const projection = currentProjection(state)
      const allRefs = [...projection.orderedWorkspaceTabs]
      const current = projection.tabsByPane[pane].filter(
        (ref) => ref.kind !== "global"
      )
      const merged = mergeWorkspacePaneOrder(allRefs, current, tabs)
      const scope = state.placementScope(currentFolderId())
      const next = {
        ...state.tabOrderByScope,
        [scope]: merged.map(workspaceTabKey),
      }
      set({ tabOrderByScope: next })
      persistOrder(next)
    },

    moveWorkspaceTab: (tab, nextPane) => {
      const state = get()
      if (tab.kind === "global" || !isVisibleTab(state, tab)) return
      const scope = state.placementScope(currentFolderId())
      const previous = state.placementByScope[scope] ?? EMPTY_PLACEMENT
      const key = workspaceTabKey(tab)
      const nextPlacement = { ...previous }
      if (nextPane === defaultPane(tab)) delete nextPlacement[key]
      else nextPlacement[key] = nextPane
      const nextByScope = { ...state.placementByScope }
      if (Object.keys(nextPlacement).length === 0) delete nextByScope[scope]
      else nextByScope[scope] = nextPlacement
      set({ placementByScope: nextByScope })
      persistPlacement(nextByScope)

      if (tab.kind === "primary") {
        useTabStore.getState().switchTab(tab.id)
      } else {
        get().activateFileTab(tab.id)
      }
      set((current) => ({
        activeWorkspaceTab: tab,
        activePane: nextPane,
        activeTabByPane: { ...current.activeTabByPane, [nextPane]: tab },
      }))
    },

    beginWorkspaceTabDrag: (tab, pane, index) => {
      if (tab.kind === "global" || !isVisibleTab(get(), tab)) return
      set({ dragging: tab, dragOverPane: pane, dragInsertIndex: index })
    },

    setWorkspaceTabDragOver: (pane, index = null) => {
      const state = get()
      if (state.dragOverPane === pane && state.dragInsertIndex === index) return
      set({ dragOverPane: pane, dragInsertIndex: pane ? index : null })
    },

    endWorkspaceTabDrag: () =>
      set({ dragging: null, dragOverPane: null, dragInsertIndex: null }),

    dropWorkspaceTab: (tab, pane, index) => {
      if (tab.kind === "global" || !isVisibleTab(get(), tab)) return
      if (currentProjection(get()).paneForTab(tab) === pane) {
        get().selectWorkspaceTab(tab)
      } else {
        get().moveWorkspaceTab(tab, pane)
      }
      const paneTabs = currentProjection(get()).tabsByPane[pane].filter(
        (ref) => ref.kind !== "global"
      )
      get().reorderWorkspaceTabs(pane, orderAfterDrop(paneTabs, tab, index))
    },

    pruneClosedPlacements: (primaryTabs, fileTabs) => {
      set((state) => {
        const scope = state.placementScope(currentFolderId())
        const current = state.placementByScope[scope] ?? EMPTY_PLACEMENT
        const next = removeClosedPlacements(current, primaryTabs, fileTabs)
        if (next === current) return state
        const placementByScope = { ...state.placementByScope }
        if (Object.keys(next).length === 0) delete placementByScope[scope]
        else placementByScope[scope] = next
        persistPlacement(placementByScope)
        return { placementByScope }
      })
    },

    reset: () => set(createInitialWorkspaceLayoutState()),
  })
)

export function resetWorkspaceLayoutStore(): void {
  useWorkspaceLayoutStore.getState().reset()
}

export function workspacePlacementForFolder(
  folderId: number | null
): WorkspaceTabPlacement {
  return (
    useWorkspaceLayoutStore.getState().placementByScope[
      workspacePlacementScope(folderId)
    ] ?? EMPTY_PLACEMENT
  )
}

registerBackendScopedStoreReset(resetWorkspaceLayoutStore)

/**
 * Persist a split fold once the left group empties, so the next tab opened on
 * the left doesn't resurrect the old split. Waits for primary-tab hydration:
 * a half-restored tab list would look like an empty left group.
 */
export function persistSplitFold(): void {
  const tabState = useTabStore.getState()
  if (!tabState.tabsHydrated || !tabState.terminalInventoryHasSnapshot) return
  const state = useWorkspaceLayoutStore.getState()
  const scope = state.placementScope(currentFolderId())
  const raw = state.placementByScope[scope]
  if (!raw) return
  // 只写回原有的显式位置：默认停在右侧的 tab（群组页）独处时的并回只用于显示，
  // 写死成左侧后再打开文件，群组就回不到右侧了。
  const folded = Object.fromEntries(
    Object.entries(foldEmptySplit(raw, currentRefs(state))).filter(
      ([key]) => key in raw
    )
  )
  if (Object.entries(folded).every(([key, pane]) => raw[key] === pane)) return
  const placementByScope = { ...state.placementByScope, [scope]: folded }
  useWorkspaceLayoutStore.setState({ placementByScope })
  persistPlacement(placementByScope)
}
