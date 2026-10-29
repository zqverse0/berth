import { act, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { AppWorkspaceProvider } from "@/contexts/app-workspace-context"
import { getGitHead } from "@/lib/api"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "@/stores/app-workspace-store"
import type {
  ConversationChange,
  DbConversationSummary,
  FolderChange,
  FolderDetail,
} from "@/lib/types"

// Capture subscription handlers and dispose spies so tests can drive events
// and assert cleanup. `vi.hoisted` runs before the mock factories so they can
// close over this shared state without a TDZ error.
const h = vi.hoisted(() => ({
  handler: null as null | ((change: unknown) => void),
  folderHandler: null as null | ((change: unknown) => void),
  bulkHandler: null as null | ((change: unknown) => void),
  disposeSpy: vi.fn(),
  folderDisposeSpy: vi.fn(),
  bulkDisposeSpy: vi.fn(),
  listAll: vi.fn(async () => [] as unknown[]),
  listOpenFolders: vi.fn(async () => [] as unknown[]),
  listAllFolders: vi.fn(async () => [] as unknown[]),
}))

vi.mock("@/lib/platform", () => ({
  // The provider registers three subscriptions — `conversation://changed`,
  // `conversations://bulk-changed`, and `folder://changed` — so route by exact
  // channel and capture each handler / dispose spy independently; the
  // conversation-sync tests keep asserting against `h.handler`/`h.disposeSpy`
  // unchanged.
  subscribe: vi.fn(async (event: string, handler: (c: unknown) => void) => {
    if (event === "folder://changed") {
      h.folderHandler = handler
      return h.folderDisposeSpy
    }
    if (event === "conversations://bulk-changed") {
      h.bulkHandler = handler
      return h.bulkDisposeSpy
    }
    h.handler = handler
    return h.disposeSpy
  }),
}))

vi.mock("@/lib/api", () => ({
  listAllConversations: h.listAll,
  listAllFolderDetails: h.listAllFolders,
  listOpenFolderDetails: h.listOpenFolders,
  getGitBranch: vi.fn(async () => null),
  getGitHead: vi.fn(async () => ({
    is_repo: false,
    branch: null,
    detached: false,
    short_sha: null,
  })),
  openFolder: vi.fn(),
  openFolderById: vi.fn(),
  removeFolderFromWorkspace: vi.fn(),
  reorderFolders: vi.fn(),
  getFolder: vi.fn(),
}))

function makeSummary(
  overrides: Partial<DbConversationSummary> & { id: number }
): DbConversationSummary {
  return {
    folder_id: 1,
    title: null,
    title_locked: false,
    agent_type: "claude_code",
    kind: "regular",
    model: null,
    git_branch: null,
    external_id: null,
    message_count: 0,
    child_count: 0,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    pinned_at: null,
    parent_id: null,
    parent_tool_use_id: null,
    delegation_call_id: null,
    ...overrides,
  }
}

function makeFolder(
  overrides: Partial<FolderDetail> & { id: number }
): FolderDetail {
  return {
    name: `folder-${overrides.id}`,
    path: `/repo/folder-${overrides.id}`,
    git_branch: null,
    default_agent_type: null,
    last_opened_at: "2026-01-01T00:00:00.000Z",
    sort_order: overrides.id,
    color: "inherit",
    parent_id: null,
    kind: "regular",
    alias: null,
    ...overrides,
  }
}

// Subscribes via selectors the way real consumers do, so the assertions also
// exercise the store's slice reactivity (a missed notify would fail here).
function Probe() {
  const conversations = useAppWorkspaceStore((s) => s.conversations)
  const stats = useAppWorkspaceStore((s) => s.stats)
  const folders = useAppWorkspaceStore((s) => s.folders)
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  return (
    <div>
      <output data-testid="ids">
        {conversations.map((c) => c.id).join(",")}
      </output>
      <output data-testid="count">{conversations.length}</output>
      <output data-testid="stat-total">
        {stats?.total_conversations ?? 0}
      </output>
      <output data-testid="stat-messages">{stats?.total_messages ?? 0}</output>
      <output data-testid="folder-ids">
        {folders.map((f) => f.id).join(",")}
      </output>
      <output data-testid="all-folder-ids">
        {allFolders.map((f) => f.id).join(",")}
      </output>
    </div>
  )
}

async function mountProvider() {
  const utils = render(
    <AppWorkspaceProvider>
      <Probe />
    </AppWorkspaceProvider>
  )
  // Flush folder hydration and the async subscribe() IIFEs.
  await act(async () => {})
  return utils
}

function emit(change: ConversationChange) {
  act(() => {
    h.handler?.(change)
  })
}

function emitFolder(change: FolderChange) {
  act(() => {
    h.folderHandler?.(change)
  })
}

beforeEach(() => {
  h.handler = null
  h.folderHandler = null
  h.bulkHandler = null
  h.disposeSpy.mockClear()
  h.folderDisposeSpy.mockClear()
  h.bulkDisposeSpy.mockClear()
  h.listAll.mockClear()
  h.listAll.mockResolvedValue([])
  h.listOpenFolders.mockClear()
  h.listOpenFolders.mockResolvedValue([])
  h.listAllFolders.mockClear()
  h.listAllFolders.mockResolvedValue([])
  // The store is a module-level singleton: restore pristine state (including
  // the delete tombstones) so state can't leak between tests.
  resetAppWorkspaceStore()
})

describe("AppWorkspaceProvider zero-Agent startup", () => {
  it("hydrates folders without listing Agent conversations", async () => {
    h.listOpenFolders.mockResolvedValue([
      makeFolder({ id: 7 }),
      makeFolder({ id: 8 }),
    ])

    await mountProvider()

    expect(h.listOpenFolders).toHaveBeenCalledTimes(1)
    expect(h.listAll).not.toHaveBeenCalled()
    expect(screen.getByTestId("folder-ids")).toHaveTextContent("7,8")
  })
})

describe("AppWorkspaceProvider conversation://changed sync", () => {
  it("registers the conversation subscription on mount", async () => {
    await mountProvider()
    expect(h.handler).toBeTypeOf("function")
  })

  it("inserts a new root conversation, prepending most-recent-first", async () => {
    await mountProvider()
    emit({ kind: "upsert", summary: makeSummary({ id: 1 }) })
    emit({ kind: "upsert", summary: makeSummary({ id: 2 }) })
    expect(screen.getByTestId("ids")).toHaveTextContent("2,1")
    expect(screen.getByTestId("count")).toHaveTextContent("2")
    expect(screen.getByTestId("stat-total")).toHaveTextContent("2")
  })

  it("ignores delegation children (parent_id set) — not sidebar rows", async () => {
    await mountProvider()
    emit({ kind: "upsert", summary: makeSummary({ id: 1 }) })
    emit({ kind: "upsert", summary: makeSummary({ id: 5, parent_id: 1 }) })
    expect(screen.getByTestId("ids")).toHaveTextContent("1")
    expect(screen.getByTestId("count")).toHaveTextContent("1")
  })

  it("removes on deleted and is idempotent for an unknown id", async () => {
    await mountProvider()
    emit({ kind: "upsert", summary: makeSummary({ id: 1 }) })
    emit({ kind: "upsert", summary: makeSummary({ id: 2 }) })
    emit({ kind: "deleted", id: 1 })
    expect(screen.getByTestId("ids")).toHaveTextContent("2")
    emit({ kind: "deleted", id: 999 })
    expect(screen.getByTestId("ids")).toHaveTextContent("2")
    expect(screen.getByTestId("count")).toHaveTextContent("1")
  })

  it("derives stats.total_messages from upserted message counts", async () => {
    await mountProvider()
    emit({ kind: "upsert", summary: makeSummary({ id: 1, message_count: 3 }) })
    emit({ kind: "upsert", summary: makeSummary({ id: 2, message_count: 4 }) })
    expect(screen.getByTestId("stat-total")).toHaveTextContent("2")
    expect(screen.getByTestId("stat-messages")).toHaveTextContent("7")
  })

  it("disposes the subscription on unmount", async () => {
    const { unmount } = await mountProvider()
    unmount()
    expect(h.disposeSpy).toHaveBeenCalledTimes(1)
  })
})

describe("upsertFolder list routing", () => {
  it("seeds a chat folder into allFolders only — never the user-facing folders list", async () => {
    // Regression: the first chat send hands the backend-created hidden chat
    // folder to upsertFolder; putting it in `folders` rendered a "Chat" header
    // row in the sidebar until the next refetch/restart.
    await mountProvider()
    act(() => {
      useAppWorkspaceStore
        .getState()
        .upsertFolder(makeFolder({ id: 7, kind: "chat", name: "Chat" }))
    })
    expect(screen.getByTestId("folder-ids").textContent).toBe("")
    expect(screen.getByTestId("all-folder-ids")).toHaveTextContent("7")
  })

  it("seeds a regular folder into both lists", async () => {
    await mountProvider()
    act(() => {
      useAppWorkspaceStore.getState().upsertFolder(makeFolder({ id: 8 }))
    })
    expect(screen.getByTestId("folder-ids")).toHaveTextContent("8")
    expect(screen.getByTestId("all-folder-ids")).toHaveTextContent("8")
  })

  it("replaces an existing chat folder in allFolders in place", async () => {
    await mountProvider()
    const { upsertFolder } = useAppWorkspaceStore.getState()
    act(() => {
      upsertFolder(makeFolder({ id: 7, kind: "chat", name: "Chat" }))
    })
    act(() => {
      upsertFolder(makeFolder({ id: 9, kind: "chat", name: "Chat" }))
    })
    act(() => {
      upsertFolder(makeFolder({ id: 7, kind: "chat", name: "Chat 2" }))
    })
    expect(screen.getByTestId("all-folder-ids")).toHaveTextContent("7,9")
    expect(screen.getByTestId("folder-ids").textContent).toBe("")
  })
})

describe("AppWorkspaceProvider conversations://bulk-changed sync", () => {
  it("answers a batch-import nudge with one scoped conversation refetch", async () => {
    h.listOpenFolders.mockResolvedValue([makeFolder({ id: 7 })])
    await mountProvider()
    expect(h.bulkHandler).toBeTypeOf("function")
    expect(h.listAll).not.toHaveBeenCalled() // startup remains zero-Agent
    await act(async () => {
      h.bulkHandler?.({ imported: 3, updated: 1, folder_ids: [7] })
    })
    expect(h.listAll).toHaveBeenCalledTimes(1)
    expect(h.listAll).toHaveBeenLastCalledWith({ folder_ids: [7] })
  })

  it("disposes the bulk subscription on unmount", async () => {
    const { unmount } = await mountProvider()
    unmount()
    expect(h.bulkDisposeSpy).toHaveBeenCalledTimes(1)
  })
})

describe("AppWorkspaceProvider folder://changed sync", () => {
  it("registers a folder subscription on mount", async () => {
    await mountProvider()
    expect(h.folderHandler).toBeTypeOf("function")
  })

  it("upserts a regular folder into both lists on a folder upsert event", async () => {
    // A headlessly-created worktree (e.g. an automation per-run worktree) must
    // land in `folders` (so a conversation inside it can be grouped/rendered)
    // and `allFolders` (cwd resolution) without a re-fetch.
    await mountProvider()
    emitFolder({ kind: "upsert", folder: makeFolder({ id: 12, parent_id: 1 }) })
    expect(screen.getByTestId("folder-ids")).toHaveTextContent("12")
    expect(screen.getByTestId("all-folder-ids")).toHaveTextContent("12")
  })

  it("replaces an existing folder in place on a repeat upsert", async () => {
    await mountProvider()
    emitFolder({ kind: "upsert", folder: makeFolder({ id: 12 }) })
    emitFolder({ kind: "upsert", folder: makeFolder({ id: 13 }) })
    emitFolder({
      kind: "upsert",
      folder: makeFolder({ id: 12, name: "renamed" }),
    })
    expect(screen.getByTestId("folder-ids")).toHaveTextContent("12,13")
  })

  it("disposes the folder subscription on unmount", async () => {
    const { unmount } = await mountProvider()
    unmount()
    expect(h.folderDisposeSpy).toHaveBeenCalledTimes(1)
  })
})

describe("AppWorkspaceProvider branch poll focus cadence", () => {
  const repoHead = {
    is_repo: true,
    branch: "main",
    detached: false,
    short_sha: "abc1234",
  }

  function setVisibility(state: DocumentVisibilityState) {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => state,
    })
  }

  async function mountWithActiveRepoFolder() {
    const folder = makeFolder({ id: 7, git_branch: "main" })
    // fetchFolders on mount re-commits folders/allFolders from the api mocks,
    // so seed both — otherwise activeFolderPath resolves to null and the poll
    // effect never starts.
    h.listOpenFolders.mockResolvedValue([folder])
    h.listAllFolders.mockResolvedValue([folder])
    useAppWorkspaceStore.setState({
      folders: [folder],
      allFolders: [folder],
      activeFolderId: 7,
    })
    return mountProvider()
  }

  it("polls fast while visible and slows down when blurred", async () => {
    vi.useFakeTimers()
    const getGitHeadMock = vi.mocked(getGitHead)
    try {
      setVisibility("visible")
      getGitHeadMock.mockResolvedValue(repoHead)
      await mountWithActiveRepoFolder()

      // Focused repo cadence: advancing 10s from the post-mount call count
      // must produce exactly one more tick.
      const baseline = getGitHeadMock.mock.calls.length
      expect(baseline).toBeGreaterThan(0)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      const afterFocused = getGitHeadMock.mock.calls.length
      expect(afterFocused).toBe(baseline + 1)

      // Blurred: the pending 10s tick (scheduled while still visible) fires
      // at most once, and — reading hidden — reschedules at the 60s
      // compensation cadence, so a further 10s must not tick again.
      setVisibility("hidden")
      const hiddenStart = getGitHeadMock.mock.calls.length
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      const afterPending = getGitHeadMock.mock.calls.length
      expect(afterPending).toBeLessThanOrEqual(hiddenStart + 1)
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      expect(getGitHeadMock.mock.calls.length).toBe(afterPending)

      // And the 60s compensation window does tick (external git activity
      // keeps converging while blurred).
      await act(async () => {
        await vi.advanceTimersByTimeAsync(60_000)
      })
      expect(getGitHeadMock.mock.calls.length).toBeGreaterThan(afterPending)
    } finally {
      vi.useRealTimers()
      setVisibility("visible")
      getGitHeadMock.mockReset()
      getGitHeadMock.mockResolvedValue({
        is_repo: false,
        branch: null,
        detached: false,
        short_sha: null,
      })
    }
  })

  it("fast-polls immediately when the window regains visibility", async () => {
    vi.useFakeTimers()
    const getGitHeadMock = vi.mocked(getGitHead)
    try {
      setVisibility("hidden")
      getGitHeadMock.mockResolvedValue(repoHead)
      await mountWithActiveRepoFolder()

      const callsWhileHidden = getGitHeadMock.mock.calls.length
      expect(callsWhileHidden).toBeGreaterThan(0)

      // Refocus short-circuits the pending slow tick: the immediate poll
      // fires without advancing any timer.
      setVisibility("visible")
      await act(async () => {
        document.dispatchEvent(new Event("visibilitychange"))
        await vi.advanceTimersByTimeAsync(0)
      })
      expect(getGitHeadMock.mock.calls.length).toBeGreaterThan(callsWhileHidden)
    } finally {
      vi.useRealTimers()
      setVisibility("visible")
      getGitHeadMock.mockReset()
      getGitHeadMock.mockResolvedValue({
        is_repo: false,
        branch: null,
        detached: false,
        short_sha: null,
      })
    }
  })
})

describe("AppWorkspaceProvider worktree fingerprint", () => {
  it("reconciles the active family only when the fingerprint changes", async () => {
    vi.useFakeTimers()
    try {
      const head = (fp: string) => ({
        is_repo: true,
        branch: "main",
        detached: false,
        short_sha: null,
        worktrees_fingerprint: fp,
      })
      vi.mocked(getGitHead)
        .mockResolvedValueOnce(head("a"))
        .mockResolvedValueOnce(head("a"))
        .mockResolvedValueOnce(head("b"))
      h.listAllFolders.mockResolvedValue([makeFolder({ id: 7 })])
      const refreshWorktreeFamily = vi.fn(async () => {})
      useAppWorkspaceStore.setState({
        activeFolderId: 7,
        refreshWorktreeFamily,
      })

      await mountProvider()
      // 首个结果只作基线，相同指纹不对账。
      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      expect(refreshWorktreeFamily).not.toHaveBeenCalled()

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10_000)
      })
      expect(refreshWorktreeFamily).toHaveBeenCalledTimes(1)
      expect(refreshWorktreeFamily).toHaveBeenCalledWith(7)
    } finally {
      vi.useRealTimers()
    }
  })
})
