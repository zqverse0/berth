import { afterEach, beforeAll, describe, expect, it } from "vitest"

import {
  applyPdfCaretRange,
  bindPdfReadingSelection,
  caretFromPointInPdfTextLayer,
  pdfTextLayerFromNode,
} from "./pdf-reading-selection"

type Box = { left: number; top: number; width: number; height: number }
const stubbed = new WeakMap<Element, Box>()

function stubBox(element: HTMLElement, box: Box) {
  stubbed.set(element, box)
  element.getBoundingClientRect = () =>
    ({
      x: box.left,
      y: box.top,
      left: box.left,
      top: box.top,
      right: box.left + box.width,
      bottom: box.top + box.height,
      width: box.width,
      height: box.height,
      toJSON() {
        return this
      },
    }) as DOMRect
}

/** jsdom 不排版：按 span 的 data-widths（缺省等分）给出字符矩形。 */
beforeAll(() => {
  Range.prototype.getBoundingClientRect = function (this: Range) {
    const span = this.startContainer.parentElement!
    const box = stubbed.get(span)!
    const length = span.textContent?.length ?? 1
    const widths =
      span.dataset.widths?.split(",").map(Number) ??
      Array.from({ length }, () => box.width / length)
    const sum = (end: number) =>
      widths.slice(0, end).reduce((total, width) => total + width, 0)
    const left = box.left + sum(this.startOffset)
    const right = box.left + sum(this.endOffset)
    return {
      left,
      right,
      top: box.top,
      bottom: box.top + box.height,
      width: right - left,
      height: box.height,
    } as DOMRect
  }
})

function spanAt(
  left: number,
  top: number,
  text: string,
  size: { width: number; height: number } = { width: 40, height: 12 }
) {
  const span = document.createElement("span")
  span.textContent = text
  stubBox(span, { left, top, ...size })
  return span
}

function mountLayer(spans: HTMLSpanElement[]) {
  const root = document.createElement("div")
  const layer = document.createElement("div")
  layer.className = "textLayer"
  stubBox(layer, { left: 0, top: 0, width: 200, height: 80 })
  for (const span of spans) layer.appendChild(span)
  root.appendChild(layer)
  document.body.appendChild(root)
  return { root, layer }
}

afterEach(() => {
  document.body.replaceChildren()
  window.getSelection()?.removeAllRanges()
})

describe("pdfTextLayerFromNode", () => {
  it("finds the text layer from a span", () => {
    const { layer } = mountLayer([spanAt(0, 0, "Hello")])
    expect(pdfTextLayerFromNode(layer.firstChild)).toBe(layer)
    expect(pdfTextLayerFromNode(document.body)).toBeNull()
  })
})

describe("caretFromPointInPdfTextLayer", () => {
  it("hits the visible span under the pointer, not a covering neighbor", () => {
    const overlapping = spanAt(0, 0, "XXXXXXXXXXXX", {
      width: 200,
      height: 40,
    })
    const visible = spanAt(8, 2, "Hi")
    const { root } = mountLayer([overlapping, visible])

    const caret = caretFromPointInPdfTextLayer(root, 12, 6)
    expect(caret?.node.textContent).toBe("Hi")
  })

  it("stays on the same visual line when the pointer is between words", () => {
    const first = spanAt(0, 0, "one")
    const second = spanAt(50, 0, "two")
    const otherLine = spanAt(0, 30, "three")
    const { root } = mountLayer([first, second, otherLine])

    const caret = caretFromPointInPdfTextLayer(root, 46, 6)
    expect(caret?.node.textContent).toBe("two")
  })
})

describe("caret offset inside a span", () => {
  it("follows real glyph widths, not an even split by character count", () => {
    // "iiW"：两个窄 i 各 2px，W 占 36px；x=10 落在 W 的左半边 → 偏移 2。
    const span = spanAt(0, 0, "iiW")
    span.dataset.widths = "2,2,36"
    const { root } = mountLayer([span])
    expect(caretFromPointInPdfTextLayer(root, 10, 6)?.offset).toBe(2)
    expect(caretFromPointInPdfTextLayer(root, 30, 6)?.offset).toBe(3)
    expect(caretFromPointInPdfTextLayer(root, 3.5, 6)?.offset).toBe(2)
  })
})

describe("applyPdfCaretRange", () => {
  it("selects only the ordered caret range", () => {
    const hello = spanAt(0, 0, "Hello")
    const world = spanAt(50, 0, "World")
    mountLayer([hello, world])
    const from = { node: hello.firstChild as Node, offset: 0 }
    const to = { node: world.firstChild as Node, offset: 5 }
    expect(applyPdfCaretRange(to, from)).toBe(true)
    expect(window.getSelection()?.toString()).toBe("HelloWorld")
  })
})

describe("bindPdfReadingSelection", () => {
  it("prevents native drag-select inside the text layer", () => {
    const hello = spanAt(0, 0, "Hello")
    const { root } = mountLayer([hello])
    const dispose = bindPdfReadingSelection(root)
    const event = new PointerEvent("pointerdown", {
      button: 0,
      clientX: 10,
      clientY: 6,
      bubbles: true,
      cancelable: true,
    })
    hello.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    dispose()
  })
})

describe("caretFromPointInPdfTextLayer while dragging", () => {
  it("snaps to the nearest line when the pointer is in line spacing", () => {
    const first = spanAt(0, 0, "one")
    const second = spanAt(0, 40, "two")
    const { root } = mountLayer([first, second])

    expect(caretFromPointInPdfTextLayer(root, 10, 30)).toBeNull()
    const caret = caretFromPointInPdfTextLayer(root, 10, 30, {
      nearestLine: true,
    })
    expect(caret?.node.textContent).toBe("two")
  })

  it("reuses measured span boxes from the drag cache", () => {
    const hello = spanAt(0, 0, "Hello")
    const { root } = mountLayer([hello])
    const cache = new WeakMap()
    caretFromPointInPdfTextLayer(root, 10, 6, { cache })
    hello.getBoundingClientRect = () => {
      throw new Error("span measured twice")
    }
    expect(
      caretFromPointInPdfTextLayer(root, 10, 6, { cache })?.node.textContent
    ).toBe("Hello")
  })
})

describe("applyPdfCaretRange end boundary", () => {
  it("never ends the range at offset 0 of a text node", () => {
    const hello = spanAt(0, 0, "Hello")
    const world = spanAt(0, 20, "World")
    mountLayer([hello, world])
    const from = { node: hello.firstChild as Node, offset: 1 }
    const to = { node: world.firstChild as Node, offset: 0 }
    expect(applyPdfCaretRange(from, to)).toBe(true)
    const range = window.getSelection()!.getRangeAt(0)
    expect(range.endContainer).toBe(hello.firstChild)
    expect(range.endOffset).toBe(5)
    expect(window.getSelection()?.toString()).toBe("ello")
  })
})
