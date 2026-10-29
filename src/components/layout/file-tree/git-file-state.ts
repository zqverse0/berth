export type GitFileState =
  | "untracked"
  | "modified"
  | "staged"
  | "conflicted"
  | "deleted"
  | "renamed"

export interface GitFileDecoration {
  badge: "U" | "M" | "A" | "D" | "R" | "!"
  className: string
}

export function classifyGitFileState(status: string): GitFileState | null {
  const code = status.trim().toUpperCase()
  if (!code) return null
  if (code === "??") return "untracked"
  if (code.includes("U")) return "conflicted"
  if (code.includes("R") || code.includes("C")) return "renamed"
  if (code.includes("D")) return "deleted"
  if (code.includes("M") || code.includes("T")) return "modified"
  if (code.includes("A")) return "staged"
  return null
}

export function getGitFileStateClassName(status?: string): string {
  if (!status) return ""
  const state = classifyGitFileState(status)
  if (state === "untracked") return "text-emerald-600 dark:text-emerald-400"
  if (state === "modified") return "text-amber-600 dark:text-amber-400"
  if (state === "staged") return "text-emerald-500 dark:text-emerald-400"
  if (state === "conflicted") return "text-violet-600 dark:text-violet-400"
  if (state === "deleted") return "text-red-600 dark:text-red-400"
  if (state === "renamed") return "text-blue-600 dark:text-blue-400"
  return ""
}

export function getGitFileDecoration(
  status?: string
): GitFileDecoration | null {
  if (!status) return null
  const state = classifyGitFileState(status)
  const className = getGitFileStateClassName(status)
  if (state === "untracked") return { badge: "U", className }
  if (state === "modified") return { badge: "M", className }
  if (state === "staged") return { badge: "A", className }
  if (state === "deleted") return { badge: "D", className }
  if (state === "renamed") return { badge: "R", className }
  if (state === "conflicted") return { badge: "!", className }
  return null
}

const DIRECTORY_STATE_PRIORITY: GitFileState[] = [
  "conflicted",
  "deleted",
  "modified",
  "renamed",
  "staged",
  "untracked",
]

export function getDirectoryGitDecoration(
  statuses: readonly string[]
): GitFileDecoration | null {
  for (const state of DIRECTORY_STATE_PRIORITY) {
    const status = statuses.find(
      (candidate) => classifyGitFileState(candidate) === state
    )
    if (status) return getGitFileDecoration(status)
  }
  return null
}
