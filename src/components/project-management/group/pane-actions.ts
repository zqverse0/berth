"use client"

import { toast } from "@/lib/notify"
import { useTabActions, useTabStore } from "@/contexts/tab-context"
import { useAgentProfiles } from "@/hooks/use-agent-profiles"
import { getTerminalSession, sendTerminalKey } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  interruptKeyFor,
  refreshAgentPanes,
  type AgentPaneRow,
} from "@/lib/terminal/agent-panes"
import { tabFromDescriptor } from "@/lib/terminal/create-and-open-primary-terminal"
import { isTerminalTab, type TerminalTab } from "@/lib/workspace/primary-tabs"
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store"
import { useAppUiStore } from "@/stores/app-ui-store"

const TAIL_LINES = 200

/** 群成员的终端动作：跳转到它的终端 tab、打断、读最近输出。 */
export function usePaneActions() {
  const { agents } = useAgentProfiles()
  const { openTerminalTab, switchTab } = useTabActions()

  const jump = ({ descriptor }: AgentPaneRow, displayFolderId?: number) => {
    const existing = useTabStore
      .getState()
      .tabs.find(
        (tab): tab is TerminalTab =>
          isTerminalTab(tab) && tab.terminalId === descriptor.terminalId
      )
    // 激活终端 tab 后 TerminalView 自行聚焦。
    if (
      existing &&
      (displayFolderId === undefined || existing.folderId === displayFolderId)
    )
      switchTab(existing.id)
    else
      openTerminalTab(
        existing
          ? { ...existing, folderId: displayFolderId ?? existing.folderId }
          : tabFromDescriptor(
              descriptor,
              displayFolderId === undefined
                ? undefined
                : { folderId: displayFolderId }
            ),
        true
      )
    const id = existing?.id ?? `terminal:${descriptor.terminalId}`
    useWorkspaceLayoutStore
      .getState()
      .moveWorkspaceTab(
        { kind: "primary", id, type: "terminal" },
        "conversation"
      )
    useAppUiStore.getState().setAuxPanelOpen(true)
    return id
  }

  const interrupt = async ({ descriptor }: AgentPaneRow) => {
    try {
      await sendTerminalKey(
        descriptor.terminalId,
        interruptKeyFor(descriptor.agentId, agents)
      )
      refreshAgentPanes()
    } catch (error) {
      toast.error(toErrorMessage(error))
    }
  }

  const readTail = async ({ descriptor }: AgentPaneRow) => {
    const described = await getTerminalSession(descriptor.terminalId, {
      tailLines: TAIL_LINES,
    })
    return described.tail ?? ""
  }

  const agentName = (row: AgentPaneRow) =>
    agents.find((agent) => agent.id === row.descriptor.agentId)?.name ??
    row.descriptor.title

  return { jump, interrupt, readTail, agentName }
}
