import { describe, expect, it } from "vitest"
import { reconcilePaneActiveTab } from "@/lib/workspace/workspace-pane-model"

const primary = { kind: "primary" as const, id: "terminal" }
const file = { kind: "file" as const, id: "reader" }

describe("workspace pane model", () => {
  it("keeps a pane's remembered active tab independently", () => {
    expect(reconcilePaneActiveTab(file, [primary, file])).toEqual(file)
    expect(reconcilePaneActiveTab(file, [primary])).toEqual(primary)
  })
})
