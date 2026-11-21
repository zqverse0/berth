import type { FolderDetail } from "@/lib/types"
import { mainFolderId } from "@/lib/workspace/projects"

export type ProjectOrderInput = Pick<FolderDetail, "id" | "name" | "project">

/** 侧栏一个项目：`mainId` 是项目身份（主成员），`memberIds` 主成员在前、其余按目录名。 */
export interface ProjectSlot {
  mainId: number
  memberIds: number[]
}

function pinnedAtMs(folder: ProjectOrderInput): number {
  const timestamp = Date.parse(folder.project?.pinned_at ?? "")
  return Number.isNaN(timestamp) ? 0 : timestamp
}

/**
 * 打开的目录按项目归拢：置顶的在前（最近置顶的在前），其余按项目排序，再按主成员 id。
 * 只有项目能置顶；主成员不在列表里时项目照样列出（成员按目录名）。
 */
export function projectOrder(
  folders: readonly ProjectOrderInput[]
): ProjectSlot[] {
  const byProject = new Map<number, ProjectOrderInput[]>()
  for (const folder of folders) {
    const main = mainFolderId(folder)
    const members = byProject.get(main)
    if (members) members.push(folder)
    else byProject.set(main, [folder])
  }
  const slots = [...byProject].map(([mainId, members]) => {
    members.sort((a, b) =>
      a.id === mainId
        ? -1
        : b.id === mainId
          ? 1
          : a.name.localeCompare(b.name) || a.id - b.id
    )
    return { mainId, members }
  })
  slots.sort((a, b) => {
    const left = a.members[0]
    const right = b.members[0]
    const pinned = pinnedAtMs(right) - pinnedAtMs(left)
    if (pinned !== 0) return pinned
    const order =
      (left.project?.sort_order ?? 0) - (right.project?.sort_order ?? 0)
    return order !== 0 ? order : a.mainId - b.mainId
  })
  return slots.map(({ mainId, members }) => ({
    mainId,
    memberIds: members.map((member) => member.id),
  }))
}
