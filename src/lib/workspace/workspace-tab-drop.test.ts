import { describe, expect, it } from "vitest"
import {
  insertionIndex,
  orderAfterDrop,
} from "@/lib/workspace/workspace-tab-drop"
import type { WorkspaceTabRef } from "@/lib/workspace/workspace-tab-placement"

const slots = [
  { left: 0, width: 100 },
  { left: 100, width: 40 },
  { left: 140, width: 100 },
]

describe("insertionIndex", () => {
  it("lands before the first tab whose midpoint is right of the pointer", () => {
    expect(insertionIndex(slots, -10)).toBe(0)
    expect(insertionIndex(slots, 49)).toBe(0)
    expect(insertionIndex(slots, 51)).toBe(1)
    expect(insertionIndex(slots, 125)).toBe(2)
    expect(insertionIndex(slots, 500)).toBe(3)
    expect(insertionIndex([], 10)).toBe(0)
  })
})

describe("orderAfterDrop", () => {
  const ref = (id: string): WorkspaceTabRef => ({ kind: "file", id })

  it("moves a tab within its pane and inserts one from elsewhere", () => {
    const pane = [ref("a"), ref("b"), ref("c")]
    expect(orderAfterDrop(pane, ref("c"), 0).map((tab) => tab.id)).toEqual([
      "c",
      "a",
      "b",
    ])
    expect(orderAfterDrop(pane, ref("x"), 1).map((tab) => tab.id)).toEqual([
      "a",
      "x",
      "b",
      "c",
    ])
    expect(orderAfterDrop(pane, ref("a"), null).map((tab) => tab.id)).toEqual([
      "b",
      "c",
      "a",
    ])
  })
})
