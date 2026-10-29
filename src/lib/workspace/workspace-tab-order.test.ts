import { describe, expect, it } from "vitest"
import {
  mergeWorkspacePaneOrder,
  parseWorkspaceTabOrderState,
  reconcileWorkspaceTabOrder,
} from "@/lib/workspace/workspace-tab-order"
import type { WorkspaceTabRef } from "@/lib/workspace/workspace-tab-placement"

const ref = (
  kind: WorkspaceTabRef["kind"],
  id: string,
  type: NonNullable<WorkspaceTabRef["type"]>
): WorkspaceTabRef => ({ kind, id, type }) as WorkspaceTabRef

describe("workspace tab order", () => {
  it("restores one qualified order across tab collections", () => {
    const refs = [
      ref("file", "a", "file"),
      ref("primary", "terminal", "terminal"),
      ref("file", "b", "transcript"),
    ]
    const ordered = reconcileWorkspaceTabOrder(
      ["file:b", "primary:terminal", "file:a"],
      refs
    )

    expect(ordered.map((entry) => entry.key)).toEqual([
      "file:b",
      "primary:terminal",
      "file:a",
    ])
  })

  it("keeps global tabs first and appends newly opened regular tabs", () => {
    const refs = [
      ref("file", "new", "transcript"),
      ref("global", "settings", "global"),
      ref("primary", "terminal", "terminal"),
    ]
    const ordered = reconcileWorkspaceTabOrder(["primary:terminal"], refs)

    expect(ordered.map((entry) => entry.key)).toEqual([
      "global:settings",
      "primary:terminal",
      "file:new",
    ])
  })

  it("drops closed and duplicate persisted keys", () => {
    const ordered = reconcileWorkspaceTabOrder(
      ["file:a", "file:closed", "file:a"],
      [ref("file", "a", "file")]
    )
    expect(ordered.map((entry) => entry.key)).toEqual(["file:a"])
  })

  it("reorders colliding bare ids by qualified identity", () => {
    const primary = ref("primary", "same", "terminal")
    const file = ref("file", "same", "file")
    expect(
      mergeWorkspacePaneOrder(
        [primary, file],
        [primary, file],
        [file, primary]
      ).map((item) => `${item.kind}:${item.id}`)
    ).toEqual(["file:same", "primary:same"])
  })

  it("parses only string order arrays", () => {
    expect(
      parseWorkspaceTabOrderState(
        JSON.stringify({ project: ["file:a", "file:a", 3], bad: "x" })
      )
    ).toEqual({ project: ["file:a"] })
    expect(parseWorkspaceTabOrderState("invalid")).toEqual({})
  })
})
