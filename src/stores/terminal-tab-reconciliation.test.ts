import { describe, expect, it } from "vitest"
import type { TerminalTab } from "@/lib/workspace/primary-tabs"
import type { TerminalDescriptor } from "@/lib/types"
import { projectTerminalInventory } from "@/stores/tab-store"
import { useAgentProfilesStore } from "@/hooks/use-agent-profiles"

function descriptor(
  terminalId: string,
  overrides: Partial<TerminalDescriptor> = {}
): TerminalDescriptor {
  return {
    terminalId,
    backendInstanceId: "backend-a",
    folderId: 7,
    title: `runtime-${terminalId}`,
    initialCwd: "/repo",
    shell: "/bin/bash",
    status: "running",
    processId: 42,
    createdAt: "2026-08-11T00:00:00.000Z",
    exitedAt: null,
    ...overrides,
  }
}

function preference(
  terminalId: string,
  overrides: Partial<TerminalTab> = {}
): TerminalTab {
  return {
    kind: "terminal",
    id: `terminal:${terminalId}`,
    terminalId,
    backendInstanceId: "backend-a",
    folderId: 7,
    launchSource: { kind: "managed-command", commandId: 9 },
    agentType: "codex",
    title: `saved-${terminalId}`,
    initialCwd: "/stale",
    lastKnownCwd: "/repo/src",
    shell: "/bin/zsh",
    detachedFolderLabel: "Repo",
    detachedFolderPath: "/repo",
    isPinned: true,
    ...overrides,
  }
}

describe("projectTerminalInventory", () => {
  it("uses running inventory as lifecycle truth and preserves matched presentation metadata", () => {
    const result = projectTerminalInventory(
      [
        descriptor("live", { initialCwd: "/runtime", shell: "/bin/fish" }),
        descriptor("exited", { status: "exited" }),
      ],
      [preference("dead"), preference("live")],
      []
    )

    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      terminalId: "live",
      initialCwd: "/runtime",
      shell: "/bin/fish",
      title: "saved-live",
      agentType: "codex",
      lastKnownCwd: "/repo/src",
      isPinned: true,
    })
  })

  it("keeps preference order, discovers folderless terminals, and separates backend identities", () => {
    const result = projectTerminalInventory(
      [
        descriptor("second", { folderId: null }),
        descriptor("first"),
        descriptor("first", { backendInstanceId: "backend-b" }),
      ],
      [preference("first")],
      []
    )

    expect(result.map((terminal) => terminal.terminalId)).toEqual([
      "first",
      "second",
      "first",
    ])
    expect(result[1].folderId).toBeNull()
    expect(result[2].backendInstanceId).toBe("backend-b")
  })

  it("keeps descriptor ownership when a saved tab had a display-only folder", () => {
    const result = projectTerminalInventory(
      [
        descriptor("independent", {
          folderId: null,
          initialCwd: "/repo/nested",
        }),
      ],
      [preference("independent", { folderId: 7 })],
      []
    )

    expect(result[0]?.folderId).toBeNull()
  })

  it("keeps a stale descriptor detached after inventory refresh", () => {
    const result = projectTerminalInventory(
      [
        descriptor("stale", {
          folderId: 99,
          initialCwd: "/deleted-project/work",
        }),
      ],
      [
        preference("stale", {
          folderId: null,
          detachedFolderPath: "/deleted-project/work",
        }),
      ],
      []
    )

    expect(result[0]).toMatchObject({
      folderId: null,
      detachedFolderPath: "/deleted-project/work",
    })
  })

  it("takes agentType from the termd agentId, never from the title", () => {
    const result = projectTerminalInventory(
      [
        descriptor("claude-term", { title: "Claude Code" }),
        descriptor("pi-term", { title: "bash · project", agentId: "pi" }),
      ],
      [],
      []
    )

    expect(result).toHaveLength(2)
    expect(result[0].agentType).toBeNull()
    expect(result[1].agentType).toBe("pi")
  })

  it("heals generic process title when preference has agentType", () => {
    // 展示名来自插件 identity.name（按 projectType 匹配），不是前端名字表。
    useAgentProfilesStore.setState({
      agents: [
        { id: "claude", name: "Claude Code", projectType: "claude_code" },
      ] as never,
    })
    const result = projectTerminalInventory(
      [descriptor("term-1", { title: "python3 · repo" })],
      [
        preference("term-1", {
          agentType: "claude_code",
          title: "python3 · repo",
        }),
      ],
      []
    )

    expect(result).toHaveLength(1)
    expect(result[0].agentType).toBe("claude_code")
    expect(result[0].title).toBe("Claude Code · repo")
    useAgentProfilesStore.setState({ agents: [] })
  })

  it("preserves agentType and preference title against generic running descriptor title", () => {
    const result = projectTerminalInventory(
      [descriptor("term-agy", { title: "python3 · berth" })],
      [
        preference("term-agy", {
          agentType: "antigravity",
          title: "Antigravity · berth",
        }),
      ],
      []
    )

    expect(result).toHaveLength(1)
    expect(result[0].agentType).toBe("antigravity")
    expect(result[0].title).toBe("Antigravity · berth")
  })

  it("matches preference by terminalId fallback when backendInstanceId differs", () => {
    const result = projectTerminalInventory(
      [
        descriptor("term-fallback", {
          backendInstanceId: "new-daemon-instance",
          title: "python3 · repo",
        }),
      ],
      [
        preference("term-fallback", {
          backendInstanceId: "old-daemon-instance",
          agentType: "codex",
          title: "Codex CLI",
        }),
      ],
      []
    )

    expect(result).toHaveLength(1)
    expect(result[0].agentType).toBe("codex")
    expect(result[0].title).toBe("Codex CLI")
  })
})
