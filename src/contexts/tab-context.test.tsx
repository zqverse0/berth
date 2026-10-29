import { act, render, screen, waitFor } from "@testing-library/react"
import { useEffect } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TabProvider, useTabContext } from "@/contexts/tab-context"
import {
  CONVERSATION_CHANGED_EVENT,
  PRIMARY_TABS_CHANGED_EVENT,
} from "@/lib/types"
import type {
  AgentType,
  ConversationChange,
  ConversationTab,
  DbConversationSummary,
  FolderDetail,
  PrimaryTab,
  PrimaryTabsChanged,
  TerminalDescriptor,
  TerminalTab,
} from "@/lib/types"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import {
  resetTabStore,
  useTabStore,
  type ConversationTabItemInternal,
} from "@/stores/tab-store"
import { _resetTerminalInventoryQuery } from "@/lib/terminal/terminal-inventory-query"

const listOpenedTabsMock = vi.fn<(...args: unknown[]) => unknown>()
// 显式返回类型：无标注时 () => [] 推断为 never[]，mockResolvedValue
// 的入参也变成 never[]，TerminalDescriptor 全部赋值失败
const listTerminalSessionsMock = vi.fn(
  async (...args: unknown[]): Promise<TerminalDescriptor[]> => {
    void args
    return []
  }
)
const saveOpenedTabsMock = vi.fn<(...args: unknown[]) => unknown>()
const getFolderConversationMock = vi.fn<(...args: unknown[]) => unknown>()
const setActiveFolderIdMock = vi.fn((id: number | null) => {
  useAppWorkspaceStore.setState({ activeFolderId: id })
})
const activateConversationPaneMock = vi.fn()
const subscribeMock = vi.fn()
const loadLastActiveContextMock = vi.fn()
const saveLastActiveContextMock = vi.fn()
const clearLastActiveContextMock = vi.fn()
// Captured `primary-tabs://changed` handler for inbound broadcasts.
let tabsChangedHandler: ((change: PrimaryTabsChanged) => void) | null = null
// Captured `conversation://changed` handler so tests can drive sub-session
// status/upsert/delete events into the open-tab summary cache.
let conversationChangedHandler: ((change: ConversationChange) => void) | null =
  null
void conversationChangedHandler

vi.mock("next-intl", () => {
  // Return a STABLE function instance across renders, mirroring next-intl's
  // real behavior. An unstable `t` would re-run effects that depend on it
  // (e.g. the hydrate effect) on every render.
  const t = (key: string) => key
  return { useTranslations: () => t }
})

vi.mock("@/lib/api", () => ({
  listPrimaryTabs: (...args: unknown[]) => listOpenedTabsMock(...args),
  listTerminalSessions: (...args: unknown[]) =>
    listTerminalSessionsMock(...args),
  savePrimaryTabs: (...args: unknown[]) => saveOpenedTabsMock(...args),
  getFolderConversation: (...args: unknown[]) =>
    getFolderConversationMock(...args),
}))

vi.mock("@/lib/platform", () => ({
  subscribe: (...args: unknown[]) => subscribeMock(...args),
}))

vi.mock("@/hooks/workspace/use-workspace-runtime", () => ({
  useWorkspaceRuntimeActions: () => ({
    activateConversationPane: activateConversationPaneMock,
  }),
}))

vi.mock("@/hooks/use-sorted-available-agents", () => ({
  useSortedAvailableAgents: () => ({
    sortedTypes: ["codex" satisfies AgentType],
    fresh: true,
  }),
}))

vi.mock("@/lib/workspace/last-active-context-storage", () => ({
  loadLastActiveContext: () => loadLastActiveContextMock(),
  saveLastActiveContext: (...args: unknown[]) =>
    saveLastActiveContextMock(...args),
  clearLastActiveContext: () => clearLastActiveContextMock(),
}))

const defaultFoldersMock: FolderDetail[] = [
  {
    id: 1,
    name: "repo",
    path: "/repo",
    git_branch: null,
    default_agent_type: "codex",
    last_opened_at: "2026-05-24T00:00:00Z",
    sort_order: 0,
    color: "blue",
    parent_id: null,
    kind: "regular",
    alias: null,
  },
  {
    id: 2,
    name: "other",
    path: "/other",
    git_branch: null,
    default_agent_type: "codex",
    last_opened_at: "2026-05-24T00:00:00Z",
    sort_order: 1,
    color: "green",
    parent_id: null,
    kind: "regular",
    alias: null,
  },
]

const defaultConversationsMock: DbConversationSummary[] = [
  {
    id: 1,
    folder_id: 1,
    title: "First",
    title_locked: false,
    agent_type: "codex",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 1,
    child_count: 0,
    created_at: "2026-05-24T00:00:00Z",
    updated_at: "2026-05-24T00:00:00Z",
    pinned_at: null,
  },
  {
    id: 2,
    folder_id: 1,
    title: "Second",
    title_locked: false,
    agent_type: "codex",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 1,
    child_count: 0,
    created_at: "2026-05-24T00:00:00Z",
    updated_at: "2026-05-24T00:00:00Z",
    pinned_at: null,
  },
  {
    id: 3,
    folder_id: 2,
    title: "Third",
    title_locked: false,
    agent_type: "codex",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 1,
    child_count: 0,
    created_at: "2026-05-24T00:00:00Z",
    updated_at: "2026-05-24T00:00:00Z",
    pinned_at: null,
  },
]

// Reset the real workspace store and seed it with the default fixtures.
// `allFolders` includes hidden chat folders that the user-facing `folders`
// list excludes; both default to the same set (no chat folders) for most
// tests. `conversationsLoading` gates the sub-session seed effect; it defaults
// to loaded (false) so most tests seed immediately. Individual tests override
// slices via `useAppWorkspaceStore.setState` (e.g. an empty root list for the
// loaded-but-empty case).
function seedWorkspaceStore() {
  resetAppWorkspaceStore()
  useAppWorkspaceStore.setState({
    conversations: defaultConversationsMock,
    conversationsLoading: false,
    folders: defaultFoldersMock,
    allFolders: defaultFoldersMock,
    foldersHydrated: true,
    setActiveFolderId: setActiveFolderIdMock,
  })
  // The tab store is a module-level singleton: reset it (state + coordination
  // vars + injected runtime + one-shot correction/recovery flags) after seeding
  // the workspace store so `lastConversations` aligns with the seeded list.
  resetTabStore()
  _resetTerminalInventoryQuery()
  listTerminalSessionsMock.mockReset().mockResolvedValue([])
}

type TestTabContext = Omit<ReturnType<typeof useTabContext>, "tabs"> & {
  tabs: ConversationTabItemInternal[]
}

let latestContext: TestTabContext | null = null

