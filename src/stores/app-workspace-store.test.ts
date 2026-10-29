import { beforeEach, describe, expect, it, vi } from "vitest"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "./app-workspace-store"
import type { DbConversationSummary, FolderDetail } from "@/lib/types"
import { findOwningFolder } from "@/lib/files/file-open-target"

vi.mock("@/lib/api", () => ({
  getFolder: vi.fn(),
  listAllConversations: vi.fn(async () => [] as DbConversationSummary[]),
  removeFolderFromWorkspace: vi.fn(async () => {}),
  openFolder: vi.fn(),
  openFolderById: vi.fn(),
  listOpenFolderDetails: vi.fn(async () => []),
  listAllFolderDetails: vi.fn(async () => []),
}))

const {
  getFolder,
  listAllConversations,
  removeFolderFromWorkspace,
  openFolder,
  openFolderById,
  listOpenFolderDetails,
  listAllFolderDetails,
} = await import("@/lib/api")
const mockGetFolder = vi.mocked(getFolder)
const mockListAllConversations = vi.mocked(listAllConversations)
const mockRemoveFolderFromWorkspace = vi.mocked(removeFolderFromWorkspace)
const mockOpenFolder = vi.mocked(openFolder)
const mockOpenFolderById = vi.mocked(openFolderById)
const mockListOpenFolderDetails = vi.mocked(listOpenFolderDetails)
const mockListAllFolderDetails = vi.mocked(listAllFolderDetails)

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

beforeEach(() => {
  resetAppWorkspaceStore()
  mockGetFolder.mockReset()
  mockListAllConversations.mockReset().mockResolvedValue([])
  mockRemoveFolderFromWorkspace.mockReset().mockResolvedValue(undefined)
  mockOpenFolder.mockReset()
  mockOpenFolderById.mockReset()
  mockListOpenFolderDetails.mockReset().mockResolvedValue([])
  mockListAllFolderDetails.mockReset().mockResolvedValue([])
})

