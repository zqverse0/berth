import "@testing-library/jest-dom/vitest"

// jsdom doesn't implement a few layout APIs that ProseMirror's EditorView
// touches on mount (used by Tiptap-based editors such as the message composer).
// Polyfill them as no-ops so headless/component editor tests can construct a
// view. Only defined when missing, so real browsers/environments are untouched.
if (typeof document !== "undefined" && !document.elementFromPoint) {
  document.elementFromPoint = () => null
}
if (typeof globalThis !== "undefined" && typeof PointerEvent === "undefined") {
  // jsdom 还不实现 PointerEvent；pointer 适配器用 pointerdown 取选区。
  class PointerEventPolyfill extends MouseEvent {
    pointerId: number
    constructor(
      type: string,
      init: MouseEventInit & { pointerId?: number } = {}
    ) {
      super(type, init)
      this.pointerId = init.pointerId ?? 1
    }
  }
  ;(
    globalThis as unknown as { PointerEvent?: typeof PointerEvent }
  ).PointerEvent = PointerEventPolyfill as unknown as typeof PointerEvent
}
if (typeof Element !== "undefined") {
  // jsdom doesn't implement scrollIntoView; the composer's suggestion popup
  // calls it to keep the active row visible.
  Element.prototype.scrollIntoView ??= () => {}
  // jsdom doesn't implement Pointer Capture; Radix menus/popovers touch these
  // during the pointer interactions @testing-library/user-event drives.
  Element.prototype.hasPointerCapture ??= () => false
  Element.prototype.setPointerCapture ??= () => {}
  Element.prototype.releasePointerCapture ??= () => {}
}
if (typeof globalThis !== "undefined" && !("ResizeObserver" in globalThis)) {
  // jsdom doesn't implement ResizeObserver; cmdk (the command palette used by
  // the branch/folder pickers) constructs one on mount. A no-op stub is enough
  // for headless rendering — layout callbacks never need to fire.
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
}
if (typeof Range !== "undefined") {
  Range.prototype.getClientRects ??= () =>
    ({
      length: 0,
      item: () => null,
      [Symbol.iterator]: function* () {},
    }) as unknown as DOMRectList
  Range.prototype.getBoundingClientRect ??= () =>
    ({
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
      x: 0,
      y: 0,
    }) as DOMRect
}
