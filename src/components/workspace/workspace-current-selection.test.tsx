import { act, cleanup, render } from "@testing-library/react"
import { afterEach, beforeEach, expect, it, vi } from "vitest"
import type { WorkspaceLayoutProjection } from "@/lib/workspace/workspace-layout-projection"
import type {
  FileWorkspaceTab,
  TextFileWorkspaceTab,
} from "@/lib/files/file-workspace-tab"
import {
  WORKSPACE_PANES,
  workspaceTabRefEqual,
} from "@/lib/workspace/workspace-pane-model"
import type {
  WorkspacePane,
  WorkspaceTabRef,
} from "@/lib/workspace/workspace-tab-placement"
import { SETTINGS_GLOBAL_TAB_ID } from "@/lib/workspace/settings-tab"
import { useTabStore, type TabItem } from "@/stores/tab-store"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"
import { WorkspaceCurrentSelection } from "./workspace-current-selection"

const mocks = vi.hoisted(() => ({
  layout: null as WorkspaceLayoutProjection | null,
  isMobile: false,
  settingsOpen: false,
  setCurrentDocumentContext: vi.fn(async () => {}),
  setCurrentWorkspaceTerminal: vi.fn(async () => {}),
}))

vi.mock("@/lib/platform", () => ({ isDesktop: () => true }))
vi.mock("@/lib/api", () => ({
  setCurrentDocumentContext: mocks.setCurrentDocumentContext,
  setCurrentWorkspaceTerminal: mocks.setCurrentWorkspaceTerminal,
}))
vi.mock("@/hooks/workspace/use-workspace-layout", () => ({
  useWorkspaceLayoutProjection: () => mocks.layout,
}))
vi.mock("@/hooks/use-mobile", () => ({
  useIsMobile: () => mocks.isMobile,
}))
vi.mock("@/contexts/settings-workspace-context", () => ({
  useSettingsWorkspace: () => ({ isOpen: mocks.settingsOpen }),
}))

function textTab(
  id: string,
  content: string,
  isDirty = false
): TextFileWorkspaceTab {
  return {
    id,
    kind: "file",
    dataMode: "text",
    previewKind: "text",
    folderId: 1,
    title: id,
    description: null,
    path: `/synthetic/${id}.txt`,
    content,
    savedContent: isDirty ? "saved" : content,
    isDirty,
    language: "plaintext",
    loading: false,
    saveState: "idle",
    saveError: null,
    etag: null,
    mtimeMs: null,
    readonly: false,
    lineEnding: "none",
  }
}

function fileRef(tab: FileWorkspaceTab): WorkspaceTabRef {
  return { kind: "file", id: tab.id, type: tab.kind }
}

function terminalTab(terminalId: string): TabItem {
  return { id: `${terminalId}-tab`, kind: "terminal", terminalId } as TabItem
}

function primaryRef(tab: TabItem): WorkspaceTabRef {
  return { kind: "primary", id: tab.id, type: tab.kind }
}

type ByPane<T> = Partial<Record<WorkspacePane, T>>

