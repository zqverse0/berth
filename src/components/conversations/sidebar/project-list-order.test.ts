import { describe, expect, it } from "vitest"
import { projectOrder, type ProjectOrderInput } from "./project-list-order"

function f(
  id: number,
  main = id,
  project: Partial<NonNullable<ProjectOrderInput["project"]>> = {},
  name = `f${id}`
): ProjectOrderInput {
  return {
    id,
    name,
    project: {
      name: `p${main}`,
      main_folder_id: main,
      pinned_at: null,
      sort_order: main,
      ...project,
    },
  }
}

describe("projectOrder", () => {
  it("groups members under their project, main first then by name", () => {
    expect(
      projectOrder([f(3, 1, {}, "b"), f(1), f(2, 1, {}, "a"), f(4)])
    ).toEqual([
      { mainId: 1, memberIds: [1, 2, 3] },
      { mainId: 4, memberIds: [4] },
    ])
  })

  it("puts the most recently pinned project first, then sort_order", () => {
    const order = projectOrder([
      f(1),
      f(2, 2, { pinned_at: "2026-01-01T00:00:00Z" }),
      f(3, 3, { pinned_at: "2026-02-01T00:00:00Z" }),
      f(4, 4, { sort_order: 0 }),
    ])
    expect(order.map((slot) => slot.mainId)).toEqual([3, 2, 4, 1])
  })

  it("folders without a project (device, chat) are single-member projects", () => {
    const loose = { id: 9, name: "remote", project: null }
    expect(projectOrder([loose])).toEqual([{ mainId: 9, memberIds: [9] }])
  })

  it("lists a project whose main member is not open", () => {
    expect(projectOrder([f(5, 1, {}, "b"), f(6, 1, {}, "a")])).toEqual([
      { mainId: 1, memberIds: [6, 5] },
    ])
  })
})