describe("refreshConversations — scoped cache reconciliation", () => {
  it("starts with conversations idle because history is on-demand", () => {
    expect(useAppWorkspaceStore.getState().conversationsLoading).toBe(false)
  })

  it("does not call the API for an empty folder scope", async () => {
    await useAppWorkspaceStore.getState().refreshConversations([])

    expect(mockListAllConversations).not.toHaveBeenCalled()
    expect(useAppWorkspaceStore.getState().conversationsLoading).toBe(false)
  })

  it("uses open folders when no active folder is selected", async () => {
    useAppWorkspaceStore.setState({
      folders: [makeFolder({ id: 7 }), makeFolder({ id: 8 })],
      activeFolderId: null,
    })

    await useAppWorkspaceStore.getState().refreshConversations()

    expect(mockListAllConversations).toHaveBeenCalledWith({
      folder_ids: [7, 8],
    })
  })

  it("keeps hidden chat folders in the bounded conversation scope", async () => {
    useAppWorkspaceStore.setState({
      folders: [makeFolder({ id: 7 })],
      allFolders: [makeFolder({ id: 7 }), makeFolder({ id: 99, kind: "chat" })],
      activeFolderId: 7,
    })

    await useAppWorkspaceStore.getState().refreshConversations()

    expect(mockListAllConversations).toHaveBeenCalledWith({
      folder_ids: [7, 99],
    })
  })

  it("replaces only the requested folder and preserves other cached folders", async () => {
    const store = useAppWorkspaceStore.getState()
    store.applyConversationUpsert(makeSummary({ id: 1, folder_id: 7 }))
    store.applyConversationUpsert(makeSummary({ id: 2, folder_id: 8 }))
    mockListAllConversations.mockResolvedValue([
      makeSummary({ id: 3, folder_id: 7 }),
    ])

    await store.refreshConversations([7])

    expect(
      useAppWorkspaceStore.getState().conversations.map((c) => c.id)
    ).toEqual([2, 3])
  })

  it("coalesces overlapping full refreshes for the same folder", async () => {
    let resolveFull: ((rows: DbConversationSummary[]) => void) | undefined
    const fullResponse = new Promise<DbConversationSummary[]>((resolve) => {
      resolveFull = resolve
    })
    mockListAllConversations.mockImplementationOnce(() => fullResponse)

    const firstRefresh = useAppWorkspaceStore
      .getState()
      .refreshConversations([7], true)
    const secondRefresh = useAppWorkspaceStore
      .getState()
      .refreshConversations([7], true)

    await Promise.resolve()
    expect(mockListAllConversations).toHaveBeenCalledTimes(1)

    resolveFull?.([makeSummary({ id: 1, folder_id: 7 })])
    await Promise.all([firstRefresh, secondRefresh])
    expect(useAppWorkspaceStore.getState().conversations).toHaveLength(1)
  })

  it("coalesces active refreshes with the same normalized scope", async () => {
    let resolveActive: ((rows: DbConversationSummary[]) => void) | undefined
    const activeResponse = new Promise<DbConversationSummary[]>((resolve) => {
      resolveActive = resolve
    })
    mockListAllConversations.mockImplementationOnce(() => activeResponse)

    const firstRefresh = useAppWorkspaceStore
      .getState()
      .refreshConversations([8, 7])
    const secondRefresh = useAppWorkspaceStore
      .getState()
      .refreshConversations([7, 8])

    await Promise.resolve()
    expect(mockListAllConversations).toHaveBeenCalledTimes(1)
    resolveActive?.([
      makeSummary({ id: 1, folder_id: 7 }),
      makeSummary({ id: 2, folder_id: 8 }),
    ])
    await Promise.all([firstRefresh, secondRefresh])
  })

  it("forces a fresh full refresh after an in-flight snapshot settles", async () => {
    let resolveFull: ((rows: DbConversationSummary[]) => void) | undefined
    const fullResponse = new Promise<DbConversationSummary[]>((resolve) => {
      resolveFull = resolve
    })
    mockListAllConversations
      .mockImplementationOnce(() => fullResponse)
      .mockResolvedValueOnce([makeSummary({ id: 2, folder_id: 7 })])

    const firstRefresh = useAppWorkspaceStore
      .getState()
      .refreshConversations([7], true)
    const forcedRefresh = useAppWorkspaceStore
      .getState()
      .refreshConversations([7], true, true)

    await Promise.resolve()
    expect(mockListAllConversations).toHaveBeenCalledTimes(1)

    resolveFull?.([makeSummary({ id: 1, folder_id: 7 })])
    await Promise.all([firstRefresh, forcedRefresh])

    expect(mockListAllConversations).toHaveBeenCalledTimes(2)
    expect(useAppWorkspaceStore.getState().conversations[0]?.id).toBe(2)
  })

  it("reuses conversation and stats references for an unchanged refresh", async () => {
    const summary = makeSummary({ id: 1, folder_id: 7 })
    useAppWorkspaceStore.getState().applyConversationUpsert(summary)
    const before = useAppWorkspaceStore.getState()
    mockListAllConversations.mockResolvedValue([
      makeSummary({ id: 1, folder_id: 7 }),
    ])

    await useAppWorkspaceStore.getState().refreshConversations([7], true)

    const after = useAppWorkspaceStore.getState()
    expect(after.conversations).toBe(before.conversations)
    expect(after.conversations[0]).toBe(before.conversations[0])
    expect(after.stats).toBe(before.stats)
  })

  it("does not publish an identical conversation upsert", () => {
    const summary = makeSummary({ id: 1, folder_id: 7 })
    useAppWorkspaceStore.getState().applyConversationUpsert(summary)
    const before = useAppWorkspaceStore.getState()

    useAppWorkspaceStore
      .getState()
      .applyConversationUpsert(makeSummary({ id: 1, folder_id: 7 }))

    const after = useAppWorkspaceStore.getState()
    expect(after.conversations).toBe(before.conversations)
    expect(after.stats).toBe(before.stats)
    expect(after.conversations[0]).toBe(before.conversations[0])
  })

  it("purges a removed folder and ignores its in-flight response", async () => {
    const parent = makeFolder({ id: 6, path: "/home/user/.berth" })
    const child = makeFolder({ id: 7, path: "/home/user/.berth/skills" })
    useAppWorkspaceStore.setState({
      folders: [parent, child],
      allFolders: [parent, child],
      branches: new Map([[7, "main"]]),
      gitHeads: new Map([
        [
          7,
          {
            is_repo: true,
            branch: "main",
            detached: false,
            short_sha: "abc1234",
          },
        ],
      ]),
      conversations: [makeSummary({ id: 1, folder_id: 7 })],
    })
    const skillFile = "/home/user/.berth/skills/example/SKILL.md"
    expect(
      findOwningFolder(skillFile, useAppWorkspaceStore.getState().allFolders)
        ?.folderId
    ).toBe(7)
    let resolveRefresh: ((rows: DbConversationSummary[]) => void) | undefined
    mockListAllConversations.mockImplementationOnce(
      () =>
        new Promise<DbConversationSummary[]>((resolve) => {
          resolveRefresh = resolve
        })
    )
    const refresh = useAppWorkspaceStore
      .getState()
      .refreshConversations([7], true)
    await Promise.resolve()

    await useAppWorkspaceStore.getState().removeFolderFromWorkspace(7)
    expect(mockRemoveFolderFromWorkspace).toHaveBeenCalledWith(7, false)
    expect(useAppWorkspaceStore.getState().conversations).toEqual([])
    expect(
      useAppWorkspaceStore.getState().folders.map((folder) => folder.id)
    ).toEqual([6])
    expect(
      useAppWorkspaceStore.getState().allFolders.map((folder) => folder.id)
    ).toEqual([6])
    expect(useAppWorkspaceStore.getState().branches.has(7)).toBe(false)
    expect(useAppWorkspaceStore.getState().gitHeads.has(7)).toBe(false)
    expect(
      findOwningFolder(skillFile, useAppWorkspaceStore.getState().allFolders)
        ?.folderId
    ).toBe(6)

    resolveRefresh?.([makeSummary({ id: 2, folder_id: 7 })])
    await refresh
    expect(useAppWorkspaceStore.getState().conversations).toEqual([])
  })

  it("forwards physical worktree deletion explicitly", async () => {
    useAppWorkspaceStore.setState({
      folders: [makeFolder({ id: 8, parent_id: 1 })],
    })

    await useAppWorkspaceStore.getState().removeFolderFromWorkspace(8, true)

    expect(mockRemoveFolderFromWorkspace).toHaveBeenCalledWith(8, true)
    expect(useAppWorkspaceStore.getState().folders).toEqual([])
  })

  it("drops the whole worktree family when removing a root", async () => {
    const family = [
      makeFolder({ id: 1 }),
      makeFolder({ id: 2, parent_id: 1 }),
      makeFolder({ id: 3 }),
    ]
    useAppWorkspaceStore.setState({
      folders: family,
      allFolders: family,
      activeFolderId: 2,
      conversations: [
        makeSummary({ id: 10, folder_id: 2 }),
        makeSummary({ id: 11, folder_id: 3 }),
      ],
    })

    await useAppWorkspaceStore.getState().removeFolderFromWorkspace(1)

    const state = useAppWorkspaceStore.getState()
    expect(state.folders.map((f) => f.id)).toEqual([3])
    expect(state.allFolders.map((f) => f.id)).toEqual([3])
    expect(state.activeFolderId).toBeNull()
    expect(state.conversations.map((c) => c.id)).not.toContain(10)
  })

  it("keeps chat rows when removing the last regular folder", async () => {
    useAppWorkspaceStore.setState({
      folders: [makeFolder({ id: 7 })],
      allFolders: [makeFolder({ id: 7 }), makeFolder({ id: 99, kind: "chat" })],
      activeFolderId: 7,
      conversations: [
        makeSummary({ id: 1, folder_id: 7 }),
        makeSummary({ id: 2, folder_id: 99, kind: "chat" }),
      ],
    })
    mockListAllConversations.mockResolvedValue([
      makeSummary({ id: 2, folder_id: 99, kind: "chat" }),
    ])

    await useAppWorkspaceStore.getState().removeFolderFromWorkspace(7)
    await vi.waitFor(() => expect(mockListAllConversations).toHaveBeenCalled())

    expect(mockListAllConversations).toHaveBeenLastCalledWith({
      folder_ids: [99],
    })
    expect(
      useAppWorkspaceStore
        .getState()
        .conversations.map((conversation) => conversation.id)
    ).toEqual([2])
  })

  it("retries the active projection when a full refresh fails", async () => {
    mockListAllConversations
      .mockRejectedValueOnce(new Error("archive query failed"))
      .mockResolvedValueOnce([makeSummary({ id: 1, folder_id: 7 })])

    await useAppWorkspaceStore.getState().refreshConversations([7], true)
    await vi.waitFor(() =>
      expect(mockListAllConversations).toHaveBeenCalledTimes(2)
    )

    expect(
      useAppWorkspaceStore.getState().conversations.map((c) => c.id)
    ).toEqual([1])
  })

  it("does not let an older response overwrite a newer response for one folder", async () => {
    let resolveFirst: ((rows: DbConversationSummary[]) => void) | undefined
    const firstResponse = new Promise<DbConversationSummary[]>((resolve) => {
      resolveFirst = resolve
    })
    mockListAllConversations
      .mockImplementationOnce(() => firstResponse)
      .mockResolvedValueOnce([makeSummary({ id: 2, folder_id: 7 })])

    const firstRefresh = storeRefresh(7)
    await storeRefresh(7, true)
    resolveFirst?.([makeSummary({ id: 1, folder_id: 7 })])
    await firstRefresh

    expect(
      useAppWorkspaceStore.getState().conversations.map((c) => c.id)
    ).toEqual([2])
  })
})