function Probe() {
  const ctx = useTabContext() as TestTabContext
  const activeTab = ctx.tabs.find((tab) => tab.id === ctx.activeTabId)
  const activeFolderId = useAppWorkspaceStore((s) => s.activeFolderId)

  useEffect(() => {
    latestContext = ctx
  }, [ctx])

  return (
    <div>
      <output data-testid="active">{ctx.activeTabId ?? "none"}</output>
      <output data-testid="tabs">
        {ctx.tabs.map((tab) => tab.id).join(",")}
      </output>
      <output data-testid="active-folder">
        {activeTab?.folderId ?? activeFolderId ?? "none"}
      </output>
    </div>
  )
}

function renderTabs() {
  latestContext = null
  return render(
    <TabProvider>
      <Probe />
    </TabProvider>
  )
}

function openConversationTab(
  folderId: number,
  conversationId: number,
  title: string
) {
  act(() => {
    latestContext?.openTab(folderId, conversationId, "codex", true, title)
  })
}

describe("TabProvider tab state transitions", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedWorkspaceStore()
    listOpenedTabsMock.mockReturnValue(new Promise(() => {}))
    saveOpenedTabsMock.mockResolvedValue({
      accepted: true,
      version: 1,
      tabs: [],
    })
    // mockReset (not just clearAllMocks) also drains any leftover
    // mockReturnValueOnce queue from a prior test so it can't leak a stale
    // (e.g. never-resolving) promise into the next test's first fetch.
    getFolderConversationMock.mockReset()
    getFolderConversationMock.mockReturnValue(new Promise(() => {}))
    tabsChangedHandler = null
    conversationChangedHandler = null
    subscribeMock.mockImplementation((event: string, handler: unknown) => {
      if (event === PRIMARY_TABS_CHANGED_EVENT)
        tabsChangedHandler = handler as (change: PrimaryTabsChanged) => void
      if (event === CONVERSATION_CHANGED_EVENT)
        conversationChangedHandler = handler as (
          change: ConversationChange
        ) => void
      return Promise.resolve(() => {})
    })
  })

  it("activates the neighboring tab when another tab update is already queued", () => {
    renderTabs()

    expect(latestContext).not.toBeNull()

    openConversationTab(1, 1, "First")
    openConversationTab(1, 2, "Second")
    act(() => {
      latestContext?.switchTab("conv-1-codex-1")
    })

    expect(screen.getByTestId("active")).toHaveTextContent("conv-1-codex-1")

    act(() => {
      latestContext?.setTabRuntimeConversationId("conv-1-codex-1", -1)
      latestContext?.closeTab("conv-1-codex-1")
    })

    expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-2")
    expect(screen.getByTestId("active")).toHaveTextContent("conv-1-codex-2")
  })

  it("keeps the current active tab when closing an inactive tab", () => {
    renderTabs()

    expect(latestContext).not.toBeNull()

    openConversationTab(1, 1, "First")
    openConversationTab(1, 2, "Second")
    act(() => {
      latestContext?.switchTab("conv-1-codex-1")
    })

    expect(screen.getByTestId("active")).toHaveTextContent("conv-1-codex-1")

    act(() => {
      latestContext?.closeTab("conv-1-codex-2")
    })

    expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-1")
    expect(screen.getByTestId("active")).toHaveTextContent("conv-1-codex-1")
  })

  it("leaves no active tab when closing the last session in a folder", () => {
    renderTabs()

    expect(latestContext).not.toBeNull()

    openConversationTab(1, 1, "First")

    act(() => {
      latestContext?.closeTab("conv-1-codex-1")
    })

    expect(screen.getByTestId("active")).toHaveTextContent("none")
    expect(screen.getByTestId("tabs").textContent).toBe("")
  })

  it("clears the active tab when closing the last tab with no folders available", () => {
    act(() => {
      useAppWorkspaceStore.setState({ folders: [], allFolders: [] })
    })
    renderTabs()

    expect(latestContext).not.toBeNull()

    openConversationTab(1, 1, "First")

    act(() => {
      latestContext?.closeTab("conv-1-codex-1")
    })

    expect(screen.getByTestId("tabs")).toHaveTextContent("")
    expect(screen.getByTestId("active")).toHaveTextContent("none")
  })

  it("activates a remaining tab when closing a folder after switching to one of its tabs in the same batch", () => {
    renderTabs()

    expect(latestContext).not.toBeNull()

    openConversationTab(1, 1, "First")
    openConversationTab(1, 2, "Second")
    openConversationTab(2, 3, "Third")
    act(() => {
      latestContext?.switchTab("conv-2-codex-3")
    })

    expect(screen.getByTestId("active")).toHaveTextContent("conv-2-codex-3")

    act(() => {
      latestContext?.switchTab("conv-1-codex-1")
      latestContext?.closeTabsByFolder(1)
    })

    expect(screen.getByTestId("tabs")).toHaveTextContent("conv-2-codex-3")
    expect(screen.getByTestId("active")).toHaveTextContent("conv-2-codex-3")
  })

  it("ignores closeOtherTabs when its target was removed earlier in the same batch", () => {
    renderTabs()

    expect(latestContext).not.toBeNull()

    openConversationTab(1, 1, "First")
    openConversationTab(1, 2, "Second")

    act(() => {
      latestContext?.closeTab("conv-1-codex-1")
      latestContext?.closeOtherTabs("conv-1-codex-1")
    })

    expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-2")
    expect(screen.getByTestId("active")).toHaveTextContent("conv-1-codex-2")
  })

  it("keeps an existing draft active when reopening a draft after closing it in the same batch", () => {
    renderTabs()

    expect(latestContext).not.toBeNull()

    act(() => {
      latestContext?.openNewConversationTab(1, "/repo")
    })

    const draftTabId = latestContext?.activeTabId
    expect(draftTabId).toMatch(/^new-/)

    act(() => {
      latestContext?.closeTab(draftTabId!)
      latestContext?.openNewConversationTab(1, "/repo")
    })

    const activeId = latestContext?.activeTabId ?? ""
    expect(activeId).toMatch(/^new-/)
    expect(screen.getByTestId("active")).toHaveTextContent(activeId)
    expect(screen.getByTestId("tabs")).toHaveTextContent(activeId)
  })

  it("redirects a new-conversation action targeting a hidden chat folder to chat mode", () => {
    // The open-folder list (`folders`) excludes chat folders after refetch, but
    // `allFolders` keeps them — chat detection must read `allFolders`, else a
    // "new conversation" from an active chat conversation would pile a normal
    // draft onto the hidden per-conversation chat folder.
    const chatFolder: FolderDetail = {
      id: 42,
      name: "Chat",
      path: "/data/chat-sessions/x",
      git_branch: null,
      default_agent_type: null,
      last_opened_at: "2026-06-11T00:00:00Z",
      sort_order: 99,
      color: "inherit",
      parent_id: null,
      kind: "chat",
      alias: null,
    }
    act(() => {
      useAppWorkspaceStore.setState({
        folders: defaultFoldersMock,
        allFolders: [...defaultFoldersMock, chatFolder],
      })
    })
    renderTabs()
    expect(latestContext).not.toBeNull()

    act(() => {
      latestContext?.openNewConversationTab(42, "/data/chat-sessions/x")
    })

    const activeId = latestContext?.activeTabId ?? ""
    const draft = latestContext?.tabs.find((t) => t.id === activeId)
    expect(activeId).toMatch(/^new-/)
    expect(draft?.isChat).toBe(true)
    expect(draft?.folderId).toBe(0)
  })

  it("returns to the project workspace when closing a bound chat tab", () => {
    const chatFolder: FolderDetail = {
      id: 42,
      name: "Chat",
      path: "/data/chat-sessions/x",
      git_branch: null,
      default_agent_type: null,
      last_opened_at: "2026-06-11T00:00:00Z",
      sort_order: 99,
      color: "inherit",
      parent_id: null,
      kind: "chat",
      alias: null,
    }
    act(() => {
      useAppWorkspaceStore.setState({
        folders: defaultFoldersMock, // open list excludes the chat folder
        allFolders: [...defaultFoldersMock, chatFolder],
      })
    })
    renderTabs()
    expect(latestContext).not.toBeNull()

    act(() => {
      latestContext?.openTab(42, 5, "codex", true, "chat conversation")
    })
    act(() => {
      latestContext?.closeTab("conv-42-codex-5")
    })

    const repl = latestContext?.tabs.find(
      (t) => t.id === latestContext?.activeTabId
    )
    expect(repl).toBeUndefined()
    expect(latestContext?.activeTabId).toBeNull()
  })

  it("opens a new draft in the target folder after closing the previous draft", async () => {
    renderTabs()

    expect(latestContext).not.toBeNull()

    act(() => {
      latestContext?.openNewConversationTab(1, "/repo")
    })

    const draftTabId = latestContext?.activeTabId
    expect(draftTabId).toMatch(/^new-/)

    act(() => {
      latestContext?.closeTab(draftTabId!)
      latestContext?.openNewConversationTab(2, "/other")
    })

    const nextDraftId = latestContext?.activeTabId ?? ""
    expect(nextDraftId).toMatch(/^new-/)
    expect(nextDraftId).not.toBe(draftTabId)
    expect(screen.getByTestId("active")).toHaveTextContent(nextDraftId)
    expect(screen.getByTestId("tabs")).toHaveTextContent(nextDraftId)

    await waitFor(() => {
      expect(screen.getByTestId("active-folder")).toHaveTextContent("2")
    })
  })

  it("can create a draft tab without stealing the active project surface", () => {
    renderTabs()
    expect(latestContext).not.toBeNull()

    openConversationTab(1, 1, "First")
    expect(screen.getByTestId("active")).toHaveTextContent("conv-1-codex-1")
    activateConversationPaneMock.mockClear()

    act(() => {
      latestContext?.openNewConversationTab(1, "/repo", { activate: false })
    })

    const tabsText = screen.getByTestId("tabs").textContent ?? ""
    expect(tabsText).toMatch(/new-/)
    expect(screen.getByTestId("active")).toHaveTextContent("conv-1-codex-1")
    expect(activateConversationPaneMock).not.toHaveBeenCalled()
  })

  it("applies the supplied folderDefaultAgent for a folder not in the open list", () => {
    // Regression: navigating a branch switch to a just-reopened (closed) folder
    // passes that folder's saved default agent explicitly, because `foldersRef`
    // only catches up on the next render. Folder 999 is absent from the
    // provider's folders, so without the override the draft would fall back to
    // sortedTypes[0] ("codex"); the override must win.
    renderTabs()
    expect(latestContext).not.toBeNull()

    act(() => {
      latestContext?.openNewConversationTab(999, "/closed-wt", {
        folderDefaultAgent: "claude_code",
      })
    })

    const activeId = latestContext?.activeTabId
    const draft = latestContext?.tabs.find((tab) => tab.id === activeId)
    expect(draft?.folderId).toBe(999)
    expect(draft?.agentType).toBe("claude_code")
  })

  it("activates an opened tab when another tab update is already queued", () => {
    renderTabs()

    expect(latestContext).not.toBeNull()

    openConversationTab(1, 1, "First")

    expect(screen.getByTestId("active")).toHaveTextContent("conv-1-codex-1")

    act(() => {
      latestContext?.setTabRuntimeConversationId("conv-1-codex-1", -1)
      latestContext?.openTab(1, 2, "codex", true, "Second")
    })

    expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-1")
    expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-2")
    expect(screen.getByTestId("active")).toHaveTextContent("conv-1-codex-2")
  })

  it("keeps the retained draft tab active when binding it over an existing duplicate conversation tab", () => {
    renderTabs()

    expect(latestContext).not.toBeNull()

    openConversationTab(1, 1, "First")
    act(() => {
      latestContext?.openNewConversationTab(1, "/repo")
    })

    const draftTabId = latestContext?.activeTabId
    expect(draftTabId).toMatch(/^new-/)

    act(() => {
      latestContext?.setTabRuntimeConversationId(draftTabId!, -1)
      latestContext?.bindConversationTab(draftTabId!, 1, "codex", "First", -1)
    })

    expect(screen.getByTestId("tabs")).toHaveTextContent(draftTabId!)
    expect(screen.getByTestId("tabs").textContent).not.toContain(
      "conv-1-codex-1"
    )
    expect(screen.getByTestId("active")).toHaveTextContent(draftTabId!)
  })
})

