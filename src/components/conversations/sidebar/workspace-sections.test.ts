import { describe, expect, it } from "vitest"
import {
  assignWorkspaceGroup,
  checkWorkspaceName,
  createWorkspaceGroup,
  moveWorkspaceGroup,
  normalizeWorkspaceGroups,
  pruneWorkspaceMembers,
  removeWorkspaceGroup,
  renameWorkspaceGroup,
  workspaceGroupOf,
} from "@/lib/workspace-groups"
import {
  workspaceSections,
  type SectionFolder,
  type SectionSession,
} from "./workspace-sections"

function f(id: number, extra: Partial<SectionFolder> = {}): SectionFolder {
  return {
    id,
    parent_id: null,
    pinned_at: null,
    sort_order: id,
    name: `f${id}`,
    path: `/p${id}`,
    ...extra,
  }
}

function s(
  id: string,
  folderId: number | null,
  dot: SectionSession["dot"] = null,
  device = 0
): SectionSession {
  return { id, device, folderId, dot }
}

/** 默认 + 科研两个工作区 */
function twoGroups() {
  const base = normalizeWorkspaceGroups(null, "默认")
  return createWorkspaceGroup(base, "lab", " 科研 ", "🔬")
}

describe("workspace groups rules", () => {
  it("migrates to a single default group holding every project", () => {
    const state = normalizeWorkspaceGroups(null, "默认")
    expect(state.groups).toEqual([
      { id: "default", name: "默认", emoji: null, isDefault: true },
    ])
    expect(workspaceGroupOf(state, 0, "/any")).toBe("default")
    expect(workspaceGroupOf(state, 3, "/remote")).toBe("default")
  })

  it("keeps a valid file and drops members of unknown groups", () => {
    const state = normalizeWorkspaceGroups(
      {
        version: 1,
        groups: [
          { id: "lab", name: "科研", emoji: null, isDefault: false },
          { id: "d", name: "Mine", emoji: null, isDefault: true },
        ],
        members: [
          { device: 0, path: "/a", groupId: "lab" },
          { device: 0, path: "/b", groupId: "gone" },
        ],
      },
      "默认"
    )
    expect(state.groups.map((g) => g.id)).toEqual(["lab", "d"])
    expect(state.members).toEqual([{ device: 0, path: "/a", groupId: "lab" }])
    expect(workspaceGroupOf(state, 0, "/b")).toBe("d")
  })

  it("rejects blank and duplicate names, trims on save", () => {
    const state = twoGroups()
    expect(state.groups[1].name).toBe("科研")
    expect(checkWorkspaceName(state, "  ")).toBe("empty")
    expect(checkWorkspaceName(state, "科研 ")).toBe("duplicate")
    expect(checkWorkspaceName(state, "科研", "lab")).toBeNull()
    expect(checkWorkspaceName(state, "论文")).toBeNull()
  })

  it("default can be renamed but not removed", () => {
    const state = renameWorkspaceGroup(twoGroups(), "default", "开发", null)
    expect(state.groups[0]).toMatchObject({ name: "开发", isDefault: true })
    expect(removeWorkspaceGroup(state, "default")).toBe(state)
  })

  it("removing a group sends its projects back to default", () => {
    const state = assignWorkspaceGroup(twoGroups(), 0, "/p1", "lab")
    expect(workspaceGroupOf(state, 0, "/p1")).toBe("lab")
    const after = removeWorkspaceGroup(state, "lab")
    expect(after.groups.map((g) => g.id)).toEqual(["default"])
    expect(workspaceGroupOf(after, 0, "/p1")).toBe("default")
  })

  it("moving to default drops the record; reorder clamps", () => {
    const state = assignWorkspaceGroup(twoGroups(), 0, "/p1", "lab")
    expect(assignWorkspaceGroup(state, 0, "/p1", "default").members).toEqual([])
    expect(
      moveWorkspaceGroup(state, "lab", -5).groups.map((g) => g.id)
    ).toEqual(["lab", "default"])
  })

  it("prunes removed local projects and removed devices only", () => {
    let state = twoGroups()
    state = assignWorkspaceGroup(state, 0, "/kept", "lab")
    state = assignWorkspaceGroup(state, 0, "/deleted", "lab")
    state = assignWorkspaceGroup(state, 2, "/offline-device", "lab")
    state = assignWorkspaceGroup(state, 9, "/removed-device", "lab")
    const pruned = pruneWorkspaceMembers(
      state,
      new Set(["/kept"]),
      new Set([2])
    )
    expect(pruned.members.map((m) => m.path)).toEqual([
      "/kept",
      "/offline-device",
    ])
    expect(
      pruneWorkspaceMembers(pruned, new Set(["/kept"]), new Set([2]))
    ).toBe(pruned)
  })
})

