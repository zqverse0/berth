/** 每个 tab 组最多挂着的终端 xterm 数（含当前可见的；可见的多于此数时全部保留）；每个约 15 MB。 */
export const MAX_WARM_TERMINALS = 4

/**
 * 显示过的终端按最近显示排序（最近的在末尾），截到上限；当前可见的永不截掉。
 * 已退出、不可见的直接卸掉，再显示时由 termd 快照恢复。
 */
export function nextWarmTerminalIds(
  prev: readonly string[],
  liveIds: ReadonlySet<string>,
  shownIds: readonly string[],
  exitedIds: ReadonlySet<string>
): readonly string[] {
  const shown = new Set(shownIds)
  const next = [
    ...prev.filter(
      (id) => liveIds.has(id) && !shown.has(id) && !exitedIds.has(id)
    ),
    ...shown,
  ].slice(-Math.max(MAX_WARM_TERMINALS, shown.size))
  return next.length === prev.length && next.every((id, i) => id === prev[i])
    ? prev
    : next
}
