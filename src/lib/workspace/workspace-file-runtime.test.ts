import { beforeEach, describe, expect, it, vi } from "vitest"
import * as api from "@/lib/api"
import { isTextFileTab } from "@/lib/files/file-workspace-tab"
import {
  createWorkspaceFileRuntime,
  planColdTextEviction,
  WORKSPACE_COLD_CONTENT_BUDGET,
  type WorkspaceFileRuntimeContext,
} from "@/lib/workspace/workspace-file-runtime"
import type { TextFileWorkspaceTab } from "@/lib/files/file-workspace-tab"
import {
  resetWorkspaceFileStore,
  useWorkspaceFileStore,
} from "@/stores/workspace-file-store"

const folders = [
  { id: 1, path: "/repo" },
  { id: 2, path: "/repo2" },
]

function context(
  scope = 1,
  onConflict?: WorkspaceFileRuntimeContext["enqueueExternalConflict"]
): WorkspaceFileRuntimeContext {
  return {
    scope,
    folders,
    translate: (key, values) =>
      values ? `${key}:${JSON.stringify(values)}` : key,
    enqueueExternalConflict: onConflict,
  }
}

function fileResult(content: string, etag: string) {
  return {
    path: "file.ts",
    content,
    etag,
    mtime_ms: 1,
    readonly: false,
    line_ending: "lf" as const,
  }
}

describe("workspace file runtime", () => {
  beforeEach(() => {
    resetWorkspaceFileStore()
    vi.restoreAllMocks()
    vi.spyOn(api, "gitIsTracked").mockResolvedValue(false)
  })

  it("opens and activates an ordinary file without a React owner", async () => {
    vi.spyOn(api, "readFileForEdit").mockResolvedValue(
      fileResult("hello", "e1")
    )
    const activate = vi.fn()
    const runtime = createWorkspaceFileRuntime()

    await runtime.openTextFile("/repo/src/app.ts", undefined, {
      ...context(),
      activateFileTab: activate,
    })

    const state = useWorkspaceFileStore.getState()
    expect(state.fileTabs).toHaveLength(1)
    const loaded = state.fileTabs[0]
    expect(loaded && isTextFileTab(loaded) ? loaded.content : null).toBe(
      "hello"
    )
    expect(state.activeFileTabId).toBe(loaded?.id)
    expect(activate).toHaveBeenCalledWith(state.fileTabs[0]?.id)
  })

  it("filters activation by folder scope while retaining hidden tabs", async () => {
    vi.spyOn(api, "readFileForEdit").mockResolvedValue(
      fileResult("hello", "e1")
    )
    const runtime = createWorkspaceFileRuntime()
    // 在项目 1 打开项目 2 的文件：只归项目 2，项目 1 不激活它，tab 仍保留。
    await runtime.openTextFile("/repo2/src/app.ts", undefined, context())
    const tabId = useWorkspaceFileStore.getState().fileTabs[0]?.id ?? ""

    expect(useWorkspaceFileStore.getState().activeFileTabId).toBeNull()
    expect(runtime.activateFileTab(tabId, context())).toBe(false)
    expect(runtime.activateFileTab(tabId, context(2))).toBe(true)
    expect(useWorkspaceFileStore.getState().fileTabs).toHaveLength(1)
  })

  it("does not let a stale load write after close and reopen", async () => {
    const reads: Array<{
      resolve: (value: ReturnType<typeof fileResult>) => void
    }> = []
    vi.spyOn(api, "readFileForEdit").mockImplementation(
      () =>
        new Promise((resolve) => {
          reads.push({ resolve })
        })
    )
    const runtime = createWorkspaceFileRuntime()
    const first = runtime.openTextFile("/repo/src/app.ts", undefined, context())
    const firstTabId = useWorkspaceFileStore.getState().fileTabs[0]?.id
    expect(firstTabId).toBeTruthy()

    runtime.invalidateFileTab(firstTabId ?? "")
    useWorkspaceFileStore.getState().setFileTabs([])
    const second = runtime.openTextFile(
      "/repo/src/app.ts",
      undefined,
      context()
    )

    reads[0]?.resolve(fileResult("old", "old"))
    reads[1]?.resolve(fileResult("new", "new"))
    await Promise.all([first, second])

    const reopened = useWorkspaceFileStore.getState().fileTabs[0]
    expect(reopened && isTextFileTab(reopened) ? reopened.content : null).toBe(
      "new"
    )
    expect(reopened && isTextFileTab(reopened) ? reopened.etag : null).toBe(
      "new"
    )
  })

  it("preserves dirty content and reports a disk conflict before saving", async () => {
    vi.spyOn(api, "readFileForEdit")
      .mockResolvedValueOnce(fileResult("disk", "e1"))
      .mockResolvedValueOnce(fileResult("changed on disk", "e2"))
    const save = vi.spyOn(api, "saveFileContent")
    const conflict = vi.fn()
    const runtime = createWorkspaceFileRuntime()
    const ctx = context(1, conflict)
    await runtime.openTextFile("/repo/src/app.ts", undefined, ctx)
    const tabId = useWorkspaceFileStore.getState().activeFileTabId
    expect(tabId).toBeTruthy()
    runtime.updateFileTabContent(tabId ?? "", "local edits")
    runtime.markTabsStale("/repo/src/app.ts")

    expect(await runtime.saveFileTab(tabId ?? "", undefined, ctx)).toBe(false)
    const tab = useWorkspaceFileStore.getState().fileTabs[0]
    expect(tab && "content" in tab ? tab.content : "").toBe("local edits")
    expect(conflict).toHaveBeenCalledWith(
      {
        path: "/repo/src/app.ts",
        diskContent: "changed on disk",
        unsavedContent: "local edits",
        signature: "e2",
      },
      { force: true }
    )
    expect(save).not.toHaveBeenCalled()
  })

  it("toasts error and does not retain tab when opening non-existent file", async () => {
    vi.spyOn(api, "readFileForEdit").mockRejectedValue(
      new Error("File does not exist")
    )
    const runtime = createWorkspaceFileRuntime()
    await runtime.openTextFile("/repo/src/missing.ts", undefined, context())

    expect(useWorkspaceFileStore.getState().fileTabs).toHaveLength(0)
    expect(useWorkspaceFileStore.getState().activeFileTabId).toBeNull()
  })

  it("toasts error and does not retain tab when opening unsupported binary file", async () => {
    vi.spyOn(api, "readFileForEdit").mockRejectedValue(
      new Error("Binary files are not supported in preview")
    )
    const runtime = createWorkspaceFileRuntime()
    await runtime.openTextFile("/repo/src/blob.bin", undefined, context())

    expect(useWorkspaceFileStore.getState().fileTabs).toHaveLength(0)
    expect(useWorkspaceFileStore.getState().activeFileTabId).toBeNull()
  })
})