function storeRefresh(folderId: number, force = false): Promise<void> {
  return useAppWorkspaceStore
    .getState()
    .refreshConversations([folderId], false, force)
}

describe("updateConversationLocal — stats reference stability", () => {
  function seedTwo() {
    const store = useAppWorkspaceStore.getState()
    store.applyConversationUpsert(makeSummary({ id: 1, message_count: 3 }))
    store.applyConversationUpsert(makeSummary({ id: 2, message_count: 4 }))
  }

  it("reuses the stats reference on a title patch", () => {
    seedTwo()
    const statsBefore = useAppWorkspaceStore.getState().stats

    useAppWorkspaceStore
      .getState()
      .updateConversationLocal(2, { title: "Renamed" })

    const after = useAppWorkspaceStore.getState()
    expect(after.stats).toBe(statsBefore)
    expect(after.conversations.find((c) => c.id === 2)?.title).toBe("Renamed")
  })

  it("still tracks stats when message_count actually changes (via upsert)", () => {
    seedTwo()
    // total_messages = 3 + 4
    expect(useAppWorkspaceStore.getState().stats?.total_messages).toBe(7)

    // A real message_count change flows through applyConversationUpsert (whose
    // recompute we intentionally left intact), so stats update as before.
    useAppWorkspaceStore
      .getState()
      .applyConversationUpsert(makeSummary({ id: 1, message_count: 10 }))

    expect(useAppWorkspaceStore.getState().stats?.total_messages).toBe(14)
  })
})

