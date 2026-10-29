import { describe, expect, it } from "vitest"
import { markdown, markdownLanguage } from "@codemirror/lang-markdown"
import { EditorState } from "@codemirror/state"
import { EditorView } from "@codemirror/view"
import { findEmbeds, findWikiEmbeds, markdownEmbeds } from "./markdown-embeds"

const state = (doc: string, anchor = 0) =>
  EditorState.create({
    doc,
    selection: { anchor },
    extensions: [markdown({ base: markdownLanguage }), markdownEmbeds()],
  })

describe("findEmbeds", () => {
  it("finds inline / block math and mermaid, ignoring code and prices", () => {
    const doc = [
      "Energy $E=mc^2$ costs $5 and $10.",
      "",
      "$$",
      "\\int_0^1 x\\,dx",
      "$$",
      "",
      "`$not math$`",
      "",
      "```mermaid",
      "graph TD; A-->B",
      "```",
      "",
      "```sh",
      "echo $HOME $PATH",
      "```",
    ].join("\n")
    const embeds = findEmbeds(state(doc))
    expect(embeds.map((e) => [e.kind, e.source])).toEqual([
      ["math-inline", "E=mc^2"],
      ["math-block", "\\int_0^1 x\\,dx"],
      ["mermaid", "graph TD; A-->B"],
    ])
  })

  it("shows source while the cursor is inside an embed", () => {
    const doc = "a $x$ b"
    const mount = (anchor: number) => {
      const view = new EditorView({
        parent: document.body,
        state: state(doc, anchor),
      })
      const rendered = view.dom.querySelectorAll(".cm-md-embed").length
      view.destroy()
      return rendered
    }
    expect(mount(0)).toBe(1)
    expect(mount(3)).toBe(0)
  })

  it("keeps embeds rendered while a mouse drag selects across them", () => {
    const view = new EditorView({
      parent: document.body,
      state: state("plain\na $x$ b", 0),
    })
    const rendered = () => view.dom.querySelectorAll(".cm-md-embed").length
    // 鼠标拖过公式：按下点不在公式里，保持渲染，块不跳
    view.dispatch({
      selection: { anchor: 0, head: view.state.doc.length },
      userEvent: "select.pointer",
    })
    expect(rendered()).toBe(1)
    // 键盘扩选到公式：照常展开源码
    view.dispatch({ selection: { anchor: 0, head: view.state.doc.length } })
    expect(rendered()).toBe(0)
    // 鼠标点进别处：公式重新渲染
    view.dispatch({ selection: { anchor: 0 }, userEvent: "select.pointer" })
    expect(rendered()).toBe(1)
    view.destroy()
  })

  it("maps embeds through unrelated edits and rescans when math is typed", () => {
    const view = new EditorView({
      parent: document.body,
      state: state("plain\na $x$ b", 0),
    })
    const sources = () =>
      [...view.dom.querySelectorAll(".cm-md-embed")].map((el) =>
        el.getAttribute("data-source")
      )
    // 无关输入（行内没有 `$`）：不重扫，公式位置随前面的插入平移
    view.dispatch({
      changes: { from: 0, insert: "zz" },
      selection: { anchor: 0 },
    })
    expect(view.state.sliceDoc(10, 13)).toBe("$x$")
    // 替换范围准确落在 `$x$` 上：行内只剩公式部件与两侧原文
    expect(view.dom.querySelectorAll(".cm-line")[1].textContent).toBe("a x b")
    // 光标移进公式：按平移后的位置露出源码
    view.dispatch({ selection: { anchor: 11 } })
    expect(sources()).toEqual([])
    view.dispatch({ selection: { anchor: 0 } })
    // 输入新公式：行内含 `$`，触发重扫
    const end = view.state.doc.length
    view.dispatch({
      changes: { from: end, insert: " $y$" },
      selection: { anchor: 0 },
    })
    expect(sources()).toEqual(["x", "y"])
    view.destroy()
  })
})

describe("findWikiEmbeds", () => {
  it("finds own-line ![[...]] embeds with width, skipping code and inline use", () => {
    const doc = [
      "![[Drawing 2026]]",
      "![[assets/pic.png|300]]",
      "![[flow.excalidraw#^frame|400x200]]",
      "text ![[inline.png]]",
      "```",
      "![[in-code.png]]",
      "```",
    ].join("\n")
    expect(findWikiEmbeds(state(doc)).map((e) => [e.target, e.width])).toEqual([
      ["Drawing 2026", null],
      ["assets/pic.png", 300],
      ["flow.excalidraw", 400],
    ])
  })
})
