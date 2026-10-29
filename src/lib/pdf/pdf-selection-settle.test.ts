import { describe, expect, it } from "vitest"
import { snapSelectionToWords, wordEdge } from "./pdf-selection-settle"

describe("wordEdge", () => {
  it("pushes a mid-word offset to the word start or end", () => {
    expect(wordEdge("hello world", 2, true)).toBe(0)
    expect(wordEdge("hello world", 8, false)).toBe(11)
  })

  it("leaves offsets already on a boundary or in spaces", () => {
    expect(wordEdge("hello world", 6, true)).toBe(6)
    expect(wordEdge("hello world", 5, false)).toBe(5)
  })
})

describe("snapSelectionToWords", () => {
  function select(text: string, anchor: number, focus: number) {
    const span = document.createElement("span")
    span.textContent = text
    document.body.replaceChildren(span)
    const selection = window.getSelection()!
    selection.setBaseAndExtent(
      span.firstChild!,
      anchor,
      span.firstChild!,
      focus
    )
    snapSelectionToWords(selection)
    return selection.toString()
  }

  it("snaps a multi-word drag in either direction to whole words", () => {
    expect(select("alpha beta gamma", 2, 8)).toBe("alpha beta")
    expect(select("alpha beta gamma", 13, 8)).toBe("beta gamma")
  })

  it("keeps character precision inside a single word", () => {
    expect(select("alpha beta", 1, 3)).toBe("lp")
  })
})