function tabItem(
  folderId: number,
  conversationId: number,
  _isActive = false
): ConversationTab {
  void _isActive
  return {
    kind: "conversation",
    id: `conv-${folderId}-codex-${conversationId}`,
    folderId,
    conversationId,
    agentType: "codex",
    title: `Conversation ${conversationId}`,
    isPinned: true,
  }
}

function terminalTab(terminalId: string, folderId = 1): TerminalTab {
  return {
    kind: "terminal",
    id: `terminal:${terminalId}`,
    terminalId,
    backendInstanceId: "backend-a",
    folderId,
    title: "Terminal",
    initialCwd: "/repo",
    shell: "/bin/bash",
    detachedFolderLabel: null,
    detachedFolderPath: null,
    isPinned: false,
  }
}

describe("TabProvider terminal-first persistence sync", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedWorkspaceStore()
    listOpenedTabsMock.mockResolvedValue({ items: [], version: 0 })
    listTerminalSessionsMock.mockReset().mockResolvedValue([])
    saveOpenedTabsMock.mockResolvedValue({
      accepted: true,
      version: 1,
      tabs: [],
    })
    getFolderConversationMock.mockReset()
    getFolderConversationMock.mockReturnValue(new Promise(() => {}))
    tabsChangedHandler = null
    conversationChangedHandler = null
    subscribeMock.mockImplementation((event: string, handler: unknown) => {
      if (event === PRIMARY_TABS_CHANGED_EVENT)
        tabsChangedHandler = handler as (change: PrimaryTabsChanged) => void
      if (event === CONVERSATION_CHANGED_EVENT)
        conversationChangedHandler = handler as (
          change: ConversationChange
        ) => void
      return Promise.resolve(() => {})
    })
  })

  function descriptorFromTab(tab: TerminalTab): TerminalDescriptor {
    return {
      terminalId: tab.terminalId,
      backendInstanceId: tab.backendInstanceId,
      folderId: tab.folderId,
      title: tab.title,
      initialCwd: tab.initialCwd,
      shell: tab.shell,
      status: "running",
      processId: 42,
      createdAt: "2026-08-11T00:00:00.000Z",
      exitedAt: null,
    }
  }

  async function renderHydrated() {
    renderTabs()
    await waitFor(() =>
      expect(useTabStore.getState().terminalInventoryHasSnapshot).toBe(true)
    )
  }

  it("never overwrites server tabs when hydration failed", async () => {
    // A failed read must not let the empty local state be saved over the
    // server's primary tabs (conversation tabs only live there).
    listOpenedTabsMock.mockRejectedValue(new Error("transport disconnected"))
    listTerminalSessionsMock.mockResolvedValue([
      descriptorFromTab(terminalTab("term-after-failed-hydrate")),
    ])
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {})

    try {
      await renderHydrated()
      await act(async () => {
        await new Promise((r) => setTimeout(r, 700))
      })

      expect(saveOpenedTabsMock).not.toHaveBeenCalled()
    } finally {
      errorSpy.mockRestore()
    }
  })

  it("restores persisted ConversationTabs together with live terminal descriptors", async () => {
    const terminal = terminalTab("term-live")
    listOpenedTabsMock.mockResolvedValue({
      items: [tabItem(1, 1), terminal],
      version: 3,
    })
    listTerminalSessionsMock.mockResolvedValue([descriptorFromTab(terminal)])

    await renderHydrated()

    expect(screen.getByTestId("tabs")).toHaveTextContent("terminal:term-live")
    expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-1")
  })

  it("applies remote persisted ConversationTabs as shared primary-tab truth", async () => {
    await renderHydrated()
    openConversationTab(1, 1, "Local")
    saveOpenedTabsMock.mockClear()

    act(() => {
      tabsChangedHandler?.({
        version: 2,
        origin: "remote",
        tabs: [tabItem(1, 2)],
      })
    })

    expect(screen.getByTestId("tabs")).not.toHaveTextContent("conv-1-codex-1")
    expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-2")
    expect(saveOpenedTabsMock).not.toHaveBeenCalled()
  })

  it("keeps inventory-discovered terminals that a remote preference snapshot omits", async () => {
    const first = terminalTab("term-first")
    const second = terminalTab("term-second")
    listTerminalSessionsMock.mockResolvedValue([
      descriptorFromTab(first),
      descriptorFromTab(second),
    ])
    await renderHydrated()

    act(() => {
      tabsChangedHandler?.({
        version: 2,
        origin: "remote",
        tabs: [first],
      })
    })

    expect(screen.getByTestId("tabs")).toHaveTextContent(
      "terminal:term-first,terminal:term-second"
    )
  })

  it("persists a locally opened bound ConversationTab", async () => {
    const terminal = terminalTab("term-only")
    listTerminalSessionsMock.mockResolvedValue([descriptorFromTab(terminal)])
    await renderHydrated()
    await waitFor(() => expect(saveOpenedTabsMock).toHaveBeenCalled())
    saveOpenedTabsMock.mockClear()

    openConversationTab(1, 1, "Transient")
    act(() => latestContext?.pinTab("terminal:term-only"))

    await waitFor(() => expect(saveOpenedTabsMock).toHaveBeenCalled())
    const saved = saveOpenedTabsMock.mock.calls[
      saveOpenedTabsMock.mock.calls.length - 1
    ]?.[0] as PrimaryTab[]
    expect(saved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "terminal",
          terminalId: "term-only",
        }),
        expect.objectContaining({
          kind: "conversation",
          conversationId: 1,
        }),
      ])
    )
  })
})

