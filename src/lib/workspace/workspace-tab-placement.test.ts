import { describe, expect, it } from "vitest"
import {
  defaultPane,
  foldEmptySplit,
  hasCrossPanePlacement,
  mergePaneReorder,
  mergeVisibleReorder,
  paneForTab,
  partitionTabsByPane,
  removeClosedPlacements,
  workspaceTabKey,
  type WorkspaceTabPlacement,
} from "@/lib/workspace/workspace-tab-placement"

interface PrimaryFixture {
  id: string
  kind: "conversation" | "terminal"
  folderId: number | null
}

interface FileFixture {
  id: string
  kind: "file"
  folderId: number | null
  path?: string
}

const primaryTab = (
  id: string,
  folderId: number | null,
  kind: PrimaryFixture["kind"] = "conversation"
): PrimaryFixture => ({ id, kind, folderId })

const fileTab = (
  id: string,
  folderId: number | null,
  path?: string
): FileFixture => ({
  id,
  kind: "file",
  folderId,
  path,
})

describe("workspace tab placement", () => {
  it("keeps primary and file ids distinct and resolves default panes", () => {
    expect(workspaceTabKey({ kind: "primary", id: "same" })).toBe(
      "primary:same"
    )
    expect(workspaceTabKey({ kind: "file", id: "same" })).toBe("file:same")
    expect(
      defaultPane({ kind: "primary", id: "conversation", type: "conversation" })
    ).toBe("files")
    expect(
      defaultPane({ kind: "primary", id: "terminal:7", type: "terminal" })
    ).toBe("conversation")
    expect(defaultPane({ kind: "file", id: "file" })).toBe("files")

    const placement: WorkspaceTabPlacement = {
      "file:file": "conversation",
    }
    expect(paneForTab({ kind: "file", id: "file" }, placement)).toBe(
      "conversation"
    )
    expect(
      paneForTab(
        { kind: "primary", id: "conversation", type: "conversation" },
        placement
      )
    ).toBe("files")
  })

  it("reorders one pane without changing the other pane slots", () => {
    const visible = [
      primaryTab("p1", 1),
      primaryTab("p2", 1),
      primaryTab("p3", 1),
    ]
    expect(
      mergePaneReorder(
        visible,
        [visible[0], visible[2]],
        [visible[2], visible[0]]
      )
    ).toEqual([visible[2], visible[1], visible[0]])
    expect(mergePaneReorder(visible, [visible[0]], [visible[1]])).toEqual(
      visible
    )
  })

  it("partitions both tab types while retaining each source order", () => {
    const primary = [primaryTab("p1", 1), primaryTab("p2", 1)]
    const files = [fileTab("f1", 1), fileTab("f2", 1)]
    const placement: WorkspaceTabPlacement = {
      "primary:p1": "files",
      "file:f2": "conversation",
    }

    const result = partitionTabsByPane(primary, files, placement)

    expect(result.primaryTabsByPane.conversation).toEqual([])
    expect(result.primaryTabsByPane.files.map((tab) => tab.id)).toEqual([
      "p1",
      "p2",
    ])
    expect(result.fileTabsByPane.conversation.map((tab) => tab.id)).toEqual([
      "f2",
    ])
    expect(result.fileTabsByPane.files.map((tab) => tab.id)).toEqual(["f1"])
  })

  it("keeps a terminal on the conversation pane by default", () => {
    const primary = [primaryTab("terminal:1", 1, "terminal")]

    expect(hasCrossPanePlacement({}, primary, [])).toBe(false)
    expect(
      partitionTabsByPane(primary, [], {}).primaryTabsByPane.conversation
    ).toEqual(primary)
    expect(
      partitionTabsByPane(primary, [], {}).primaryTabsByPane.files
    ).toEqual([])
  })

  it("still allows a terminal tab to move onto the files pane", () => {
    const primary = [primaryTab("terminal:1", 1, "terminal")]
    const placement: WorkspaceTabPlacement = {
      "primary:terminal:1": "files",
    }

    expect(hasCrossPanePlacement(placement, primary, [])).toBe(true)
    expect(
      partitionTabsByPane(primary, [], placement).primaryTabsByPane.files
    ).toEqual(primary)
  })

  it("keeps an empty target pane representable after a cross-pane move", () => {
    const primary = [primaryTab("session", 1, "terminal")]
    const result = partitionTabsByPane(primary, [], {
      "primary:session": "files",
    })

    expect(result.primaryTabsByPane.conversation).toEqual([])
    expect(result.primaryTabsByPane.files.map((tab) => tab.id)).toEqual([
      "session",
    ])
    expect(result.fileTabsByPane.files).toEqual([])
    expect(result.fileTabsByPane.conversation).toEqual([])
    expect(hasCrossPanePlacement({ "primary:session": "files" })).toBe(true)
  })

  it("merges visible reorder without moving hidden folder tabs", () => {
    const tabs = [
      primaryTab("visible-a", 1),
      primaryTab("hidden", 2),
      primaryTab("visible-b", 1),
    ]

    expect(
      mergeVisibleReorder(tabs, [tabs[2], tabs[0]], 1, "primary").map(
        (tab) => tab.id
      )
    ).toEqual(["visible-b", "hidden", "visible-a"])
  })

  it("uses legacy file paths for scope and rejects stale reorder payloads", () => {
    const tabs = [
      fileTab("root-a", null, "/repo/a.ts"),
      fileTab("other", 2, "/other/b.ts"),
      fileTab("root-b", null, "/repo/b.ts"),
    ]
    const folders = [{ id: 1, path: "/repo" }]

    expect(
      mergeVisibleReorder(tabs, [tabs[2], tabs[0]], 1, "file", folders).map(
        (tab) => tab.id
      )
    ).toEqual(["root-b", "other", "root-a"])
    expect(mergeVisibleReorder(tabs, [tabs[0]], 1, "file", folders)).toEqual(
      tabs
    )
  })

  it("uses exact primary folder scope and rejects duplicate reorder ids", () => {
    const tabs = [
      primaryTab("personal", null),
      primaryTab("project-a", 1),
      primaryTab("project-b", 1),
    ]

    expect(
      mergeVisibleReorder(tabs, [tabs[2], tabs[1]], 1, "primary").map(
        (tab) => tab.id
      )
    ).toEqual(["personal", "project-b", "project-a"])
    expect(mergeVisibleReorder(tabs, [tabs[1], tabs[1]], 1, "primary")).toEqual(
      tabs
    )
  })

  it("rejects stale same-id payloads instead of replacing current tab data", () => {
    const tabs = [
      fileTab("current-a", 1, "/repo/a.ts"),
      fileTab("current-b", 1, "/repo/b.ts"),
      fileTab("hidden", 2, "/other/hidden.ts"),
    ]
    const stale = { ...tabs[0], path: "/repo/a-renamed.ts" }

    expect(mergeVisibleReorder(tabs, [tabs[1], stale], 1, "file")).toEqual(tabs)
  })

  it("cleans closed placements but preserves hidden-folder tabs", () => {
    const placement: WorkspaceTabPlacement = {
      "primary:open": "files",
      "file:hidden": "conversation",
      "file:closed": "conversation",
    }
    const next = removeClosedPlacements(
      placement,
      [primaryTab("open", 1, "terminal")],
      [fileTab("hidden", 2)]
    )

    expect(next).toEqual({
      "primary:open": "files",
      "file:hidden": "conversation",
    })
  })

  it("reports live cross-pane placements and ignores stale entries when scoped", () => {
    const placement: WorkspaceTabPlacement = {
      "primary:open": "conversation",
      "file:default": "files",
      "file:stale": "conversation",
    }

    expect(hasCrossPanePlacement(placement)).toBe(true)
    expect(
      hasCrossPanePlacement({
        "primary:default": "conversation",
        "file:default": "files",
      })
    ).toBe(false)
    expect(
      hasCrossPanePlacement(
        placement,
        [primaryTab("open", 1, "terminal")],
        [fileTab("default", 1)]
      )
    ).toBe(false)
    expect(
      hasCrossPanePlacement(
        { "file:stale": "conversation" },
        [primaryTab("open", 1, "terminal")],
        [fileTab("default", 1)]
      )
    ).toBe(false)
    expect(
      hasCrossPanePlacement(
        { "file:default": "conversation" },
        [primaryTab("open", 1, "terminal")],
        [fileTab("default", 1)]
      )
    ).toBe(true)
  })
})

describe("foldEmptySplit", () => {
  const left = { kind: "file" as const, id: "left", type: "file" as const }
  const right = { kind: "file" as const, id: "right", type: "file" as const }
  const split: WorkspaceTabPlacement = { "file:right": "files-split" }

  it("keeps a split while the left group has a tab", () => {
    expect(foldEmptySplit(split, [left, right])).toBe(split)
  })

  it("folds the split back into the left group once it empties", () => {
    expect(foldEmptySplit(split, [right])).toEqual({ "file:right": "files" })
  })

  it("counts a global tab (settings) as left-group content", () => {
    const settings = { kind: "global" as const, id: "settings" }
    expect(foldEmptySplit(split, [settings, right])).toBe(split)
  })
})
