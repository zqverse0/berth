import type { FolderDetail } from "@/lib/types"

export type ProjectOrderInput = Pick<
  FolderDetail,
  "id" | "parent_id" | "pinned_at" | "sort_order" | "name"
>

/** 项目列表里的一行：`worktree` 决定图标与标签，`nested` 决定缩进与连接线。 */
export interface ProjectRowSlot {
  folderId: number
  worktree: boolean
  nested: boolean
}

function pinnedAtMs(value: string | null | undefined): number {
  const timestamp = Date.parse(value ?? "")
  return Number.isNaN(timestamp) ? 0 : timestamp
}

/**
 * Pinned folders first (most-recently pinned first), then unpinned folders by
 * `sort_order`.
 */
export function compareFoldersByPinThenOrder(
  left: Pick<FolderDetail, "id" | "pinned_at" | "sort_order">,
  right: Pick<FolderDetail, "id" | "pinned_at" | "sort_order">
): number {
  const leftPinned = left.pinned_at != null && left.pinned_at !== ""
  const rightPinned = right.pinned_at != null && right.pinned_at !== ""
  if (leftPinned !== rightPinned) return leftPinned ? -1 : 1
  if (leftPinned && rightPinned) {
    const pinnedDiff = pinnedAtMs(right.pinned_at) - pinnedAtMs(left.pinned_at)
    if (pinnedDiff !== 0) return pinnedDiff
    return right.id - left.id
  }
  if (left.sort_order !== right.sort_order) {
    return left.sort_order - right.sort_order
  }
  return left.id - right.id
}

/**
 * 打开的项目按显示顺序展开成行：顶层按置顶/排序；root 已打开的 worktree 跟在
 * 其 root 之后（sort_order → name → id）；置顶的 worktree 提到顶层单独显示；
 * root 不在列表里的孤儿 worktree 作为普通顶层项目。
 */
export function projectRowOrder(
  folders: readonly ProjectOrderInput[]
): ProjectRowSlot[] {
  const openIds = new Set(folders.map((f) => f.id))
  const isWorktree = (f: ProjectOrderInput) =>
    f.parent_id != null && openIds.has(f.parent_id)
  const isPinned = (f: ProjectOrderInput) =>
    f.pinned_at != null && f.pinned_at !== ""

  const children = new Map<number, ProjectOrderInput[]>()
  for (const f of folders) {
    if (!isWorktree(f) || isPinned(f)) continue
    const list = children.get(f.parent_id as number)
    if (list) list.push(f)
    else children.set(f.parent_id as number, [f])
  }

  const rows: ProjectRowSlot[] = []
  const topLevel = folders
    .filter((f) => !isWorktree(f) || isPinned(f))
    .sort(compareFoldersByPinThenOrder)
  for (const top of topLevel) {
    rows.push({ folderId: top.id, worktree: isWorktree(top), nested: false })
    const kids = (children.get(top.id) ?? []).sort((a, b) => {
      if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
      const byName = a.name.localeCompare(b.name)
      return byName !== 0 ? byName : a.id - b.id
    })
    for (const kid of kids) {
      rows.push({ folderId: kid.id, worktree: true, nested: true })
    }
  }
  return rows
}