describe("TabProvider post-hydration recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedWorkspaceStore()
    // Draft-only sessions persist nothing, so a fresh launch hydrates empty.
    listOpenedTabsMock.mockResolvedValue({ items: [], version: 0 })
    saveOpenedTabsMock.mockResolvedValue({
      accepted: true,
      version: 1,
      tabs: [],
    })
    loadLastActiveContextMock.mockReturnValue(null)
    tabsChangedHandler = null
    subscribeMock.mockImplementation(
      (event: string, handler: (change: PrimaryTabsChanged) => void) => {
        if (event === PRIMARY_TABS_CHANGED_EVENT) tabsChangedHandler = handler
        return Promise.resolve(() => {})
      }
    )
  })

  async function renderHydrated() {
    renderTabs()
    await act(async () => {})
  }

  function activeTab() {
    return latestContext?.tabs.find((t) => t.id === latestContext?.activeTabId)
  }

  it("restores the hinted folder when it still exists", async () => {
    loadLastActiveContextMock.mockReturnValue({
      folderId: 2,
      isChat: false,
    })
    await renderHydrated()
    await waitFor(() =>
      expect(screen.getByTestId("active-folder")).toHaveTextContent("2")
    )
    expect(activeTab()).toBeUndefined()
  })

  it("falls back to the first folder when the hinted folder is gone", async () => {
    loadLastActiveContextMock.mockReturnValue({
      folderId: 999,
      isChat: false,
    })
    await renderHydrated()
    await waitFor(() =>
      expect(screen.getByTestId("active-folder")).toHaveTextContent("1")
    )
    expect(activeTab()).toBeUndefined()
  })

  it("does not restore a chat Agent draft from the device-local hint", async () => {
    loadLastActiveContextMock.mockReturnValue({
      folderId: 0,
      isChat: true,
    })
    await renderHydrated()
    await waitFor(() =>
      expect(screen.getByTestId("active-folder")).toHaveTextContent("1")
    )
    expect(activeTab()).toBeUndefined()
  })

  it("does not materialize conversations loaded for the active folder", async () => {
    act(() => {
      useAppWorkspaceStore.setState({ conversations: [] })
    })
    await renderHydrated()

    await waitFor(() =>
      expect(screen.getByTestId("active-folder")).toHaveTextContent("1")
    )

    act(() => {
      useAppWorkspaceStore.setState({ conversations: defaultConversationsMock })
    })

    await waitFor(() =>
      expect(latestContext?.tabs.map((tab) => tab.id)).toEqual([])
    )
  })

  it("activates the first folder when there is no hint and can materialize historical tabs", async () => {
    await renderHydrated()
    await waitFor(() =>
      expect(screen.getByTestId("active-folder")).toHaveTextContent("1")
    )
    act(() => latestContext?.ensureFolderConversationTabs(1))
    await waitFor(() =>
      expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-1")
    )
    expect(latestContext?.tabs.map((tab) => tab.id)).toEqual(
      expect.arrayContaining(["conv-1-codex-1", "conv-1-codex-2"])
    )
    expect(latestContext?.tabs.map((tab) => tab.id)).not.toContain(
      "conv-2-codex-3"
    )
  })

  it("materializes an exact folder's historical tabs idempotently", async () => {
    await renderHydrated()
    act(() => latestContext?.ensureFolderConversationTabs(1))
    await waitFor(() =>
      expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-2")
    )

    act(() => {
      latestContext?.ensureFolderConversationTabs(2)
      latestContext?.ensureFolderConversationTabs(2)
    })

    const ids = latestContext?.tabs.map((tab) => tab.id) ?? []
    expect(ids).toContain("conv-2-codex-3")
    expect(ids.filter((id) => id === "conv-2-codex-3")).toHaveLength(1)
    expect(ids.filter((id) => id === "conv-1-codex-1")).toHaveLength(1)
    expect(ids.filter((id) => id === "conv-1-codex-2")).toHaveLength(1)
  })

  it("keeps the normal empty shell without synthesizing an Agent draft when there are no folders", async () => {
    act(() => {
      useAppWorkspaceStore.setState({ folders: [], allFolders: [] })
    })
    await renderHydrated()
    await waitFor(() =>
      expect(useTabStore.getState().terminalInventoryResolved).toBe(true)
    )
    expect(screen.getByTestId("active")).toHaveTextContent("none")
    expect(screen.getByTestId("tabs").textContent).toBe("")
  })

  it("retains the active folder when a remote ConversationTab arrives", async () => {
    await renderHydrated()
    await waitFor(() =>
      expect(screen.getByTestId("active-folder")).toHaveTextContent("1")
    )
    act(() => {
      tabsChangedHandler?.({ version: 1, origin: "x", tabs: [tabItem(1, 1)] })
    })
    expect(latestContext?.tabs.map((tab) => tab.id)).toEqual(["conv-1-codex-1"])
    expect(screen.getByTestId("active-folder")).toHaveTextContent("1")
  })

  it("persists the active project's context for the next launch", async () => {
    await renderHydrated()
    await waitFor(() =>
      expect(saveLastActiveContextMock).toHaveBeenCalledWith(
        expect.objectContaining({ folderId: 1, isChat: false })
      )
    )
  })

  it("persists the active real conversation for restart recovery", async () => {
    await renderHydrated()
    saveLastActiveContextMock.mockClear()
    act(() => {
      latestContext?.openTab(1, 1, "codex", true, "First")
      latestContext?.switchTab("conv-1-codex-1")
    })
    await waitFor(() =>
      expect(saveLastActiveContextMock).toHaveBeenCalledWith(
        expect.objectContaining({
          folderId: 1,
          isChat: false,
          primaryTabId: "conv-1-codex-1",
        })
      )
    )
  })

  it("keeps a persisted ConversationTab while recovering the hinted folder", async () => {
    listOpenedTabsMock.mockResolvedValue({
      items: [tabItem(1, 1, true)],
      version: 1,
    })
    loadLastActiveContextMock.mockReturnValue({
      folderId: 2,
      isChat: false,
    })
    await renderHydrated()
    await waitFor(() =>
      expect(screen.getByTestId("active-folder")).toHaveTextContent("2")
    )
    expect(screen.getByTestId("tabs")).toHaveTextContent("conv-1-codex-1")
  })
})

