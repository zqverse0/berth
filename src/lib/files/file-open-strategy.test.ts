import { describe, expect, it } from "vitest"
import { fileOpenStrategyFromPath } from "@/lib/files/file-open-strategy"

describe("fileOpenStrategyFromPath", () => {
  it.each(["a.pdf", "A.PDF", "C:\\repo\\Report.PdF"])(
    "classifies %s as a workspace PDF resource",
    (path) => {
      expect(fileOpenStrategyFromPath(path)).toEqual({
        dataMode: "resource",
        previewKind: "pdf",
        reloadPolicy: "workspace-resource",
      })
    }
  )

  it("keeps office self-managed and markdown text-backed", () => {
    expect(fileOpenStrategyFromPath("a.docx").reloadPolicy).toBe("self-managed")
    expect(fileOpenStrategyFromPath("README.md").dataMode).toBe("text")
  })

  it.each(["a.excalidraw", "vault/Drawing.excalidraw.md"])(
    "classifies %s as a text-backed Excalidraw drawing",
    (path) => {
      expect(fileOpenStrategyFromPath(path)).toEqual({
        dataMode: "text",
        previewKind: "excalidraw",
        reloadPolicy: "text-buffer",
      })
    }
  )

  it("keeps ordinary json as text", () => {
    expect(fileOpenStrategyFromPath("foo.json")).toEqual({
      dataMode: "text",
      previewKind: "text",
      reloadPolicy: "text-buffer",
    })
  })
})
