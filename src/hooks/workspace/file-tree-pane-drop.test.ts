import { beforeEach, describe, expect, it, vi } from "vitest"
import { paneAtPoint } from "@/hooks/workspace/workspace-tab-drag-hit-test"
import { readWorkspaceLayoutProjection } from "@/hooks/workspace/use-workspace-layout"
import { useTabStore } from "@/stores/tab-store"
import { osDropOverAt, treeDropOverAt } from "./file-tree-pane-drop"

vi.mock("@/hooks/workspace/workspace-tab-drag-hit-test", () => ({
  paneAtPoint: vi.fn(),
}))
vi.mock("@/hooks/workspace/use-workspace-layout", () => ({
  readWorkspaceLayoutProjection: vi.fn(),
}))

function layout(options: {
  hit: string | null
  splitActive?: boolean
  filesTabs?: number
  active?: Record<string, { kind: string; id: string }>
}) {
  vi.mocked(paneAtPoint).mockReturnValue(options.hit as never)
  vi.mocked(readWorkspaceLayoutProjection).mockReturnValue({
    splitActive: options.splitActive ?? false,
    tabsByPane: { files: Array(options.filesTabs ?? 1) },
    activeTabByPane: options.active ?? {},
  } as never)
}

describe("treeDropOverAt", () => {
  beforeEach(() => {
    useTabStore.setState({
      tabs: [
        { id: "t", kind: "terminal" },
        { id: "c", kind: "conversation" },
      ],
    } as never)
  })

  it("pastes into a terminal pane, files and directories alike", () => {
    const active = { conversation: { kind: "primary", id: "t" } }
    layout({ hit: "conversation", active })
    const paste = { pane: "conversation", action: "paste" }
    expect(treeDropOverAt(0, 0, "file")).toEqual(paste)
    expect(treeDropOverAt(0, 0, "dir")).toEqual(paste)
  })

  it("opens files elsewhere and refuses directories", () => {
    layout({ hit: "files", active: { files: { kind: "file", id: "f" } } })
    expect(treeDropOverAt(0, 0, "file")).toEqual({
      pane: "files",
      action: "open",
    })
    expect(treeDropOverAt(0, 0, "dir")).toBeNull()
  })

  it("a terminal wins over the proposed split under the pointer", () => {
    const active = { files: { kind: "primary", id: "t" } }
    layout({ hit: "files-split", active })
    expect(treeDropOverAt(0, 0, "file")).toEqual({
      pane: "files",
      action: "paste",
    })
  })

  it("proposes a split only when the left group has tabs", () => {
    layout({ hit: "files-split" })
    expect(treeDropOverAt(0, 0, "file")?.pane).toBe("files-split")
    layout({ hit: "files-split", filesTabs: 0 })
    expect(treeDropOverAt(0, 0, "file")?.pane).toBe("files")
  })

  it("system files only land on terminals", () => {
    layout({ hit: "files", active: { files: { kind: "file", id: "f" } } })
    expect(osDropOverAt(0, 0)).toBeNull()
  })
})