describe("TabProvider sub-session tabs", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedWorkspaceStore()
    // No hydration noise — open the sub-session tab imperatively instead.
    listOpenedTabsMock.mockReturnValue(new Promise(() => {}))
    saveOpenedTabsMock.mockResolvedValue({
      accepted: true,
      version: 1,
      tabs: [],
    })
    // mockReset (not just clearAllMocks) also drains any leftover
    // mockReturnValueOnce queue from a prior test so it can't leak a stale
    // (e.g. never-resolving) promise into the next test's first fetch.
    getFolderConversationMock.mockReset()
    getFolderConversationMock.mockReturnValue(new Promise(() => {}))
    tabsChangedHandler = null
    conversationChangedHandler = null
    subscribeMock.mockImplementation((event: string, handler: unknown) => {
      if (event === PRIMARY_TABS_CHANGED_EVENT)
        tabsChangedHandler = handler as (change: PrimaryTabsChanged) => void
      if (event === CONVERSATION_CHANGED_EVENT)
        conversationChangedHandler = handler as (
          change: ConversationChange
        ) => void
      return Promise.resolve(() => {})
    })
  })

  function subSummary(
    overrides: Partial<DbConversationSummary> = {}
  ): DbConversationSummary {
    return {
      id: 99,
      folder_id: 1,
      title: "Review the auth module",
      title_locked: false,
      agent_type: "codex",
      kind: "delegate",
      model: null,
      git_branch: null,
      external_id: null,
      message_count: 0,
      child_count: 0,
      created_at: "2026-05-24T00:00:00Z",
      updated_at: "2026-05-24T00:00:00Z",
      pinned_at: null,
      parent_id: 1,
      ...overrides,
    }
  }

  it("does not fetch a summary for a root conversation tab (resolved from the list)", async () => {
    // Id 1 IS a root in the conversations list, so the tab resolves from there
    // and the sub-session seed fetch must never fire for it.
    renderTabs()
    await act(async () => {})
    act(() => {
      latestContext?.openTab(1, 1, "codex", true)
    })
    await act(async () => {})
    expect(getFolderConversationMock).not.toHaveBeenCalled()
    expect(
      latestContext?.tabs.find((tab) => tab.conversationId === 1)?.title
    ).toBe("First")
  })

  it("seeds an open child tab even when the (loaded) root list is empty", async () => {
    // Loaded-but-empty root list: the seed must still fire (gated on loading, not
    // on conversationMap.size, which an old `size === 0` guard would skip).
    act(() => {
      useAppWorkspaceStore.setState({
        conversations: [],
        conversationsLoading: false,
      })
    })
    getFolderConversationMock.mockResolvedValue({
      summary: subSummary(),
      turns: [],
      session_stats: null,
    })
    renderTabs()
    await act(async () => {})
    act(() => {
      latestContext?.openTab(1, 99, "codex", true)
    })
    await act(async () => {})
    expect(getFolderConversationMock).toHaveBeenCalledWith(99)
    expect(
      latestContext?.tabs.find((tab) => tab.conversationId === 99)?.title
    ).toBe("Review the auth module")
  })

  it("does not seed while the root list is still loading", async () => {
    act(() => {
      useAppWorkspaceStore.setState({ conversationsLoading: true })
    })
    renderTabs()
    await act(async () => {})
    act(() => {
      latestContext?.openTab(1, 99, "codex", true)
    })
    await act(async () => {})
    expect(getFolderConversationMock).not.toHaveBeenCalled()
  })

  it("prunes a child tab's cached summary when the tab closes (so a reopen refetches)", async () => {
    getFolderConversationMock.mockResolvedValue({
      summary: subSummary(),
      turns: [],
      session_stats: null,
    })
    renderTabs()
    await act(async () => {})
    act(() => {
      latestContext?.openTab(1, 99, "codex", true)
    })
    await act(async () => {})
    expect(getFolderConversationMock).toHaveBeenCalledTimes(1)
    const tabId = latestContext?.tabs.find(
      (tab) => tab.conversationId === 99
    )?.id
    act(() => {
      latestContext?.closeTab(tabId!)
    })
    await act(async () => {})
    // Reopen → a pruned cache forces a fresh fetch (a leaked entry would not).
    act(() => {
      latestContext?.openTab(1, 99, "codex", true)
    })
    await act(async () => {})
    expect(getFolderConversationMock).toHaveBeenCalledTimes(2)
  })

  it("only seeds the active unresolved tab when multiple unresolved tabs exist (no fan-out)", async () => {
    // Simulate startup with multiple persisted unresolved conversation tabs.
    // Only the active one should trigger a detail fetch; the others must wait.
    getFolderConversationMock.mockResolvedValue({
      summary: subSummary(),
      turns: [],
      session_stats: null,
    })
    renderTabs()
    await act(async () => {})
    // Open three unresolved tabs; the last one opened is active by default.
    act(() => {
      latestContext?.openTab(1, 90, "codex", false, "Ninety")
      latestContext?.openTab(1, 91, "codex", false, "Ninety-one")
      latestContext?.openTab(1, 92, "codex", true, "Ninety-two")
    })
    await act(async () => {})
    // Only the active tab (92) should have been fetched.
    const calledIds = getFolderConversationMock.mock.calls.map(
      (c: unknown[]) => c[0]
    )
    expect(calledIds).toEqual([92])
    expect(getFolderConversationMock).toHaveBeenCalledTimes(1)
  })

  it("seeds the next active unresolved tab after switching to it", async () => {
    getFolderConversationMock.mockResolvedValue({
      summary: subSummary(),
      turns: [],
      session_stats: null,
    })
    renderTabs()
    await act(async () => {})
    // Open two unresolved tabs; the second is active.
    act(() => {
      latestContext?.openTab(1, 90, "codex", false, "Ninety")
      latestContext?.openTab(1, 91, "codex", true, "Ninety-one")
    })
    await act(async () => {})
    expect(getFolderConversationMock).toHaveBeenCalledTimes(1)
    expect(getFolderConversationMock.mock.calls[0][0]).toBe(91)
    // Switch active tab to the other unresolved one.
    act(() => {
      latestContext?.switchTab(
        latestContext!.tabs.find((t) => t.conversationId === 90)!.id
      )
    })
    await act(async () => {})
    // Now tab 90 should also have been seeded.
    expect(getFolderConversationMock).toHaveBeenCalledTimes(2)
    expect(getFolderConversationMock.mock.calls[1][0]).toBe(90)
  })

  it("does not seed a non-active unresolved tab even after conversations refresh", async () => {
    getFolderConversationMock.mockResolvedValue({
      summary: subSummary(),
      turns: [],
      session_stats: null,
    })
    renderTabs()
    await act(async () => {})
    // Open two unresolved tabs; only the active one (92) should seed.
    act(() => {
      latestContext?.openTab(1, 91, "codex", false, "Ninety-one")
      latestContext?.openTab(1, 92, "codex", true, "Ninety-two")
    })
    await act(async () => {})
    expect(getFolderConversationMock).toHaveBeenCalledTimes(1)
    expect(getFolderConversationMock.mock.calls[0][0]).toBe(92)
    // Simulate a conversations refresh (e.g. reconnect or folder switch).
    act(() => {
      useAppWorkspaceStore.setState({
        conversations: [...defaultConversationsMock],
      })
    })
    await act(async () => {})
    // Still only one fetch — the non-active tab 91 must not have been seeded.
    expect(getFolderConversationMock).toHaveBeenCalledTimes(1)
  })
})

