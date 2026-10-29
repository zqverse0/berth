import { describe, expect, it } from "vitest"
import {
  pickTabInFolder,
  resolveCloseTabActivation,
  resolveFolderWorkspaceActivation,
} from "@/lib/workspace/folder-workspace-resume"

const conversationTab = (folderId: number, id: string) => ({
  id,
  folderId,
  kind: "conversation",
})

const terminalTab = (folderId: number, id: string) => ({
  id,
  folderId,
  kind: "terminal",
})

describe("resolveFolderWorkspaceActivation", () => {
  it("resumes a still-open primary tab and keeps its pane", () => {
    expect(
      resolveFolderWorkspaceActivation({
        folderId: 1,
        resume: { primaryTabId: "conv-1", pane: "file" },
        rawTabs: [terminalTab(1, "term-1"), conversationTab(1, "conv-1")],
        activeTabId: "term-1",
      })
    ).toEqual({
      tabId: "conv-1",
      pane: "file",
    })
  })

  it("falls back to the folder's first tab when the resume tab is gone", () => {
    expect(
      resolveFolderWorkspaceActivation({
        folderId: 1,
        resume: { primaryTabId: "conv-gone", pane: "conversation" },
        rawTabs: [terminalTab(1, "term-1"), conversationTab(1, "conv-1")],
        activeTabId: "other",
      })
    ).toEqual({
      tabId: "term-1",
      pane: "conversation",
    })
  })

  it("keeps the current tab when it still belongs to the folder", () => {
    expect(
      resolveFolderWorkspaceActivation({
        folderId: 1,
        resume: { primaryTabId: "gone", pane: "file" },
        rawTabs: [conversationTab(1, "conv-1"), terminalTab(1, "term-1")],
        activeTabId: "term-1",
      })
    ).toEqual({
      tabId: "term-1",
      pane: "file",
    })
  })

  it("keeps the remaining session", () => {
    expect(
      resolveFolderWorkspaceActivation({
        folderId: 1,
        resume: { primaryTabId: "gone", pane: "conversation" },
        rawTabs: [conversationTab(1, "conv-1")],
        activeTabId: null,
      })
    ).toEqual({
      tabId: "conv-1",
      pane: "conversation",
    })
  })

  it("returns null tabId when the folder scope is empty", () => {
    expect(
      resolveFolderWorkspaceActivation({
        folderId: 2,
        resume: null,
        rawTabs: [conversationTab(1, "conv-1")],
        activeTabId: "conv-1",
      })
    ).toEqual({
      tabId: null,
      pane: "conversation",
    })
  })

  it("ignores a resume tab that belongs to another folder", () => {
    expect(
      resolveFolderWorkspaceActivation({
        folderId: 2,
        resume: { primaryTabId: "conv-1", pane: "file" },
        rawTabs: [conversationTab(1, "conv-1"), terminalTab(2, "term-2")],
        activeTabId: "conv-1",
      })
    ).toEqual({
      tabId: "term-2",
      pane: "file",
    })
  })
})

describe("resolveCloseTabActivation", () => {
  it("stays on the same-folder neighbor instead of a later project's tab", () => {
    expect(
      resolveCloseTabActivation({
        remainingInFolder: [
          terminalTab(1, "term-1"),
          conversationTab(1, "conv-1b"),
        ],
        closingIndexInFolder: 1,
      })
    ).toEqual({
      activeTabId: "conv-1b",
    })
  })

  it("clamps to the last remaining tab when the closed one was at the end", () => {
    expect(
      resolveCloseTabActivation({
        remainingInFolder: [terminalTab(1, "term-1")],
        closingIndexInFolder: 1,
      })
    ).toEqual({
      activeTabId: "term-1",
    })
  })

  it("returns activeTabId null when the folder scope is empty", () => {
    expect(
      resolveCloseTabActivation({
        remainingInFolder: [],
        closingIndexInFolder: 0,
      })
    ).toEqual({
      activeTabId: null,
    })
  })
})

describe("pickTabInFolder", () => {
  it("ignores a preferred tab from another folder", () => {
    expect(
      pickTabInFolder(
        [terminalTab(1, "term-1"), conversationTab(2, "conv-2")],
        1,
        "conv-2"
      )
    ).toBe("term-1")
  })

  it("prefers the still-open tab in the current folder", () => {
    expect(
      pickTabInFolder(
        [terminalTab(1, "term-1"), conversationTab(1, "conv-1")],
        1,
        "conv-1"
      )
    ).toBe("conv-1")
  })
})
