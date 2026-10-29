import { describe, expect, it } from "vitest"
import type { ContentBlock, MessageTurn, TurnRole } from "@/lib/types"
import { buildExchanges, filterProcess, matchesExchange } from "./exchanges"
import fixture from "./exchanges.fixture.json"

let seq = 0
function turn(role: TurnRole, blocks: ContentBlock[], extra = {}): MessageTurn {
  seq += 1
  return {
    id: `t${seq}`,
    role,
    blocks,
    timestamp: `2026-09-29T00:00:${String(seq).padStart(2, "0")}.000Z`,
    ...extra,
  }
}
const text = (value: string): ContentBlock => ({ type: "text", text: value })
const toolUse = (id: string, name: string): ContentBlock => ({
  type: "tool_use",
  tool_use_id: id,
  tool_name: name,
  input_preview: `{"cmd":"${name}"}`,
})
const result = (id: string, isError = false): ContentBlock => ({
  type: "tool_result",
  tool_use_id: id,
  output_preview: "out",
  is_error: isError,
})

const turns = (): MessageTurn[] => [
  turn("system", [text("session preamble")]),
  turn("user", [text("first question\nmore detail")]),
  turn("assistant", [{ type: "thinking", text: "hmm" }, toolUse("a", "Bash")]),
  turn("system", [result("a", true)]),
  turn("assistant", [text("looking"), toolUse("b", "Read")], {
    usage: {
      input_tokens: 10,
      output_tokens: 5,
      cache_read_input_tokens: 90,
      cache_creation_input_tokens: 0,
    },
  }),
  turn("user", [result("b")]),
  turn("assistant", []),
  turn("assistant", [text("final answer")]),
  turn("user", [text("second question")]),
]

describe("buildExchanges", () => {
  it("splits on real prompts and keeps preamble as index 0", () => {
    const exchanges = buildExchanges(turns())
    expect(exchanges.map((ex) => ex.index)).toEqual([0, 1, 2])
    expect(exchanges[0].prompt).toBeNull()
    expect(exchanges[2].process).toEqual([])
  })

  it("extracts the last assistant text as answer and merges tool results", () => {
    const [, first] = buildExchanges(turns())
    expect(first.answer?.blocks).toEqual([text("final answer")])
    // assistant + 工具结果轮合并成一轮，调用与结果同处一轮才能配对
    expect(first.process).toHaveLength(1)
    const types = first.process[0].blocks.map((block) => block.type)
    expect(types).toEqual([
      "thinking",
      "tool_use",
      "tool_result",
      "text",
      "tool_use",
      "tool_result",
    ])
    expect(first.stats).toMatchObject({
      tools: { Bash: 1, Read: 1 },
      toolCalls: 2,
      errors: 1,
      thinking: 1,
      contextTokens: 100,
    })
  })

  it("filters process by tool name and errors", () => {
    const [, first] = buildExchanges(turns())
    const base = {
      thinking: true,
      tools: true,
      toolName: null,
      skill: null,
      errorsOnly: false,
    }
    const read = filterProcess(first.process, { ...base, toolName: "Read" })
    expect(read[0].blocks).toEqual([toolUse("b", "Read"), result("b")])
    const errors = filterProcess(first.process, { ...base, errorsOnly: true })
    expect(errors[0].blocks).toEqual([toolUse("a", "Bash"), result("a", true)])
    const noTools = filterProcess(first.process, { ...base, tools: false })
    expect(noTools[0].blocks.map((block) => block.type)).toEqual([
      "thinking",
      "text",
    ])
    expect(
      matchesExchange(
        first,
        { toolName: "Grep", skill: null, errorsOnly: false },
        ""
      )
    ).toBe(false)
    expect(matchesExchange(first, base, "LOOKING")).toBe(true)
  })

  it("counts and filters skill loads marked by the reader", () => {
    const skillUse: ContentBlock = {
      type: "tool_use",
      tool_use_id: "s",
      tool_name: "Skill",
      input_preview: '{"skill":"diagnose"}',
      meta: { "berth.skills": ["diagnose"] },
    }
    const [exchange] = buildExchanges([
      turn("user", [text("debug this")]),
      turn("assistant", [skillUse, toolUse("r", "Read")]),
      turn("system", [result("s"), result("r")]),
      turn("assistant", [text("done")]),
    ])
    expect(exchange.stats.skills).toEqual({ diagnose: 1 })
    const only = filterProcess(exchange.process, {
      thinking: true,
      tools: true,
      toolName: null,
      skill: "diagnose",
      errorsOnly: false,
    })
    expect(only[0].blocks).toEqual([skillUse, result("s")])
  })
})

// 与 Rust `berth_project_core::knowledge::exchanges` 共用样例：Jev 分类与会话页分出同样的问答。
describe("shared exchange fixture", () => {
  it("groups the same prompts, steps, tool errors and answers as the Rust side", () => {
    const textOf = (block: ContentBlock) =>
      block.type === "text" && block.text.trim() !== ""
        ? block.text.trim()
        : null
    const got = buildExchanges(fixture.turns as MessageTurn[]).map(
      (exchange) => {
        const blocks = exchange.process.flatMap((turn) =>
          turn.role === "assistant" ? turn.blocks : []
        )
        const tools = new Map(
          exchange.process
            .flatMap((turn) => turn.blocks)
            .flatMap((block) =>
              block.type === "tool_use" && block.tool_use_id
                ? [[block.tool_use_id, block.tool_name] as const]
                : []
            )
        )
        return {
          index: exchange.index,
          prompt: exchange.prompt
            ? exchange.prompt.blocks
                .flatMap((block) => textOf(block) ?? [])
                .join("\n")
            : null,
          steps: blocks.flatMap((block) => textOf(block) ?? []),
          errors: exchange.process
            .flatMap((turn) => turn.blocks)
            .flatMap((block) =>
              block.type === "tool_result" && block.is_error
                ? [tools.get(block.tool_use_id ?? "") ?? "?"]
                : []
            ),
          answer: exchange.answer ? textOf(exchange.answer.blocks[0]) : null,
        }
      }
    )
    expect(got).toEqual(fixture.expected)
  })
})