function makeFolder(
  overrides: Partial<FolderDetail> & { id: number }
): FolderDetail {
  return {
    name: "repo",
    path: "/tmp/repo",
    git_branch: null,
    default_agent_type: null,
    last_opened_at: "2026-01-01T00:00:00.000Z",
    sort_order: 1,
    color: "#000000",
    parent_id: null,
    kind: "regular",
    alias: null,
    ...overrides,
  }
}

describe("refreshFolder — branch null-guard", () => {
  it("keeps the poll-resolved branch when the refreshed row's git_branch is null", async () => {
    // Git-head polling has populated the display branch; the folder row's
    // `git_branch` column is null (it always is today), so the refresh must
    // leave the polled name alone.
    useAppWorkspaceStore.getState().setBranch(1, "feature/x")
    mockGetFolder.mockResolvedValue(makeFolder({ id: 1, git_branch: null }))

    await useAppWorkspaceStore.getState().refreshFolder(1)

    // Regression guard for the "no branch" flash: a null DB branch must not
    // clobber the polled name (which would blank the bottom selector until the
    // next poll, up to 10s later).
    expect(useAppWorkspaceStore.getState().branches.get(1)).toBe("feature/x")
  })

  it("adopts the refreshed branch when the row actually carries one", async () => {
    useAppWorkspaceStore.getState().setBranch(1, "old")
    mockGetFolder.mockResolvedValue(makeFolder({ id: 1, git_branch: "main" }))

    await useAppWorkspaceStore.getState().refreshFolder(1)

    expect(useAppWorkspaceStore.getState().branches.get(1)).toBe("main")
  })
})

