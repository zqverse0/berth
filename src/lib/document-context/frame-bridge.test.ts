import { beforeAll, describe, expect, it } from "vitest"
import {
  DOCUMENT_CONTEXT_BRIDGE_SCRIPT,
  DOCUMENT_FRAME_CONTEXT_MESSAGE,
  parseDocumentFrameContextMessage,
} from "./frame-bridge"

describe("parseDocumentFrameContextMessage", () => {
  it("accepts bounded HTML preview messages", () => {
    const message = parseDocumentFrameContextMessage({
      type: DOCUMENT_FRAME_CONTEXT_MESSAGE,
      event: "selection",
      generation: "page-1",
      url: "about:srcdoc",
      text: "selected",
      content: "full document",
    })

    expect(message).toMatchObject({
      event: "selection",
      generation: "page-1",
      url: "about:srcdoc",
      text: "selected",
      content: "full document",
    })
  })

  it("rejects malformed or non-web frame URLs", () => {
    expect(
      parseDocumentFrameContextMessage({
        type: DOCUMENT_FRAME_CONTEXT_MESSAGE,
        event: "selection",
        url: "file:///tmp/a.html",
        text: "selected",
      })
    ).toBeNull()
    expect(
      parseDocumentFrameContextMessage({
        type: DOCUMENT_FRAME_CONTEXT_MESSAGE,
        event: "selection",
        generation: "page-1",
        url: "https://example.test",
        text: "",
      })
    ).toBeNull()
  })

  it("clips large payloads before they reach the context provider", () => {
    const message = parseDocumentFrameContextMessage({
      type: DOCUMENT_FRAME_CONTEXT_MESSAGE,
      event: "document",
      generation: "page-1",
      url: "https://example.test",
      content: "x".repeat(600_000),
    })

    expect(message?.content).toHaveLength(512 * 1024)
  })
})

