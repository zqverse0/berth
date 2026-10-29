import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { FolderWorkspaceResume } from "@/lib/workspace/folder-workspace-resume"
import {
  getFolderActivationGeneration,
  getFolderWorkspaceResume,
  resetTabStore,
  runRecoveryOnce,
  useTabStore,
} from "./tab-store"
import {
  resetAppWorkspaceStore,
  useAppWorkspaceStore,
} from "./app-workspace-store"
import type { TabItemInternal } from "./tab-store"
import type { FolderDetail } from "@/lib/types"
import { saveLastActiveContext } from "@/lib/workspace/last-active-context-storage"

function seedFolders(ids: number[]) {
  const folders: FolderDetail[] = ids.map((id) => ({
    id,
    name: `folder-${id}`,
    path: `/folder-${id}`,
    git_branch: null,
    default_agent_type: null,
    last_opened_at: "2026-08-22T00:00:00Z",
    sort_order: id,
    color: "inherit",
    parent_id: null,
    kind: "regular",
    alias: null,
  }))
  useAppWorkspaceStore.setState({
    folders,
    allFolders: folders,
    foldersHydrated: true,
  })
}

function conversationTab(
  folderId: number,
  conversationId: number
): TabItemInternal {
  return {
    kind: "conversation",
    id: `conv-${folderId}-codex-${conversationId}`,
    folderId,
    conversationId,
    agentType: "codex",
    title: `conv ${conversationId}`,
    isPinned: true,
  }
}

function terminalTab(folderId: number, terminalId: string): TabItemInternal {
  return {
    kind: "terminal",
    id: `terminal:${terminalId}`,
    terminalId,
    backendInstanceId: "backend",
    folderId,
    title: terminalId,
    initialCwd: "/repo",
    shell: "/bin/bash",
    detachedFolderLabel: null,
    detachedFolderPath: null,
    isPinned: true,
  }
}

beforeEach(() => {
  resetAppWorkspaceStore()
  seedFolders([1, 2, 3, 4, 5, 6, 7, 8, 9, 10])
  resetTabStore()
})

afterEach(() => {
  resetTabStore()
  resetAppWorkspaceStore()
})

