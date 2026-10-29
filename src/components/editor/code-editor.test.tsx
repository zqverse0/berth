import { createRef } from "react"
import { act, cleanup, render } from "@testing-library/react"
import type { EditorHandle } from "@/lib/editor/contracts"
import { afterEach, describe, expect, it, vi } from "vitest"
import { CodeEditor } from "./code-editor"
import { editorDocumentRegistry } from "@/lib/editor/document-registry"

const appearance = {
  fontFamily: "monospace",
  fontSize: 13,
  fontLigatures: false,
  wordWrap: false,
}

afterEach(() => {
  cleanup()
  editorDocumentRegistry.clear()
})

describe("CodeEditor", () => {
  it("returns the actual cursor line after clamping, not the requested line", () => {
    const ref = createRef<EditorHandle>()
    render(
      <CodeEditor
        ref={ref}
        documentId="reveal:clamped"
        value={"one\ntwo\nthree"}
        appearance={appearance}
      />
    )
    let actual: number | null | undefined
    act(() => {
      actual = ref.current?.revealLine(99)
    })
    expect(actual).toBe(3)
    const view = ref.current?.getView()
    expect(view?.state.doc.lineAt(view.state.selection.main.head).number).toBe(
      actual
    )
  })

  it("reveals a line without stealing focus from a terminal textarea", () => {
    const ref = createRef<EditorHandle>()
    render(
      <CodeEditor
        ref={ref}
        documentId="reveal:keep-focus"
        value={"one\ntwo"}
        appearance={appearance}
      />
    )
    const terminal = document.createElement("textarea")
    document.body.appendChild(terminal)
    terminal.focus()
    act(() => {
      ref.current?.revealLine(2)
    })
    expect(document.activeElement).toBe(terminal)
    terminal.remove()
  })

  it("reports readiness after the live buffer is mounted and updated", () => {
    const ref = createRef<EditorHandle>()
    const onReady = vi.fn(() => ref.current?.getContent())
    const rendered = render(
      <CodeEditor
        ref={ref}
        documentId="reveal:ready"
        value="first"
        appearance={appearance}
        onReady={onReady}
      />
    )
    expect(onReady).toHaveReturnedWith("first")
    const nextReady = vi.fn(() => ref.current?.getContent())
    rendered.rerender(
      <CodeEditor
        ref={ref}
        documentId="reveal:ready"
        value="updated"
        appearance={appearance}
        onReady={nextReady}
      />
    )
    expect(nextReady).toHaveReturnedWith("updated")
    const handle = ref.current
    rendered.unmount()
    expect(handle?.revealLine(1)).toBeNull()
  })

  it("keeps each tab document independent", () => {
    const first = render(
      <CodeEditor
        documentId="tab:first"
        value="first"
        appearance={appearance}
      />
    )
    expect(first.container.querySelector(".cm-content")?.textContent).toBe(
      "first"
    )
    first.unmount()

    const second = render(
      <CodeEditor
        documentId="tab:second"
        value="second"
        appearance={appearance}
      />
    )
    expect(second.container.querySelector(".cm-content")?.textContent).toBe(
      "second"
    )
    expect(editorDocumentRegistry.size).toBe(2)
  })

  it("disposes transient document state on unmount", () => {
    const rendered = render(
      <CodeEditor
        documentId="merge:transient"
        value="result"
        appearance={appearance}
        preserveState={false}
      />
    )
    expect(editorDocumentRegistry.get("merge:transient")).toBeDefined()

    rendered.unmount()

    expect(editorDocumentRegistry.get("merge:transient")).toBeUndefined()
  })

  it("applies external content updates without remounting", () => {
    const onChange = vi.fn()
    const rendered = render(
      <CodeEditor
        documentId="tab:update"
        value="before"
        appearance={appearance}
        onChange={onChange}
      />
    )

    rendered.rerender(
      <CodeEditor
        documentId="tab:update"
        value="after"
        appearance={appearance}
        onChange={onChange}
      />
    )

    expect(rendered.container.querySelector(".cm-content")?.textContent).toBe(
      "after"
    )
    expect(onChange).toHaveBeenCalledWith("after")
  })
})
