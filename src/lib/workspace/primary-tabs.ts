import type { AgentType } from "@/lib/types"

export interface ConversationTab {
  kind: "conversation"
  id: string
  folderId: number
  conversationId: number
  agentType: AgentType
  title: string
  isPinned: boolean
}

export interface TerminalTab {
  kind: "terminal"
  id: string
  terminalId: string
  backendInstanceId: string
  folderId: number | null
  launchSource?:
    | { kind: "shell" }
    | { kind: "managed-command"; commandId: number }
  /** Present when this PTY is an Agent CLI session rather than a plain shell. */
  agentType?: AgentType | null
  title: string
  initialCwd: string
  lastKnownCwd?: string
  shell: string
  detachedFolderLabel: string | null
  detachedFolderPath: string | null
  isPinned: boolean
}

export type PrimaryTab = ConversationTab | TerminalTab

export type ConversationTabPersistInput = Omit<
  ConversationTab,
  "conversationId"
> & {
  conversationId: number | null
  /** Shared v2 identity when a locally-bound draft keeps its runtime key. */
  persistedId?: string
}

export type PrimaryTabPersistInput = ConversationTabPersistInput | TerminalTab

export function isConversationTab<T extends { kind: string }>(
  tab: T
): tab is Extract<T, { kind: "conversation" }> {
  return tab.kind === "conversation"
}

export function isTerminalTab<T extends { kind: string }>(
  tab: T
): tab is Extract<T, { kind: "terminal" }> {
  return tab.kind === "terminal"
}

/**
 * Projects runtime tab objects to the exact shared v2 wire shape. Conversation
 * drafts stay on this device, and arbitrary runtime/view fields are deliberately
 * picked out instead of being spread into persistence.
 */
export function buildPersistItems<T extends PrimaryTabPersistInput>(
  tabs: readonly T[]
): PrimaryTab[] {
  return tabs.flatMap((tab): PrimaryTab[] => {
    if (isConversationTab(tab)) {
      if (tab.conversationId == null) return []
      return [
        {
          kind: "conversation",
          id: tab.persistedId ?? tab.id,
          folderId: tab.folderId,
          conversationId: tab.conversationId,
          agentType: tab.agentType,
          title: tab.title,
          isPinned: tab.isPinned,
        },
      ]
    }

    const terminal = tab as TerminalTab
    return [
      {
        kind: "terminal",
        id: terminal.id,
        terminalId: terminal.terminalId,
        backendInstanceId: terminal.backendInstanceId,
        folderId: terminal.folderId,
        ...(terminal.launchSource
          ? { launchSource: terminal.launchSource }
          : {}),
        ...(terminal.agentType ? { agentType: terminal.agentType } : {}),
        title: terminal.title,
        initialCwd: terminal.initialCwd,
        ...(terminal.lastKnownCwd
          ? { lastKnownCwd: terminal.lastKnownCwd }
          : {}),
        shell: terminal.shell,
        detachedFolderLabel: terminal.detachedFolderLabel,
        detachedFolderPath: terminal.detachedFolderPath,
        isPinned: terminal.isPinned,
      },
    ]
  })
}
