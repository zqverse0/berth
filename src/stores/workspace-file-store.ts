import { create } from "zustand"
import { registerBackendScopedStoreReset } from "@/stores/backend-scoped-store-reset"
import type { FileWorkspaceTab } from "@/lib/files/file-workspace-tab"
import type { WorkspaceExternalConflict } from "@/lib/workspace/workspace-file-runtime"
import type { WorkspaceOpenFileOutcome } from "@/lib/api"
import { normalizeAbsPath } from "@/lib/files/file-open-target"

export type WorkspaceFileTabUpdater =
  | FileWorkspaceTab[]
  | ((previous: FileWorkspaceTab[]) => FileWorkspaceTab[])
export type WorkspacePreviewTabUpdater =
  | ReadonlySet<string>
  | ((previous: ReadonlySet<string>) => ReadonlySet<string>)

export interface PendingFileReveal {
  requestId: number
  path: string
  line: number | null
  page: number | null
  /** 为 false 时加载仍在进行，不能消费同路径的旧缓冲。 */
  ready?: boolean
  /** 仅此请求的完成回调；清槽或替换只能取消，不能证明打开成功。 */
  onComplete?: (outcome: WorkspaceOpenFileOutcome) => void
}

export type PendingFileRevealUpdater =
  | PendingFileReveal
  | null
  | ((previous: PendingFileReveal | null) => PendingFileReveal | null)

export type WorkspaceFileTabIdByScope = Readonly<Record<string, string>>
export type WorkspaceFileZoomByTab = Readonly<Record<string, number>>

export interface WorkspaceFileStoreState {
  /** 所有已打开的文件阅读器 Tab，包括当前项目隐藏的 Tab。 */
  fileTabs: FileWorkspaceTab[]
  /** 当前文件夹作用域中的活动 Tab。 */
  activeFileTabId: string | null
  /** 每个文件夹作用域最后活动的 Tab，键为字符串形式的文件夹 id。 */
  activeTabIdByScope: WorkspaceFileTabIdByScope
  /** Source-preview mode is UI state for a file surface, keyed by tab id. */
  previewFileTabIds: ReadonlySet<string>
  /** 处于编辑模式的文本 tab；不在集合里 = 阅读模式（只读，防误触）。不持久化。 */
  editingFileTabIds: ReadonlySet<string>
  /** 在别的项目里打开、还没看过的 tab（绿色状态点）；激活一次即移除。不持久化。 */
  unseenFileTabIds: ReadonlySet<string>
  /** Text reader zoom percentage, keyed by tab id. Missing entries mean 100%. */
  fileZoomByTab: WorkspaceFileZoomByTab
  pendingFileReveal: PendingFileReveal | null
  /** FIFO disk-vs-buffer conflicts; owned by the workspace file store. */
  externalConflictQueue: WorkspaceExternalConflict[]
  externalConflictSignatures: Readonly<Record<string, string>>

  setFileTabs: (tabs: WorkspaceFileTabUpdater) => void
  setActiveFileTabId: (
    tabId: string | null | ((previous: string | null) => string | null)
  ) => void
  insertFileTab: (tab: FileWorkspaceTab) => void
  rememberActiveTab: (scope: number | null, tabId: string) => void
  /** Toggle a file tab between global (all projects) and project-scoped. */
  /** 钉住 / 取消钉住；取消后回到文件所属项目，不属于任何项目的留在当前 `scope`。 */
  toggleFileTabGlobal: (tabId: string, scope: number | null) => void
  toggleFileTabPreview: (tabId: string) => void
  /** 阅读 / 编辑切换；editing 省略 = 取反 */
  setFileTabEditing: (tabId: string, editing?: boolean) => void
  setFileTabUnseen: (tabId: string, unseen: boolean) => void
  setPreviewFileTabIds: (update: WorkspacePreviewTabUpdater) => void
  setFileZoom: (tabId: string, zoom: number) => void
  setPendingFileReveal: (update: PendingFileRevealUpdater) => void
  consumePendingFileReveal: (
    requestId: number,
    outcome?: WorkspaceOpenFileOutcome
  ) => void
  enqueueExternalConflict: (
    conflict: WorkspaceExternalConflict,
    options?: { force?: boolean }
  ) => void
  dequeueExternalConflict: (options?: {
    clearSignature?: boolean
  }) => WorkspaceExternalConflict | null
  clearExternalConflictsForPath: (path: string) => void
  restoreFileTabs: (input: {
    tabs: FileWorkspaceTab[]
    activeTabId: string | null
    activeTabIdByScope: WorkspaceFileTabIdByScope
  }) => void
  reset: () => void
}

