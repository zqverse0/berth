import { describe, expect, it, vi, afterEach } from "vitest"
import {
  capturePdfSelectionGeometry,
  findPageElement,
  mergePdfSelectionRects,
  normalizeRectToPage,
  rectWithinPage,
  type PdfSelectionGeometry,
} from "./pdf-selection-geometry"

afterEach(() => {
  vi.restoreAllMocks()
})

function makePage(
  pageNumber: number,
  box: { left: number; top: number; width: number; height: number }
) {
  const el = document.createElement("div")
  el.setAttribute("data-page-number", String(pageNumber))
  el.getBoundingClientRect = () =>
    ({
      left: box.left,
      top: box.top,
      right: box.left + box.width,
      bottom: box.top + box.height,
      width: box.width,
      height: box.height,
      x: box.left,
      y: box.top,
      toJSON: () => ({}),
    }) as DOMRect
  return el
}

describe("normalizeRectToPage", () => {
  const pageBox = { left: 10, top: 20, width: 500, height: 700 }

  it("normalizes client rect to 0-1 page coords", () => {
    expect(
      normalizeRectToPage(
        { left: 60, top: 90, width: 100, height: 14 },
        pageBox
      )
    ).toEqual({ x: 0.1, y: 0.1, w: 0.2, h: 0.02 })
  })

  it("returns null for zero-size page or rect", () => {
    expect(
      normalizeRectToPage({ left: 0, top: 0, width: 0, height: 10 }, pageBox)
    ).toBeNull()
    expect(
      normalizeRectToPage(
        { left: 0, top: 0, width: 10, height: 0 },
        { left: 0, top: 0, width: 0, height: 0 }
      )
    ).toBeNull()
  })
})

describe("rectWithinPage", () => {
  const pageBox = { left: 0, top: 0, width: 500, height: 700 }

  it("accepts rects that overlap the page box", () => {
    expect(
      rectWithinPage(
        {
          left: 100,
          top: 100,
          right: 200,
          bottom: 150,
          width: 100,
          height: 50,
        },
        pageBox
      )
    ).toBe(true)
  })

  it("rejects empty or fully outside rects", () => {
    expect(
      rectWithinPage(
        { left: 100, top: 100, right: 100, bottom: 150, width: 0, height: 50 },
        pageBox
      )
    ).toBe(false)
    expect(
      rectWithinPage(
        {
          left: 1000,
          top: 1000,
          right: 1100,
          bottom: 1100,
          width: 100,
          height: 100,
        },
        pageBox
      )
    ).toBe(false)
  })
})

describe("findPageElement", () => {
  it("uses elementFromPoint and climbs to the page element", () => {
    const viewer = document.createElement("div")
    const page = makePage(3, { left: 0, top: 0, width: 500, height: 700 })
    const span = document.createElement("span")
    span.textContent = "text"
    page.appendChild(span)
    viewer.appendChild(page)
    document.body.appendChild(viewer)

    vi.spyOn(document, "elementFromPoint").mockReturnValue(span)
    expect(findPageElement(viewer, 250, 350)).toBe(page)
    document.body.removeChild(viewer)
  })

  it("returns null when the hit is outside the viewer and point is outside all pages", () => {
    const viewer = document.createElement("div")
    const page = makePage(1, { left: 0, top: 0, width: 500, height: 700 })
    viewer.appendChild(page)
    document.body.appendChild(viewer)

    const outside = document.createElement("div")
    document.body.appendChild(outside)
    vi.spyOn(document, "elementFromPoint").mockReturnValue(outside)
    // 点 (5000, 5000) 不在任何页面 box 内 → 回退扫描也找不到 → null
    expect(findPageElement(viewer, 5000, 5000)).toBeNull()
    document.body.removeChild(viewer)
    document.body.removeChild(outside)
  })

  it("falls back to page scan when elementFromPoint hits outside the viewer", () => {
    const viewer = document.createElement("div")
    const page = makePage(1, { left: 0, top: 0, width: 500, height: 700 })
    viewer.appendChild(page)
    document.body.appendChild(viewer)

    const outside = document.createElement("div")
    document.body.appendChild(outside)
    vi.spyOn(document, "elementFromPoint").mockReturnValue(outside)
    // 点 (250, 350) 在 page1 box 内 → 回退扫描返回 page1
    expect(findPageElement(viewer, 250, 350)).toBe(page)
    document.body.removeChild(viewer)
    document.body.removeChild(outside)
  })

  it("falls back to containing-page scan when elementFromPoint misses", () => {
    const viewer = document.createElement("div")
    const page1 = makePage(1, { left: 0, top: 0, width: 500, height: 700 })
    const page2 = makePage(2, { left: 0, top: 700, width: 500, height: 700 })
    viewer.appendChild(page1)
    viewer.appendChild(page2)
    document.body.appendChild(viewer)

    vi.spyOn(document, "elementFromPoint").mockReturnValue(null)
    expect(findPageElement(viewer, 250, 1050)).toBe(page2)
    document.body.removeChild(viewer)
  })
})

