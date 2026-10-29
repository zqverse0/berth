import { afterEach, describe, expect, it } from "vitest"
import {
  loadPdfReadingPosition,
  savePdfReadingPosition,
} from "./pdf-reading-position"

const file = { rootPath: "/p", path: "docs/a.pdf" }

afterEach(() => localStorage.clear())

describe("pdf reading position", () => {
  it("round-trips per file", () => {
    const position = { page: 7, top: 420, left: 0, fitWidth: false, scale: 1.5 }
    savePdfReadingPosition(file, position)
    expect(loadPdfReadingPosition(file)).toEqual(position)
    expect(
      loadPdfReadingPosition({ rootPath: "/p", path: "docs/b.pdf" })
    ).toBeNull()
  })

  it("rejects corrupt entries", () => {
    localStorage.setItem("berth:pdf-position:/p\0docs/a.pdf", "{bad")
    expect(loadPdfReadingPosition(file)).toBeNull()
    localStorage.setItem(
      "berth:pdf-position:/p\0docs/a.pdf",
      JSON.stringify({ page: 0, top: 1, left: 0, fitWidth: true, scale: 1 })
    )
    expect(loadPdfReadingPosition(file)).toBeNull()
  })
})