describe("DOCUMENT_CONTEXT_BRIDGE_SCRIPT element context", () => {
  // The bridge installs once per window, so one DOM + one install serve all
  // cases. jsdom: window.parent === window, so the bridge posts to us.
  const messages: Record<string, unknown>[] = []
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  const last = () => messages[messages.length - 1]
  const byId = (id: string) => document.getElementById(id)!
  const select = (from: string, to = from) => {
    const range = document.createRange()
    range.setStartBefore(byId(from).firstChild!)
    range.setEndAfter(byId(to).firstChild!)
    window.getSelection()!.removeAllRanges()
    window.getSelection()!.addRange(range)
  }
  const click = (id: string, init: MouseEventInit = {}) => {
    window.getSelection()!.removeAllRanges()
    byId(id).dispatchEvent(
      new MouseEvent("click", { bubbles: true, button: 0, ...init })
    )
  }

  beforeAll(() => {
    document.body.innerHTML = [
      '<div data-path="/slide[1]/shape[@id=12]"><p><span id="t">组会汇报</span></p></div>',
      '<p data-path="/body/p[1]"><span id="p1">第一段</span></p>',
      '<p data-path="/body/p[2]"><span id="p2">第二段</span></p>',
      '<div data-path="/slide[1]/picture[@id=2]" id="pic"></div>',
      "<table><tr>",
      '<td data-path="/Sheet1/A1" id="a1">1</td><td data-path="/Sheet1/B1" id="b1">2</td>',
      '</tr><tr><td data-path="/Sheet1/A2" id="a2">3</td><td data-path="/Sheet1/B2" id="b2">4</td>',
      "</tr></table>",
    ].join("")
    window.addEventListener("message", (event) => {
      messages.push(event.data as Record<string, unknown>)
    })
    ;(window as unknown as Record<string, unknown>).__BERTH_ELEMENT_PICK__ =
      true
    // Bind globals as params so late MutationObserver callbacks survive env teardown.
    new Function("window", "document", DOCUMENT_CONTEXT_BRIDGE_SCRIPT)(
      window,
      document
    )
  })

  it("reports the enclosing element path with a text selection", async () => {
    select("t")
    document.dispatchEvent(new MouseEvent("mouseup"))
    await tick()
    expect(
      parseDocumentFrameContextMessage({ ...last(), url: "about:srcdoc" })
    ).toMatchObject({
      event: "selection",
      text: "组会汇报",
      dataPaths: ["/slide[1]/shape[@id=12]"],
    })
  })

  it("reports every touched element when a selection spans paragraphs", async () => {
    select("p1", "p2")
    document.dispatchEvent(new MouseEvent("mouseup"))
    await tick()
    expect(last()).toMatchObject({
      dataPaths: ["/body/p[1]", "/body/p[2]"],
    })
  })

  it("intercepts the native menu for a text selection", () => {
    select("t")
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    })
    byId("t").dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
  })

  it("picks elements by click and adds with Ctrl+click", async () => {
    click("pic")
    await tick()
    expect(last()).toMatchObject({
      event: "selection",
      text: "[/slide[1]/picture[@id=2]]",
      dataPaths: ["/slide[1]/picture[@id=2]"],
    })
    click("t", { ctrlKey: true })
    await tick()
    expect(last()).toMatchObject({
      dataPaths: ["/slide[1]/picture[@id=2]", "/slide[1]/shape[@id=12]"],
    })
  })

  it("picks a sheet range with Shift+click", async () => {
    click("b2")
    click("a1", { shiftKey: true })
    await tick()
    expect(last()).toMatchObject({
      text: "1\t2\n3\t4",
      dataPaths: ["/Sheet1/A1:B2"],
    })
  })

  it("draws host-sent officecli marks and reveals a path", async () => {
    const scrolled: string[] = []
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.getAttribute("data-path") ?? this.id)
    }
    // jsdom leaves MessageEvent.source empty on postMessage; the bridge only
    // trusts its parent window (=== window here), so dispatch explicitly.
    const fromHost = (data: unknown) =>
      window.dispatchEvent(
        new MessageEvent("message", { data, source: window })
      )
    fromHost({
      type: "berth:preview-view",
      marks: [
        {
          path: "/body/p[2]",
          color: "red",
          note: "换个词",
          find: "第二",
          tofix: "次",
        },
        { path: "/missing", note: "ignored" },
      ],
      revealPath: "/body/p[2]",
    })
    await tick()
    await new Promise((resolve) => setTimeout(resolve, 30))
    const notes = Array.from(
      document.querySelectorAll("[data-berth-note]"),
      (box) => box.getAttribute("data-berth-note")
    )
    // Collapsed to the mark number until the element is hovered.
    expect(notes).toEqual(["1"])
    expect(scrolled).toEqual(["/body/p[2]"])
    byId("p2").dispatchEvent(new MouseEvent("mousemove", { bubbles: true }))
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(
      document
        .querySelector("[data-berth-note]")
        ?.getAttribute("data-berth-note")
    ).toBe("1 · 换个词 「第二」 → 「次」")

    // A later empty list clears the marks.
    fromHost({ type: "berth:preview-view", marks: [] })
    await tick()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(document.querySelectorAll("[data-berth-note]")).toHaveLength(0)
  })

  it("right-click on an element without text selection sends its path", async () => {
    window.getSelection()!.removeAllRanges()
    const event = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: 5,
      clientY: 6,
    })
    byId("p1").dispatchEvent(event)
    await tick()
    expect(event.defaultPrevented).toBe(true)
    expect(last()).toMatchObject({
      event: "contextmenu",
      text: "第一段",
      dataPaths: ["/body/p[1]"],
      clientX: 5,
      clientY: 6,
    })
  })
})

