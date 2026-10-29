import { describe, expect, it } from "vitest"
import { getProjectActiveSessionTabs } from "@/lib/workspace/project-active-sessions"
import type { TabItemInternal } from "@/stores/tab-store"

describe("getProjectActiveSessionTabs", () => {
  it("filters tabs belonging to the given folderId", () => {
    const tabs: TabItemInternal[] = [
      {
        id: "tab-1",
        kind: "conversation",
        folderId: 1,
        conversationId: 101,
        agentType: "claude_code",
        title: "Claude Session 1",
        isPinned: false,
      },
      {
        id: "tab-2",
        kind: "conversation",
        folderId: 2,
        conversationId: 102,
        agentType: "codex",
        title: "Codex Session 2",
        isPinned: false,
      },
      {
        id: "tab-3",
        kind: "terminal",
        folderId: 1,
        terminalId: "term-1",
        backendInstanceId: "backend-1",
        initialCwd: "/path",
        shell: "/bin/bash",
        detachedFolderLabel: null,
        detachedFolderPath: null,
        title: "Terminal 1",
        isPinned: false,
      },
    ]

    const result = getProjectActiveSessionTabs(tabs, 1)
    expect(result).toHaveLength(2)
    expect(result.map((t) => t.id)).toEqual(["tab-1", "tab-3"])
  })

  it("returns empty array when folder has no tabs", () => {
    expect(getProjectActiveSessionTabs([], 1)).toEqual([])
  })
})
