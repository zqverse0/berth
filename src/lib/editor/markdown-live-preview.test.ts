import { describe, expect, it, vi } from "vitest"
import { ensureSyntaxTree } from "@codemirror/language"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { markdownLivePreview } from "./markdown-live-preview"

function mount(
  doc: string,
  resolveImage = vi.fn(async () => "data:x"),
  onLinkClick: (url: string) => void = () => {},
  openCodePath: (code: string) => (() => void) | null = () => null
) {
  const parent = document.createElement("div")
  document.body.appendChild(parent)
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: markdownLivePreview({
        onLinkClick,
        openCodePath,
        resolveImage,
        wikiLinks: {},
        wikiEmbed: { load: async () => null, open: () => {} },
      }),
    }),
  })
  return { view, resolveImage }
}

function nodeNames(state: EditorState) {
  const names = new Set<string>()
  ensureSyntaxTree(state, state.doc.length, 1000)?.iterate({
    enter: (node) => {
      names.add(node.name)
    },
  })
  return names
}

describe("markdownLivePreview", () => {
  it("parses frontmatter as YAML instead of a setext heading", () => {
    const { view } = mount("---\ntitle: X\n---\n\n# Body\n")
    const names = nodeNames(view.state)
    expect(names.has("SetextHeading2")).toBe(false)
    expect(names.has("ATXHeading1")).toBe(true)
    view.destroy()
  })

  it("renders images through resolveImage, skipping images inside tables", () => {
    const { view, resolveImage } = mount(
      "![a](./pic.png)\n\n| h |\n| - |\n| ![b](in-table.png) |\n"
    )
    expect(view.dom.querySelectorAll(".cm-atomic-image")).toHaveLength(1)
    expect(resolveImage).toHaveBeenCalledWith("./pic.png")
    expect(resolveImage).not.toHaveBeenCalledWith("in-table.png")
    view.destroy()
  })
})

describe("table cell inline code patch", () => {
  it("renders backtick spans in table cells as inline code", () => {
    const { view } = mount("| a |\n| - |\n| `x*y*` |\n\ntail\n")
    const code = view.dom.querySelector(
      ".cm-atomic-table .cm-atomic-inline-code"
    )
    expect(code?.textContent).toBe("x*y*")
    view.destroy()
  })
})

describe("click to open", () => {
  const click = (el: Element | null | undefined) =>
    el?.dispatchEvent(new MouseEvent("click", { bubbles: true, button: 0 }))

  it("opens links and path-like inline code from their text", () => {
    const onLink = vi.fn()
    const open = vi.fn()
    const openCodePath = vi.fn((code: string) =>
      code.endsWith(".ts") ? open : null
    )
    const { view } = mount(
      "x\n\n[doc](./a.md) and `src/b.ts` and `plain`\n",
      undefined,
      onLink,
      openCodePath
    )
    const targets = view.dom.querySelectorAll(".cm-berth-open")
    expect(targets).toHaveLength(2)
    click(targets[0])
    expect(onLink).toHaveBeenCalledWith("./a.md")
    click(targets[1])
    expect(openCodePath).toHaveBeenLastCalledWith("src/b.ts")
    expect(open).toHaveBeenCalledOnce()
    view.destroy()
  })

  it("leaves a link editable while the cursor is inside it", () => {
    const { view } = mount("x\n\n[doc](./a.md)\n")
    expect(view.dom.querySelector(".cm-berth-open")).not.toBeNull()
    view.dispatch({ selection: { anchor: 5 } })
    expect(view.dom.querySelector(".cm-berth-open")).toBeNull()
    view.destroy()
  })
})
