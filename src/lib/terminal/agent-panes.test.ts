import { describe, expect, it, vi } from "vitest"
import {
  buildAgentPaneRows,
  countAttention,
  interruptKeyFor,
  paneAgentState,
  paneFolderId,
} from "@/lib/terminal/agent-panes"
import type { AgentProfileSummary } from "@/lib/transport/launchbar"
import type { TerminalAgentSignal, TerminalDescriptor } from "@/lib/types"

function pane(
  terminalId: string,
  state: TerminalAgentSignal["state"] | null,
  extra: Partial<TerminalDescriptor> = {}
): TerminalDescriptor {
  return {
    terminalId,
    backendInstanceId: "b",
    folderId: 1,
    title: terminalId,
    initialCwd: "/p",
    shell: "/bin/sh",
    status: "running",
    processId: 1,
    createdAt: "2026-10-01T00:00:00Z",
    exitedAt: null,
    agentId: "pi",
    agentSignal: state
      ? {
          state,
          notification: null,
          stateChangedAt: 100,
          progressState: "hidden",
          progress: 0,
        }
      : null,
    ...extra,
  }
}

describe("agent panes", () => {
  it("maps pane state, exit wins and missing signal is idle", () => {
    expect(paneAgentState(pane("a", "attention"))).toBe("attention")
    expect(paneAgentState(pane("a", "working"))).toBe("working")
    expect(paneAgentState(pane("a", null))).toBe("idle")
    expect(paneAgentState(pane("a", "attention", { status: "exited" }))).toBe(
      "exited"
    )
  })

  it("counts only attention panes", () => {
    const rows = buildAgentPaneRows(
      [
        pane("a", "attention"),
        pane("b", "working"),
        pane("c", "attention"),
        pane("d", "attention", { status: "exited" }),
      ],
      [],
      0
    )
    expect(countAttention(rows)).toBe(2)
    expect(countAttention([])).toBe(0)
  })

  it("reuses rows and the array when a poll returns the same panes", () => {
    const first = buildAgentPaneRows(
      [pane("a", "working"), pane("b", null)],
      [],
      0
    )
    const same = buildAgentPaneRows(
      [pane("a", "working"), pane("b", null)],
      first,
      2000
    )
    expect(same).toBe(first)

    const next = buildAgentPaneRows(
      [pane("a", "working"), pane("b", null, { title: "renamed" })],
      first,
      4000
    )
    expect(next).not.toBe(first)
    expect(next[0]).toBe(first[0])
    expect(next[1]?.descriptor.title).toBe("renamed")
  })

  it("does not count a plain shell ringing the bell", () => {
    const rows = buildAgentPaneRows(
      [pane("a", "attention", { agentId: null })],
      [],
      0
    )
    expect(countAttention(rows)).toBe(0)
  })

  it("puts a pane under the deepest registered folder containing its cwd", () => {
    const folders = [
      { id: 1, path: "/repo" },
      { id: 2, path: "/repo/" + "wt" },
      { id: 3, path: "/repo-feat" },
    ]
    const at = (cwd: string | null, extra: Partial<TerminalDescriptor> = {}) =>
      paneFolderId(
        pane("a", null, { cwd, initialCwd: "/repo", ...extra }),
        folders
      )
    expect(at("/repo/wt/src")).toBe(2)
    expect(at("/repo/src")).toBe(1)
    // 前缀相同但不是子目录。
    expect(at("/repo-feat")).toBe(3)
    expect(at(null)).toBe(1)
    // 不在任何已注册目录里：仍归会话所属项目。
    expect(at("/tmp")).toBe(1)
    // 独立终端不按 cwd 补项目。
    expect(at("/repo/wt", { folderId: null })).toBeNull()
  })

  it("skips attention the user has seen until the next round", () => {
    const rows = buildAgentPaneRows([pane("a", "attention")], [], 0)
    expect(countAttention(rows, { a: 100_000 })).toBe(0)
    const next = buildAgentPaneRows(
      [
        pane("a", "attention", {
          agentSignal: {
            ...rows[0].descriptor.agentSignal!,
            stateChangedAt: 200,
          },
        }),
      ],
      rows,
      0
    )
    expect(countAttention(next, { a: 100_000 })).toBe(1)
  })

  it("keeps since while state holds and uses termd time for attention", () => {
    const first = buildAgentPaneRows([pane("a", "working")], [], 1_000)
    const same = buildAgentPaneRows([pane("a", "working")], first, 5_000)
    expect(same[0].since).toBe(1_000)
    const idle = buildAgentPaneRows([pane("a", "idle")], same, 9_000)
    expect(idle[0].since).toBe(9_000)
    const attention = buildAgentPaneRows([pane("a", "attention")], idle, 9_500)
    expect(attention[0].since).toBe(100_000)
  })

  it("falls back to Escape when interruptKey is not declared", () => {
    const agents = [
      { id: "demo", name: "Demo", interruptKey: "C-c" },
      { id: "plain", name: "Plain", interruptKey: null },
    ] as AgentProfileSummary[]
    expect(interruptKeyFor("demo", agents)).toBe("C-c")
    expect(interruptKeyFor("plain", agents)).toBe("Escape")
    expect(interruptKeyFor("missing", agents)).toBe("Escape")
    expect(interruptKeyFor(null, agents)).toBe("Escape")
  })
})

describe("seen attention", () => {
  it("survives a reload", async () => {
    const first = await import("@/lib/terminal/agent-panes")
    first.useAgentPaneStore.setState({ seen: { t1: 6_000 } })
    vi.resetModules()
    const reloaded = await import("@/lib/terminal/agent-panes")
    expect(reloaded.useAgentPaneStore.getState().seen).toEqual({ t1: 6_000 })
  })
})
