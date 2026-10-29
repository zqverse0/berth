import type { TabItem } from "@/stores/tab-store"
import { isTerminalTab } from "@/lib/workspace/primary-tabs"
import type { EditorReferenceTarget } from "./types"

export function resolveEditorReferenceTarget(
  activeTabId: string | null,
  tabs: readonly TabItem[]
): EditorReferenceTarget | null {
  if (!activeTabId) return null
  const tab = tabs.find((candidate) => candidate.id === activeTabId)
  if (!tab) return null
  if (tab.kind === "conversation") {
    return { kind: "conversation", tabId: tab.id }
  }
  if (!isTerminalTab(tab)) return null

  const common = {
    tabId: tab.id,
    terminalId: tab.terminalId,
    backendInstanceId: tab.backendInstanceId,
    cwd: tab.lastKnownCwd ?? tab.initialCwd,
    shell: tab.shell,
  }
  return tab.agentType
    ? { kind: "agent-terminal", ...common, agentType: tab.agentType }
    : { kind: "shell-terminal", ...common }
}
