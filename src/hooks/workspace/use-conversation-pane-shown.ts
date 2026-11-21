"use client"

import { useAppUiStore } from "@/stores/app-ui-store"
import { useGroupWorkspaceStore } from "@/stores/group-workspace-store"

/** 辅助面板里的终端组（`conversation` pane）此刻是否看得见：渲染与「当前选中」共用这一个判断。 */
export function useConversationPaneShown(): boolean {
  const open = useAppUiStore(
    (state) => state.auxPanelOpen && state.auxView === "terminals"
  )
  const emptyMember = useGroupWorkspaceStore((state) => !!state.emptyMember)
  return open && !emptyMember
}
