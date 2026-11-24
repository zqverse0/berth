/**
 * Berth Errors（群组 ACP 模式）
 *
 * 模型请求失败时 pi-acp 只回空的 end_turn，错误只在 pi 会话文件里。这里在一轮最终结束前
 * （自动重试都用完之后）把最后一条助手消息的 errorMessage 经 `ui.notify` 发出，
 * pi-acp 把它转成回答文字，群里看到失败原因而不是「没有回答」。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

type Assistant = { role?: string; stopReason?: string; errorMessage?: string }

export default function (pi: ExtensionAPI) {
  let error: string | undefined

  pi.on("agent_start", async () => {
    error = undefined
  })
  // 重试会再来一次 agent_end：以最后一次为准。
  pi.on("agent_end", async (event) => {
    const last = [...event.messages]
      .reverse()
      .find((message) => (message as Assistant).role === "assistant") as
      | Assistant
      | undefined
    error =
      last?.stopReason === "error"
        ? last.errorMessage?.trim() || "unknown error"
        : undefined
  })
  pi.on("agent_before_settle", async (_event, ctx) => {
    if (error) ctx.ui.notify(`模型请求失败：${error}`, "error")
    error = undefined
  })
}