describe("TabProvider save_primary_tabs error diagnostic", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedWorkspaceStore()
    listOpenedTabsMock.mockResolvedValue({ items: [], version: 0 })
    listTerminalSessionsMock.mockReset().mockResolvedValue([])
    getFolderConversationMock.mockReset()
    getFolderConversationMock.mockReturnValue(new Promise(() => {}))
    tabsChangedHandler = null
    conversationChangedHandler = null
    subscribeMock.mockImplementation(
      (
        event: string,
        handler: (change: PrimaryTabsChanged | ConversationChange) => void
      ) => {
        if (event === PRIMARY_TABS_CHANGED_EVENT)
          tabsChangedHandler = handler as (change: PrimaryTabsChanged) => void
        if (event === CONVERSATION_CHANGED_EVENT)
          conversationChangedHandler = handler as (
            change: ConversationChange
          ) => void
        return Promise.resolve(() => {})
      }
    )
  })

  function descriptorForPersistableTerminal(): TerminalDescriptor {
    return {
      terminalId: "term-diag",
      backendInstanceId: "backend-1",
      folderId: 1,
      title: "sensitive-title",
      initialCwd: "/sensitive/path",
      shell: "/bin/bash",
      status: "running",
      processId: 42,
      createdAt: "2026-08-11T00:00:00.000Z",
      exitedAt: null,
    }
  }

  it("logs a safe diagnostic on transport rejection without sensitive payload", async () => {
    // Arrange: save rejects with an AppCommandError-shaped error.
    const appCommandError = {
      code: "database_error",
      message: "database is locked",
      detail: "SqliteError: database is locked (os error 5)",
    }
    saveOpenedTabsMock.mockRejectedValue(appCommandError)

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    listTerminalSessionsMock.mockResolvedValue([
      descriptorForPersistableTerminal(),
    ])

    try {
      renderTabs()
      await waitFor(() =>
        expect(useTabStore.getState().terminalInventoryHasSnapshot).toBe(true)
      )
      // Wait for the 500 ms debounce + save attempt.
      await waitFor(() => expect(saveOpenedTabsMock).toHaveBeenCalled(), {
        timeout: 3000,
      })
      // Allow the rejection to propagate into the catch handler.
      await act(async () => {
        await new Promise((r) => setTimeout(r, 100))
      })

      // Assert: console.warn was called with a safe diagnostic.
      const warnCalls = warnSpy.mock.calls.map((c) =>
        c.map((v) => String(v)).join(" ")
      )
      const saveWarn = warnCalls.find((msg) =>
        msg.includes("save_primary_tabs")
      )
      expect(saveWarn).toBeDefined()
      expect(saveWarn).toContain("phase=save")
      expect(saveWarn).toContain("type=AppCommandError")
      expect(saveWarn).toContain("code=database_error")
      expect(saveWarn).toContain("database is locked")
      expect(saveWarn).toContain(
        "detail=SqliteError: database is locked (os error 5)"
      )

      // Assert: no sensitive payload content leaked into ANY warn call.
      const allWarnText = warnCalls.join(" ")
      expect(allWarnText).not.toContain("term-diag")
      expect(allWarnText).not.toContain("sensitive-title")
      expect(allWarnText).not.toContain("/sensitive/path")
      expect(allWarnText).not.toContain("backend-1")
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("logs a safe diagnostic on generic Error without sensitive payload", async () => {
    // Arrange: save rejects with a plain Error (transport disconnect shape).
    saveOpenedTabsMock.mockRejectedValue(new Error("transport disconnected"))

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    listTerminalSessionsMock.mockResolvedValue([
      descriptorForPersistableTerminal(),
    ])

    try {
      renderTabs()
      await waitFor(() =>
        expect(useTabStore.getState().terminalInventoryHasSnapshot).toBe(true)
      )
      await waitFor(() => expect(saveOpenedTabsMock).toHaveBeenCalled(), {
        timeout: 3000,
      })
      await act(async () => {
        await new Promise((r) => setTimeout(r, 100))
      })

      const warnCalls = warnSpy.mock.calls.map((c) =>
        c.map((v) => String(v)).join(" ")
      )
      const saveWarn = warnCalls.find((msg) =>
        msg.includes("save_primary_tabs")
      )
      expect(saveWarn).toBeDefined()
      expect(saveWarn).toContain("phase=save")
      expect(saveWarn).toContain("type=Error")
      expect(saveWarn).toContain("transport disconnected")
      // No code or detail field for plain Error.
      expect(saveWarn).not.toContain("code=")
      expect(saveWarn).not.toContain("detail=")

      // No sensitive content.
      const allWarnText = warnCalls.join(" ")
      expect(allWarnText).not.toContain("term-diag")
      expect(allWarnText).not.toContain("sensitive-title")
      expect(allWarnText).not.toContain("/sensitive/path")
    } finally {
      warnSpy.mockRestore()
    }
  })
})

describe("TabProvider projection stability and save storm prevention", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedWorkspaceStore()
    listOpenedTabsMock.mockResolvedValue({ items: [], version: 0 })
    saveOpenedTabsMock.mockResolvedValue({
      accepted: true,
      version: 1,
      tabs: [],
    })
    getFolderConversationMock.mockReset()
    getFolderConversationMock.mockReturnValue(new Promise(() => {}))
    tabsChangedHandler = null
    conversationChangedHandler = null
    subscribeMock.mockImplementation((event: string, handler: unknown) => {
      if (event === PRIMARY_TABS_CHANGED_EVENT)
        tabsChangedHandler = handler as (change: PrimaryTabsChanged) => void
      if (event === CONVERSATION_CHANGED_EVENT)
        conversationChangedHandler = handler as (
          change: ConversationChange
        ) => void
      return Promise.resolve(() => {})
    })
  })

  function stableDescriptor(terminalId: string): TerminalDescriptor {
    return {
      terminalId,
      backendInstanceId: "backend-a",
      folderId: 1,
      title: "Terminal",
      initialCwd: "/repo",
      shell: "/bin/bash",
      status: "running",
      processId: 42,
      createdAt: "2026-08-11T00:00:00.000Z",
      exitedAt: null,
    }
  }

  it("does not call savePrimaryTabs when the same inventory is published repeatedly", async () => {
    const descriptor = stableDescriptor("term-stable")
    listTerminalSessionsMock.mockResolvedValue([descriptor])

    renderTabs()
    // Wait for hydration + first inventory + first save.
    await waitFor(
      () => {
        expect(useTabStore.getState().terminalInventoryHasSnapshot).toBe(true)
      },
      { timeout: 3000 }
    )
    // Wait for the initial save to complete.
    await waitFor(() => expect(saveOpenedTabsMock).toHaveBeenCalled(), {
      timeout: 3000,
    })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 600))
    })

    const callsAfterInitial = saveOpenedTabsMock.mock.calls.length

    // Simulate 5 more identical inventory refreshes (what the old 1.5s poll
    // would have done repeatedly).
    for (let i = 0; i < 5; i++) {
      const { refreshTerminalInventory } =
        await import("@/lib/terminal/terminal-inventory-query")
      await act(async () => {
        await refreshTerminalInventory()
        await new Promise((r) => setTimeout(r, 100))
      })
    }

    // No additional saves should have been triggered.
    expect(saveOpenedTabsMock.mock.calls.length).toBe(callsAfterInitial)
  })

  it("does not re-save after a transport rejection when the same inventory is refreshed", async () => {
    const descriptor = stableDescriptor("term-reject")
    listTerminalSessionsMock.mockResolvedValue([descriptor])
    // First save succeeds, then all subsequent saves reject.
    saveOpenedTabsMock
      .mockResolvedValueOnce({ accepted: true, version: 1, tabs: [] })
      .mockRejectedValue(new Error("transport disconnected"))

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    try {
      renderTabs()
      await waitFor(
        () => {
          expect(useTabStore.getState().terminalInventoryHasSnapshot).toBe(true)
        },
        { timeout: 3000 }
      )
      // Wait for initial save + rejection.
      await waitFor(() => expect(saveOpenedTabsMock).toHaveBeenCalled(), {
        timeout: 3000,
      })
      await act(async () => {
        await new Promise((r) => setTimeout(r, 700))
      })

      const callsAfterRejection = saveOpenedTabsMock.mock.calls.length

      // Simulate more identical inventory refreshes — none should trigger saves.
      for (let i = 0; i < 5; i++) {
        const { refreshTerminalInventory } =
          await import("@/lib/terminal/terminal-inventory-query")
        await act(async () => {
          await refreshTerminalInventory()
          await new Promise((r) => setTimeout(r, 100))
        })
      }

      // No additional saves after the rejection.
      expect(saveOpenedTabsMock.mock.calls.length).toBe(callsAfterRejection)
    } finally {
      warnSpy.mockRestore()
    }
  })

  it("converges after a CAS rejection without ping-pong", async () => {
    const descriptor = stableDescriptor("term-cas")
    listTerminalSessionsMock.mockResolvedValue([descriptor])
    // First save succeeds. Second returns CAS rejection with server truth.
    saveOpenedTabsMock
      .mockResolvedValueOnce({ accepted: true, version: 1, tabs: [] })
      .mockResolvedValueOnce({
        accepted: false,
        version: 2,
        tabs: [
          {
            kind: "terminal",
            id: "terminal:term-cas",
            terminalId: "term-cas",
            backendInstanceId: "backend-a",
            folderId: 1,
            title: "Server Title",
            initialCwd: "/repo",
            shell: "/bin/bash",
            detachedFolderLabel: null,
            detachedFolderPath: null,
            isPinned: false,
          },
        ],
      })

    renderTabs()
    await waitFor(
      () => {
        expect(useTabStore.getState().terminalInventoryHasSnapshot).toBe(true)
      },
      { timeout: 3000 }
    )
    // Wait for the initial save.
    await waitFor(() => expect(saveOpenedTabsMock).toHaveBeenCalledTimes(1), {
      timeout: 3000,
    })

    // Trigger a pin action to cause a second save.
    act(() => {
      useTabStore.getState().pinTab("terminal:term-cas")
    })

    // Wait for the CAS rejection to be processed.
    await waitFor(
      () => {
        expect(saveOpenedTabsMock).toHaveBeenCalledTimes(2)
      },
      { timeout: 3000 }
    )
    await act(async () => {
      await new Promise((r) => setTimeout(r, 700))
    })

    // After CAS rejection + reconcile, the system should not keep saving.
    const callsAfterCas = saveOpenedTabsMock.mock.calls.length
    // Allow at most 1 more save for the post-CAS reconcile (bounded).
    expect(callsAfterCas).toBeLessThanOrEqual(3)

    // More identical refreshes must not trigger additional saves.
    for (let i = 0; i < 3; i++) {
      const { refreshTerminalInventory } =
        await import("@/lib/terminal/terminal-inventory-query")
      await act(async () => {
        await refreshTerminalInventory()
        await new Promise((r) => setTimeout(r, 100))
      })
    }

    // No unbounded growth.
    expect(saveOpenedTabsMock.mock.calls.length).toBeLessThanOrEqual(
      callsAfterCas + 1
    )
  })
})

