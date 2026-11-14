import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  applyDeltaToState,
  getWorkspaceStateStore,
  type WorkspaceStateView,
} from "@/hooks/workspace/use-workspace-state-store"
import * as api from "@/lib/api"
import * as platform from "@/lib/platform"
import type {
  FileTreeNode,
  WorkspaceDelta,
  WorkspaceStateEvent,
} from "@/lib/types"

// Token-set state machine for the per-root workspace stream store:
// full/paths subscription modes, upgrade/downgrade transitions against the
// backend, idempotent release, and the shutdown-grace lifecycle. Each test
// uses a unique root path — stores are module-level singletons.

vi.mock("@/lib/api", () => ({
  startWorkspaceStateStream: vi.fn(),
  stopWorkspaceStateStream: vi.fn(),
  getWorkspaceSnapshot: vi.fn(),
}))

vi.mock("@/lib/platform", () => ({
  subscribe: vi.fn(async () => () => {}),
}))

const mockedApi = api as unknown as {
  startWorkspaceStateStream: ReturnType<typeof vi.fn>
  stopWorkspaceStateStream: ReturnType<typeof vi.fn>
  getWorkspaceSnapshot: ReturnType<typeof vi.fn>
}

function fullSnapshot(rootPath: string, seq = 0) {
  return {
    root_path: rootPath,
    seq,
    version: 1,
    full: true,
    tree_snapshot: [],
    git_snapshot: [],
    deltas: [],
    degraded: false,
    is_git_repo: true,
  }
}

// Drain resolved promises + due timers deterministically.
const drain = () => vi.advanceTimersByTimeAsync(0)

beforeEach(() => {
  vi.useFakeTimers()
  mockedApi.startWorkspaceStateStream.mockReset()
  mockedApi.stopWorkspaceStateStream.mockReset()
  mockedApi.getWorkspaceSnapshot.mockReset()
  mockedApi.startWorkspaceStateStream.mockImplementation((rootPath: string) =>
    Promise.resolve(fullSnapshot(rootPath))
  )
  mockedApi.stopWorkspaceStateStream.mockResolvedValue(undefined)
  mockedApi.getWorkspaceSnapshot.mockImplementation((rootPath: string) =>
    Promise.resolve(fullSnapshot(rootPath))
  )
})

afterEach(() => {
  vi.useRealTimers()
})