describe("DOCUMENT_CONTEXT_BRIDGE_SCRIPT source-line picking", () => {
  // HTML previews: a separate frame window, since the bridge installs once
  // per window and the suite above already configured Office picking.
  const messages: Record<string, unknown>[] = []
  let win: Window & typeof globalThis
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  const last = () => messages[messages.length - 1]
  const byId = (id: string) => win.document.getElementById(id)!
  const click = (id: string) => {
    win.getSelection()!.removeAllRanges()
    const event = new win.MouseEvent("click", {
      bubbles: true,
      cancelable: true,
      button: 0,
    })
    byId(id).dispatchEvent(event)
    return event
  }
  const fromHost = (data: unknown) =>
    win.dispatchEvent(
      new win.MessageEvent("message", { data, source: win.parent })
    )

  beforeAll(() => {
    const frame = document.createElement("iframe")
    document.body.appendChild(frame)
    win = frame.contentWindow as Window & typeof globalThis
    win.document.body.innerHTML = [
      '<p data-berth-line="3"><span id="s">hi</span></p>',
      '<button data-berth-line="4" id="a">go</button>',
      '<section data-berth-line="5" id="sec"><b data-berth-line="6">x</b><i data-berth-line="8">y</i></section>',
      '<div><p data-berth-line="20" id="q1">aa</p><p data-berth-line="21" id="q2">bb</p></div>',
    ].join("")
    // jsdom leaves MessageEvent.source empty; tell frames apart by URL.
    window.addEventListener("message", (event) => {
      if (event.data?.url === win.location.href) messages.push(event.data)
    })
    // Real previews set this in <head>, before the bridge's deferred setup.
    ;(win as unknown as Record<string, unknown>).__BERTH_ELEMENT_PICK__ = {
      attr: "data-berth-line",
      lines: true,
      toggle: true,
    }
    new Function("window", "document", DOCUMENT_CONTEXT_BRIDGE_SCRIPT)(
      win,
      win.document
    )
  })

  it("reports source lines with a text selection while picking is off", async () => {
    const range = win.document.createRange()
    range.selectNodeContents(byId("s"))
    win.getSelection()!.removeAllRanges()
    win.getSelection()!.addRange(range)
    win.document.dispatchEvent(new win.MouseEvent("mouseup"))
    await tick()
    expect(last()).toMatchObject({ event: "selection", dataPaths: ["3"] })
  })

  it("ignores an element the selection only touches at its start", async () => {
    // Triple-click shape: the range ends at offset 0 inside the next element.
    const range = win.document.createRange()
    range.setStart(byId("q1").firstChild!, 0)
    range.setEnd(byId("q2").firstChild!, 0)
    win.getSelection()!.removeAllRanges()
    win.getSelection()!.addRange(range)
    win.document.dispatchEvent(new win.MouseEvent("mouseup"))
    await tick()
    expect(last()).toMatchObject({ event: "selection", dataPaths: ["20"] })
  })

  it("reveals and briefly flashes the element at or before a line", async () => {
    const scrolled: Element[] = []
    const proto = win.Element.prototype
    const originalRect = proto.getBoundingClientRect
    proto.scrollIntoView = function (this: Element) {
      scrolled.push(this)
    }
    // jsdom has no layout; the bridge hides zero-size boxes.
    proto.getBoundingClientRect = () =>
      ({ left: 0, top: 0, right: 10, bottom: 10 }) as DOMRect
    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))
    const flashBoxes = () =>
      Array.from(win.document.querySelectorAll("div")).filter(
        (box) =>
          box.style.display === "block" &&
          box.style.background.includes("245, 158, 11")
      )
    try {
      fromHost({ type: "berth:preview-view", revealLine: 7 })
      expect(scrolled.map((el) => el.getAttribute("data-berth-line"))).toEqual([
        "6",
      ])
      await wait(40)
      expect(flashBoxes()).toHaveLength(1)
      await wait(1600)
      expect(flashBoxes()).toHaveLength(0)
    } finally {
      proto.getBoundingClientRect = originalRect
    }
  })

  it("leaves page clicks alone until the host turns picking on", async () => {
    const count = messages.length
    expect(click("a").defaultPrevented).toBe(false)
    await tick()
    expect(messages).toHaveLength(count)
  })

  it("picks an element's line range and blocks the page click when on", async () => {
    fromHost({ type: "berth:preview-view", pick: true })
    expect(click("sec").defaultPrevented).toBe(true)
    await tick()
    expect(last()).toMatchObject({ event: "selection", dataPaths: ["5-8"] })

    fromHost({ type: "berth:preview-view", pick: false })
    expect(click("a").defaultPrevented).toBe(false)
  })
})