function selectLayout(
  {
    activePane = "files",
    activeTabByPane: activeInput = {},
    fileTabsByPane: fileInput = {},
    primaryTabsByPane: primaryInput = {},
    ...overrides
  }: Omit<
    Partial<WorkspaceLayoutProjection>,
    "activeTabByPane" | "fileTabsByPane" | "primaryTabsByPane"
  > & {
    activeTabByPane?: ByPane<WorkspaceTabRef | null>
    fileTabsByPane?: ByPane<FileWorkspaceTab[]>
    primaryTabsByPane?: ByPane<TabItem[]>
  },
  activeFileTabId: string | null = null
) {
  const activeTabByPane: Record<WorkspacePane, WorkspaceTabRef | null> = {
    files: null,
    "files-split": null,
    conversation: null,
    ...activeInput,
  }
  const fileTabsByPane: Record<WorkspacePane, FileWorkspaceTab[]> = {
    files: [],
    "files-split": [],
    conversation: [],
    ...fileInput,
  }
  const primaryTabsByPane: Record<WorkspacePane, TabItem[]> = {
    files: [],
    "files-split": [],
    conversation: [],
    ...primaryInput,
  }
  const tabsByPane: Record<WorkspacePane, WorkspaceTabRef[]> = {
    files: [],
    "files-split": [],
    conversation: [],
  }
  for (const pane of WORKSPACE_PANES) {
    tabsByPane[pane] = [
      ...fileTabsByPane[pane].map(fileRef),
      ...primaryTabsByPane[pane].map(primaryRef),
    ]
  }
  mocks.layout = {
    mode: "fusion",
    splitActive: tabsByPane["files-split"].length > 0,
    activePane,
    placement: {},
    activeWorkspaceTab: activeTabByPane[activePane],
    activeTabByPane,
    tabsByPane,
    orderedTabsByPane: tabsByPane,
    orderedWorkspaceTabs: WORKSPACE_PANES.flatMap((pane) => tabsByPane[pane]),
    fileTabsByPane,
    primaryTabsByPane,
    globalTabs: [],
    paneForTab: (tab) =>
      WORKSPACE_PANES.find((pane) =>
        tabsByPane[pane].some((candidate) =>
          workspaceTabRefEqual(candidate, tab)
        )
      ) ?? "conversation",
    dragging: null,
    dragOverPane: null,
    dragInsertIndex: null,
    ...overrides,
  }
  const primaryTabs = WORKSPACE_PANES.flatMap((pane) => primaryTabsByPane[pane])
  useTabStore.setState({ tabs: primaryTabs, rawTabs: primaryTabs })
  useWorkspaceFileStore.setState({
    fileTabs: WORKSPACE_PANES.flatMap((pane) => fileTabsByPane[pane]),
    activeFileTabId,
  })
}

function selectFile(tab: FileWorkspaceTab | null) {
  selectLayout(
    {
      activeTabByPane: { files: tab ? fileRef(tab) : null, conversation: null },
      fileTabsByPane: { files: tab ? [tab] : [], conversation: [] },
    },
    tab?.id ?? null
  )
}

function selectTerminal(terminalId: string) {
  const tab = terminalTab(terminalId)
  selectLayout({
    activePane: "conversation",
    activeTabByPane: { files: null, conversation: primaryRef(tab) },
    primaryTabsByPane: { files: [], conversation: [tab] },
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  mocks.isMobile = false
  mocks.settingsOpen = false
  mocks.setCurrentDocumentContext.mockReset()
  mocks.setCurrentDocumentContext.mockImplementation(async () => {})
  mocks.setCurrentWorkspaceTerminal.mockReset()
  mocks.setCurrentWorkspaceTerminal.mockImplementation(async () => {})
  useTabStore.setState({ tabs: [], rawTabs: [] })
  selectFile(null)
  useWorkspaceFileStore.setState({ previewFileTabIds: new Set() })
})

afterEach(async () => {
  cleanup()
  await flush()
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "visible",
  })
  vi.useRealTimers()
  mocks.setCurrentDocumentContext.mockReset()
  mocks.setCurrentWorkspaceTerminal.mockReset()
})

async function flush(ms = 0) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
}

it("提交 clean 与 dirty 的编辑器缓冲，空文件也是有效快照", async () => {
  const tab = textTab("notes", "clean-from-GUI")
  selectFile(tab)
  const view = render(<WorkspaceCurrentSelection />)
  await flush()
  expect(mocks.setCurrentDocumentContext).toHaveBeenLastCalledWith({
    scope: "workspace",
    kind: "text",
    path: tab.path,
    content: "clean-from-GUI",
  })
  act(() => selectFile(textTab("notes", "unsaved", true)))
  view.rerender(<WorkspaceCurrentSelection />)
  await flush(179)
  expect(mocks.setCurrentDocumentContext).toHaveBeenCalledTimes(1)
  await flush(1)
  expect(mocks.setCurrentDocumentContext).toHaveBeenLastCalledWith(
    expect.objectContaining({ content: "unsaved" })
  )
  act(() => selectFile(textTab("empty", "")))
  view.rerender(<WorkspaceCurrentSelection />)
  await flush()
  expect(mocks.setCurrentDocumentContext).toHaveBeenLastCalledWith(
    expect.objectContaining({ path: "/synthetic/empty.txt", content: "" })
  )
})

