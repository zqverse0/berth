import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { useOpenFileTabsWatch } from "./use-open-file-tabs-watch"
import type { TextFileWorkspaceTab } from "@/lib/files/file-workspace-tab"
import { workspaceFileRuntime } from "@/lib/workspace/workspace-file-runtime"
import * as workspaceStateStore from "@/hooks/workspace/use-workspace-state-store"

function textTabFixture(
  id: string,
  path: string,
  overrides: Partial<TextFileWorkspaceTab> = {}
): TextFileWorkspaceTab {
  return {
    id,
    kind: "file",
    dataMode: "text",
    previewKind: "text",
    folderId: 1,
    title: id,
    description: path,
    path,
    language: "typescript",
    content: "console.log(1)",
    savedContent: "console.log(1)",
    isDirty: false,
    etag: "e1",
    mtimeMs: 1,
    readonly: false,
    lineEnding: "lf",
    loading: false,
    saveState: "idle",
    saveError: null,
    ...overrides,
  }
}

describe("useOpenFileTabsWatch", () => {
  beforeEach(() => {
    vi.restoreAllMocks()
  })

  it("closes clean tabs when inspectExternalChange reports missing", async () => {
    let subscriber:
      | ((envelope: { changed_paths: string[]; kind?: string }) => void)
      | null = null
    vi.spyOn(workspaceStateStore, "getWorkspaceStateStore").mockReturnValue({
      acquire: vi.fn(() => 1),
      release: vi.fn(),
      subscribeEnvelopes: vi.fn((cb) => {
        subscriber = cb
        return () => {}
      }),
    } as never)

    const tab = textTabFixture("t1", "/repo/src/app.ts")
    const closeFileTab = vi.fn()
    const rejectFileTab = vi.fn()
    const markTabsStale = vi.fn()

    vi.spyOn(workspaceFileRuntime, "inspectExternalChange").mockResolvedValue({
      kind: "missing",
      path: "/repo/src/app.ts",
      error: "File does not exist",
    })

    renderHook(() =>
      useOpenFileTabsWatch({
        fileTabs: [tab],
        fileTabsRef: { current: [tab] },
        activeFileTabIdRef: { current: "t1" },
        activeFileTab: tab,
        allFolders: [{ id: 1, path: "/repo" }],
        openFilePreview: vi.fn(),
        closeFileTab,
        bumpResourceRevision: vi.fn(),
        applyExternalReload: vi.fn(),
        markTabsStale,
        markTabsStaleBatch: vi.fn(),
        rejectFileTab,
        enqueueExternalConflict: vi.fn(),
        consumeSelfWriteEcho: vi.fn(() => false),
      })
    )

    expect(subscriber).toBeTruthy()
    // 断言存在后非空调用：赋值在 mock 回调里，TS 窄化为 null 报不可调用
    subscriber!({ changed_paths: ["app.ts"] })

    await waitFor(() => {
      expect(closeFileTab).toHaveBeenCalledWith("t1")
    })
    expect(rejectFileTab).not.toHaveBeenCalled()
  })

  it("marks dirty tabs stale without closing when inspectExternalChange reports missing", async () => {
    let subscriber:
      | ((envelope: { changed_paths: string[]; kind?: string }) => void)
      | null = null
    vi.spyOn(workspaceStateStore, "getWorkspaceStateStore").mockReturnValue({
      acquire: vi.fn(() => 1),
      release: vi.fn(),
      subscribeEnvelopes: vi.fn((cb) => {
        subscriber = cb
        return () => {}
      }),
    } as never)

    const tab = textTabFixture("t1", "/repo/src/app.ts", { isDirty: true })
    const closeFileTab = vi.fn()
    const rejectFileTab = vi.fn()
    const markTabsStale = vi.fn()

    vi.spyOn(workspaceFileRuntime, "inspectExternalChange").mockResolvedValue({
      kind: "missing",
      path: "/repo/src/app.ts",
      error: "File does not exist",
    })

    renderHook(() =>
      useOpenFileTabsWatch({
        fileTabs: [tab],
        fileTabsRef: { current: [tab] },
        activeFileTabIdRef: { current: "t1" },
        activeFileTab: tab,
        allFolders: [{ id: 1, path: "/repo" }],
        openFilePreview: vi.fn(),
        closeFileTab,
        bumpResourceRevision: vi.fn(),
        applyExternalReload: vi.fn(),
        markTabsStale,
        markTabsStaleBatch: vi.fn(),
        rejectFileTab,
        enqueueExternalConflict: vi.fn(),
        consumeSelfWriteEcho: vi.fn(() => false),
      })
    )

    expect(subscriber).toBeTruthy()
    // 断言存在后非空调用：赋值在 mock 回调里，TS 窄化为 null 报不可调用
    subscriber!({ changed_paths: ["app.ts"] })

    await waitFor(() => {
      expect(markTabsStale).toHaveBeenCalledWith("/repo/src/app.ts")
    })
    expect(closeFileTab).not.toHaveBeenCalled()
  })
})
