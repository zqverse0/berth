import type { PaneDot } from "@/lib/terminal/agent-panes"
import {
  workspaceGroupOf,
  type WorkspaceGroup,
  type WorkspaceGroupsState,
} from "@/lib/workspace-groups"
import {
  projectRowOrder,
  type ProjectOrderInput,
  type ProjectRowSlot,
} from "./project-list-order"

export type SectionFolder = ProjectOrderInput & { path: string }

/** 一台设备打开的项目：本机 `device` 为 0。 */
export interface SectionDevice {
  device: number
  folders: readonly SectionFolder[]
}

/** 一个会话（终端 / Agent）：`folderId` 是它所在的项目（含 worktree），不属于任何项目为 null。 */
export interface SectionSession {
  id: string
  device: number
  folderId: number | null
  dot: PaneDot
}

export interface SectionRow<S extends SectionSession = SectionSession> {
  device: number
  slot: ProjectRowSlot
  sessions: S[]
}

export interface WorkspaceSection<S extends SectionSession = SectionSession> {
  group: WorkspaceGroup
  /** 当前项目所在的工作区 */
  current: boolean
  /** 完整显示（全部项目、worktree、会话）；否则只看运行中 */
  full: boolean
  rows: SectionRow<S>[]
  /** 需关注 / 工作中的会话，需关注在前（只看运行中时显示这些） */
  running: S[]
  /** root 项目数（只剩标题行时显示） */
  projectCount: number
  attention: number
  working: number
}

export interface WorkspaceSectionsInput<S extends SectionSession> {
  state: WorkspaceGroupsState
  devices: readonly SectionDevice[]
  sessions: readonly S[]
  /** 当前选中的项目（含 worktree），决定哪个工作区是「当前」；没有时第一个工作区算当前 */
  current: { device: number; folderId: number } | null
  /** 用户手动设过的完整 / 只看运行中，优先于自动收放 */
  manual: Readonly<Record<string, boolean>>
}

/** worktree 跟着 root：root 已打开就用 root 的路径，否则（孤儿 worktree）用自己的。 */
function rootPath(folder: SectionFolder, byId: Map<number, SectionFolder>) {
  const root = folder.parent_id == null ? undefined : byId.get(folder.parent_id)
  return (root ?? folder).path
}

/**
 * 侧栏按工作区分节：每节的项目行沿用 `projectRowOrder`（本机在前，设备按传入顺序），
 * 会话挂到所在项目行；找不到项目的会话进「未归属会话」。
 */
export function workspaceSections<S extends SectionSession>(
  input: WorkspaceSectionsInput<S>
): {
  sections: WorkspaceSection<S>[]
  unassigned: S[]
} {
  const { state, devices, sessions, current, manual } = input
  const sessionsAt = new Map<string, S[]>()
  for (const session of sessions) {
    const key = `${session.device}:${session.folderId}`
    const list = sessionsAt.get(key)
    if (list) list.push(session)
    else sessionsAt.set(key, [session])
  }

  const rowsByGroup = new Map<string, SectionRow<S>[]>()
  const countByGroup = new Map<string, number>()
  const placed = new Set<string>()
  let currentGroup: string | null = null
  for (const { device, folders } of devices) {
    const byId = new Map(folders.map((folder) => [folder.id, folder]))
    for (const slot of projectRowOrder(folders)) {
      const folder = byId.get(slot.folderId)!
      const groupId = workspaceGroupOf(state, device, rootPath(folder, byId))
      const key = `${device}:${folder.id}`
      placed.add(key)
      if (current?.device === device && current.folderId === folder.id)
        currentGroup = groupId
      const row = { device, slot, sessions: sessionsAt.get(key) ?? [] }
      const rows = rowsByGroup.get(groupId)
      if (rows) rows.push(row)
      else rowsByGroup.set(groupId, [row])
      if (!slot.worktree)
        countByGroup.set(groupId, (countByGroup.get(groupId) ?? 0) + 1)
    }
  }

  // 没有选中项目（或它不在列表里）时第一个工作区算当前，列表不至于只剩标题
  currentGroup ??= state.groups[0]?.id ?? null
  const sections = state.groups.map((group): WorkspaceSection<S> => {
    const rows = rowsByGroup.get(group.id) ?? []
    const all = rows.flatMap((row) => row.sessions)
    const attention = all.filter((session) => session.dot === "attention")
    const working = all.filter((session) => session.dot === "working")
    const isCurrent = group.id === currentGroup
    return {
      group,
      current: isCurrent,
      full: manual[group.id] ?? isCurrent,
      rows,
      running: [...attention, ...working],
      projectCount: countByGroup.get(group.id) ?? 0,
      attention: attention.length,
      working: working.length,
    }
  })
  const unassigned = sessions.filter(
    (session) => !placed.has(`${session.device}:${session.folderId}`)
  )
  return { sections, unassigned }
}