it.each(["md", "html"])(
  "%s 预览复用已有 GUI 源文本，切换源码不清空或重复提交",
  async (extension) => {
    const tab: TextFileWorkspaceTab = {
      ...textTab("preview", "unsaved-source", true),
      path: `/synthetic/preview.${extension}`,
      previewKind: "text",
    }
    selectFile(tab)
    useWorkspaceFileStore.setState({ previewFileTabIds: new Set([tab.id]) })
    const view = render(<WorkspaceCurrentSelection />)
    await flush()
    expect(mocks.setCurrentDocumentContext).toHaveBeenLastCalledWith({
      scope: "workspace",
      kind: "text",
      path: tab.path,
      content: "unsaved-source",
    })

    act(() => useWorkspaceFileStore.setState({ previewFileTabIds: new Set() }))
    view.rerender(<WorkspaceCurrentSelection />)
    await flush()
    expect(mocks.setCurrentDocumentContext).toHaveBeenCalledTimes(1)
  }
)

it.each(["pdf", "office", "image"] as const)(
  "%s 资源预览不提交文本快照，也不触发源文本加载",
  async (kind) => {
    const base = textTab("resource", "not-source")
    selectFile({
      id: base.id,
      kind: "file",
      dataMode: "resource",
      preview:
        kind === "image"
          ? { kind, revision: 1, dataUrl: null }
          : { kind, revision: 1 },
      folderId: base.folderId,
      title: base.title,
      description: null,
      path: `/synthetic/resource.${kind}`,
      loading: false,
      saveState: "idle",
      saveError: null,
      readonly: true,
    })
    render(<WorkspaceCurrentSelection />)
    await flush()
    expect(mocks.setCurrentDocumentContext).toHaveBeenLastCalledWith({
      scope: "workspace",
      kind: "",
      clear: true,
    })
  }
)

it("不把 Excalidraw 画板当文本编辑器", async () => {
  selectFile({
    ...textTab("drawing", "{}"),
    path: "/synthetic/drawing.excalidraw",
    previewKind: "excalidraw",
  })
  render(<WorkspaceCurrentSelection />)
  await flush()
  expect(mocks.setCurrentDocumentContext).toHaveBeenLastCalledWith({
    scope: "workspace",
    kind: "",
    clear: true,
  })
})

it("中心文件与辅助终端并排时，切到终端保留实际宿主中的 dirty 缓冲", async () => {
  const file = textTab("split", "unsaved-split", true)
  const terminal = terminalTab("split-terminal")
  const layout = {
    activeTabByPane: {
      files: fileRef(file),
      conversation: primaryRef(terminal),
    },
    fileTabsByPane: { files: [file], conversation: [] },
    primaryTabsByPane: { files: [], conversation: [terminal] },
  }
  selectLayout(layout, file.id)
  const view = render(<WorkspaceCurrentSelection />)
  await flush()
  expect(mocks.setCurrentDocumentContext).toHaveBeenLastCalledWith(
    expect.objectContaining({ path: file.path, content: "unsaved-split" })
  )
  expect(mocks.setCurrentWorkspaceTerminal).toHaveBeenLastCalledWith(null)

  act(() => selectLayout({ ...layout, activePane: "conversation" }, file.id))
  view.rerender(<WorkspaceCurrentSelection />)
  await flush(200)
  expect(mocks.setCurrentDocumentContext).toHaveBeenCalledTimes(1)
  expect(mocks.setCurrentWorkspaceTerminal).toHaveBeenLastCalledWith(
    "split-terminal"
  )
})

it.each([null, "closed"])(
  "实际文件宿主的 activeFileTabId 为 %s 时，不按 pane 的首项猜文件",
  async (activeFileTabId) => {
    const first = textTab("first", "not-rendered-first")
    const second = textTab("second", "not-rendered-second")
    selectLayout(
      {
        activeTabByPane: {
          files: fileRef(first),
          conversation: fileRef(second),
        },
        fileTabsByPane: { files: [first], conversation: [second] },
      },
      activeFileTabId
    )
    render(<WorkspaceCurrentSelection />)
    await flush()
    expect(mocks.setCurrentDocumentContext).toHaveBeenLastCalledWith({
      scope: "workspace",
      kind: "",
      clear: true,
    })
  }
)