describe("openFolder — registered path skip", () => {
  it("does not refresh conversations for an already-registered path", async () => {
    const existing = makeFolder({ id: 7, path: "/tmp/repo" })
    useAppWorkspaceStore.setState({
      folders: [existing],
      allFolders: [existing],
    })
    mockOpenFolder.mockResolvedValue(existing)

    await useAppWorkspaceStore.getState().openFolder("/tmp/repo")
    await Promise.resolve()

    expect(mockListAllConversations).not.toHaveBeenCalled()
    expect(mockListAllFolderDetails).not.toHaveBeenCalled()
  })

  it("still refreshes conversations and folders on first add", async () => {
    const added = makeFolder({ id: 8, path: "/tmp/new" })
    mockOpenFolder.mockResolvedValue(added)
    mockListOpenFolderDetails.mockResolvedValue([added])
    mockListAllFolderDetails.mockResolvedValue([added])

    await useAppWorkspaceStore.getState().openFolder("/tmp/new")
    await vi.waitFor(() => {
      expect(mockListAllConversations).toHaveBeenCalledWith({
        folder_ids: [8],
      })
    })
    expect(mockListAllFolderDetails).toHaveBeenCalled()
  })
})

describe("addFolderToWorkspaceById — registered skip", () => {
  it("does not refresh conversations for an already-registered id", async () => {
    const existing = makeFolder({ id: 7, path: "/tmp/repo" })
    useAppWorkspaceStore.setState({
      folders: [],
      allFolders: [existing],
    })
    mockOpenFolderById.mockResolvedValue(existing)

    await useAppWorkspaceStore.getState().addFolderToWorkspaceById(7)
    await Promise.resolve()

    expect(mockListAllConversations).not.toHaveBeenCalled()
    expect(
      useAppWorkspaceStore.getState().folders.some((f) => f.id === 7)
    ).toBe(true)
  })

  it("refreshes conversations when the id is first seen", async () => {
    const added = makeFolder({ id: 9, path: "/tmp/first" })
    mockOpenFolderById.mockResolvedValue(added)

    await useAppWorkspaceStore.getState().addFolderToWorkspaceById(9)
    await vi.waitFor(() => {
      expect(mockListAllConversations).toHaveBeenCalledWith({
        folder_ids: [9],
      })
    })
  })
})

it("clears the active project when it is absent from refreshed folders", async () => {
  useAppWorkspaceStore.setState({ activeFolderId: 61 })
  await useAppWorkspaceStore.getState().fetchFolders()
  expect(useAppWorkspaceStore.getState().activeFolderId).toBeNull()
  expect(useAppWorkspaceStore.getState().folders).toEqual([])
})

it("keeps folder identities when a refetch returns unchanged rows", async () => {
  const a = makeFolder({ id: 1, path: "/tmp/a" })
  const b = makeFolder({ id: 2, path: "/tmp/b" })
  mockListOpenFolderDetails.mockResolvedValue([{ ...a }, { ...b }])
  mockListAllFolderDetails.mockResolvedValue([{ ...a }, { ...b }])
  await useAppWorkspaceStore.getState().fetchFolders()
  const first = useAppWorkspaceStore.getState()

  mockListOpenFolderDetails.mockResolvedValue([{ ...a }, { ...b }])
  mockListAllFolderDetails.mockResolvedValue([{ ...a }, { ...b, name: "b2" }])
  await useAppWorkspaceStore.getState().fetchFolders()
  const second = useAppWorkspaceStore.getState()

  expect(second.folders).toBe(first.folders)
  expect(second.branches).toBe(first.branches)
  expect(second.allFolders).not.toBe(first.allFolders)
  expect(second.allFolders[0]).toBe(first.allFolders[0])
  expect(second.allFolders[1]?.name).toBe("b2")
})
