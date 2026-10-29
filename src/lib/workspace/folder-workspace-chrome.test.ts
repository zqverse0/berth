import { describe, expect, it } from "vitest"
import { resolveFolderWorkspaceChrome } from "@/lib/workspace/folder-workspace-chrome"

describe("resolveFolderWorkspaceChrome", () => {
  it("resumes the files pane when that folder still has the remembered tab", () => {
    expect(
      resolveFolderWorkspaceChrome({
        resumePane: "file",
        visibleFileTabIds: ["file-a", "file-b"],
        rememberedFileTabId: "file-b",
      })
    ).toEqual({ pane: "files", fileTabId: "file-b" })
  })

  it("falls back to the first visible file tab when the remembered one is gone", () => {
    expect(
      resolveFolderWorkspaceChrome({
        resumePane: "file",
        visibleFileTabIds: ["file-a"],
        rememberedFileTabId: "file-gone",
      })
    ).toEqual({ pane: "files", fileTabId: "file-a" })
  })

  it("returns to the conversation pane when files resume has no file tab", () => {
    expect(
      resolveFolderWorkspaceChrome({
        resumePane: "file",
        visibleFileTabIds: [],
        rememberedFileTabId: "file-a",
      })
    ).toEqual({ pane: "conversation", fileTabId: null })
  })

  it("keeps the conversation pane when that is what the folder last used", () => {
    expect(
      resolveFolderWorkspaceChrome({
        resumePane: "conversation",
        visibleFileTabIds: ["file-a"],
        rememberedFileTabId: "file-a",
      })
    ).toEqual({ pane: "conversation", fileTabId: "file-a" })
  })

  it("does not override pane when there is no resume but file tabs exist", () => {
    expect(
      resolveFolderWorkspaceChrome({
        resumePane: null,
        visibleFileTabIds: ["file-a"],
        rememberedFileTabId: null,
      })
    ).toEqual({ pane: null, fileTabId: "file-a" })
  })
})
