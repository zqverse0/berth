import { describe, expect, it } from "vitest"
import {
  fileTabIsInFolderScope,
  fileTabsForFolderScope,
  mergeFileTabsForFolderScope,
  sortFolderTabs,
  tabsForFolderScope,
} from "@/lib/workspace/tab-scope"
import type { PrimaryTab } from "@/lib/workspace/primary-tabs"

const pinnedTab = (folderId: number): PrimaryTab =>
  conversationTab(folderId, `pinned:${folderId}`, true)

const conversationTab = (
  folderId: number,
  id: string,
  isPinned = false
): PrimaryTab => ({
  kind: "conversation",
  id,
  folderId,
  conversationId: Number(id),
  agentType: "codex",
  title: id,
  isPinned,
})

const terminalTab = (
  folderId: number | null,
  id: string,
  isPinned = false
): PrimaryTab => ({
  kind: "terminal",
  id,
  terminalId: id,
  backendInstanceId: "backend",
  folderId,
  title: id,
  initialCwd: "/tmp",
  shell: "/bin/sh",
  detachedFolderLabel: null,
  detachedFolderPath: null,
  isPinned,
})

describe("tabsForFolderScope", () => {
  it("keeps unpinned tabs in their folder, pinned ones everywhere", () => {
    const tabs = [
      conversationTab(2, "conversation-b"),
      pinnedTab(1),
      terminalTab(1, "terminal-a"),
      conversationTab(1, "conversation-a"),
      pinnedTab(2),
    ]

    // Pinned (global) tabs show everywhere; unpinned tabs stay strictly
    // inside their folder.
    expect(tabsForFolderScope(tabs, 1).map((tab) => tab.id)).toEqual([
      "pinned:1",
      "terminal-a",
      "conversation-a",
      "pinned:2",
    ])
  })

  it("does not merge unpinned worktree conversations with their parent folder", () => {
    const tabs = [pinnedTab(7), pinnedTab(8), conversationTab(8, "wt")]

    // Pinned (global) tabs show everywhere; the unpinned worktree
    // conversation stays in folder 8.
    expect(tabsForFolderScope(tabs, 7).map((tab) => tab.id)).toEqual([
      "pinned:7",
      "pinned:8",
    ])
  })

  it("shows only folderless terminals in the null scope", () => {
    const tabs = [terminalTab(null, "personal"), terminalTab(3, "project")]

    expect(tabsForFolderScope(tabs, null).map((tab) => tab.id)).toEqual([
      "personal",
    ])
  })

  it("keeps a folderless terminal out of every project scope", () => {
    const detached = {
      ...terminalTab(null, "detached"),
      detachedFolderPath: "/deleted-project/work",
    }

    expect(tabsForFolderScope([detached], 1)).toEqual([])
    expect(tabsForFolderScope([detached], 2)).toEqual([])
    expect(tabsForFolderScope([detached], null)).toEqual([detached])
  })

  it("shows pinned tabs in every folder scope (pin = global)", () => {
    const tabs = [
      conversationTab(1, "conv-1"),
      conversationTab(2, "conv-2", true),
      terminalTab(3, "terminal-3", true),
    ]

    // Filtering preserves raw order; pinning is handled by sortFolderTabs.
    // terminal-3 is pinned (global) so it shows in folder 1 too.
    expect(tabsForFolderScope(tabs, 1).map((tab) => tab.id)).toEqual([
      "conv-1",
      "conv-2",
      "terminal-3",
    ])
    expect(tabsForFolderScope(tabs, 3).map((tab) => tab.id)).toEqual([
      "conv-2",
      "terminal-3",
    ])
    expect(tabsForFolderScope(tabs, null).map((tab) => tab.id)).toEqual([
      "conv-2",
      "terminal-3",
    ])
  })
})

describe("sortFolderTabs", () => {
  it("puts pinned (global) tabs before folder-scoped tabs", () => {
    const tabs = [
      conversationTab(1, "conversation"),
      pinnedTab(1),
      conversationTab(1, "global-conv", true),
    ]

    // Pinned tabs tie and keep their original order; both land before the
    // unpinned conversation.
    expect(sortFolderTabs(tabs).map((tab) => tab.id)).toEqual([
      "pinned:1",
      "global-conv",
      "conversation",
    ])
  })
})

