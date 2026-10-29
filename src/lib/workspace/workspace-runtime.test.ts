import { beforeEach, describe, expect, it, vi } from "vitest"
import * as api from "@/lib/api"
import { isResourceFileTab } from "@/lib/files/file-workspace-tab"
import { fileTabIsInFolderScope } from "@/lib/workspace/tab-scope"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabStore } from "@/stores/tab-store"
import {
  resetWorkspaceFileStore,
  useWorkspaceFileStore,
} from "@/stores/workspace-file-store"
import {
  resetWorkspaceLayoutStore,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store"
import {
  createWorkspaceRuntime,
  type WorkspaceRuntimeDependencies,
} from "@/lib/workspace/workspace-runtime"

const folders = [{ id: 1, path: "/repo" }]
const deps: WorkspaceRuntimeDependencies = {
  scope: 1,
  folders,
  translate: (key, values) =>
    values ? `${key}:${JSON.stringify(values)}` : key,
  confirm: () => true,
}

beforeEach(() => {
  resetWorkspaceFileStore()
  resetWorkspaceLayoutStore()
  useAppWorkspaceStore.setState({ allFolders: [], activeFolderId: null })
  vi.restoreAllMocks()
})

describe("workspace runtime", () => {
  it.each([
    { path: "/loose/file.rs", owner: null },
    { path: "/repo/file.rs", owner: 1 },
  ])(
    "opens $path for a reveal request in the current project",
    async ({ path, owner }) => {
      const allFolders = [...folders, { id: 2, path: "/other" }]
      useAppWorkspaceStore.setState({
        allFolders: allFolders as never,
        activeFolderId: 1,
      })
      vi.spyOn(api, "readFileForEdit").mockResolvedValue({
        path: "file.rs",
        content: "first\nsecond",
        etag: "synthetic-cross-project",
        mtime_ms: 1,
        readonly: false,
        line_ending: "lf",
      })
      const onReveal = vi.fn()
      await createWorkspaceRuntime().openFilePreview(
        path,
        { line: 2, onReveal },
        { ...deps, folders: allFolders }
      )
      const state = useWorkspaceFileStore.getState()
      const tab = state.fileTabs.find((candidate) => candidate.path === path)
      expect(useAppWorkspaceStore.getState().activeFolderId).toBe(1)
      expect(state.activeFileTabId).toBe(tab?.id)
      expect(tab?.folderId).toBe(owner)
      expect(tab?.lifetime).toBeUndefined()
      expect(tab?.openedInFolderId).toBe(1)
      expect(state.unseenFileTabIds.size).toBe(0)
      expect(state.pendingFileReveal).toMatchObject({ path, ready: true })
      expect(onReveal).not.toHaveBeenCalled()
    }
  )

  it("opens another project's file in the background for a reveal request", async () => {
    const path = "/other/file.rs"
    const allFolders = [...folders, { id: 2, path: "/other" }]
    useAppWorkspaceStore.setState({
      allFolders: allFolders as never,
      activeFolderId: 1,
    })
    vi.spyOn(api, "readFileForEdit").mockResolvedValue({
      path: "file.rs",
      content: "first\nsecond",
      etag: "synthetic-cross-project",
      mtime_ms: 1,
      readonly: false,
      line_ending: "lf",
    })
    const onReveal = vi.fn()
    await createWorkspaceRuntime().openFilePreview(
      path,
      { line: 2, onReveal },
      { ...deps, folders: allFolders }
    )
    const state = useWorkspaceFileStore.getState()
    const tab = state.fileTabs.find((candidate) => candidate.path === path)
    // `berth open` 不切项目：留在当前项目，tab 标绿点，立即回执。
    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(1)
    expect(tab?.folderId).toBe(2)
    expect(state.unseenFileTabIds.has(tab!.id)).toBe(true)
    expect(onReveal).toHaveBeenCalledWith({ state: "opened", path, line: 2 })
    // 行定位留到切过去时：pending 仍在，但不再回执。
    expect(state.pendingFileReveal).toMatchObject({
      path,
      line: 2,
      ready: true,
    })
    expect(state.pendingFileReveal?.onComplete).toBeUndefined()
  })

  it("switches to the owning project when the user asks to see the file", async () => {
    const path = "/other/note.md"
    const allFolders = [...folders, { id: 2, path: "/other" }]
    useAppWorkspaceStore.setState({
      allFolders: allFolders as never,
      activeFolderId: 1,
    })
    vi.spyOn(api, "readFileForEdit").mockResolvedValue({
      path: "note.md",
      content: "x",
      etag: "e",
      mtime_ms: 1,
      readonly: false,
      line_ending: "lf",
    })
    const activate = vi
      .spyOn(useTabStore.getState(), "activateFolderWorkspace")
      .mockImplementation(() => {})
    const select = vi.spyOn(
      useWorkspaceLayoutStore.getState(),
      "selectWorkspaceTab"
    )
    await createWorkspaceRuntime().openFilePreview(
      path,
      { folderId: 1, switchToOwner: true },
      { ...deps, folders: allFolders }
    )
    const state = useWorkspaceFileStore.getState()
    const tab = state.fileTabs.find((candidate) => candidate.path === path)
    // 点击要看：直接切过去选中，不挂绿点
    expect(activate).toHaveBeenCalledWith(2)
    expect(select).toHaveBeenCalledWith(
      expect.objectContaining({ kind: "file", id: tab?.id })
    )
    expect(state.unseenFileTabIds.size).toBe(0)
  })

  it("keeps a tab in its own project when another project reopens it", async () => {
    const allFolders = [...folders, { id: 2, path: "/other" }]
    vi.spyOn(api, "readFileForEdit").mockResolvedValue({
      path: "file.rs",
      content: "x",
      etag: "e",
      mtime_ms: 1,
      readonly: false,
      line_ending: "lf",
    })
    const runtime = createWorkspaceRuntime()
    await runtime.openFilePreview("/other/file.rs", undefined, {
      ...deps,
      scope: 2,
      folders: allFolders,
    })
    await runtime.openFilePreview("/other/file.rs", undefined, {
      ...deps,
      folders: allFolders,
    })
    const state = useWorkspaceFileStore.getState()
    const tab = state.fileTabs.find((t) => t.path === "/other/file.rs")
    expect(state.fileTabs).toHaveLength(1)
    expect(tab?.lifetime).toBeUndefined()
    // 不搬移：仍只在项目 2 显示，并标「新开未看」。
    expect(tab?.openedInFolderId).toBe(2)
    expect(fileTabIsInFolderScope(tab!, 2, allFolders)).toBe(true)
    expect(fileTabIsInFolderScope(tab!, 1, allFolders)).toBe(false)
    expect(state.unseenFileTabIds.has(tab!.id)).toBe(true)
  })

  it("registers a target-bound receipt even when no line is requested", async () => {
    vi.spyOn(api, "readFileBase64").mockResolvedValue("aW1hZ2U=")
    const onReveal = vi.fn()
    await createWorkspaceRuntime().openFilePreview(
      "/repo/./image.png",
      { onReveal },
      deps
    )
    expect(useWorkspaceFileStore.getState().pendingFileReveal).toMatchObject({
      path: "/repo/image.png",
      line: null,
      onComplete: onReveal,
    })
    expect(onReveal).not.toHaveBeenCalled()
  })

  it("marks only its still-current reveal ready after loading completes", async () => {
    let finishLoad!: (data: string) => void
    vi.spyOn(api, "readFileBase64").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLoad = resolve
        })
    )
    const onReveal = vi.fn()
    const opening = createWorkspaceRuntime().openFilePreview(
      "/repo/image.png",
      { onReveal },
      deps
    )
    await vi.waitFor(() =>
      expect(useWorkspaceFileStore.getState().pendingFileReveal?.ready).toBe(
        false
      )
    )
    finishLoad("aW1hZ2U=")
    await opening
    expect(useWorkspaceFileStore.getState().pendingFileReveal?.ready).toBe(true)
    expect(onReveal).not.toHaveBeenCalled()
  })

  it("never restores a replaced reveal when its old load completes", async () => {
    let finishLoad!: (data: string) => void
    vi.spyOn(api, "readFileBase64").mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLoad = resolve
        })
    )
    const onReveal = vi.fn()
    const opening = createWorkspaceRuntime().openFilePreview(
      "/repo/image.png",
      { onReveal },
      deps
    )
    await vi.waitFor(() =>
      expect(useWorkspaceFileStore.getState().pendingFileReveal).not.toBeNull()
    )
    const replacement = {
      requestId: 999,
      path: "/synthetic/other.rs",
      line: 1,
      page: null,
      ready: false,
    }
    useWorkspaceFileStore.getState().setPendingFileReveal(replacement)
    finishLoad("aW1hZ2U=")
    await opening
    expect(useWorkspaceFileStore.getState().pendingFileReveal).toBe(replacement)
    expect(onReveal).toHaveBeenCalledWith({
      state: "failed",
      message: expect.stringContaining("cancel"),
    })
  })

  it("does not register a late reveal after its waiter has been aborted", async () => {
    const controller = new AbortController()
    controller.abort()
    const onReveal = vi.fn()
    const read = vi.spyOn(api, "readFileBase64")
    await expect(
      createWorkspaceRuntime().openFilePreview(
        "/repo/image.png",
        { onReveal, signal: controller.signal },
        deps
      )
    ).rejects.toThrow()
    expect(read).not.toHaveBeenCalled()
    expect(useWorkspaceFileStore.getState().pendingFileReveal).toBeNull()
  })

  it("uses the source editor for line requests instead of HTML preview", async () => {
    vi.spyOn(api, "readFileForEdit").mockResolvedValue({
      path: "page.html",
      content: "first\nsecond",
      etag: "synthetic",
      mtime_ms: 1,
      readonly: false,
      line_ending: "lf",
    })
    const runtime = createWorkspaceRuntime()
    await runtime.openFilePreview("/repo/page.html", undefined, deps)
    const tabId = useWorkspaceFileStore.getState().fileTabs[0].id
    expect(useWorkspaceFileStore.getState().previewFileTabIds.has(tabId)).toBe(
      true
    )
    await runtime.openFilePreview(
      "/repo/page.html",
      { line: 2, onReveal: vi.fn() },
      deps
    )
    expect(useWorkspaceFileStore.getState().previewFileTabIds.has(tabId)).toBe(
      false
    )
  })

  it("closing the active file selects its neighbor in the same tab group", async () => {
    useAppWorkspaceStore.setState({
      allFolders: folders as never,
      activeFolderId: 1,
    })
    vi.spyOn(api, "readFileForEdit").mockResolvedValue({
      path: "x",
      content: "x",
      etag: "synthetic",
      mtime_ms: 1,
      readonly: false,
      line_ending: "lf",
    })
    const runtime = createWorkspaceRuntime()
    for (const name of ["a", "b", "c"]) {
      await runtime.openFilePreview(`/repo/${name}.ts`, undefined, deps)
    }
    const [a, b, c] = useWorkspaceFileStore.getState().fileTabs
    useWorkspaceLayoutStore.setState({
      placementByScope: { "folder:1": { [`file:${c.id}`]: "files-split" } },
    })
    useWorkspaceLayoutStore
      .getState()
      .selectWorkspaceTab({ kind: "file", id: b.id, type: "file" })
    expect(useWorkspaceFileStore.getState().activeFileTabId).toBe(b.id)

    await runtime.closeFileTab(b.id, deps)

    // The global next tab would be `c`, but it lives in the right group.
    expect(useWorkspaceFileStore.getState().activeFileTabId).toBe(a.id)
    expect(useWorkspaceLayoutStore.getState().activeTabByPane.files?.id).toBe(
      a.id
    )
  })

  it("cancels a pending receipt when its file tab is closed", async () => {
    vi.spyOn(api, "readFileBase64").mockResolvedValue("aW1hZ2U=")
    const runtime = createWorkspaceRuntime()
    const onReveal = vi.fn()
    await runtime.openFilePreview("/repo/image.png", { onReveal }, deps)
    const tab = useWorkspaceFileStore.getState().fileTabs[0]
    await runtime.closeFileTab(tab.id, deps)
    expect(useWorkspaceFileStore.getState().pendingFileReveal).toBeNull()
    expect(onReveal).toHaveBeenCalledWith({
      state: "failed",
      message: expect.stringContaining("cancel"),
    })
  })

  it("rejects a requested receipt when resource loading fails instead of accepting a cleared tab", async () => {
    vi.spyOn(api, "readFileBase64").mockRejectedValue(
      new Error("synthetic load failure")
    )
    const onReveal = vi.fn()
    await expect(
      createWorkspaceRuntime().openFilePreview(
        "/repo/image.png",
        { onReveal },
        deps
      )
    ).rejects.toThrow("file could not be loaded")
    expect(onReveal).not.toHaveBeenCalledWith(
      expect.objectContaining({ state: "opened" })
    )
    expect(useWorkspaceFileStore.getState().fileTabs).toHaveLength(0)
  })

  it("opens resource previews without a React owner", async () => {
    useAppWorkspaceStore.setState({
      allFolders: folders as never,
      activeFolderId: 1,
    })
    vi.spyOn(api, "readFileBase64").mockResolvedValue("aW1hZ2U=")
    const runtime = createWorkspaceRuntime()

    await runtime.openFilePreview("/repo/image.png", undefined, deps)

    const tab = useWorkspaceFileStore.getState().fileTabs[0]
    expect(tab && isResourceFileTab(tab) ? tab.preview : null).toEqual({
      kind: "image",
      revision: 1,
      dataUrl: "data:image/png;base64,aW1hZ2U=",
    })
    expect(useWorkspaceLayoutStore.getState().activeWorkspaceTab?.id).toBe(
      tab?.id
    )
  })

  it("loads a working-tree diff into a stable file tab", async () => {
    useAppWorkspaceStore.setState({
      allFolders: folders as never,
      activeFolderId: 1,
    })
    vi.spyOn(api, "gitDiff").mockResolvedValue("diff --git a/a.ts b/a.ts")
    const runtime = createWorkspaceRuntime()

    await runtime.openWorkingTreeDiff("src/a.ts", undefined, deps)

    const tab = useWorkspaceFileStore.getState().fileTabs[0]
    expect(tab?.kind).toBe("rich-diff")
    expect(tab && "originalContent" in tab ? tab.originalContent : null).toBe(
      ""
    )
  })

  it("keeps conflict queue ownership in the file store", () => {
    const runtime = createWorkspaceRuntime()
    runtime.enqueueExternalConflict({
      path: "/repo/a.ts",
      diskContent: "disk",
      unsavedContent: "local",
      signature: "etag-2",
    })

    expect(runtime.externalConflict?.path).toBe("/repo/a.ts")
    runtime.dismissExternalConflict()
    expect(useWorkspaceFileStore.getState().externalConflictQueue).toEqual([])
  })

  it("closes dirty tabs through the injected confirmation boundary", async () => {
    useAppWorkspaceStore.setState({
      allFolders: folders as never,
      activeFolderId: 1,
    })
    vi.spyOn(api, "readFileForEdit").mockResolvedValue({
      path: "a.ts",
      content: "disk",
      etag: "etag-1",
      mtime_ms: 1,
      readonly: false,
      line_ending: "lf",
    })
    const runtime = createWorkspaceRuntime()
    await runtime.openFilePreview("/repo/a.ts", undefined, deps)
    runtime.updateFileTabContent(
      useWorkspaceFileStore.getState().activeFileTabId ?? "",
      "local"
    )
    const confirm = vi.fn(async () => false)

    await runtime.closeFileTab("file:%2Frepo%2Fa.ts", { ...deps, confirm })

    expect(confirm).toHaveBeenCalledOnce()
    expect(useWorkspaceFileStore.getState().fileTabs).toHaveLength(1)
  })

  it("toasts error and closes tab when resource loading fails", async () => {
    useAppWorkspaceStore.setState({
      allFolders: folders as never,
      activeFolderId: 1,
    })
    vi.spyOn(api, "readFileBase64").mockRejectedValue(
      new Error("File does not exist")
    )
    const runtime = createWorkspaceRuntime()

    await runtime.openFilePreview("/repo/nonexistent.png", undefined, deps)

    expect(useWorkspaceFileStore.getState().fileTabs).toHaveLength(0)
  })
})