describe("TabProvider saveRetryPending stale-guard edge", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedWorkspaceStore()
    listOpenedTabsMock.mockResolvedValue({ items: [], version: 0 })
    saveOpenedTabsMock.mockResolvedValue({
      accepted: true,
      version: 1,
      tabs: [],
    })
    getFolderConversationMock.mockReset()
    getFolderConversationMock.mockReturnValue(new Promise(() => {}))
    tabsChangedHandler = null
    conversationChangedHandler = null
    subscribeMock.mockImplementation((event: string, handler: unknown) => {
      if (event === PRIMARY_TABS_CHANGED_EVENT)
        tabsChangedHandler = handler as (change: PrimaryTabsChanged) => void
      if (event === CONVERSATION_CHANGED_EVENT)
        conversationChangedHandler = handler as (
          change: ConversationChange
        ) => void
      return Promise.resolve(() => {})
    })
  })

  function stableDescriptor(terminalId: string): TerminalDescriptor {
    return {
      terminalId,
      backendInstanceId: "backend-a",
      folderId: 1,
      title: "Terminal",
      initialCwd: "/repo",
      shell: "/bin/bash",
      status: "running",
      processId: 42,
      createdAt: "2026-08-11T00:00:00.000Z",
      exitedAt: null,
    }
  }

  it("allows save after transport failure + remote reconcile + genuine user mutation", async () => {
    const descriptor = stableDescriptor("term-retry-edge")
    listTerminalSessionsMock.mockResolvedValue([descriptor])

    // First save succeeds. Second save fails with transport error.
    saveOpenedTabsMock
      .mockResolvedValueOnce({ accepted: true, version: 1, tabs: [] })
      .mockRejectedValueOnce(new Error("transport disconnected"))
      .mockResolvedValue({ accepted: true, version: 3, tabs: [] })

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {})

    try {
      renderTabs()
      await waitFor(
        () => {
          expect(useTabStore.getState().terminalInventoryHasSnapshot).toBe(true)
        },
        { timeout: 3000 }
      )
      // Wait for initial save to complete.
      await waitFor(() => expect(saveOpenedTabsMock).toHaveBeenCalledTimes(1), {
        timeout: 3000,
      })

      // Trigger a pin action to cause a second save (which will fail).
      act(() => {
        useTabStore.getState().pinTab("terminal:term-retry-edge")
      })

      // Wait for the failed save attempt.
      await waitFor(() => expect(saveOpenedTabsMock).toHaveBeenCalledTimes(2), {
        timeout: 3000,
      })
      await act(async () => {
        await new Promise((r) => setTimeout(r, 200))
      })

      // Simulate a remote snapshot arriving (server/remote reconcile).
      // This represents a primary-tabs://changed event from another client.
      act(() => {
        if (tabsChangedHandler) {
          tabsChangedHandler({
            version: 2,
            origin: "other-client",
            tabs: [
              {
                kind: "terminal",
                id: "terminal:term-retry-edge",
                terminalId: "term-retry-edge",
                backendInstanceId: "backend-a",
                folderId: 1,
                title: "Terminal",
                initialCwd: "/repo",
                shell: "/bin/bash",
                detachedFolderLabel: null,
                detachedFolderPath: null,
                isPinned: false,
              },
            ],
          })
        }
      })
      await act(async () => {
        await new Promise((r) => setTimeout(r, 200))
      })

      const callsAfterRemote = saveOpenedTabsMock.mock.calls.length

      // Now simulate a genuine user mutation (unpin the tab).
      // This MUST trigger a save, even though saveRetryPayload was set.
      act(() => {
        useTabStore.getState().pinTab("terminal:term-retry-edge")
      })

      // Wait for the save to be attempted.
      await waitFor(
        () => {
          expect(saveOpenedTabsMock.mock.calls.length).toBeGreaterThan(
            callsAfterRemote
          )
        },
        { timeout: 3000 }
      )

      // Success: the genuine user mutation triggered a save despite the
      // previous transport failure.
    } finally {
      warnSpy.mockRestore()
    }
  })
})