describe("capturePdfSelectionGeometry", () => {
  function makeViewerWithPages() {
    const viewer = document.createElement("div")
    const page1 = makePage(1, { left: 0, top: 0, width: 500, height: 700 })
    const page2 = makePage(2, { left: 0, top: 700, width: 500, height: 700 })
    viewer.appendChild(page1)
    viewer.appendChild(page2)
    document.body.appendChild(viewer)
    return { viewer, page1, page2 }
  }

  function mockSelection(range: Range | null, text: string) {
    const selection = {
      isCollapsed: false,
      rangeCount: range ? 1 : 0,
      getRangeAt: () => range,
      toString: () => text,
      removeAllRanges: () => {},
      addRange: () => {},
    } as unknown as Selection
    vi.spyOn(window, "getSelection").mockReturnValue(selection)
    return selection
  }

  function makeRange(start: Node, rects: Partial<DOMRect>[]) {
    const range = {
      commonAncestorContainer: start,
      getClientRects: () =>
        rects.map((rect) => ({
          ...rect,
          toJSON: () => ({}),
        })) as unknown as DOMRectList,
      getBoundingClientRect: () =>
        ({ left: 0, top: 0, width: 0, height: 0 }) as DOMRect,
    } as unknown as Range
    return range
  }

  it("captures selection geometry grouped by page", () => {
    const { viewer, page1, page2 } = makeViewerWithPages()
    const range = makeRange(page1, [
      { left: 50, top: 70, right: 250, bottom: 84, width: 200, height: 14 },
      { left: 50, top: 770, right: 250, bottom: 784, width: 200, height: 14 },
    ])
    mockSelection(range, "quoted text")
    vi.spyOn(document, "elementFromPoint").mockImplementation((_x, y) => {
      if (y < 700) return page1
      return page2
    })

    const result = capturePdfSelectionGeometry(viewer)
    expect(result).not.toBeNull()
    const geometry = result as PdfSelectionGeometry
    expect(geometry.quote).toBe("quoted text")
    expect(geometry.pages.get(1)).toEqual([{ x: 0.1, y: 0.1, w: 0.4, h: 0.02 }])
    expect(geometry.pages.get(2)).toEqual([{ x: 0.1, y: 0.1, w: 0.4, h: 0.02 }])
    document.body.removeChild(viewer)
  })

  it("returns null for empty or collapsed selection", () => {
    const { viewer } = makeViewerWithPages()
    mockSelection(null, "")
    expect(capturePdfSelectionGeometry(viewer)).toBeNull()

    const collapsed = {
      isCollapsed: true,
      rangeCount: 0,
      toString: () => "",
    } as unknown as Selection
    vi.spyOn(window, "getSelection").mockReturnValue(collapsed)
    expect(capturePdfSelectionGeometry(viewer)).toBeNull()
    document.body.removeChild(viewer)
  })

  it("returns null when selection is outside the viewer", () => {
    const { viewer } = makeViewerWithPages()
    const outside = document.createElement("div")
    const range = makeRange(outside, [
      { left: 50, top: 70, width: 200, height: 14 },
    ])
    mockSelection(range, "outside text")
    vi.spyOn(document, "elementFromPoint").mockReturnValue(outside)
    expect(capturePdfSelectionGeometry(viewer)).toBeNull()
    document.body.removeChild(viewer)
  })

  it("merges word fragments across spaces on the same line into one continuous rect", () => {
    const { viewer, page1 } = makeViewerWithPages()
    // "We" (x: 50..100), gap (100..120), "present" (120..200) on page 1 at top: 70..84
    const range = makeRange(page1, [
      { left: 50, top: 70, right: 100, bottom: 84, width: 50, height: 14 },
      { left: 120, top: 70, right: 200, bottom: 84, width: 80, height: 14 },
    ])
    mockSelection(range, "We present")
    vi.spyOn(document, "elementFromPoint").mockReturnValue(page1)

    const result = capturePdfSelectionGeometry(viewer)
    expect(result).not.toBeNull()
    const geometry = result as PdfSelectionGeometry
    expect(geometry.quote).toBe("We present")
    // Merged into single rect from x: 50 to 200 (page width 500 => x: 0.1, w: 0.3)
    expect(geometry.pages.get(1)).toEqual([{ x: 0.1, y: 0.1, w: 0.3, h: 0.02 }])
    document.body.removeChild(viewer)
  })
})

describe("mergePdfSelectionRects", () => {
  it("joins same-line fragments across spaces and keeps line breaks separate", () => {
    const merged = mergePdfSelectionRects([
      { x: 0.1, y: 0.2, w: 0.2, h: 0.03 },
      { x: 0.35, y: 0.2, w: 0.25, h: 0.03 },
      { x: 0.1, y: 0.25, w: 0.2, h: 0.03 },
    ])
    expect(merged).toHaveLength(2)
    expect(merged[0]).toEqual({ x: 0.1, y: 0.2, w: 0.5, h: 0.03 })
    expect(merged[1]!.y).toBeCloseTo(0.25)
  })
})