function textTabFixture(
  id: string,
  contentLength: number,
  overrides: Partial<TextFileWorkspaceTab> = {}
): TextFileWorkspaceTab {
  const content = "x".repeat(contentLength)
  return {
    id,
    kind: "file",
    dataMode: "text",
    previewKind: "text",
    folderId: 1,
    title: id,
    description: null,
    path: `/repo/${id}`,
    language: "plaintext",
    content,
    savedContent: content,
    isDirty: false,
    etag: `${id}-etag`,
    mtimeMs: 1,
    readonly: false,
    lineEnding: "none",
    loading: false,
    saveState: "idle",
    saveError: null,
    ...overrides,
  }
}

describe("cold text content eviction", () => {
  beforeEach(() => {
    resetWorkspaceFileStore()
    vi.restoreAllMocks()
  })

  it("evicts coldest tabs first until the footprint fits the budget", () => {
    const store = useWorkspaceFileStore.getState()
    // 两个候选共 4.6MB，超出预算；recency 让 t-cold 最冷。
    store.restoreFileTabs({
      tabs: [
        textTabFixture("t-active", 1_000),
        textTabFixture("t-new", 2_000_000),
        textTabFixture("t-old", 100_000, { gitBaseContent: undefined }),
        textTabFixture("t-cold", 2_600_000),
      ],
      activeTabId: "t-active",
      activeTabIdByScope: {},
    })
    const runtime = createWorkspaceFileRuntime()

    const evicted = runtime.unloadColdTextContent(
      useWorkspaceFileStore.getState().fileTabs,
      "t-active",
      ["t-new", "t-old"],
      // 生产默认预算为 48M 字符；此处注入小预算以复现原 4M 收敛场景。
      { budget: 4_000_000 }
    )

    expect(WORKSPACE_COLD_CONTENT_BUDGET).toBe(48 * 1024 * 1024)
    // t-new(2MB) 命中预算内保留；最冷的 t-cold（无 recency 记录）先被逐出。
    expect(evicted).toBe(1)
    const tabById = (id: string) => {
      const tab = useWorkspaceFileStore
        .getState()
        .fileTabs.find((candidate) => candidate.id === id)
      return tab && isTextFileTab(tab) ? tab : null
    }
    const cold = tabById("t-cold")
    expect(cold?.content).toBe("")
    expect(cold?.savedContent).toBe("")
    expect(cold?.gitBaseContent).toBeUndefined()
    expect(cold?.stale).toBe(true)
    // 命中预算后停止，更早的 t-old 内容保持不变。
    expect(tabById("t-old")?.content.length).toBe(100_000)
    expect(tabById("t-new")?.content.length).toBe(2_000_000)
    expect(tabById("t-active")?.stale).toBeFalsy()
  })

  it("never unloads active, dirty, loading, or saving tabs", () => {
    const store = useWorkspaceFileStore.getState()
    store.restoreFileTabs({
      tabs: [
        textTabFixture("t-dirty", 3_000_000, { isDirty: true }),
        textTabFixture("t-loading", 3_000_000, { loading: true }),
        textTabFixture("t-saving", 3_000_000, { saveState: "saving" }),
        textTabFixture("t-clean-cold", 4_500_000),
      ],
      activeTabId: null,
      activeTabIdByScope: {},
    })
    const runtime = createWorkspaceFileRuntime()

    const evicted = runtime.unloadColdTextContent(
      useWorkspaceFileStore.getState().fileTabs,
      null,
      [],
      { budget: 4_000_000 }
    )

    // 只有可安全卸载的冷候选参与预算计算：dirty/loading/saving 均不计入，
    // 仅超预算的 t-clean-cold 被逐出。
    expect(evicted).toBe(1)
    for (const protected_tab of ["t-dirty", "t-loading", "t-saving"]) {
      const tab = useWorkspaceFileStore
        .getState()
        .fileTabs.find((candidate) => candidate.id === protected_tab)
      expect(tab && isTextFileTab(tab) ? tab.content : null).toHaveLength(
        3_000_000
      )
      expect(tab && isTextFileTab(tab) ? tab.stale : true).toBeFalsy()
    }
    const cold = useWorkspaceFileStore
      .getState()
      .fileTabs.find((candidate) => candidate.id === "t-clean-cold")
    expect(cold && isTextFileTab(cold) ? cold.content : null).toBe("")
  })

  it("counts shared gitBaseContent once — no false eviction", () => {
    // 共享 gitBase（gitBaseContent === content）只能计一次费。
    // 用例设计：总真实占用 1800 超预算 1000，两者都应逐出；
    // 若双倍计费（旧缺陷），t1 的扣减会虚增到 1200，逐出循环在
    // 剩余量判断上失真。此用例锁定 charCount 守卫语义。
    const shared = "x".repeat(600)
    const unloadIds = planColdTextEviction({
      tabs: [
        textTabFixture("t-shared-1", 600, { gitBaseContent: shared }),
        textTabFixture("t-shared-2", 600, { gitBaseContent: "y".repeat(600) }),
      ],
      activeTabId: null,
      recency: [],
      budget: 1000,
    })

    expect(unloadIds).toContain("t-shared-1")
    expect(unloadIds).toContain("t-shared-2")
  })

  it("never evicts when shared gitBase keeps the true footprint within budget", () => {
    // 单个共享 gitBase tab：真占用 600，双倍虚增则是 1200。
    // 预算 1000：正确行为是不逐出；旧缺陷会误判超支并逐出。
    const shared = "x".repeat(600)
    const unloadIds = planColdTextEviction({
      tabs: [textTabFixture("t-only-shared", 600, { gitBaseContent: shared })],
      activeTabId: null,
      recency: [],
      budget: 1000,
    })

    expect(unloadIds).toEqual([])
  })

  it("re-checks loading/saving state atomically before clearing content", () => {
    // planner 吃的是调用方传入的快照；快照可能落后于 store 实际状态。
    // 构造快照里 clean、store 里已进入 loading/saving 的两个 tab，
    //Setter 原子复查必须拒绝清空它们；仅真正 idle 的候选会被卸载。
    useWorkspaceFileStore.getState().restoreFileTabs({
      tabs: [
        textTabFixture("t-now-loading", 600, { loading: true }),
        textTabFixture("t-now-saving", 600, { saveState: "saving" }),
        textTabFixture("t-still-clean", 600),
      ],
      activeTabId: null,
      activeTabIdByScope: {},
    })
    const runtime = createWorkspaceFileRuntime()

    const staleSnapshot = useWorkspaceFileStore
      .getState()
      .fileTabs.map((tab) =>
        isTextFileTab(tab) &&
        (tab.id === "t-now-loading" || tab.id === "t-now-saving")
          ? { ...tab, loading: false, saveState: "idle" as const }
          : tab
      )

    const evicted = runtime.unloadColdTextContent(
      staleSnapshot,
      null,
      [],
      // 预算小于单个 tab，迫使 planner 把全部三个都列入逐出计划。
      { budget: 500 }
    )

    expect(evicted).toBe(3)
    const tabById = (id: string) => {
      const tab = useWorkspaceFileStore
        .getState()
        .fileTabs.find((candidate) => candidate.id === id)
      return tab && isTextFileTab(tab) ? tab : null
    }
    // 复查拦截：快照虽报 clean，但真实态已转入 loading/saving，不可清。
    expect(tabById("t-now-loading")?.content).toHaveLength(600)
    expect(tabById("t-now-saving")?.content).toHaveLength(600)
    expect(tabById("t-now-loading")?.stale).toBeFalsy()
    // 真正 idle 的候选按计划正常卸载。
    expect(tabById("t-still-clean")?.content).toBe("")
    expect(tabById("t-still-clean")?.stale).toBe(true)
  })
})
