/** `+12 −3`：改动行数。0/0 不显示（未跟踪文件不进 numstat，0/0 不代表没改）。 */
export function LineCounts({
  additions,
  deletions,
}: {
  additions: number
  deletions: number
}) {
  if (additions === 0 && deletions === 0) return null
  return (
    <span className="shrink-0 font-mono text-[11px] whitespace-nowrap">
      <span className="text-green-700 dark:text-green-400">+{additions}</span>{" "}
      <span className="text-red-700 dark:text-red-400">−{deletions}</span>
    </span>
  )
}
