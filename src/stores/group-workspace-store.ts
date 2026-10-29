import { registerBackendScopedStoreReset } from "./backend-scoped-store-reset"
import { create } from "zustand"
import { useAppUiStore } from "./app-ui-store"
import { useWorkspaceLayoutStore } from "./workspace-layout-store"

/** 仅保存群页面的查看上下文，不承担任务或终端生命周期。 */
export const useGroupWorkspaceStore = create<{
  folderId: number | null
  group: string | null
  previewTabId: string | null
  emptyMember: string | null
  focusedMember: string | null
  setFocusedMember: (name: string | null) => void
  selectGroup: (folderId: number, group: string) => void
  preview: (tabId: string | null, emptyMember?: string) => void
  clearEmpty: () => void
}>((set, get) => ({
  folderId: null,
  group: null,
  previewTabId: null,
  emptyMember: null,
  focusedMember: null,
  setFocusedMember: (focusedMember) => set({ focusedMember }),
  selectGroup: (folderId, group) => {
    const current = get()
    if (current.folderId === folderId && current.group === group) return
    const active =
      useWorkspaceLayoutStore.getState().activeTabByPane.conversation
    // 切群隐藏旧成员预览，但不关闭 tab、不终止其进程，也不抢无关辅助页面。
    if (
      current.emptyMember ||
      (current.previewTabId && active?.id === current.previewTabId)
    ) {
      useAppUiStore.getState().setAuxPanelOpen(false)
    }
    set({
      folderId,
      group,
      previewTabId: null,
      emptyMember: null,
      focusedMember: null,
    })
  },
  preview: (previewTabId, emptyMember) => {
    set({ previewTabId, emptyMember: emptyMember ?? null })
    useAppUiStore.getState().setAuxPanelOpen(true)
  },
  clearEmpty: () => set({ emptyMember: null }),
}))

// 后端切换时丢弃旧项目的查看上下文，避免串到另一套项目数据。
registerBackendScopedStoreReset(() =>
  useGroupWorkspaceStore.setState({
    folderId: null,
    group: null,
    previewTabId: null,
    emptyMember: null,
    focusedMember: null,
  })
)
