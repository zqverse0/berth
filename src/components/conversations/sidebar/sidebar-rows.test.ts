import { describe, expect, it } from "vitest"
import { sidebarRows, type RowFolder, type RowSession } from "./sidebar-rows"

function f(id: number, main = id, path = `/p${id}`): RowFolder {
  return {
    id,
    name: `f${id}`,
    path,
    project: {
      name: `p${main}`,
      main_folder_id: main,
      pinned_at: null,
      sort_order: main,
    },
  }
}

function s(
  id: string,
  folderId: number | null,
  dot: RowSession["dot"] = null,
  device = 0
): RowSession {
  return { id, device, folderId, dot }
}

describe("sidebarRows", () => {
  it("lists local projects before device projects; sessions hang on members and add up per project", () => {
    const { rows } = sidebarRows(
      [
        { device: 0, folders: [f(1), f(2, 1)] },
        { device: 3, folders: [f(1, 1, "/remote")] },
      ],
      [s("a", 2, "working"), s("m", 1), s("b", 1, null, 3)]
    )
    expect(
      rows.map((r) => [
        r.device,
        r.mainId,
        r.members.map((m) => [m.folderId, m.sessions.map((x) => x.id)]),
        r.sessions.map((x) => x.id),
      ])
    ).toEqual([
      [
        0,
        1,
        [
          [1, ["m"]],
          [2, ["a"]],
        ],
        ["m", "a"],
      ],
      [3, 1, [[1, ["b"]]], ["b"]],
    ])
  })

  it("sessions outside every open project are unassigned, in order", () => {
    const { unassigned } = sidebarRows(
      [{ device: 0, folders: [f(1)] }],
      [s("home", null, "attention"), s("x", 1), s("ssh", null, null, 4)]
    )
    expect(unassigned.map((x) => x.id)).toEqual(["home", "ssh"])
  })
})