function scopeKey(scope: number | null): string {
  return scope == null ? "none" : String(scope)
}

export function createInitialWorkspaceFileStoreState(): Pick<
  WorkspaceFileStoreState,
  | "fileTabs"
  | "activeFileTabId"
  | "activeTabIdByScope"
  | "previewFileTabIds"
  | "editingFileTabIds"
  | "unseenFileTabIds"
  | "fileZoomByTab"
  | "pendingFileReveal"
  | "externalConflictQueue"
  | "externalConflictSignatures"
> {
  return {
    fileTabs: [],
    activeFileTabId: null,
    activeTabIdByScope: {},
    previewFileTabIds: new Set<string>(),
    editingFileTabIds: new Set<string>(),
    unseenFileTabIds: new Set<string>(),
    fileZoomByTab: {},
    pendingFileReveal: null,
    externalConflictQueue: [],
    externalConflictSignatures: {},
  }
}

export const useWorkspaceFileStore = create<WorkspaceFileStoreState>()(
  (set, get) => ({
    ...createInitialWorkspaceFileStoreState(),

    setFileTabs: (tabs) => {
      set((state) => {
        const nextTabs =
          typeof tabs === "function" ? tabs(state.fileTabs) : tabs
        return nextTabs === state.fileTabs ? state : { fileTabs: nextTabs }
      })
    },

    setActiveFileTabId: (tabId) => {
      set((state) => {
        const nextId =
          typeof tabId === "function" ? tabId(state.activeFileTabId) : tabId
        return nextId === state.activeFileTabId
          ? state
          : { activeFileTabId: nextId }
      })
    },

    insertFileTab: (tab) => {
      set((state) =>
        state.fileTabs.some((candidate) => candidate.id === tab.id)
          ? state
          : { fileTabs: [...state.fileTabs, tab] }
      )
    },

    rememberActiveTab: (scope, tabId) => {
      set((state) => {
        const key = scopeKey(scope)
        if (state.activeTabIdByScope[key] === tabId) return state
        return {
          activeTabIdByScope: { ...state.activeTabIdByScope, [key]: tabId },
        }
      })
    },

    toggleFileTabGlobal: (tabId, scope) => {
      set((state) => {
        const index = state.fileTabs.findIndex((tab) => tab.id === tabId)
        if (index < 0) return { fileTabs: state.fileTabs }
        const target = state.fileTabs[index]
        const nextLifetime: "global" | "project" =
          target.lifetime === "global" ? "project" : "global"
        return {
          fileTabs: state.fileTabs.map((tab, i) =>
            i !== index
              ? tab
              : nextLifetime === "global"
                ? { ...tab, lifetime: nextLifetime }
                : { ...tab, lifetime: nextLifetime, openedInFolderId: scope }
          ),
        }
      })
    },

    setFileTabUnseen: (tabId, unseen) => {
      set((state) => {
        if (state.unseenFileTabIds.has(tabId) === unseen) return state
        const next = new Set(state.unseenFileTabIds)
        if (unseen) next.add(tabId)
        else next.delete(tabId)
        return { unseenFileTabIds: next }
      })
    },

    toggleFileTabPreview: (tabId) => {
      set((state) => {
        const next = new Set(state.previewFileTabIds)
        if (next.has(tabId)) next.delete(tabId)
        else next.add(tabId)
        return { previewFileTabIds: next }
      })
    },

    setFileTabEditing: (tabId, editing) => {
      set((state) => {
        const on = editing ?? !state.editingFileTabIds.has(tabId)
        if (state.editingFileTabIds.has(tabId) === on) return state
        const next = new Set(state.editingFileTabIds)
        if (on) next.add(tabId)
        else next.delete(tabId)
        return { editingFileTabIds: next }
      })
    },

    setPreviewFileTabIds: (update) => {
      set((state) => {
        const next =
          typeof update === "function"
            ? update(state.previewFileTabIds)
            : update
        return next === state.previewFileTabIds
          ? state
          : { previewFileTabIds: new Set(next) }
      })
    },

    setFileZoom: (tabId, zoom) => {
      set((state) => {
        const nextZoom = Math.min(200, Math.max(50, Math.round(zoom / 10) * 10))
        if ((state.fileZoomByTab[tabId] ?? 100) === nextZoom) return state
        const next = { ...state.fileZoomByTab }
        if (nextZoom === 100) delete next[tabId]
        else next[tabId] = nextZoom
        return { fileZoomByTab: next }
      })
    },

    setPendingFileReveal: (update) => {
      const previous = get().pendingFileReveal
      const next = typeof update === "function" ? update(previous) : update
      if (next === previous) return
      set({ pendingFileReveal: next })
      if (
        previous?.requestId !== next?.requestId ||
        previous?.path !== next?.path ||
        previous?.onComplete !== next?.onComplete
      ) {
        previous?.onComplete?.({
          state: "failed",
          message: "file reveal cancelled",
        })
      }
    },

    consumePendingFileReveal: (requestId, outcome) => {
      const pending = get().pendingFileReveal
      if (pending?.requestId !== requestId) return
      if (outcome?.state === "opened" && pending.ready === false) return
      set({ pendingFileReveal: null })
      if (
        outcome?.state === "opened" &&
        normalizeAbsPath(outcome.path) !== normalizeAbsPath(pending.path)
      ) {
        pending.onComplete?.({
          state: "failed",
          message: "file reveal path does not match its target",
        })
      } else {
        pending.onComplete?.(
          outcome ?? { state: "failed", message: "file reveal cancelled" }
        )
      }
    },

    enqueueExternalConflict: (conflict, options) => {
      set((state) => {
        const key = conflict.path.replace(/\\/g, "/")
        const shown = state.externalConflictSignatures[key]
        if (!options?.force && shown === conflict.signature) return state
        const queue = [...state.externalConflictQueue]
        const index = queue.findIndex(
          (candidate) => candidate.path.replace(/\\/g, "/") === key
        )
        if (index >= 0) queue[index] = conflict
        else queue.push(conflict)
        return {
          externalConflictQueue: queue,
          externalConflictSignatures: {
            ...state.externalConflictSignatures,
            [key]: conflict.signature,
          },
        }
      })
    },

    dequeueExternalConflict: (options) => {
      let head: WorkspaceExternalConflict | null = null
      set((state) => {
        head = state.externalConflictQueue[0] ?? null
        if (!head) return state
        const signatures = { ...state.externalConflictSignatures }
        if (options?.clearSignature) {
          delete signatures[head.path.replace(/\\/g, "/")]
        }
        return {
          externalConflictQueue: state.externalConflictQueue.slice(1),
          externalConflictSignatures: signatures,
        }
      })
      return head
    },

    clearExternalConflictsForPath: (path) => {
      const key = path.replace(/\\/g, "/")
      set((state) => {
        const queue = state.externalConflictQueue.filter(
          (conflict) => conflict.path.replace(/\\/g, "/") !== key
        )
        if (
          queue.length === state.externalConflictQueue.length &&
          !(key in state.externalConflictSignatures)
        ) {
          return state
        }
        const signatures = { ...state.externalConflictSignatures }
        delete signatures[key]
        return {
          externalConflictQueue: queue,
          externalConflictSignatures: signatures,
        }
      })
    },

    restoreFileTabs: ({ tabs, activeTabId, activeTabIdByScope }) => {
      set({
        fileTabs: tabs,
        activeFileTabId: activeTabId,
        activeTabIdByScope: { ...activeTabIdByScope },
      })
    },

    reset: () => {
      const pending = get().pendingFileReveal
      set(createInitialWorkspaceFileStoreState())
      pending?.onComplete?.({
        state: "failed",
        message: "file reveal cancelled",
      })
    },
  })
)

export function resetWorkspaceFileStore(): void {
  useWorkspaceFileStore.getState().reset()
}

registerBackendScopedStoreReset(resetWorkspaceFileStore)
