import { afterEach, describe, expect, it, vi } from "vitest"

const api = vi.hoisted(() => ({
  createFileTreeEntry: vi.fn(),
  readFilePreview: vi.fn(),
  saveFileContent: vi.fn(),
}))

vi.mock("@/lib/api", () => api)

import {
  createHighlight,
  createNote,
  loadHighlights,
  marksSidecarPath,
  saveHighlights,
  type PdfHighlight,
} from "./pdf-highlight-store"

const pdfFile = { rootPath: "/repo", path: "docs/paper.pdf" }

function sampleHighlights(): PdfHighlight[] {
  return [
    createHighlight(1, [{ x: 0.1, y: 0.2, w: 0.5, h: 0.03 }], "selected text"),
  ]
}

describe("marksSidecarPath", () => {
  it("appends .marks.json to the pdf relative path", () => {
    expect(marksSidecarPath("docs/paper.pdf")).toBe("docs/paper.pdf.marks.json")
    expect(marksSidecarPath("a.pdf")).toBe("a.pdf.marks.json")
  })
})

describe("loadHighlights", () => {
  afterEach(() => {
    api.readFilePreview.mockReset()
  })

  it("returns parsed highlights from an existing sidecar", async () => {
    const payload = JSON.stringify({
      version: 1,
      highlights: sampleHighlights(),
    })
    api.readFilePreview.mockResolvedValue({
      path: "docs/paper.pdf.marks.json",
      content: payload,
    })
    const loaded = await loadHighlights(pdfFile)
    expect(loaded).toHaveLength(1)
    expect(loaded[0]).toMatchObject({ page: 1, quote: "selected text" })
    expect(api.readFilePreview).toHaveBeenCalledWith(
      "/repo",
      "docs/paper.pdf.marks.json"
    )
  })

  it("returns empty when the sidecar is missing", async () => {
    api.readFilePreview.mockRejectedValue({ code: "not_found" })
    await expect(loadHighlights(pdfFile)).resolves.toEqual([])
  })

  it("returns empty for corrupt or wrong-version content", async () => {
    api.readFilePreview.mockResolvedValueOnce({
      path: "x",
      content: "{not json",
    })
    await expect(loadHighlights(pdfFile)).resolves.toEqual([])
    api.readFilePreview.mockResolvedValueOnce({
      path: "x",
      content: JSON.stringify({ version: 99, highlights: [] }),
    })
    await expect(loadHighlights(pdfFile)).resolves.toEqual([])
  })

  it("drops invalid entries but keeps valid ones", async () => {
    const payload = JSON.stringify({
      version: 1,
      highlights: [
        { version: 1, kind: "highlight", id: "ok", page: 2, rects: [] },
        { junk: true },
      ],
    })
    api.readFilePreview.mockResolvedValue({ path: "x", content: payload })
    const loaded = await loadHighlights(pdfFile)
    expect(loaded).toHaveLength(1)
    expect(loaded[0].id).toBe("ok")
  })
})

describe("saveHighlights", () => {
  afterEach(() => {
    api.createFileTreeEntry.mockReset()
    api.saveFileContent.mockReset()
  })

  it("writes directly when the sidecar exists", async () => {
    api.saveFileContent.mockResolvedValue({ path: "docs/paper.pdf.marks.json" })
    await expect(saveHighlights(pdfFile, sampleHighlights())).resolves.toBe(
      true
    )
    expect(api.saveFileContent).toHaveBeenCalledTimes(1)
    expect(api.createFileTreeEntry).not.toHaveBeenCalled()
    const [root, path, content] = api.saveFileContent.mock.calls[0]
    expect(root).toBe("/repo")
    expect(path).toBe("docs/paper.pdf.marks.json")
    expect(JSON.parse(content)).toMatchObject({ version: 1 })
  })

  it("creates the file then writes when the first save fails", async () => {
    api.saveFileContent
      .mockRejectedValueOnce({ code: "not_found" })
      .mockResolvedValueOnce({ path: "docs/paper.pdf.marks.json" })
    api.createFileTreeEntry.mockResolvedValue("docs/paper.pdf.marks.json")
    await expect(saveHighlights(pdfFile, sampleHighlights())).resolves.toBe(
      true
    )
    expect(api.createFileTreeEntry).toHaveBeenCalledWith(
      "/repo",
      "docs",
      "paper.pdf.marks.json",
      "file"
    )
    expect(api.saveFileContent).toHaveBeenCalledTimes(2)
  })

  it("creates at the root when the sidecar has no parent dir", async () => {
    api.saveFileContent
      .mockRejectedValueOnce({ code: "not_found" })
      .mockResolvedValueOnce({ path: "a.pdf.marks.json" })
    api.createFileTreeEntry.mockResolvedValue("a.pdf.marks.json")
    await expect(
      saveHighlights({ rootPath: "/repo", path: "a.pdf" }, sampleHighlights())
    ).resolves.toBe(true)
    expect(api.createFileTreeEntry).toHaveBeenCalledWith(
      "/repo",
      "",
      "a.pdf.marks.json",
      "file"
    )
  })

  it("returns false when creation or write keeps failing", async () => {
    api.saveFileContent.mockRejectedValue({ code: "io_error" })
    api.createFileTreeEntry.mockRejectedValue({ code: "io_error" })
    await expect(saveHighlights(pdfFile, sampleHighlights())).resolves.toBe(
      false
    )
  })
})

describe("createHighlight", () => {
  it("builds a complete highlight with defaults", () => {
    const highlight = createHighlight(1, [{ x: 0, y: 0, w: 1, h: 1 }], "q")
    expect(highlight).toMatchObject({
      version: 1,
      kind: "highlight",
      page: 1,
      quote: "q",
      color: "yellow",
    })
    expect(highlight.id).toBeTruthy()
    expect(highlight.createdAt).toBeTruthy()
    expect(highlight.updatedAt).toBeTruthy()
  })

  it("honors an explicit color", () => {
    expect(createHighlight(2, [], "q", "green").color).toBe("green")
  })
})

describe("createNote", () => {
  it("builds a complete note entry with comment", () => {
    const note = createNote(
      1,
      [{ x: 0.1, y: 0.2, w: 0.5, h: 0.03 }],
      "text",
      "my note"
    )
    expect(note).toMatchObject({
      version: 1,
      kind: "note",
      page: 1,
      quote: "text",
      comment: "my note",
    })
    expect(note.id).toBeTruthy()
    expect(note.createdAt).toBeTruthy()
    expect(note.updatedAt).toBeTruthy()
  })
})