it("两个 tab 组都显示文件时，只提交 activeFileTabId 那一个", async () => {
  const rendered = textTab("rendered", "actual-source")
  const unrendered = textTab("unrendered", "must-not-publish")
  selectLayout(
    {
      activePane: "conversation",
      activeTabByPane: {
        files: fileRef(rendered),
        conversation: fileRef(unrendered),
      },
      fileTabsByPane: { files: [rendered], conversation: [unrendered] },
    },
    rendered.id
  )
  render(<WorkspaceCurrentSelection />)
  await flush()
  expect(mocks.setCurrentDocumentContext).toHaveBeenLastCalledWith(
    expect.objectContaining({ path: rendered.path, content: "actual-source" })
  )
  expect(mocks.setCurrentDocumentContext).not.toHaveBeenCalledWith(
    expect.objectContaining({ content: "must-not-publish" })
  )
})

it("同 pane 的终端盖住文件时只提交终端，不提交被盖住的 activeFileTabId", async () => {
  const file = textTab("covered", "must-not-publish")
  const terminal = terminalTab("focused-terminal")
  selectLayout(
    {
      activeTabByPane: { files: primaryRef(terminal), conversation: null },
      fileTabsByPane: { files: [file], conversation: [] },
      primaryTabsByPane: { files: [terminal], conversation: [] },
    },
    file.id
  )
  render(<WorkspaceCurrentSelection />)
  await flush()
  expect(mocks.setCurrentDocumentContext).not.toHaveBeenCalledWith(
    expect.objectContaining({ path: file.path })
  )
  expect(mocks.setCurrentWorkspaceTerminal).toHaveBeenLastCalledWith(
    "focused-terminal"
  )
})

it("文件拖到辅助面板后，按它所在 tab 组的显示状态提交", async () => {
  const file = textTab("moved", "moved-source")
  const terminal = terminalTab("center-terminal")
  selectLayout(
    {
      activePane: "conversation",
      activeTabByPane: {
        files: primaryRef(terminal),
        conversation: fileRef(file),
      },
      fileTabsByPane: { files: [], conversation: [file] },
      primaryTabsByPane: { files: [terminal], conversation: [] },
    },
    file.id
  )
  render(<WorkspaceCurrentSelection />)
  await flush()
  expect(mocks.setCurrentDocumentContext).toHaveBeenLastCalledWith(
    expect.objectContaining({ path: file.path, content: "moved-source" })
  )
})

it("组内切换文件时立即换快照", async () => {
  const first = textTab("first", "first-source")
  const second = textTab("second", "second-source")
  const fileTabsByPane = { files: [first, second], conversation: [] }
  selectLayout(
    {
      activeTabByPane: { files: fileRef(first), conversation: null },
      fileTabsByPane,
    },
    first.id
  )
  const view = render(<WorkspaceCurrentSelection />)
  await flush()
  act(() =>
    selectLayout(
      {
        activeTabByPane: { files: fileRef(second), conversation: null },
        fileTabsByPane,
      },
      second.id
    )
  )
  view.rerender(<WorkspaceCurrentSelection />)
  await flush()
  expect(mocks.setCurrentDocumentContext).toHaveBeenLastCalledWith(
    expect.objectContaining({ path: second.path, content: "second-source" })
  )
})

it.each(["closed", "out-of-scope", "loading"])(
  "文件 %s 后即使 activeFileTabId 尚未清理也不能继续提交",
  async (boundary) => {
    const file = textTab("old", "old-source")
    selectFile(file)
    const view = render(<WorkspaceCurrentSelection />)
    await flush()
    act(() => {
      selectLayout(
        {
          activeTabByPane: { files: fileRef(file), conversation: null },
          fileTabsByPane: {
            files: boundary === "loading" ? [{ ...file, loading: true }] : [],
            conversation: [],
          },
        },
        file.id
      )
      if (boundary === "out-of-scope") {
        useWorkspaceFileStore.setState({ fileTabs: [file] })
      }
    })
    view.rerender(<WorkspaceCurrentSelection />)
    await flush()
    expect(mocks.setCurrentDocumentContext).toHaveBeenLastCalledWith({
      scope: "workspace",
      kind: "",
      clear: true,
    })
  }
)

