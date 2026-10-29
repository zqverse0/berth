import { describe, expect, it } from "vitest"

import { pointerMenuItems } from "./menu"

describe("pointerMenuItems", () => {
  it("empty excerpt hides copy and translate", () => {
    expect(
      pointerMenuItems({ excerpt: "  ", source: null, editable: false })
    ).toEqual({
      copyContent: false,
      copySource: false,
      translate: false,
      editor: false,
    })
  })

  it("readonly without source only copies content", () => {
    expect(
      pointerMenuItems({ excerpt: "hi", source: null, editable: false })
    ).toEqual({
      copyContent: true,
      copySource: false,
      translate: true,
      editor: false,
    })
  })

  it("readonly with source can copy both", () => {
    expect(
      pointerMenuItems({
        excerpt: "hi",
        source: {
          identity: { type: "file", path: "a.ts" },
          excerpt: "hi",
        },
        editable: false,
      })
    ).toEqual({
      copyContent: true,
      copySource: true,
      translate: true,
      editor: false,
    })
  })

  it("terminal identity can copy content, source, and translate", () => {
    expect(
      pointerMenuItems({
        excerpt: "npm test",
        source: {
          identity: {
            type: "terminal",
            backendInstanceId: "backend-a",
            terminalId: "term-1",
            pane: { session: "7", window: "term-1", index: 0 },
          },
          excerpt: "npm test",
        },
        editable: false,
      })
    ).toEqual({
      copyContent: true,
      copySource: true,
      translate: true,
      editor: false,
    })
  })

  it("editable composer has editor items and no source", () => {
    expect(
      pointerMenuItems({ excerpt: "hi", source: null, editable: true })
    ).toEqual({
      copyContent: true,
      copySource: false,
      translate: true,
      editor: true,
    })
  })
})
