import { describe, expect, it } from "vitest"
import type { MessageTurn } from "@/lib/types"
import { sessionLog, toolTarget } from "./group-pending"

const turn = (
  at: number,
  role: MessageTurn["role"],
  blocks: MessageTurn["blocks"]
): MessageTurn => ({
  id: String(at),
  role,
  blocks,
  timestamp: new Date(at).toISOString(),
})

describe("sessionLog", () => {
  it("lists actions between the question and the answer, flagging errors and thinking", () => {
    const turns = [
      turn(500, "assistant", [{ type: "text", text: "before the ask" }]),
      turn(1_000, "user", [{ type: "text", text: "[berth 群] do it" }]),
      turn(2_000, "assistant", [
        { type: "text", text: "\nLooking at deliver.rs\nmore" },
        {
          type: "tool_use",
          tool_use_id: "1",
          tool_name: "Bash",
          input_preview: "pnpm test\n--run",
        },
      ]),
      turn(3_000, "user", [
        {
          type: "tool_result",
          tool_use_id: "1",
          output_preview: "Error: boom\nstack",
          is_error: true,
        },
      ]),
      turn(4_000, "assistant", [{ type: "thinking", text: "hmm" }]),
    ]
    expect(sessionLog(turns, 1_000)).toEqual({
      lines: [
        { text: "Looking at deliver.rs" },
        { text: "→ Bash pnpm test" },
        { text: "✗ Error: boom", error: true },
        { text: "hmm", thinking: true },
      ],
      updatedAt: 4_000,
    })
    expect(sessionLog(turns, 1_000, 2_000).lines).toHaveLength(2)
    expect(sessionLog(turns, 5_000)).toEqual({ lines: [], updatedAt: null })
  })
})

describe("toolTarget", () => {
  it("picks the most telling argument from a tool input preview", () => {
    expect(toolTarget('{"command":"pnpm test","timeout":5}')).toBe("pnpm test")
    expect(toolTarget('{"edits":[{"newText":"x"}],"path":"a.md"}')).toBe("a.md")
    expect(toolTarget('{"description":"look"}')).toBe("look")
    // 预览被截断：JSON 解析不了时按键名从文本里取。
    expect(toolTarget('{"path":"src/a \\"b\\".ts","edits":[{"old')).toBe(
      'src/a "b".ts'
    )
    expect(toolTarget("plain text")).toBe("plain text")
  })
})