it("关闭宿主当前文件后不猜另一个文件，等待实际 activeFileTabId 更新", async () => {
  const first = textTab("first", "first-source")
  const second = textTab("second", "second-source")
  const layout = {
    activeTabByPane: { files: fileRef(first), conversation: null },
  }
  selectLayout(
    { ...layout, fileTabsByPane: { files: [first, second], conversation: [] } },
    second.id
  )
  const view = render(<WorkspaceCurrentSelection />)
  await flush()
  act(() =>
    selectLayout(
      { ...layout, fileTabsByPane: { files: [first], conversation: [] } },
      second.id
    )
  )
  view.rerender(<WorkspaceCurrentSelection />)
  await flush()
  expect(mocks.setCurrentDocumentContext).toHaveBeenLastCalledWith({
    scope: "workspace",
    kind: "",
    clear: true,
  })
  act(() =>
    selectLayout(
      { ...layout, fileTabsByPane: { files: [first], conversation: [] } },
      first.id
    )
  )
  view.rerender(<WorkspaceCurrentSelection />)
  await flush()
  expect(mocks.setCurrentDocumentContext).toHaveBeenLastCalledWith(
    expect.objectContaining({ path: first.path })
  )
})

it("Settings 实际遮盖中栏文件时清空，即使文件仍 mounted", async () => {
  const file = textTab("behind-settings", "must-hide")
  const settings = { kind: "global" as const, id: SETTINGS_GLOBAL_TAB_ID }
  const layout = {
    activeTabByPane: { files: fileRef(file), conversation: null },
    globalTabs: [settings],
    fileTabsByPane: { files: [file], conversation: [] },
  }
  mocks.settingsOpen = true
  selectLayout(layout, file.id)
  const view = render(<WorkspaceCurrentSelection />)
  await flush()
  expect(mocks.setCurrentDocumentContext).toHaveBeenLastCalledWith(
    expect.objectContaining({ path: file.path })
  )

  act(() =>
    selectLayout(
      {
        ...layout,
        activeTabByPane: { files: settings, conversation: null },
      },
      file.id
    )
  )
  view.rerender(<WorkspaceCurrentSelection />)
  await flush()
  expect(mocks.setCurrentDocumentContext).toHaveBeenLastCalledWith({
    scope: "workspace",
    kind: "",
    clear: true,
  })
  act(() => selectLayout(layout, file.id))
  view.rerender(<WorkspaceCurrentSelection />)
  await flush()
  expect(mocks.setCurrentDocumentContext).toHaveBeenLastCalledWith(
    expect.objectContaining({ path: file.path })
  )
})

it("移动端只在实际挂载文件宿主的分支提交", async () => {
  const file = textTab("mobile", "mobile-source")
  const terminal = terminalTab("focused-terminal")
  const layout = {
    activeTabByPane: {
      files: fileRef(file),
      conversation: primaryRef(terminal),
    },
    fileTabsByPane: { files: [file], conversation: [] },
    primaryTabsByPane: { files: [], conversation: [terminal] },
  }
  mocks.isMobile = true
  selectLayout({ ...layout, activePane: "conversation" }, file.id)
  const view = render(<WorkspaceCurrentSelection />)
  await flush()
  expect(mocks.setCurrentDocumentContext).toHaveBeenLastCalledWith({
    scope: "workspace",
    kind: "",
    clear: true,
  })
  act(() => selectLayout({ ...layout, activePane: "files" }, file.id))
  view.rerender(<WorkspaceCurrentSelection />)
  await flush()
  expect(mocks.setCurrentDocumentContext).toHaveBeenLastCalledWith(
    expect.objectContaining({ path: file.path, content: "mobile-source" })
  )
  expect(mocks.setCurrentWorkspaceTerminal).toHaveBeenLastCalledWith(null)
})

