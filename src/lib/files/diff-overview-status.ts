import { create } from "zustand"

/** 差异总览页同步到底部状态栏与顶部统一工具栏的状态和动作。 */
export interface DiffOverviewStatus {
  kind: "commit" | "working" | "branch"
  /** 状态栏主标号：短 hash / 分支名 / 工作区 */
  badge: string
  /** 点击标号复制的内容（完整 commit hash 或路径） */
  copyText: string | null
  /** 非 commit 差异的简短说明（如工作区路径 / 分支比较描述） */
  description: string | null
  fileCount: number
  additions: number
  deletions: number
  author: string | null
  date: string | null
  pushed: boolean | null
  allExpanded: boolean
  fileFilter: string
  onToggleAllFiles: () => void
  onFileFilterChange: (value: string) => void
  onRefresh?: () => void
}

interface DiffOverviewStatusStoreState {
  byTabId: Readonly<Record<string, DiffOverviewStatus>>
  setStatus: (tabId: string, status: DiffOverviewStatus) => void
  clearStatus: (tabId: string) => void
}

export const useDiffOverviewStatusStore = create<DiffOverviewStatusStoreState>(
  (set) => ({
    byTabId: {},
    setStatus: (tabId, status) =>
      set((state) => ({
        byTabId: { ...state.byTabId, [tabId]: status },
      })),
    clearStatus: (tabId) =>
      set((state) => {
        if (!(tabId in state.byTabId)) return state
        const next = { ...state.byTabId }
        delete next[tabId]
        return { byTabId: next }
      }),
  })
)
