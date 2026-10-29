import { act, render } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { projectWorkspaceLayout } from "@/lib/workspace/workspace-layout-projection"
import {
  configureWorkspaceLayoutFileActivator,
  createInitialWorkspaceLayoutState,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabStore, type TabItem } from "@/stores/tab-store"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"
import type { WorkspaceTabRef } from "@/lib/workspace/workspace-tab-placement"

const terminalTab: TabItem = {
  kind: "terminal",
  id: "term-home",
  terminalId: "term-home",
  backendInstanceId: "backend-1",
  folderId: 1,
  initialCwd: "/project",
  shell: "/bin/bash",
  detachedFolderLabel: null,
  detachedFolderPath: null,
  title: "Terminal",
  isPinned: true,
}

function LayoutConsumer() {
  const mode = projectWorkspaceLayout(useWorkspaceLayoutStore(), {
    primaryTabs: useTabStore((state) => state.tabs),
    rawPrimaryTabs: useTabStore((state) => state.rawTabs),
    fileTabs: useWorkspaceFileStore((state) => state.fileTabs),
    activeFolderId: useAppWorkspaceStore((state) => state.activeFolderId),
    allFolders: useAppWorkspaceStore((state) => state.allFolders),
  }).mode
  return <output data-testid="mode">{mode}</output>
}