it("仅同步当前明确选中的终端，不根据文件或 pane 候选猜终端", async () => {
  selectTerminal("synthetic-terminal")
  const view = render(<WorkspaceCurrentSelection />)
  await flush()
  expect(mocks.setCurrentWorkspaceTerminal).toHaveBeenLastCalledWith(
    "synthetic-terminal"
  )
  act(() => {
    const file = textTab("focused", "source")
    const terminal = terminalTab("synthetic-terminal")
    selectLayout(
      {
        activeTabByPane: {
          files: fileRef(file),
          conversation: primaryRef(terminal),
        },
        fileTabsByPane: { files: [file], conversation: [] },
        primaryTabsByPane: { files: [], conversation: [terminal] },
      },
      file.id
    )
  })
  view.rerender(<WorkspaceCurrentSelection />)
  await flush()
  expect(mocks.setCurrentWorkspaceTerminal).toHaveBeenLastCalledWith(null)
})

it("切选与隐藏立即清空，旧防抖不得反写；OS 失焦不清空", async () => {
  selectFile(textTab("one", "before"))
  const view = render(<WorkspaceCurrentSelection />)
  await flush()
  act(() => selectFile(textTab("one", "stale", true)))
  view.rerender(<WorkspaceCurrentSelection />)
  act(() => selectFile(null))
  view.rerender(<WorkspaceCurrentSelection />)
  await flush()
  await flush(200)
  expect(mocks.setCurrentDocumentContext).toHaveBeenLastCalledWith({
    scope: "workspace",
    kind: "",
    clear: true,
  })
  expect(mocks.setCurrentDocumentContext).not.toHaveBeenCalledWith(
    expect.objectContaining({ content: "stale" })
  )

  act(() => selectFile(textTab("two", "visible")))
  view.rerender(<WorkspaceCurrentSelection />)
  await flush()
  const calls = mocks.setCurrentDocumentContext.mock.calls.length
  act(() => window.dispatchEvent(new Event("blur")))
  await flush()
  expect(mocks.setCurrentDocumentContext).toHaveBeenCalledTimes(calls)
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: "hidden",
  })
  act(() => document.dispatchEvent(new Event("visibilitychange")))
  await flush()
  expect(mocks.setCurrentDocumentContext).toHaveBeenLastCalledWith({
    scope: "workspace",
    kind: "",
    clear: true,
  })
})

it("并排时 OS blur 保留两种投影，页面隐藏清空、再次显示恢复", async () => {
  const file = textTab("visible", "visible-source")
  const terminal = terminalTab("visible-terminal")
  selectLayout(
    {
      activePane: "conversation",
      activeTabByPane: {
        files: fileRef(file),
        conversation: primaryRef(terminal),
      },
      fileTabsByPane: { files: [file], conversation: [] },
      primaryTabsByPane: { files: [], conversation: [terminal] },
    },
    file.id
  )
  render(<WorkspaceCurrentSelection />)
  await flush()
  act(() => window.dispatchEvent(new Event("blur")))
  await flush()
  expect(mocks.setCurrentDocumentContext).toHaveBeenCalledTimes(1)
  expect(mocks.setCurrentWorkspaceTerminal).toHaveBeenCalledTimes(1)

  act(() => window.dispatchEvent(new Event("pagehide")))
  await flush()
  expect(mocks.setCurrentDocumentContext).toHaveBeenLastCalledWith({
    scope: "workspace",
    kind: "",
    clear: true,
  })
  expect(mocks.setCurrentWorkspaceTerminal).toHaveBeenLastCalledWith(null)

  act(() => window.dispatchEvent(new Event("pageshow")))
  await flush()
  expect(mocks.setCurrentDocumentContext).toHaveBeenLastCalledWith(
    expect.objectContaining({ path: file.path, content: "visible-source" })
  )
  expect(mocks.setCurrentWorkspaceTerminal).toHaveBeenLastCalledWith(
    "visible-terminal"
  )
})

