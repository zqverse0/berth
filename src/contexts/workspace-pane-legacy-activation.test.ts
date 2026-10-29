import { describe, expect, it } from "vitest"
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store"

describe("workspace layout activation", () => {
  it("keeps the selected file tab in its owning pane", () => {
    useWorkspaceLayoutStore.setState({
      activeWorkspaceTab: { kind: "file", id: "file:one", type: "file" },
      activeTabByPane: {
        conversation: null,
        files: { kind: "file", id: "file:one", type: "file" },
        "files-split": null,
      },
      activePane: "files",
    })
    expect(useWorkspaceLayoutStore.getState().activePane).toBe("files")
    expect(useWorkspaceLayoutStore.getState().activeTabByPane.files).toEqual({
      kind: "file",
      id: "file:one",
      type: "file",
    })
  })
})