describe("workspace layout store", () => {
  beforeEach(() => {
    window.localStorage.removeItem("berth:workspace-tab-placement:v1")
    window.localStorage.removeItem("berth:workspace-tab-order:v1")
    configureWorkspaceLayoutFileActivator(null)
    useWorkspaceLayoutStore.setState({
      ...createInitialWorkspaceLayoutState(),
      placementByScope: {},
      tabOrderByScope: {},
    })
    useWorkspaceFileStore.getState().reset()
    useAppWorkspaceStore.setState({ activeFolderId: 1, allFolders: [] })
    useTabStore.setState({
      tabs: [terminalTab],
      rawTabs: [terminalTab],
      activeTabId: terminalTab.id,
    })
  })

  afterEach(() => {
    configureWorkspaceLayoutFileActivator(null)
  })

  it("projects placement by folder scope without changing tab ownership", () => {
    const ref: WorkspaceTabRef = {
      kind: "primary",
      id: terminalTab.id,
      type: terminalTab.kind,
    }
    act(() => useWorkspaceLayoutStore.getState().moveWorkspaceTab(ref, "files"))

    const state = useWorkspaceLayoutStore.getState()
    expect(state.placementByScope["folder:1"]?.["primary:term-home"]).toBe(
      "files"
    )
    expect(
      window.localStorage.getItem("berth:workspace-tab-placement:v1")
    ).toContain('"primary:term-home":"files"')
    expect(useTabStore.getState().rawTabs).toEqual([terminalTab])
    const projection = projectWorkspaceLayout(state, {
      primaryTabs: [terminalTab],
      rawPrimaryTabs: [terminalTab],
      fileTabs: [],
      activeFolderId: 1,
      allFolders: [],
    })
    expect(projection.mode).toBe("fusion")
    expect(projection.tabsByPane.files).toEqual([ref])
  })

  it("drops a tab at a strip position, in its own or another pane", () => {
    const terminals = ["a", "b", "c"].map((id) => ({
      ...terminalTab,
      id: `term-${id}`,
      terminalId: `term-${id}`,
      isPinned: false,
    }))
    useTabStore.setState({ tabs: terminals, rawTabs: terminals })
    const ref = (id: string): WorkspaceTabRef => ({
      kind: "primary",
      id: `term-${id}`,
      type: "terminal",
    })
    const paneIds = (pane: "conversation" | "files") =>
      projectWorkspaceLayout(useWorkspaceLayoutStore.getState(), {
        primaryTabs: terminals,
        rawPrimaryTabs: terminals,
        fileTabs: [],
        activeFolderId: 1,
        allFolders: [],
      }).tabsByPane[pane].map((tab) => tab.id)

    act(() =>
      useWorkspaceLayoutStore
        .getState()
        .dropWorkspaceTab(ref("c"), "conversation", 0)
    )
    expect(paneIds("conversation")).toEqual(["term-c", "term-a", "term-b"])

    act(() =>
      useWorkspaceLayoutStore
        .getState()
        .dropWorkspaceTab(ref("b"), "files", null)
    )
    act(() =>
      useWorkspaceLayoutStore.getState().dropWorkspaceTab(ref("a"), "files", 0)
    )
    expect(paneIds("files")).toEqual(["term-a", "term-b"])
    expect(paneIds("conversation")).toEqual(["term-c"])
    expect(useWorkspaceLayoutStore.getState().activeWorkspaceTab?.id).toBe(
      "term-a"
    )
  })

  it("keeps a global tab active after opening it", () => {
    act(() => {
      useWorkspaceLayoutStore.getState().openGlobalTab("settings")
    })

    expect(useWorkspaceLayoutStore.getState().activeWorkspaceTab).toEqual({
      kind: "global",
      id: "settings",
    })
  })

  it("renders a consumer from the projection rather than a provider", () => {
    const { getByTestId } = render(<LayoutConsumer />)
    expect(getByTestId("mode").textContent).toBe("conversation")

    act(() =>
      useWorkspaceLayoutStore
        .getState()
        .moveWorkspaceTab(
          { kind: "primary", id: terminalTab.id, type: terminalTab.kind },
          "files"
        )
    )
    expect(getByTestId("mode").textContent).toBe("fusion")
  })

  it("drives file activation through the injected activator only", () => {
    const fileTab = {
      id: "file:x",
      kind: "file",
      folderId: 1,
    } as never
    useWorkspaceFileStore.setState({ fileTabs: [fileTab] })
    const activate = vi.fn(() => true)
    configureWorkspaceLayoutFileActivator(activate)

    const store = useWorkspaceLayoutStore.getState()
    act(() => store.openGlobalTab("settings"))
    let activated = false
    act(() => {
      activated = useWorkspaceLayoutStore.getState().activateFileTab("file:x")
    })
    expect(activated).toBe(true)

    // 激活语义单一来源：只通过注入回调触达文件域。
    expect(activate).toHaveBeenCalledTimes(1)
    expect(activate).toHaveBeenCalledWith({
      tabId: "file:x",
      scope: 1,
      folders: [],
    })
    const state = useWorkspaceLayoutStore.getState()
    // 布局侧副作用：自 global 激活时记忆返回目标 + 选中态收敛。
    expect(state.globalTabReturn).toEqual({
      kind: "file",
      id: "file:x",
      type: "file",
    })
    expect(state.activeWorkspaceTab).toEqual({
      kind: "file",
      id: "file:x",
      type: "file",
    })
    expect(state.activePane).toBe("files")
    expect(state.activeTabByPane.files).toEqual({
      kind: "file",
      id: "file:x",
      type: "file",
    })
  })

  it("returns false without an activator and keeps state untouched", () => {
    const before = useWorkspaceLayoutStore.getState().activeWorkspaceTab
    expect(useWorkspaceLayoutStore.getState().activateFileTab("file:x")).toBe(
      false
    )
    expect(useWorkspaceLayoutStore.getState().activeWorkspaceTab).toBe(before)
  })

  it("adoptFileActivation applies layout effects without re-entering the file domain", () => {
    const fileTab = {
      id: "file:y",
      kind: "file",
      folderId: 1,
    } as never
    useWorkspaceFileStore.setState({ fileTabs: [fileTab] })
    const activate = vi.fn(() => true)
    configureWorkspaceLayoutFileActivator(activate)
    const store = useWorkspaceLayoutStore.getState()
    act(() => store.openGlobalTab("settings"))

    act(() => useWorkspaceLayoutStore.getState().adoptFileActivation("file:y"))

    // 运行时已完成文件域激活后回调此方法；不再反向触发注入的激活器。
    expect(activate).not.toHaveBeenCalled()
    const state = useWorkspaceLayoutStore.getState()
    expect(state.globalTabReturn).toEqual({
      kind: "file",
      id: "file:y",
      type: "file",
    })
    expect(state.activeWorkspaceTab).toEqual({
      kind: "file",
      id: "file:y",
      type: "file",
    })
  })

  it("allows selecting a pinned primary tab created in another folder scope", () => {
    const foreignPinnedTab: TabItem = {
      kind: "terminal",
      id: "terminal:term-other-project",
      terminalId: "term-other-project",
      backendInstanceId: "b-instance",
      folderId: 2,
      title: "Foreign Terminal",
      initialCwd: "/repo",
      shell: "bash",
      detachedFolderLabel: null,
      detachedFolderPath: null,
      isPinned: true,
    }
    useAppWorkspaceStore.setState({ activeFolderId: 1, allFolders: [] })
    useTabStore.setState({
      tabs: [terminalTab, foreignPinnedTab],
      rawTabs: [terminalTab, foreignPinnedTab],
      activeTabId: terminalTab.id,
    })

    const ref: WorkspaceTabRef = {
      kind: "primary",
      id: foreignPinnedTab.id,
      type: foreignPinnedTab.kind,
    }
    act(() => {
      useWorkspaceLayoutStore.getState().selectWorkspaceTab(ref)
    })

    expect(useWorkspaceLayoutStore.getState().activeWorkspaceTab).toEqual(ref)
    expect(useTabStore.getState().activeTabId).toBe(foreignPinnedTab.id)
    // activeFolderId remains folder 1 without unnecessary project jumping
    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(1)
  })
})