describe("workspace state store full/paths token machine", () => {
  it("registers a paths-only subscription without tree/git scanning", async () => {
    const store = getWorkspaceStateStore("/machine/t1")
    const token = store.acquire("paths")
    await drain()

    expect(mockedApi.startWorkspaceStateStream).toHaveBeenCalledTimes(1)
    expect(mockedApi.startWorkspaceStateStream).toHaveBeenCalledWith(
      "/machine/t1",
      false
    )

    store.release(token)
    await vi.advanceTimersByTimeAsync(700)
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenCalledWith(
      "/machine/t1",
      false
    )
  })

  it("upgrades paths→full by adding the full ref BEFORE releasing the paths ref", async () => {
    const store = getWorkspaceStateStore("/machine/t2")
    const pathsToken = store.acquire("paths")
    await drain()
    expect(mockedApi.startWorkspaceStateStream).toHaveBeenLastCalledWith(
      "/machine/t2",
      false
    )

    const fullToken = store.acquire("full")
    await drain()

    expect(mockedApi.startWorkspaceStateStream).toHaveBeenLastCalledWith(
      "/machine/t2",
      true
    )
    // The old paths ref is released only after the full ref registered —
    // the backend refcount never touched zero (no teardown mid-upgrade).
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenCalledTimes(1)
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenCalledWith(
      "/machine/t2",
      false
    )
    const startOrder =
      mockedApi.startWorkspaceStateStream.mock.invocationCallOrder[1]
    const stopOrder =
      mockedApi.stopWorkspaceStateStream.mock.invocationCallOrder[0]
    expect(startOrder).toBeLessThan(stopOrder)

    store.release(fullToken)
    store.release(pathsToken)
    await vi.advanceTimersByTimeAsync(700)
  })

  it("downgrades full→paths on last full release, keeping the stream alive", async () => {
    const store = getWorkspaceStateStore("/machine/t3")
    const fullToken = store.acquire("full")
    await drain()
    expect(mockedApi.startWorkspaceStateStream).toHaveBeenLastCalledWith(
      "/machine/t3",
      true
    )
    const pathsToken = store.acquire("paths")
    await drain()

    store.release(fullToken)
    await drain()

    // Transition: re-register as paths, release the full ref.
    expect(mockedApi.startWorkspaceStateStream).toHaveBeenLastCalledWith(
      "/machine/t3",
      false
    )
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenCalledTimes(1)
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenCalledWith(
      "/machine/t3",
      true
    )

    // The stream survives: no shutdown while the paths token remains.
    await vi.advanceTimersByTimeAsync(700)
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenCalledTimes(1)

    store.release(pathsToken)
    await vi.advanceTimersByTimeAsync(700)
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenCalledTimes(2)
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenLastCalledWith(
      "/machine/t3",
      false
    )
  })

  it("treats a duplicate release as a no-op (StrictMode-safe)", async () => {
    const store = getWorkspaceStateStore("/machine/t4")
    const first = store.acquire("paths")
    const second = store.acquire("paths")
    await drain()

    store.release(first)
    store.release(first)
    store.release(first)
    await vi.advanceTimersByTimeAsync(700)

    // `second` still holds the stream — the duplicate releases must not
    // have driven the token count to zero.
    expect(mockedApi.stopWorkspaceStateStream).not.toHaveBeenCalled()

    store.release(second)
    await vi.advanceTimersByTimeAsync(700)
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenCalledTimes(1)
  })

  it("re-acquiring within the shutdown grace reuses the stream and resyncs", async () => {
    const store = getWorkspaceStateStore("/machine/t5")
    const token = store.acquire("paths")
    await drain()
    expect(mockedApi.startWorkspaceStateStream).toHaveBeenCalledTimes(1)
    const snapshotCallsAfterStart =
      mockedApi.getWorkspaceSnapshot.mock.calls.length

    store.release(token)
    await vi.advanceTimersByTimeAsync(300)

    const token2 = store.acquire("paths")
    await vi.advanceTimersByTimeAsync(700)

    // No stop, no second start — the grace window kept the stream.
    expect(mockedApi.stopWorkspaceStateStream).not.toHaveBeenCalled()
    expect(mockedApi.startWorkspaceStateStream).toHaveBeenCalledTimes(1)
    // Events during the ref-less window may have been dropped — the store
    // must pull a catch-up snapshot.
    expect(mockedApi.getWorkspaceSnapshot.mock.calls.length).toBeGreaterThan(
      snapshotCallsAfterStart
    )

    store.release(token2)
    await vi.advanceTimersByTimeAsync(700)
  })

  it("reconciles a full token acquired while the initial paths start is in flight", async () => {
    let resolveStart: ((value: unknown) => void) | null = null
    mockedApi.startWorkspaceStateStream.mockImplementationOnce(
      () => new Promise((resolve) => (resolveStart = resolve))
    )

    const store = getWorkspaceStateStore("/machine/t6")
    const pathsToken = store.acquire("paths")
    // Start call is pending; a full subscriber joins meanwhile.
    const fullToken = store.acquire("full")

    resolveStart!(fullSnapshot("/machine/t6"))
    await drain()
    await drain()

    // The post-start reconciliation upgraded the subscription to full.
    expect(mockedApi.startWorkspaceStateStream).toHaveBeenLastCalledWith(
      "/machine/t6",
      true
    )
    expect(mockedApi.stopWorkspaceStateStream).toHaveBeenCalledWith(
      "/machine/t6",
      false
    )

    store.release(fullToken)
    store.release(pathsToken)
    await vi.advanceTimersByTimeAsync(700)
  })
})

it("does not resync a directory whose stream failed to start", async () => {
  const errorLog = vi.spyOn(console, "error").mockImplementation(() => {})
  try {
    mockedApi.startWorkspaceStateStream.mockRejectedValueOnce({
      code: "not_found",
      message: "Folder does not exist",
    })
    const store = getWorkspaceStateStore("/machine/missing")
    const token = store.acquire("paths")
    await drain()
    await store.requestResync("manual_refresh")
    expect(mockedApi.getWorkspaceSnapshot).not.toHaveBeenCalled()
    expect(store.getSnapshot().health).toBe("degraded")
    store.release(token)
    await vi.advanceTimersByTimeAsync(700)
  } finally {
    errorLog.mockRestore()
  }
})

const file = (path: string): FileTreeNode => ({
  kind: "file",
  name: path.split("/").pop()!,
  path,
})
const dir = (path: string, children: FileTreeNode[]): FileTreeNode => ({
  kind: "dir",
  name: path.split("/").pop()!,
  path,
  children,
  isRepo: false,
})
const view = (
  tree: FileTreeNode[],
  git: WorkspaceStateView["git"] = []
): WorkspaceStateView => ({
  rootPath: "/p",
  seq: 0,
  version: 2,
  health: "healthy",
  tree,
  git,
  error: null,
  degraded: false,
  isGitRepo: true,
})

