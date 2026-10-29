import { removeTerminalRecord, terminateTerminalSession } from "@/lib/api"
import { extractAppCommandError } from "@/lib/app-error"
import { isTerminalTab } from "@/lib/workspace/primary-tabs"
import { useTabStore } from "@/stores/tab-store"

function terminalErrorCode(error: unknown): string | null {
  return extractAppCommandError(error)?.code ?? null
}

export function isTerminalGoneError(error: unknown): boolean {
  const code = terminalErrorCode(error)
  return (
    code === "not_found" ||
    code === "terminal_not_found" ||
    code === "terminal_instance_expired" ||
    code === "terminal_exited"
  )
}

export function closeLocalTerminalTabs(terminalId: string): void {
  const { rawTabs, closeTab } = useTabStore.getState()
  const tabIds = rawTabs
    .filter((tab) => isTerminalTab(tab) && tab.terminalId === terminalId)
    .map((tab) => tab.id)

  for (const tabId of tabIds) closeTab(tabId)
}

export async function removeTerminalRecordIdempotent(
  terminalId: string
): Promise<void> {
  try {
    await removeTerminalRecord(terminalId)
  } catch (error) {
    if (!isTerminalGoneError(error)) throw error
  }
  closeLocalTerminalTabs(terminalId)
}

export async function terminateTerminalSessionIdempotent(
  terminalId: string
): Promise<void> {
  try {
    await terminateTerminalSession(terminalId)
  } catch (error) {
    if (!isTerminalGoneError(error)) throw error
  }
  await removeTerminalRecordIdempotent(terminalId)
}