it("终端聚焦时文件 setter 在途，旧正文提交不得覆盖后来实际显示的文件", async () => {
  let release!: () => void
  const pending = new Promise<void>((resolve) => {
    release = resolve
  })
  mocks.setCurrentDocumentContext.mockImplementationOnce(() => pending)
  const oldFile = textTab("old", "old-source")
  const newFile = textTab("new", "new-source")
  const terminal = terminalTab("focused-terminal")
  const showFile = (file: TextFileWorkspaceTab) =>
    selectLayout(
      {
        activePane: "conversation",
        activeTabByPane: {
          files: fileRef(file),
          conversation: primaryRef(terminal),
        },
        fileTabsByPane: { files: [file], conversation: [] },
        primaryTabsByPane: { files: [], conversation: [terminal] },
      },
      file.id
    )
  showFile(oldFile)
  const view = render(<WorkspaceCurrentSelection />)
  try {
    await flush()
    expect(mocks.setCurrentDocumentContext).toHaveBeenCalledTimes(1)
    act(() =>
      showFile({ ...oldFile, content: "queued-old-source", isDirty: true })
    )
    view.rerender(<WorkspaceCurrentSelection />)
    await flush(180)
    expect(mocks.setCurrentDocumentContext).toHaveBeenCalledTimes(1)
    act(() => showFile(newFile))
    view.rerender(<WorkspaceCurrentSelection />)
    await flush()
  } finally {
    release()
    await flush()
  }
  expect(mocks.setCurrentDocumentContext).toHaveBeenLastCalledWith(
    expect.objectContaining({ path: newFile.path, content: "new-source" })
  )
  expect(mocks.setCurrentDocumentContext).not.toHaveBeenCalledWith(
    expect.objectContaining({ content: "queued-old-source" })
  )
  expect(mocks.setCurrentWorkspaceTerminal).toHaveBeenCalledTimes(1)
})

it.each(["file", "terminal"] as const)(
  "隐藏时在途 %s setter 完成后仍必须清空选择",
  async (kind) => {
    let release!: () => void
    const pending = new Promise<void>((resolve) => {
      release = resolve
    })
    if (kind === "file") {
      mocks.setCurrentDocumentContext.mockImplementationOnce(() => pending)
      selectFile(textTab("old", "unsaved"))
    } else {
      mocks.setCurrentWorkspaceTerminal.mockImplementationOnce(() => pending)
      selectTerminal("old-terminal")
    }
    const setter =
      kind === "file"
        ? mocks.setCurrentDocumentContext
        : mocks.setCurrentWorkspaceTerminal
    const view = render(<WorkspaceCurrentSelection />)
    try {
      await flush()
      expect(setter).toHaveBeenCalledTimes(1)
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        value: "hidden",
      })
      act(() => document.dispatchEvent(new Event("visibilitychange")))
      await flush()
      expect(setter).toHaveBeenCalledTimes(1)
    } finally {
      release()
      await flush()
    }
    expect(setter).toHaveBeenLastCalledWith(
      kind === "file" ? { scope: "workspace", kind: "", clear: true } : null
    )
    view.unmount()
  }
)

it("旧工作区卸载后，迟到的清空不会覆盖新工作区缓冲", async () => {
  let releaseFirst!: () => void
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  mocks.setCurrentDocumentContext.mockImplementationOnce(() => first)
  selectFile(textTab("old", "previous"))
  const oldView = render(<WorkspaceCurrentSelection />)
  await flush()
  oldView.unmount()

  selectFile(textTab("new", "current"))
  const newView = render(<WorkspaceCurrentSelection />)
  await flush()
  releaseFirst()
  await flush()
  expect(mocks.setCurrentDocumentContext).toHaveBeenLastCalledWith({
    scope: "workspace",
    kind: "text",
    path: "/synthetic/new.txt",
    content: "current",
  })
  newView.unmount()
})

it("旧工作区卸载后，迟到的终端清空不会覆盖新终端", async () => {
  let releaseFirst!: () => void
  const first = new Promise<void>((resolve) => {
    releaseFirst = resolve
  })
  mocks.setCurrentWorkspaceTerminal.mockImplementationOnce(() => first)
  selectTerminal("old-terminal")
  const oldView = render(<WorkspaceCurrentSelection />)
  await flush()
  oldView.unmount()

  selectTerminal("new-terminal")
  const newView = render(<WorkspaceCurrentSelection />)
  await flush()
  releaseFirst()
  await flush()
  expect(mocks.setCurrentWorkspaceTerminal).toHaveBeenLastCalledWith(
    "new-terminal"
  )
  newView.unmount()
})
