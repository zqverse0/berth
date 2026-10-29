import type {
  ConversationTabItemInternal,
  TabItemInternal,
  TerminalTabItemInternal,
} from "@/stores/tab-store"

export type ProjectActiveSessionTab =
  | ConversationTabItemInternal
  | TerminalTabItemInternal

/**
 * 筛选特定项目下当前所有已打开/运行中的会话 Tab（包括 Agent 对话与终端，排除项目管理页）。
 */
export function getProjectActiveSessionTabs(
  rawTabs: TabItemInternal[],
  folderId: number
): ProjectActiveSessionTab[] {
  return rawTabs.filter((tab): tab is ProjectActiveSessionTab => {
    if (tab.folderId !== folderId) return false
    return tab.kind === "conversation" || tab.kind === "terminal"
  })
}
