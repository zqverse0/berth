import { beforeEach, describe, expect, it, vi } from "vitest"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"

describe("workspace file reveal receipt", () => {
  beforeEach(() => useWorkspaceFileStore.getState().reset())

  function pending(requestId: number, onComplete = vi.fn()) {
    return {
      requestId,
      path: "/synthetic/file.rs",
      line: 99,
      page: null,
      onComplete,
    }
  }

  it("settles only the matching request with its actual path and line", () => {
    const request = pending(7)
    const store = useWorkspaceFileStore.getState()
    store.setPendingFileReveal(request)
    const actual = { state: "opened" as const, path: request.path, line: 3 }
    store.consumePendingFileReveal(8, actual)
    expect(request.onComplete).not.toHaveBeenCalled()
    expect(useWorkspaceFileStore.getState().pendingFileReveal).toBe(request)
    store.consumePendingFileReveal(7, actual)
    expect(request.onComplete).toHaveBeenCalledTimes(1)
    expect(request.onComplete).toHaveBeenCalledWith(actual)
    expect(useWorkspaceFileStore.getState().pendingFileReveal).toBeNull()
    store.consumePendingFileReveal(7, actual)
    expect(request.onComplete).toHaveBeenCalledTimes(1)
  })

  it("keeps the same request callback alive when its load becomes ready", () => {
    const request = { ...pending(7), ready: false }
    const store = useWorkspaceFileStore.getState()
    store.setPendingFileReveal(request)
    store.consumePendingFileReveal(7, {
      state: "opened",
      path: request.path,
      line: 3,
    })
    expect(useWorkspaceFileStore.getState().pendingFileReveal).toBe(request)
    expect(request.onComplete).not.toHaveBeenCalled()
    store.setPendingFileReveal({ ...request, ready: true })
    expect(request.onComplete).not.toHaveBeenCalled()
  })

  it.each([
    ["/synthetic/dir/../file.rs", "/synthetic/file.rs"],
    ["c:\\synthetic\\file.rs", "C:/synthetic/file.rs"],
    ["//host/share/dir/../file.rs", "//host/share/file.rs"],
  ])(
    "accepts normalized aliases and preserves actual path %s",
    (requested, actual) => {
      const request = { ...pending(7), path: requested }
      const store = useWorkspaceFileStore.getState()
      store.setPendingFileReveal(request)
      const outcome = { state: "opened" as const, path: actual, line: 3 }
      store.consumePendingFileReveal(7, outcome)
      expect(request.onComplete).toHaveBeenCalledWith(outcome)
    }
  )

  it("cannot settle the next request with a stale editor completion", () => {
    const first = pending(7)
    const second = pending(8)
    const store = useWorkspaceFileStore.getState()
    store.setPendingFileReveal(first)
    store.setPendingFileReveal(second)
    store.consumePendingFileReveal(7, {
      state: "opened",
      path: second.path,
      line: 99,
    })
    expect(second.onComplete).not.toHaveBeenCalled()
    expect(useWorkspaceFileStore.getState().pendingFileReveal).toBe(second)
  })

  it("rejects a completion for a different path", () => {
    const request = pending(7)
    const store = useWorkspaceFileStore.getState()
    store.setPendingFileReveal(request)
    store.consumePendingFileReveal(7, {
      state: "opened",
      path: "/synthetic/other.rs",
      line: 99,
    })
    expect(request.onComplete).toHaveBeenCalledWith({
      state: "failed",
      message: expect.stringContaining("path"),
    })
  })

  it.each(["replace", "clear", "consume", "reset"])(
    "reports %s as cancellation, never as opened",
    (action) => {
      const request = pending(7)
      const store = useWorkspaceFileStore.getState()
      store.setPendingFileReveal(request)
      if (action === "replace") store.setPendingFileReveal(pending(8))
      if (action === "clear") store.setPendingFileReveal(null)
      if (action === "consume") store.consumePendingFileReveal(7)
      if (action === "reset") store.reset()
      expect(request.onComplete).toHaveBeenCalledTimes(1)
      expect(request.onComplete).toHaveBeenCalledWith({
        state: "failed",
        message: expect.stringContaining("cancel"),
      })
    }
  )
})

describe("workspace file zoom", () => {
  beforeEach(() => useWorkspaceFileStore.getState().reset())

  it("stores zoom by tab and removes the default entry", () => {
    const store = useWorkspaceFileStore.getState()

    store.setFileZoom("file:a", 137)
    store.setFileZoom("file:b", 80)
    expect(useWorkspaceFileStore.getState().fileZoomByTab).toEqual({
      "file:a": 140,
      "file:b": 80,
    })

    useWorkspaceFileStore.getState().setFileZoom("file:a", 100)
    expect(useWorkspaceFileStore.getState().fileZoomByTab).toEqual({
      "file:b": 80,
    })
  })

  it("clamps zoom to the supported range", () => {
    const store = useWorkspaceFileStore.getState()

    store.setFileZoom("file:min", 20)
    store.setFileZoom("file:max", 260)

    expect(useWorkspaceFileStore.getState().fileZoomByTab).toEqual({
      "file:min": 50,
      "file:max": 200,
    })
  })
})

describe("workspace file pin", () => {
  beforeEach(() => useWorkspaceFileStore.getState().reset())

  it("keeps an unpinned tab in the project it was unpinned from", () => {
    useWorkspaceFileStore.getState().setFileTabs([
      {
        id: "file:/other/a.ts",
        kind: "task",
        folderId: 2,
        taskDirName: "a",
        title: "a",
        description: null,
        path: null,
        readonly: true,
        loading: false,
        saveState: "idle",
        saveError: null,
        lifetime: "global",
      },
    ])
    useWorkspaceFileStore.getState().toggleFileTabGlobal("file:/other/a.ts", 1)
    expect(useWorkspaceFileStore.getState().fileTabs[0]).toMatchObject({
      lifetime: "project",
      openedInFolderId: 1,
    })
  })
})
