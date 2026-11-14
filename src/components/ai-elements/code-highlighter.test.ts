import { afterEach, describe, expect, it } from "vitest"
import type { TokensResult } from "shiki"
import {
  RESULT_CACHE_MAX,
  __resetCodeHighlighterForTest,
  code,
  highlight,
  resolveLanguage,
} from "./code-highlighter"

function highlighted(source: string, language: string): Promise<TokensResult> {
  return new Promise((resolve) => {
    const ready = highlight(source, language, resolve)
    if (ready) resolve(ready)
  })
}

describe("code highlighter", () => {
  afterEach(() => __resetCodeHighlighterForTest())

  it("highlights whitelisted languages and their aliases with both themes", async () => {
    const result = await highlighted("const a: number = 1", "ts")
    const tokens = result.tokens.flat()
    expect(tokens.length).toBeGreaterThan(3)
    expect(new Set(tokens.map((t) => t.htmlStyle?.color)).size).toBeGreaterThan(
      1
    )
    expect(tokens[0].htmlStyle?.["--shiki-dark"]).toBeTruthy()
    // 已缓存：同步返回同一份。
    expect(highlight("const a: number = 1", "typescript")).toBe(result)
    expect(resolveLanguage("Bash")).toBe("shellscript")
    expect(code.supportsLanguage("rs" as never)).toBe(true)
  })

  it("falls back to plain text for languages outside the whitelist", async () => {
    expect(resolveLanguage("haskell")).toBeNull()
    expect(code.supportsLanguage("haskell" as never)).toBe(false)
    const result = await highlighted('main = putStrLn "hi"\nx = 1', "haskell")
    expect(result.tokens).toHaveLength(2)
    expect(result.tokens[0].map((t) => t.content).join("")).toBe(
      'main = putStrLn "hi"'
    )
    expect(
      new Set(result.tokens.flat().map((t) => t.htmlStyle?.color)).size
    ).toBe(1)
  })

  it("keeps at most RESULT_CACHE_MAX results, dropping the least recently used", async () => {
    await highlighted("x = 0", "py")
    for (let i = 1; i <= RESULT_CACHE_MAX; i++) {
      await highlighted(`x = ${i}`, "py")
      // 第一条一直被读到，不会被挤掉。
      if (i === RESULT_CACHE_MAX / 2)
        expect(highlight("x = 0", "py")).not.toBeNull()
    }
    expect(highlight("x = 0", "py")).not.toBeNull()
    expect(highlight("x = 1", "py")).toBeNull()
    expect(highlight(`x = ${RESULT_CACHE_MAX}`, "py")).not.toBeNull()
  })
})
