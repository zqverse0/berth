import { controlAcpMember } from "@/lib/agent/berth-group"
import { launchbar } from "@/lib/transport/launchbar"
import { createAndOpenPrimaryTerminalDetailed } from "@/lib/terminal/create-and-open-primary-terminal"

/**
 * ACP 成员「在终端打开」：先交接（运行时停掉进程，消息留着），再用同一份启动选择 + 会话 id 开终端，
 * 开好后登记终端；开不了就交回群里。同一会话同一时刻只在一处打开。
 * 返回 `null` 为成功，否则是失败原因：`unsupported`（插件不能按会话 id 打开）、`failed`，或后端报错原文。
 */
export async function handoffAcpMember(
  folderId: number,
  group: string,
  member: string,
  title: string
): Promise<"unsupported" | "failed" | { message: string } | null> {
  const response = await controlAcpMember(folderId, group, member, "handoff")
  if (!response.ok) return { message: response.error.message }
  const handed = response.result
  const config = await launchbar({ type: "load", agent: handed.agent })
  const sessionItem =
    config.type === "file"
      ? (config.file.config?.items ?? []).find(
          (item) => item.optionsFrom === "projectSessions"
        )
      : undefined
  const opened = sessionItem
    ? await createAndOpenPrimaryTerminalDetailed({
        cwd: handed.cwd,
        folderId,
        title,
        agentContractId: handed.agent,
        agentLaunchInputs: {
          ...handed.inputs,
          [sessionItem.id]: handed.session,
        },
        providerId: handed.provider,
        modelId: handed.model,
      }).catch(() => ({ terminalId: null }))
    : { terminalId: null }
  if (!opened.terminalId) {
    await controlAcpMember(folderId, group, member, "return")
    return sessionItem ? "failed" : "unsupported"
  }
  await controlAcpMember(folderId, group, member, "handoff", opened.terminalId)
  return null
}
