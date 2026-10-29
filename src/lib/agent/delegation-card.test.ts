import { describe, expect, it } from "vitest"

import { parseDelegationMeta, parseInput } from "@/lib/agent/delegation-card"

describe("parseInput wrapper peeling", () => {
  it("reads top-level delegation args", () => {
    const parsed = parseInput(
      JSON.stringify({
        agent_type: "codex",
        task: "run the build",
        working_dir: "/tmp/proj",
      })
    )
    expect(parsed.agentType).toBe("codex")
    expect(parsed.task).toBe("run the build")
    expect(parsed.workingDir).toBe("/tmp/proj")
  })

  it("peels Cursor's MCP args wrapper", () => {
    // Cursor surfaces MCP calls as {providerIdentifier, toolName, args} — the
    // delegation fields live one level down under `args`.
    const parsed = parseInput(
      JSON.stringify({
        providerIdentifier: "berth-mcp",
        toolName: "delegate_to_agent",
        args: { agent_type: "claude_code", task: "执行 pnpm build" },
      })
    )
    expect(parsed.agentType).toBe("claude_code")
    expect(parsed.task).toBe("执行 pnpm build")
    expect(parsed.workingDir).toBeNull()
  })

  it("returns empty for undelegation-like payloads", () => {
    const parsed = parseInput(JSON.stringify({ command: "ls -la" }))
    expect(parsed.agentType).toBeNull()
    expect(parsed.task).toBeNull()
  })

  // Agent 身份即插件 projectType：插件新增的 id 也要认，畸形值不认。
  it.each(["codex", "claude_code", "demo_agent"])(
    "recognizes the %s agent_type",
    (agentType) => {
      const parsed = parseInput(
        JSON.stringify({ agent_type: agentType, task: "do the thing" })
      )
      expect(parsed.agentType).toBe(agentType)
    }
  )

  it("rejects a malformed agent_type", () => {
    const parsed = parseInput(JSON.stringify({ agent_type: "Not An Id" }))
    expect(parsed.agentType).toBeNull()
  })
})

describe("parseDelegationMeta task fields", () => {
  it("surfaces the broker-stamped task_preview and task_id", () => {
    // The persisted Cursor shape: raw_input is "{}" forever, so the meta the
    // broker stamped is the card's ONLY label source after a refresh.
    const parsed = parseDelegationMeta({
      "berth.delegation": {
        status: "running",
        child_conversation_id: 42,
        task_preview: "执行 pnpm build",
        task_id: "task-uuid-1",
      },
    })
    expect(parsed).not.toBeNull()
    expect(parsed?.task).toBe("执行 pnpm build")
    expect(parsed?.taskId).toBe("task-uuid-1")
    expect(parsed?.childConversationId).toBe(42)
  })

  it("keeps task fields null when the meta lacks them (older backend)", () => {
    const parsed = parseDelegationMeta({
      "berth.delegation": { status: "completed" },
    })
    expect(parsed?.task).toBeNull()
    expect(parsed?.taskId).toBeNull()
  })

  it("ignores empty and non-string task fields", () => {
    const parsed = parseDelegationMeta({
      "berth.delegation": {
        status: "running",
        task_preview: "",
        task_id: 7,
      },
    })
    expect(parsed?.task).toBeNull()
    expect(parsed?.taskId).toBeNull()
  })
})
