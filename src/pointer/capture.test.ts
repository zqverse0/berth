import { describe, expect, it } from "vitest"

import {
  findPdfPageNumber,
  resolveContextMenuSelection,
  selectionHasText,
  shouldInterceptContextMenu,
} from "./capture"

describe("findPdfPageNumber", () => {
  it("reads data-page-number from pdf.js 6.x page div", () => {
    const page = document.createElement("div")
    page.dataset.pageNumber = "3"
    const span = document.createElement("span")
    span.dataset.elementId = "0"
    page.append(span)
    expect(findPdfPageNumber(span)).toBe(3)
  })

  it("falls back to legacy data-pdf-page", () => {
    const page = document.createElement("div")
    page.dataset.pdfPage = "2"
    const span = document.createElement("span")
    page.append(span)
    expect(findPdfPageNumber(span)).toBe(2)
  })

  it("prefers data-page-number over legacy attribute", () => {
    const page = document.createElement("div")
    page.dataset.pageNumber = "5"
    page.dataset.pdfPage = "4"
    const span = document.createElement("span")
    page.append(span)
    expect(findPdfPageNumber(span)).toBe(5)
  })

  it("returns null for nodes outside a page", () => {
    const node = document.createElement("div")
    node.append(document.createElement("span"))
    expect(findPdfPageNumber(node.firstChild)).toBeNull()
    expect(findPdfPageNumber(null)).toBeNull()
  })
})

describe("shouldInterceptContextMenu", () => {
  it("intercepts only when there is selected text", () => {
    expect(shouldInterceptContextMenu(null)).toBe(false)
    expect(
      shouldInterceptContextMenu({
        excerpt: "   ",
        source: null,
        editable: false,
      })
    ).toBe(false)
    expect(
      shouldInterceptContextMenu({
        excerpt: "hello",
        source: null,
        editable: false,
      })
    ).toBe(true)
    expect(
      selectionHasText({ excerpt: "x", source: null, editable: true })
    ).toBe(true)
  })
})

describe("resolveContextMenuSelection", () => {
  const fileSel = {
    excerpt: "hello",
    editable: false,
    source: {
      identity: { type: "file" as const, path: "a.ts" },
      excerpt: "hello",
    },
  }

  it("does not intercept when nothing is selected and the click is not on an owned surface", () => {
    expect(
      resolveContextMenuSelection({
        liveExcerpt: "",
        liveTouchesTarget: false,
        reported: fileSel,
        onOwnedSurface: false,
      })
    ).toBeNull()
  })

  it("does not use leftover DOM text if the right-click missed the selection", () => {
    expect(
      resolveContextMenuSelection({
        liveExcerpt: "hello",
        liveTouchesTarget: false,
        reported: fileSel,
        onOwnedSurface: false,
      })
    ).toBeNull()
  })

  it("uses the live selection only when the click is on it", () => {
    expect(
      resolveContextMenuSelection({
        liveExcerpt: "hello",
        liveTouchesTarget: true,
        reported: fileSel,
        onOwnedSurface: false,
      })
    ).toEqual({
      excerpt: "hello",
      editable: false,
      source: fileSel.source,
    })
  })

  it("allows editor-reported selection only on an owned surface", () => {
    expect(
      resolveContextMenuSelection({
        liveExcerpt: "",
        liveTouchesTarget: false,
        reported: fileSel,
        onOwnedSurface: true,
      })
    ).toEqual(fileSel)
  })

  it("prefers the adapter report on an owned surface even if DOM text differs", () => {
    expect(
      resolveContextMenuSelection({
        liveExcerpt: "npm  test",
        liveTouchesTarget: true,
        reported: {
          excerpt: "npm test",
          editable: false,
          source: {
            identity: {
              type: "terminal",
              backendInstanceId: "backend-a",
              terminalId: "term-1",
              pane: { session: "7", window: "term-1", index: 0 },
            },
            excerpt: "npm test",
          },
        },
        onOwnedSurface: true,
      })
    ).toMatchObject({ excerpt: "npm test" })
  })
})