describe("fileTabIsInFolderScope", () => {
  it("keeps file tabs strictly within their folder scope", () => {
    const folderFile = { id: "f1", kind: "file", folderId: 1 }
    const folderlessFile = { id: "f0", kind: "file", folderId: null }

    expect(fileTabIsInFolderScope(folderFile, 1)).toBe(true)
    expect(fileTabIsInFolderScope(folderFile, 2)).toBe(false)
    expect(fileTabIsInFolderScope(folderFile, null)).toBe(false)

    expect(fileTabIsInFolderScope(folderlessFile, null)).toBe(true)
    expect(fileTabIsInFolderScope(folderlessFile, 1)).toBe(false)
  })

  it("keeps global config tabs visible in every folder scope", () => {
    const globalSkill = {
      id: "skill",
      kind: "file",
      folderId: null,
      path: "/home/user/.berth/skills/review/SKILL.md",
      lifetime: "global" as const,
    }

    expect(fileTabIsInFolderScope(globalSkill, 1)).toBe(true)
    expect(fileTabIsInFolderScope(globalSkill, 2)).toBe(true)
    expect(fileTabIsInFolderScope(globalSkill, null)).toBe(true)
  })

  it("shows a tab in the project the file lives in, not where it was opened", () => {
    const crossProject = {
      id: "x",
      kind: "file",
      folderId: 2,
      path: "/other/a.ts",
      openedInFolderId: 1,
    }
    const loose = {
      id: "l",
      kind: "file",
      folderId: null,
      path: "/tmp/a.md",
      openedInFolderId: 1,
    }

    expect(fileTabIsInFolderScope(crossProject, 1)).toBe(false)
    expect(fileTabIsInFolderScope(crossProject, 2)).toBe(true)
    // 不属于任何项目的文件留在打开它的项目。
    expect(fileTabIsInFolderScope(loose, 1)).toBe(true)
    expect(fileTabIsInFolderScope(loose, null)).toBe(false)
  })
})

describe("fileTabsForFolderScope", () => {
  const fileTab = (folderId: number | null, id: string) => ({
    folderId,
    id,
  })

  it("returns only tabs matching the active folder", () => {
    const tabs = [fileTab(1, "a"), fileTab(2, "b"), fileTab(1, "c")]
    expect(fileTabsForFolderScope(tabs, 1).map((t) => t.id)).toEqual(["a", "c"])
  })

  it("does not merge worktree with root", () => {
    const tabs = [fileTab(1, "root-file"), fileTab(2, "wt-file")]
    expect(fileTabsForFolderScope(tabs, 1).map((t) => t.id)).toEqual([
      "root-file",
    ])
  })

  it("shows folderless files only in null scope", () => {
    const tabs = [fileTab(null, "external"), fileTab(1, "project")]
    expect(fileTabsForFolderScope(tabs, null).map((t) => t.id)).toEqual([
      "external",
    ])
    expect(fileTabsForFolderScope(tabs, 1).map((t) => t.id)).toEqual([
      "project",
    ])
  })

  it("derives the owning folder for legacy path-only tabs", () => {
    const tabs = [
      { ...fileTab(null, "root-file"), path: "/repo/src/main.ts" },
      { ...fileTab(null, "worktree-file"), path: "/repo-wt/src/main.ts" },
      { ...fileTab(null, "external"), path: "/tmp/notes.md" },
    ]
    const folders = [
      { id: 1, path: "/repo" },
      { id: 2, path: "/repo-wt" },
    ]

    expect(fileTabsForFolderScope(tabs, 1, folders).map((t) => t.id)).toEqual([
      "root-file",
    ])
    expect(fileTabsForFolderScope(tabs, 2, folders).map((t) => t.id)).toEqual([
      "worktree-file",
    ])
    expect(
      fileTabsForFolderScope(tabs, null, folders).map((t) => t.id)
    ).toEqual(["external"])
  })

  it("merges a visible reorder without dropping hidden folder tabs", () => {
    const tabs = [
      { ...fileTab(1, "a"), path: "/repo/a.ts" },
      { ...fileTab(2, "b"), path: "/other/b.ts" },
      { ...fileTab(1, "c"), path: "/repo/c.ts" },
    ]
    const reordered = [tabs[2], tabs[0]]

    expect(
      mergeFileTabsForFolderScope(tabs, reordered, 1).map((tab) => tab.id)
    ).toEqual(["c", "b", "a"])
  })
})
