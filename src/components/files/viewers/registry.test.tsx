import { describe, expect, it } from "vitest"
import { FILE_VIEWER_KINDS } from "./registry"

describe("FileViewerHost registry", () => {
  it("covers every FileViewerKind exactly once", () => {
    expect([...FILE_VIEWER_KINDS].sort()).toEqual(
      [
        "excalidraw",
        "html",
        "image",
        "markdown",
        "office",
        "pdf",
        "text",
      ].sort()
    )
  })
})
