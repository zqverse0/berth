import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { describe, expect, it } from "vitest"
import { createVisualRangeExtension } from "./visual-ranges"

describe("createVisualRangeExtension", () => {
  it("marks changed lines without changing document content", () => {
    const state = EditorState.create({
      doc: "one\ntwo",
      extensions: [
        createVisualRangeExtension([], [{ line: 2, kind: "modified" }]),
      ],
    })
    const host = document.createElement("div")
    const view = new EditorView({ state, parent: host })

    expect(host.querySelector(".cm-dirty-line-modified")?.textContent).toBe(
      "two"
    )
    expect(view.state.doc.toString()).toBe("one\ntwo")
    view.destroy()
  })

  it("replaces collapsed line ranges without changing document content", () => {
    const state = EditorState.create({
      doc: "header\nfirst\nsecond\nfooter",
      extensions: [createVisualRangeExtension([{ startLine: 2, endLine: 3 }])],
    })
    const host = document.createElement("div")
    const view = new EditorView({ state, parent: host })

    expect(view.state.doc.toString()).toBe("header\nfirst\nsecond\nfooter")
    expect(host.textContent).toContain("header")
    expect(host.textContent).toContain("footer")
    expect(host.textContent).not.toContain("first")

    view.destroy()
  })
})