describe("activateFolderWorkspace", () => {
  it("keeps activeTabId null on first visit to a folder with no tabs", () => {
    const openFolder = vi.spyOn(useAppWorkspaceStore.getState(), "openFolder")

    useTabStore.getState().activateFolderWorkspace(7)

    expect(useTabStore.getState().activeTabId).toBeNull()
    expect(useTabStore.getState().rawTabs).toEqual([])
    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(7)
    expect(openFolder).not.toHaveBeenCalled()
  })

  it("returns to the last conversation tab after switching away", () => {
    const conversation = conversationTab(1, 11)
    useTabStore.setState({
      rawTabs: [conversation],
      activeTabId: conversation.id,
    })

    useTabStore.getState().activateFolderWorkspace(2)
    expect(useTabStore.getState().activeTabId).toBeNull()

    useTabStore.getState().activateFolderWorkspace(1)
    expect(useTabStore.getState().activeTabId).toBe(conversation.id)
    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(1)
  })

  it("applies folder chrome in the same turn as the tab switch", () => {
    const apply = vi.fn()
    useTabStore.getState().setSideEffects({
      applyFolderWorkspace: apply,
    })
    const conversation = conversationTab(1, 11)
    useTabStore.setState({
      rawTabs: [conversation],
      activeTabId: conversation.id,
    })
    apply.mockClear()
    useTabStore.getState().rememberFolderWorkspace(1, {
      primaryTabId: conversation.id,
      pane: "file",
    })

    useTabStore.getState().activateFolderWorkspace(1)

    expect(useTabStore.getState().activeTabId).toBe(conversation.id)
    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(1)
    expect(apply).toHaveBeenCalledWith({
      folderId: 1,
      pane: "file",
    })
  })

  it("returns to the last terminal tab after switching away", () => {
    const terminal = terminalTab(3, "term-3")
    useTabStore.setState({
      rawTabs: [terminal],
      activeTabId: terminal.id,
    })

    useTabStore.getState().activateFolderWorkspace(4)
    useTabStore.getState().activateFolderWorkspace(3)

    expect(useTabStore.getState().activeTabId).toBe(terminal.id)
  })

  it("clears active tab when the resume tab is closed", () => {
    const conversation = conversationTab(5, 51)
    useTabStore.setState({
      rawTabs: [conversation],
      activeTabId: conversation.id,
    })
    useTabStore.setState({
      rawTabs: [],
    })

    useTabStore.getState().activateFolderWorkspace(5)

    expect(useTabStore.getState().activeTabId).toBeNull()
  })

  it("increments activation generation on each switch", () => {
    const start = getFolderActivationGeneration()
    useTabStore.getState().activateFolderWorkspace(8)
    useTabStore.getState().activateFolderWorkspace(9)
    expect(getFolderActivationGeneration()).toBe(start + 2)
  })

  it("clears recorded resume on resetTabStore", () => {
    useTabStore.getState().rememberFolderWorkspace(6, {
      primaryTabId: "conv-6",
      pane: "conversation",
    })

    resetTabStore()
    expect(getFolderWorkspaceResume(6)).toBeNull()
  })

  it("does not create extra tabs when entering a folder that only has a terminal", () => {
    const terminal = terminalTab(3, "term-3")
    useTabStore.setState({
      rawTabs: [terminal],
      activeTabId: terminal.id,
    })

    useTabStore.getState().activateFolderWorkspace(3)

    expect(useTabStore.getState().rawTabs.map((tab) => tab.id)).toEqual([
      terminal.id,
    ])
    expect(useTabStore.getState().activeTabId).toBe(terminal.id)
    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(3)
  })

  it("does not activate another project's tab when closing a session", () => {
    const first = conversationTab(1, 11)
    const second = conversationTab(2, 21)
    useAppWorkspaceStore.getState().setActiveFolderId(1)
    useTabStore.setState({
      rawTabs: [first, second],
      activeTabId: first.id,
    })

    useTabStore.getState().closeTab(first.id)

    expect(useTabStore.getState().activeTabId).toBeNull()
    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(1)
    expect(useTabStore.getState().rawTabs.map((tab) => tab.id)).toEqual([
      second.id,
    ])
  })

  it("leaves activeTabId null instead of jumping to another folder when the only tab closes", () => {
    const first = conversationTab(1, 11)
    const second = conversationTab(2, 21)
    useAppWorkspaceStore.getState().setActiveFolderId(1)
    useTabStore.setState({
      rawTabs: [first, second],
      activeTabId: first.id,
    })

    useTabStore.getState().closeTab(first.id)

    expect(useTabStore.getState().activeTabId).toBeNull()
    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(1)
    expect(
      useTabStore.getState().rawTabs.some((tab) => tab.id === second.id)
    ).toBe(true)
  })

  it("stores a pane write-back without changing the active tab", () => {
    const conversation = conversationTab(10, 101)
    useTabStore.setState({
      rawTabs: [conversation],
      activeTabId: conversation.id,
    })
    const resume: FolderWorkspaceResume = {
      primaryTabId: conversation.id,
      pane: "file",
    }
    useTabStore.getState().rememberFolderWorkspace(10, resume)

    expect(getFolderWorkspaceResume(10)).toEqual(resume)
    expect(useTabStore.getState().activeTabId).toBe(conversation.id)
  })

  it("retains the current active folder when switching to a pinned tab from another folder", () => {
    const pinnedConv = conversationTab(2, 22)
    pinnedConv.isPinned = true
    const currentConv = conversationTab(1, 11)
    currentConv.isPinned = false

    useAppWorkspaceStore.getState().setActiveFolderId(1)
    useTabStore.setState({
      rawTabs: [currentConv, pinnedConv],
      activeTabId: currentConv.id,
    })

    useTabStore.getState().switchTab(pinnedConv.id)

    expect(useTabStore.getState().activeTabId).toBe(pinnedConv.id)
    // Active folder stays at 1 because the target tab is pinned
    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(1)
  })

  it("switches active folder when switching to an unpinned tab in another folder", () => {
    const unpinnedConv = conversationTab(2, 22)
    unpinnedConv.isPinned = false

    useAppWorkspaceStore.getState().setActiveFolderId(1)
    useTabStore.setState({
      rawTabs: [unpinnedConv],
      activeTabId: null,
    })

    useTabStore.getState().switchTab(unpinnedConv.id)

    expect(useTabStore.getState().activeTabId).toBe(unpinnedConv.id)
    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(2)
  })

  it("removes terminal tab when calling closeTab", () => {
    const term = terminalTab(1, "term-1")
    useTabStore.setState({
      rawTabs: [term],
      activeTabId: term.id,
    })

    useTabStore.getState().closeTab(term.id)

    expect(
      useTabStore.getState().rawTabs.some((tab) => tab.id === term.id)
    ).toBe(false)
  })
})

describe("reload recovery", () => {
  it("returns to the last project even if tabs hydrate before recovery runs", () => {
    saveLastActiveContext({ folderId: 7, isChat: false })

    // tabs 先到、终端清单未到：这时的空状态不能覆盖上次位置
    useTabStore.setState({ tabsHydrated: true })
    useTabStore.getState().persistLastActiveContext()
    runRecoveryOnce()

    expect(useAppWorkspaceStore.getState().activeFolderId).toBe(7)
  })
})

describe("folderless terminal scope", () => {
  it("leaves the active project when switching to a folderless terminal", () => {
    useAppWorkspaceStore.getState().setActiveFolderId(1)
    const tab = {
      ...terminalTab(1, "loose"),
      folderId: null,
      isPinned: false,
    } as TabItemInternal
    useTabStore.setState({ rawTabs: [tab] })

    useTabStore.getState().switchTab(tab.id)

    expect(useAppWorkspaceStore.getState().activeFolderId).toBeNull()
    expect(useTabStore.getState().activeTabId).toBe(tab.id)
  })
})
