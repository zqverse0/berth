/**
 * Berth Agent Status
 *
 * 把 Pi 的生命周期交给 `berth group hook <事件>`（stdin 是与 Claude Code / Codex 同形的 hook JSON）：
 * 它往终端写 OSC 9;4 进度 / OSC 9 通知（termd 解析为 pane_agent_state），记下会话，
 * 一轮结束把回答贴回群组。
 * 一轮彻底结束另发「Ready for input」通知，与其他 Agent 一样计为一次「需要关注」。
 */

import { spawn } from "node:child_process"
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent"

// 通知文本不能含控制字符，否则会截断 OSC
const clean = (text: string) => text.replace(/[\x00-\x1f\x7f]+/g, " ").trim()

// 逐个串行：一轮很短时 turn-end 不能抢在 turn-start 前写状态。
let queue: Promise<void> = Promise.resolve()

/** 失败、没装 berth 都静默：不影响 Pi。 */
const hook = (event: string, payload: Record<string, unknown>) => {
  queue = queue.then(
    () =>
      new Promise<void>((resolve) => {
        try {
          const child = spawn("berth", ["group", "hook", event], {
            stdio: ["pipe", "ignore", "ignore"],
          })
          child.on("error", () => resolve())
          child.on("close", () => resolve())
          child.stdin.on("error", () => {})
          child.stdin.end(JSON.stringify(payload))
        } catch {
          resolve()
        }
      })
  )
}

type Content = { type: string; text?: string }

/** 这一轮最后一条助手消息的正文。 */
const lastReply = (messages: readonly unknown[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as {
      role?: string
      content?: string | Content[]
    }
    if (message.role !== "assistant") continue
    const text =
      typeof message.content === "string"
        ? message.content
        : (message.content ?? [])
            .filter((part) => part.type === "text")
            .map((part) => part.text ?? "")
            .join("\n")
    if (text.trim()) return text
  }
  return undefined
}

export default function (pi: ExtensionAPI) {
  let reply: string | undefined
  let session: Record<string, unknown> = {}

  pi.on("session_start", async (event, ctx) => {
    session = {
      session_id: ctx.sessionManager.getSessionId(),
      transcript_path: ctx.sessionManager.getSessionFile(),
    }
    hook("session-start", { ...session, source: event.reason })
  })
  pi.on("agent_start", async () => {
    reply = undefined
    hook("turn-start", session)
  })
  pi.on("agent_end", async (event) => {
    reply = lastReply(event.messages) ?? reply
  })
  // agent_end 之后 Pi 仍可能重试或续跑，只在 settled 时视为结束
  pi.on("agent_settled", async () => {
    hook("turn-end", { ...session, last_assistant_message: reply })
    process.stdout.write("\x1b]9;Pi: Ready for input\x07")
  })
  pi.on("ui_prompt_start", async (event) => {
    hook("attention", {
      ...session,
      message: `Pi: ${clean(event.title ?? "") || "Waiting for input"}`,
    })
  })
}
