import { describe, expect, it } from "vitest"

import { sourceRefToReference } from "./source-reference"

describe("sourceRefToReference", () => {
  it("builds a ranged file badge", () => {
    const ref = sourceRefToReference({
      identity: { type: "file", path: "/repo/src/foo.ts" },
      span: { unit: "lines", start: 12, end: 20 },
      excerpt: "const x = 1",
    })
    expect(ref?.refType).toBe("file")
    expect(ref?.label).toBe("foo.ts:12-20")
    expect(ref?.uri).toContain("#L12-20")
  })

  it("builds a url badge with the real https address", () => {
    const ref = sourceRefToReference({
      identity: {
        type: "url",
        url: "https://example.com/docs",
        title: "Docs",
      },
      excerpt: "hello",
    })
    expect(ref).toEqual({
      refType: "url",
      id: "https://example.com/docs",
      label: "Docs",
      uri: "https://example.com/docs",
      meta: { sourceUrl: "https://example.com/docs" },
    })
  })

  it("rejects a non-http url", () => {
    expect(
      sourceRefToReference({
        identity: { type: "url", url: "javascript:alert(1)" },
        excerpt: "x",
      })
    ).toBeNull()
  })

  it("does not turn a terminal identity into a composer badge", () => {
    expect(
      sourceRefToReference({
        identity: {
          type: "terminal",
          backendInstanceId: "backend-a",
          terminalId: "term-1",
          pane: { session: "7", window: "term-1", index: 0 },
          title: "codex",
        },
        excerpt: "npm test",
      })
    ).toBeNull()
  })
})