describe("workspace state patches", () => {
  it("applies a tree patch by path without mutating the previous tree", () => {
    const tree = [
      dir("docs", [file("docs/a.md"), file("docs/c.md")]),
      dir("src", [dir("src/lib", []), file("src/main.rs")]),
      file("README.md"),
      file("z.txt"),
    ]
    const before = JSON.stringify(tree)
    const next = applyDeltaToState(view(tree), {
      kind: "tree_patch",
      removals: ["docs/c.md", "z.txt"],
      upserts: [
        { parent: "docs", index: 1, node: file("docs/b.md") },
        { parent: "src/lib", index: 0, node: file("src/lib/mod.rs") },
        { parent: "", index: 3, node: file("y.txt") },
      ],
    })
    expect(next?.tree).toEqual([
      dir("docs", [file("docs/a.md"), file("docs/b.md")]),
      dir("src", [
        dir("src/lib", [file("src/lib/mod.rs")]),
        file("src/main.rs"),
      ]),
      file("README.md"),
      file("y.txt"),
    ])
    expect(JSON.stringify(tree)).toBe(before)
  })

  it("keeps order when a replaced entry moves behind an insert", () => {
    // 验收反例：`rmdir a && touch a && mkdir l`，宿主发 l@1、a@2。
    const next = applyDeltaToState(view([dir("a", []), dir("k", [])]), {
      kind: "tree_patch",
      removals: [],
      upserts: [
        { parent: "", index: 1, node: dir("l", []) },
        { parent: "", index: 2, node: file("a") },
      ],
    })
    expect(next?.tree).toEqual([dir("k", []), dir("l", []), file("a")])
  })

  it("applies a git patch in place", () => {
    const entry = (path: string, status: string) => ({
      path,
      status,
      additions: 1,
      deletions: 0,
    })
    const next = applyDeltaToState(
      view([], [entry("a.rs", "M"), entry("b.rs", "M"), entry("c.rs", "A")]),
      {
        kind: "git_patch",
        removals: ["c.rs"],
        upserts: [
          { index: 1, entry: entry("b.rs", "D") },
          { index: 2, entry: entry("bb.rs", "??") },
        ],
      }
    )
    expect(next?.git).toEqual([
      entry("a.rs", "M"),
      entry("b.rs", "D"),
      entry("bb.rs", "??"),
    ])
  })

  it("returns null for a patch that does not fit or an unknown kind", () => {
    expect(
      applyDeltaToState(view([file("a")]), {
        kind: "tree_patch",
        removals: ["missing"],
        upserts: [],
      })
    ).toBeNull()
    expect(
      applyDeltaToState(view([]), {
        kind: "future_kind",
      } as unknown as WorkspaceDelta)
    ).toBeNull()
  })
})

describe("workspace state events that cannot be applied", () => {
  async function startWithHandler(rootPath: string) {
    let handler: ((event: WorkspaceStateEvent) => void) | undefined
    vi.mocked(platform.subscribe).mockImplementation(async (_name, cb) => {
      handler = cb as (event: WorkspaceStateEvent) => void
      return () => {}
    })
    const store = getWorkspaceStateStore(rootPath)
    const token = store.acquire("full")
    await drain()
    mockedApi.getWorkspaceSnapshot.mockClear()
    const event = (
      patch: Partial<WorkspaceStateEvent>
    ): WorkspaceStateEvent => ({
      root_path: rootPath,
      seq: 1,
      version: 2,
      kind: "fs_delta",
      payload: [],
      requires_resync: false,
      changed_paths: [],
      ...patch,
    })
    return {
      store,
      token,
      emit: (e: WorkspaceStateEvent) => handler!(e),
      event,
    }
  }

  it("resyncs on an unknown delta kind and on a version mismatch", async () => {
    const { store, token, emit, event } =
      await startWithHandler("/machine/patch")
    emit(
      event({ payload: [{ kind: "future_kind" } as unknown as WorkspaceDelta] })
    )
    await drain()
    expect(mockedApi.getWorkspaceSnapshot).toHaveBeenCalledWith(
      "/machine/patch",
      0,
      2
    )
    mockedApi.getWorkspaceSnapshot.mockClear()
    emit(event({ version: 1 }))
    await drain()
    expect(mockedApi.getWorkspaceSnapshot).toHaveBeenCalledTimes(1)
    expect(store.getSnapshot().health).toBe("healthy")
    store.release(token)
    await vi.advanceTimersByTimeAsync(700)
  })

  it("falls back to a full snapshot when a replayed patch does not fit", async () => {
    const { store, token } = await startWithHandler("/machine/replay")
    const root = "/machine/replay"
    mockedApi.getWorkspaceSnapshot
      .mockResolvedValueOnce({
        ...fullSnapshot(root, 1),
        full: false,
        deltas: [
          {
            seq: 1,
            kind: "fs_delta",
            payload: [{ kind: "tree_patch", removals: ["gone"], upserts: [] }],
            requires_resync: false,
          },
        ],
      })
      .mockResolvedValueOnce({
        ...fullSnapshot(root, 1),
        tree_snapshot: [file("fresh")],
      })
    await store.requestResync("test")
    expect(mockedApi.getWorkspaceSnapshot).toHaveBeenLastCalledWith(
      root,
      undefined,
      2
    )
    expect(store.getSnapshot().tree).toEqual([file("fresh")])
    expect(store.getSnapshot().health).toBe("healthy")
    store.release(token)
    await vi.advanceTimersByTimeAsync(700)
  })
})
