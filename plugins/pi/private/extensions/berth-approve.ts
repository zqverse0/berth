/**
 * Berth Approve（群组 ACP 模式）
 *
 * Pi 自己不审批工具调用。每个调用先经 `ui.confirm`，pi-acp 把它转成 ACP `session/request_permission`，
 * 群组运行时交给用户批准；拒绝时拦下这次调用。
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    const ok = await ctx.ui.confirm(
      `Allow ${event.toolName}?`,
      JSON.stringify(event.input).slice(0, 2000)
    )
    if (!ok) return { block: true, reason: "Denied by the user in Berth" }
  })
}