describe("workspaceSections", () => {
  it("worktrees follow their root; orphan worktrees use their own path", () => {
    let state = assignWorkspaceGroup(twoGroups(), 0, "/p1", "lab")
    state = assignWorkspaceGroup(state, 0, "/p9", "lab")
    const { sections } = workspaceSections({
      state,
      devices: [
        {
          device: 0,
          folders: [
            f(1),
            f(2, { parent_id: 1 }),
            // root 4 没打开：孤儿 worktree 自己是一个项目
            f(9, { parent_id: 4 }),
            f(5),
          ],
        },
      ],
      sessions: [],
      current: null,
      manual: {},
    })
    const [main, lab] = sections
    expect(main.rows.map((r) => r.slot.folderId)).toEqual([5])
    expect(lab.rows.map((r) => [r.slot.folderId, r.slot.nested])).toEqual([
      [1, false],
      [2, true],
      [9, false],
    ])
    expect(lab.projectCount).toBe(2)
  })

  it("current group is full, others show running only unless set manually", () => {
    const state = assignWorkspaceGroup(twoGroups(), 3, "/remote", "lab")
    const input = {
      state,
      devices: [
        { device: 0, folders: [f(1), f(2, { parent_id: 1 })] },
        { device: 3, folders: [f(1, { path: "/remote" })] },
      ],
      sessions: [
        s("a", 2, "working"),
        s("b", 1, null),
        s("c", 1, "working", 3),
        s("d", 1, "attention", 3),
        s("e", 1, null, 3),
      ],
      current: { device: 0, folderId: 2 },
      manual: {},
    }
    const { sections } = workspaceSections(input)
    const [main, lab] = sections
    expect(main).toMatchObject({ current: true, full: true, working: 1 })
    expect(main.rows.map((r) => r.sessions.map((x) => x.id))).toEqual([
      ["b"],
      ["a"],
    ])
    expect(lab).toMatchObject({ current: false, full: false, attention: 1 })
    expect(lab.running.map((x) => x.id)).toEqual(["d", "c"])

    // 切到科研里的会话：科研变当前；手动展开过的默认保持展开
    const switched = workspaceSections({
      ...input,
      current: { device: 3, folderId: 1 },
      manual: { default: true },
    }).sections
    expect(switched.map((x) => [x.current, x.full])).toEqual([
      [false, true],
      [true, true],
    ])
  })

  it("without a selected project the first workspace is current", () => {
    const { sections } = workspaceSections({
      state: twoGroups(),
      devices: [{ device: 0, folders: [f(1)] }],
      sessions: [],
      current: null,
      manual: {},
    })
    expect(sections.map((x) => [x.current, x.full])).toEqual([
      [true, true],
      [false, false],
    ])
  })

  it("sessions outside every open project are unassigned", () => {
    const { unassigned } = workspaceSections({
      state: twoGroups(),
      devices: [{ device: 0, folders: [f(1)] }],
      sessions: [
        s("home", null, "attention"),
        s("ssh", null, null, 4),
        s("x", 1),
      ],
      current: null,
      manual: {},
    })
    expect(unassigned.map((x) => x.id)).toEqual(["home", "ssh"])
  })
})
