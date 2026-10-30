import { beforeEach, describe, expect, it } from "vitest"
import { useGroupWorkspaceStore } from "./group-workspace-store"
import { useWorkspaceLayoutStore } from "./workspace-layout-store"
import { useAppUiStore } from "./app-ui-store"

beforeEach(() => {
  useGroupWorkspaceStore.setState({
    folderId: 7,
    group: "a",
    previewTabId: "terminal:1",
    emptyMember: null,
    focusedMember: null,
  })
  useAppUiStore.setState({ auxPanelOpen: true })
})

describe("group viewing context", () => {
  it("hides the previous member preview on group change without removing tabs", () => {
    useWorkspaceLayoutStore.setState({
      activeTabByPane: {
        files: null,
        "files-split": null,
        conversation: { kind: "primary", id: "terminal:1", type: "terminal" },
      },
    })
    useGroupWorkspaceStore.getState().selectGroup(7, "b")
    expect(useAppUiStore.getState().auxPanelOpen).toBe(false)
    expect(useGroupWorkspaceStore.getState().previewTabId).toBeNull()
    expect(
      useWorkspaceLayoutStore.getState().activeTabByPane.conversation?.id
    ).toBe("terminal:1")
  })
  it("does not hide an unrelated auxiliary tab", () => {
    useWorkspaceLayoutStore.setState({
      activeTabByPane: {
        files: null,
        "files-split": null,
        conversation: { kind: "file", id: "unrelated", type: "file" },
      },
    })
    useGroupWorkspaceStore.getState().selectGroup(7, "b")
    expect(useAppUiStore.getState().auxPanelOpen).toBe(true)
  })
  it("preserves filtering in the same group and opens Berth's chat when changing groups", () => {
    const store = useGroupWorkspaceStore.getState()
    store.setFocusedMember("agent-1")
    store.selectGroup(7, "a")
    expect(useGroupWorkspaceStore.getState().focusedMember).toBe("agent-1")
    store.selectGroup(8, "a")
    expect(useGroupWorkspaceStore.getState().focusedMember).toBe("berth")
  })
})
