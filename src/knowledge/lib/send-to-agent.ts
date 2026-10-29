import { sendTerminalLine } from "@/lib/api"
import { paneAgentState } from "@/lib/terminal/agent-panes"
import { focusTerminalTab } from "@/lib/terminal/create-and-open-primary-terminal"
import { refreshTerminalInventory } from "@/lib/terminal/terminal-inventory-query"
import { requestAgentLaunch } from "@/stores/agent-launch-store"

/**
 * 把请求发给项目里正在运行的 Agent（优先空闲的）并切过去，返回它的标题；
 * 没有在运行的就打开启动栏，返回 null。
 */
export async function sendToProjectAgent(
  folderId: number,
  folderPath: string,
  request: string
) {
  const agents = (await refreshTerminalInventory()).filter(
    (pane) =>
      pane.folderId === folderId && pane.agentId && pane.status === "running"
  )
  const target =
    agents.find((pane) => paneAgentState(pane) === "idle") ??
    agents[agents.length - 1]
  if (!target) {
    requestAgentLaunch({ folderId, workingDirectory: folderPath })
    return null
  }
  await sendTerminalLine(target.terminalId, request)
  focusTerminalTab(target)
  return target.title
}
