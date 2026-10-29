import { describe, expect, it } from "vitest"
import {
  buildPersistItems,
  isConversationTab,
  isTerminalTab,
  type ConversationTab,
  type TerminalTab,
} from "@/lib/workspace/primary-tabs"

const conversationTab: ConversationTab = {
  kind: "conversation",
  id: "conversation:7:42",
  folderId: 7,
  conversationId: 42,
  agentType: "codex",
  title: "Agent session",
  isPinned: true,
}

const terminalTab: TerminalTab = {
  kind: "terminal",
  id: "terminal:term-1",
  terminalId: "term-1",
  backendInstanceId: "backend-a",
  folderId: 7,
  title: "Terminal",
  initialCwd: "/repo",
  shell: "/bin/bash",
  detachedFolderLabel: null,
  detachedFolderPath: null,
  isPinned: false,
}

describe("primary tabs", () => {
  it("round-trips mixed tabs while stripping device-local view state", () => {
    const items = buildPersistItems([
      { ...conversationTab, active: true, tileIndex: 0 },
      { ...terminalTab, active: false, tileIndex: 1 },
    ])

    expect(items).toEqual([conversationTab, terminalTab])
    expect(items.map((tab) => tab.kind)).toEqual(["conversation", "terminal"])
    expect(
      items.every(
        (tab) =>
          !("active" in tab) &&
          !("isActive" in tab) &&
          !("tileIndex" in tab) &&
          !("tiledTabIds" in tab)
      )
    ).toBe(true)
  })

  it("excludes device-local conversation drafts", () => {
    const items = buildPersistItems([
      conversationTab,
      {
        ...conversationTab,
        id: "new-local-draft",
        conversationId: null,
      },
      terminalTab,
    ])

    expect(items).toEqual([conversationTab, terminalTab])
  })

  it("keeps a server tab id separate from a bound draft's local runtime id", () => {
    const items = buildPersistItems([
      {
        ...conversationTab,
        id: "new-local-runtime-key",
        persistedId: "conversation:shared-42",
      },
    ])

    expect(items).toEqual([
      {
        ...conversationTab,
        id: "conversation:shared-42",
      },
    ])
    expect("persistedId" in items[0]).toBe(false)
  })

  it("persists the Agent identity only for Agent CLI terminals", () => {
    expect(buildPersistItems([{ ...terminalTab, agentType: "codex" }])).toEqual(
      [{ ...terminalTab, agentType: "codex" }]
    )
    expect(buildPersistItems([terminalTab])).toEqual([terminalTab])
  })

  it("narrows both union variants", () => {
    expect(isConversationTab(conversationTab)).toBe(true)
    expect(isTerminalTab(conversationTab)).toBe(false)
    expect(isConversationTab(terminalTab)).toBe(false)
    expect(isTerminalTab(terminalTab)).toBe(true)
  })
})
