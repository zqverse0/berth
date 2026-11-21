import type { PaneDot } from "@/lib/terminal/agent-panes"
import { projectOrder, type ProjectOrderInput } from "./project-list-order"

export type RowFolder = ProjectOrderInput & { path: string }

/** 一台设备打开的项目：本机 `device` 为 0。 */
export interface DeviceFolders {
  device: number
  folders: readonly RowFolder[]
}

/** 一个会话（终端 / Agent）：`folderId` 是它所在的项目（含 worktree），不属于任何项目为 null。 */
export interface RowSession {
  id: string
  device: number
  folderId: number | null
  dot: PaneDot
}

export interface MemberSlot<S extends RowSession = RowSession> {
  folderId: number
  sessions: S[]
}

/** 侧栏一个项目：成员主成员在前；`sessions` 是各成员会话按成员顺序的汇总。 */
export interface ProjectListRow<S extends RowSession = RowSession> {
  device: number
  mainId: number
  members: MemberSlot<S>[]
  sessions: S[]
}

/**
 * 侧栏项目行：沿用 `projectOrder`（本机在前，设备按传入顺序），会话挂到所在成员；
 * 找不到项目的会话进「未归属会话」。
 */
export function sidebarRows<S extends RowSession>(
  devices: readonly DeviceFolders[],
  sessions: readonly S[]
): { rows: ProjectListRow<S>[]; unassigned: S[] } {
  const sessionsAt = new Map<string, S[]>()
  for (const session of sessions) {
    const key = `${session.device}:${session.folderId}`
    const list = sessionsAt.get(key)
    if (list) list.push(session)
    else sessionsAt.set(key, [session])
  }
  const rows: ProjectListRow<S>[] = []
  const placed = new Set<string>()
  for (const { device, folders } of devices)
    for (const { mainId, memberIds } of projectOrder(folders)) {
      const members = memberIds.map((folderId) => {
        const key = `${device}:${folderId}`
        placed.add(key)
        return { folderId, sessions: sessionsAt.get(key) ?? [] }
      })
      rows.push({
        device,
        mainId,
        members,
        sessions: members.flatMap((member) => member.sessions),
      })
    }
  const unassigned = sessions.filter(
    (session) => !placed.has(`${session.device}:${session.folderId}`)
  )
  return { rows, unassigned }
}
