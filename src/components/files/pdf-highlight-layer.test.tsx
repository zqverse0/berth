import { act, fireEvent, render, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { PdfHighlightLayer } from "./pdf-highlight-layer"
import { createHighlight, createNote } from "@/lib/pdf/pdf-highlight-store"

const PDF_BOX = { left: 100, top: 200, width: 1000, height: 2000 }

function toDomRect(box: typeof PDF_BOX): DOMRect {
  return {
    left: box.left,
    top: box.top,
    right: box.left + box.width,
    bottom: box.top + box.height,
    width: box.width,
    height: box.height,
    x: box.left,
    y: box.top,
    toJSON: () => ({}),
  } as DOMRect
}

function setBox(element: HTMLElement, box: typeof PDF_BOX) {
  element.getBoundingClientRect = () => toDomRect(box)
}

/** 构造一个 `.pdfViewer` 元素，内含若干 `.page`（带 data-page-number）。 */
function makeViewer(pageNumbers: number[]): HTMLElement {
  const container = document.createElement("div")
  container.className = "pdf-viewer-container"
  setBox(container, PDF_BOX)
  const viewer = document.createElement("div")
  viewer.className = "pdfViewer"
  for (const page of pageNumbers) {
    const pageEl = document.createElement("div")
    pageEl.setAttribute("data-page-number", String(page))
    setBox(pageEl, PDF_BOX)
    viewer.appendChild(pageEl)
  }
  container.appendChild(viewer)
  document.body.appendChild(container)
  return viewer
}

function findRects(viewer: HTMLElement): Element[] {
  const container = viewer.parentElement
  return container
    ? Array.from(container.querySelectorAll(".berth-pdf-highlight"))
    : []
}

function findNotes(viewer: HTMLElement): Element[] {
  const container = viewer.parentElement
  return container
    ? Array.from(container.querySelectorAll(".berth-pdf-note-underline"))
    : []
}

describe("PdfHighlightLayer", () => {
  it("renders each rect in the overlay with page-relative pixel coords", async () => {
    const viewer = makeViewer([1])
    const highlight = createHighlight(
      1,
      [
        { x: 0.1, y: 0.2, w: 0.5, h: 0.03 },
        { x: 0.3, y: 0.9, w: 0.2, h: 0.01 },
      ],
      "quote",
      "green"
    )
    render(
      <PdfHighlightLayer
        highlights={[highlight]}
        viewerElement={viewer}
        scale={1}
        onHighlightClick={() => {}}
      />
    )
    await waitFor(() => expect(findRects(viewer)).toHaveLength(2))
    const rects = findRects(viewer)
    expect(rects).toHaveLength(2)
    const [first, second] = Array.from(rects)
    expect(first).toHaveStyle({
      left: "200px",
      top: "600px",
      width: "500px",
      height: "60px",
    })
    expect(second).toHaveStyle({
      left: "400px",
      top: "2000px",
      width: "200px",
      height: "20px",
    })
  })

  it("merges word fragments on the same line into a single continuous highlight block", async () => {
    const viewer = makeViewer([1])
    // Two fragments on same line (y=0.2): "We" (x: 0.1..0.2) and "present" (x: 0.25..0.45)
    const highlight = createHighlight(
      1,
      [
        { x: 0.1, y: 0.2, w: 0.1, h: 0.03 },
        { x: 0.25, y: 0.2, w: 0.2, h: 0.03 },
      ],
      "We present",
      "yellow"
    )
    render(
      <PdfHighlightLayer
        highlights={[highlight]}
        viewerElement={viewer}
        scale={1}
        onHighlightClick={() => {}}
      />
    )
    await waitFor(() => expect(findRects(viewer)).toHaveLength(1))
    const [mergedBlock] = findRects(viewer)
    // Spans continuously from 0.1 (left: 200px) to 0.45 (width: 350px = 0.35 * 1000)
    expect(mergedBlock).toHaveStyle({
      left: "200px",
      top: "600px",
      width: "350px",
      height: "60px",
    })
  })

  it("uses the highlight color and defaults to yellow", async () => {
    const viewer = makeViewer([1])
    const green = createHighlight(1, [{ x: 0, y: 0, w: 1, h: 1 }], "q", "green")
    const none = createHighlight(1, [{ x: 0, y: 0, w: 1, h: 1 }], "q")
    render(
      <PdfHighlightLayer
        highlights={[green, none]}
        viewerElement={viewer}
        scale={1}
        onHighlightClick={() => {}}
      />
    )
    await waitFor(() => expect(findRects(viewer)).toHaveLength(2))
    const rects = findRects(viewer)
    expect(rects[0]).toHaveStyle({ backgroundColor: "#86efac" })
    expect(rects[1]).toHaveStyle({ backgroundColor: "#fcd34d" })
  })

  it("skips pages not mounted yet (lazy render)", () => {
    const viewer = makeViewer([1])
    const highlight = createHighlight(
      2,
      [{ x: 0, y: 0, w: 1, h: 1 }],
      "later page"
    )
    render(
      <PdfHighlightLayer
        highlights={[highlight]}
        viewerElement={viewer}
        scale={1}
        onHighlightClick={() => {}}
      />
    )
    expect(findRects(viewer)).toHaveLength(0)
  })

  it("paints highlights after the page mounts via MutationObserver", async () => {
    const viewer = makeViewer([1])
    const highlight = createHighlight(
      2,
      [{ x: 0.25, y: 0.5, w: 0.4, h: 0.1 }],
      "later page"
    )
    render(
      <PdfHighlightLayer
        highlights={[highlight]}
        viewerElement={viewer}
        scale={1}
        onHighlightClick={() => {}}
      />
    )
    expect(findRects(viewer)).toHaveLength(0)

    const page2 = document.createElement("div")
    page2.setAttribute("data-page-number", "2")
    setBox(page2, PDF_BOX)
    act(() => viewer.appendChild(page2))

    await waitFor(() => {
      const rects = findRects(viewer)
      expect(rects).toHaveLength(1)
      expect(rects[0]).toHaveStyle({ left: "350px", top: "1200px" })
    })
  })

  it("recomputes when highlights are added without a page mutation", async () => {
    const viewer = makeViewer([1])
    const { rerender } = render(
      <PdfHighlightLayer
        highlights={[]}
        viewerElement={viewer}
        scale={1}
        onHighlightClick={() => {}}
      />
    )
    const highlight = createHighlight(
      1,
      [{ x: 0.1, y: 0.2, w: 0.5, h: 0.03 }],
      "new highlight"
    )

    rerender(
      <PdfHighlightLayer
        highlights={[highlight]}
        viewerElement={viewer}
        scale={1}
        onHighlightClick={() => {}}
      />
    )

    await waitFor(() => expect(findRects(viewer)).toHaveLength(1))
  })

  it("keeps positions anchored to the overlay while scrolling", async () => {
    const viewer = makeViewer([1])
    const highlight = createHighlight(
      1,
      [{ x: 0.1, y: 0.2, w: 0.5, h: 0.03 }],
      "scrolling highlight"
    )
    render(
      <PdfHighlightLayer
        highlights={[highlight]}
        viewerElement={viewer}
        scale={1}
        onHighlightClick={() => {}}
      />
    )
    await waitFor(() => expect(findRects(viewer)).toHaveLength(1))

    const container = viewer.parentElement
    const page = viewer.querySelector('[data-page-number="1"]')
    const overlay = container?.querySelector<HTMLElement>(
      ".berth-pdf-highlight-layer"
    )
    if (!container || !page || !overlay) {
      throw new Error("PDF highlight test surface is incomplete")
    }

    let scrollOffset = 0
    const pageRect = vi.fn(() =>
      toDomRect({ ...PDF_BOX, top: PDF_BOX.top - scrollOffset })
    )
    const overlayRect = vi.fn(() =>
      toDomRect({ ...PDF_BOX, top: PDF_BOX.top - scrollOffset })
    )
    page.getBoundingClientRect = pageRect
    overlay.getBoundingClientRect = overlayRect
    const pageRectCallsBeforeScroll = pageRect.mock.calls.length

    act(() => {
      scrollOffset = 800
      fireEvent.scroll(container)
    })

    await waitFor(() => {
      expect(pageRect.mock.calls.length).toBeGreaterThan(
        pageRectCallsBeforeScroll
      )
      expect(findRects(viewer)[0]).toHaveStyle({ top: "400px" })
    })
  })

  it("calls onHighlightClick when a rect is clicked", async () => {
    const viewer = makeViewer([1])
    const highlight = createHighlight(
      1,
      [{ x: 0, y: 0, w: 1, h: 1 }],
      "click me"
    )
    const onClick = vi.fn()
    render(
      <PdfHighlightLayer
        highlights={[highlight]}
        viewerElement={viewer}
        scale={1}
        onHighlightClick={onClick}
      />
    )
    await waitFor(() => expect(findRects(viewer)).toHaveLength(1))
    const rect = findRects(viewer)[0]
    fireEvent.click(rect)
    expect(onClick).toHaveBeenCalledTimes(1)
    expect(onClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: highlight.id }),
      expect.anything()
    )
  })

  it("renders note underlines at the bottom of the text line and allows coexistence with highlights", async () => {
    const viewer = makeViewer([1])
    const highlight = createHighlight(
      1,
      [{ x: 0.1, y: 0.2, w: 0.5, h: 0.03 }],
      "highlighted text",
      "yellow"
    )
    const note = createNote(
      1,
      [{ x: 0.1, y: 0.2, w: 0.5, h: 0.03 }],
      "highlighted text",
      "my comment"
    )
    const onNoteClick = vi.fn()
    const onHighlightClick = vi.fn()

    render(
      <PdfHighlightLayer
        highlights={[highlight, note]}
        viewerElement={viewer}
        scale={1}
        onHighlightClick={onHighlightClick}
        onNoteClick={onNoteClick}
      />
    )

    await waitFor(() => {
      expect(findRects(viewer)).toHaveLength(1)
      expect(findNotes(viewer)).toHaveLength(1)
    })

    const noteElement = findNotes(viewer)[0]
    // left: 200px (0.1 * 1000 + 100 - 100), top: 661px (200 + 0.23 * 2000 + 1), height: 2px, width: 500px
    expect(noteElement).toHaveStyle({
      left: "200px",
      top: "661px",
      width: "500px",
      height: "2px",
    })

    fireEvent.click(noteElement)
    expect(onNoteClick).toHaveBeenCalledTimes(1)
    expect(onNoteClick).toHaveBeenCalledWith(
      expect.objectContaining({ id: note.id, comment: "my comment" }),
      expect.anything()
    )
    expect(onHighlightClick).not.toHaveBeenCalled()
  })

  it("calls onDeleteHighlight when Backspace or Delete key is pressed on a highlight element", async () => {
    const viewer = makeViewer([1])
    const highlight = createHighlight(
      1,
      [{ x: 0.1, y: 0.2, w: 0.5, h: 0.03 }],
      "quote",
      "yellow"
    )
    const onDeleteHighlight = vi.fn()
    render(
      <PdfHighlightLayer
        highlights={[highlight]}
        viewerElement={viewer}
        scale={1}
        onDeleteHighlight={onDeleteHighlight}
      />
    )
    await waitFor(() => expect(findRects(viewer)).toHaveLength(1))
    const highlightEl = findRects(viewer)[0]
    fireEvent.keyDown(highlightEl, { key: "Backspace" })
    expect(onDeleteHighlight).toHaveBeenCalledTimes(1)
    expect(onDeleteHighlight).toHaveBeenCalledWith(highlight.id)

    fireEvent.keyDown(highlightEl, { key: "Delete" })
    expect(onDeleteHighlight).toHaveBeenCalledTimes(2)
  })

  it("unmounts cleanly when the viewer element disappears", () => {
    const viewer = makeViewer([1])
    const highlight = createHighlight(1, [{ x: 0, y: 0, w: 1, h: 1 }], "q")
    const { unmount } = render(
      <PdfHighlightLayer
        highlights={[highlight]}
        viewerElement={viewer}
        scale={1}
        onHighlightClick={() => {}}
      />
    )
    expect(() => unmount()).not.toThrow()
  })
})
