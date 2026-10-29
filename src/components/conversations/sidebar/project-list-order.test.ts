import { describe, expect, it } from "vitest"
import {
  compareFoldersByPinThenOrder,
  projectRowOrder,
  type ProjectOrderInput,
} from "./project-list-order"

function f(
  id: number,
  extra: Partial<ProjectOrderInput> = {}
): ProjectOrderInput {
  return {
    id,
    parent_id: null,
    pinned_at: null,
    sort_order: id,
    name: `f${id}`,
    ...extra,
  }
}

describe("compareFoldersByPinThenOrder", () => {
  it("puts the most recently pinned first, then sort_order", () => {
    const rows = [
      f(1),
      f(2, { pinned_at: "2026-01-01T00:00:00Z" }),
      f(3, { pinned_at: "2026-02-01T00:00:00Z" }),
      f(4, { sort_order: 0 }),
    ].sort(compareFoldersByPinThenOrder)
    expect(rows.map((r) => r.id)).toEqual([3, 2, 4, 1])
  })
})

describe("projectRowOrder", () => {
  it("nests open worktrees under their root in name order", () => {
    const rows = projectRowOrder([
      f(1),
      f(3, { parent_id: 1, sort_order: 0, name: "b" }),
      f(2, { parent_id: 1, sort_order: 0, name: "a" }),
      f(4),
    ])
    expect(rows).toEqual([
      { folderId: 1, worktree: false, nested: false },
      { folderId: 2, worktree: true, nested: true },
      { folderId: 3, worktree: true, nested: true },
      { folderId: 4, worktree: false, nested: false },
    ])
  })

  it("lifts a pinned worktree to the top level", () => {
    const rows = projectRowOrder([
      f(1),
      f(2, { parent_id: 1, pinned_at: "2026-01-01T00:00:00Z" }),
    ])
    expect(rows).toEqual([
      { folderId: 2, worktree: true, nested: false },
      { folderId: 1, worktree: false, nested: false },
    ])
  })

  it("treats a worktree whose root is not open as a plain project", () => {
    expect(projectRowOrder([f(2, { parent_id: 99 })])).toEqual([
      { folderId: 2, worktree: false, nested: false },
    ])
  })
})
