import { describe, expect, it, vi } from "vitest"
import { paneAtPoint } from "./workspace-tab-drag-hit-test"

function el(
  tag: string,
  attrs: Record<string, string> = {},
  children: Element[] = []
): HTMLElement {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    node.setAttribute(key, value)
  }
  for (const child of children) node.appendChild(child)
  return node
}

describe("paneAtPoint", () => {
  it("resolves content hosts", () => {
    const host = el("div", {
      "data-workspace-pane": "files",
      "data-workspace-content-pane": "",
    })
    const doc = {
      elementsFromPoint: vi.fn(() => [host]),
      elementFromPoint: vi.fn(() => host),
    } as unknown as Document

    expect(paneAtPoint(10, 10, doc)).toBe("files")
  })

  it("walks past tauri drag regions to the parent pane", () => {
    const pane = el("div", { "data-workspace-pane": "files" }, [
      el("div", { "data-tauri-drag-region": "" }),
    ])
    const drag = pane.firstElementChild as HTMLElement
    const doc = {
      elementsFromPoint: vi.fn(() => [drag, pane]),
      elementFromPoint: vi.fn(() => drag),
    } as unknown as Document

    expect(paneAtPoint(10, 10, doc)).toBe("files")
  })

  it("prefers explicit drop targets", () => {
    const pane = el("div", { "data-workspace-pane": "conversation" }, [
      el("div", { "data-workspace-tab-drop-target": "" }),
    ])
    const drop = pane.firstElementChild as HTMLElement
    const doc = {
      elementsFromPoint: vi.fn(() => [drop, pane]),
      elementFromPoint: vi.fn(() => drop),
    } as unknown as Document

    expect(paneAtPoint(10, 10, doc)).toBe("conversation")
  })

  it("skips dragged tab chrome so the target pane underneath wins", () => {
    const files = el("div", { "data-workspace-pane": "files" })
    const tab = el("div", {
      "data-tab-item": "",
      "data-workspace-pane": "conversation",
    })
    const doc = {
      elementsFromPoint: vi.fn(() => [tab, files]),
      elementFromPoint: vi.fn(() => tab),
    } as unknown as Document

    expect(paneAtPoint(10, 10, doc)).toBe("files")
  })

  it("returns null when nothing under the point is a pane", () => {
    const chrome = el("div", { "data-tauri-drag-region": "" })
    const doc = {
      elementsFromPoint: vi.fn(() => [chrome]),
      elementFromPoint: vi.fn(() => chrome),
    } as unknown as Document

    expect(paneAtPoint(10, 10, doc)).toBeNull()
  })

  it("turns the right third of an unsplit main area into a split target", () => {
    const host = el("div", {
      "data-workspace-pane": "files",
      "data-workspace-split-zone": "",
    })
    host.getBoundingClientRect = () =>
      ({ left: 0, width: 300, top: 0, height: 100 }) as DOMRect
    const doc = {
      elementsFromPoint: vi.fn(() => [host]),
      elementFromPoint: vi.fn(() => host),
    } as unknown as Document

    expect(paneAtPoint(150, 50, doc)).toBe("files")
    expect(paneAtPoint(250, 50, doc)).toBe("files-split")
  })
})
