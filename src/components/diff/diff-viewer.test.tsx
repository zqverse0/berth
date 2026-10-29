import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string, values?: { count?: number }) =>
    key === "changeCount" ? `${values?.count} change(s)` : key,
}))

vi.mock("@/hooks/use-appearance", () => ({
  useZoomLevel: () => ({ zoomLevel: 100 }),
  useEditorFont: () => ({
    editorFontStack: "monospace",
    editorFontSize: 13,
    editorLigatures: false,
    editorWordWrap: false,
  }),
}))

import { DiffViewer } from "./diff-viewer"

describe("DiffViewer", () => {
  it("renders a single-column CodeMirror diff and change summary", async () => {
    const rendered = render(
      <DiffViewer
        original="const value = 1"
        modified="const value = 2"
        originalLabel="Before"
        modifiedLabel="After"
      />
    )

    expect(screen.getByText(/Before.*After/)).toBeInTheDocument()
    expect(await screen.findByText("1 change(s)")).toBeInTheDocument()
    expect(rendered.container.querySelector(".cm-mergeView")).toBeNull()
    expect(rendered.container.querySelectorAll(".cm-editor")).toHaveLength(1)
    expect(rendered.container.querySelector(".cm-deletedChunk")).toBeTruthy()
  })

  it("keeps deletion-heavy diffs in one readable column", async () => {
    const original = Array.from(
      { length: 61 },
      (_, index) => `line ${index}`
    ).join("\n")
    const rendered = render(
      <DiffViewer original={original} modified="line 0 changed" />
    )

    expect(rendered.container.querySelectorAll(".cm-editor")).toHaveLength(1)
    expect(rendered.container.querySelector(".cm-mergeView")).toBeNull()
    expect(rendered.container.querySelector(".cm-deletedChunk")).toBeTruthy()
    expect(await screen.findByText(/change\(s\)/)).toBeInTheDocument()
  })

  it("destroys the editor on unmount", () => {
    const rendered = render(<DiffViewer original="a" modified="b" />)
    const editors = [...rendered.container.querySelectorAll(".cm-editor")]

    rendered.unmount()

    expect(editors.every((editor) => !editor.isConnected)).toBe(true)
  })
})
