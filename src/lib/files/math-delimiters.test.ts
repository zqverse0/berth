import { describe, expect, it } from "vitest"
import { normalizeMathDelimiters } from "@/lib/files/math-delimiters"

describe("normalizeMathDelimiters", () => {
  it("converts \\[ ... \\] to $$ ... $$", () => {
    expect(normalizeMathDelimiters("Here is \\[E = mc^2\\] in text")).toBe(
      "Here is $$E = mc^2$$ in text"
    )
  })

  it("converts \\( ... \\) to $ ... $", () => {
    expect(normalizeMathDelimiters("Inline \\(a^2 + b^2 = c^2\\) math")).toBe(
      "Inline $a^2 + b^2 = c^2$ math"
    )
  })

  it("preserves code fences and inline code untouched", () => {
    const code = "```latex\n\\[no replace\\]\n```\nand `\\(keep\\)`"
    expect(normalizeMathDelimiters(code)).toBe(code)
  })
})
