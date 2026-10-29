import type { FileTreeNode } from "@/lib/types"

export function parentDir(filePath: string): string {
  const slashIndex = filePath.lastIndexOf("/")
  const backslashIndex = filePath.lastIndexOf("\\")
  const splitIndex = Math.max(slashIndex, backslashIndex)
  // No separator at all: the input is a leaf living at its root. For an
  // OS path that's a degenerate "C:" / "foo" — we can't navigate above
  // it, so the caller treated the result as the path itself. For a
  // workspace-relative path like "README.md" the answer is "workspace
  // root", encoded as empty string. The empty-string convention is the
  // safer default and matches what every caller currently expects.
  if (splitIndex < 0) return ""
  if (splitIndex === 0) return filePath.slice(0, 1)
  return filePath.slice(0, splitIndex)
}

export function baseName(path: string): string {
  return path.split(/[/\\]/).pop() || path
}

export function normalizeGitStatusPath(path: string): string {
  const normalized = path.trim()
  const renameSeparator = " -> "
  const renameIndex = normalized.lastIndexOf(renameSeparator)
  if (renameIndex < 0) return normalized
  return normalized.slice(renameIndex + renameSeparator.length).trim()
}

export function normalizeComparePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+$/, "")
}

/** Whether the dragged entry may move into `destDir` (relative; `""` = the
 *  workspace root). False when it's a no-op (already that parent) or would move
 *  a directory into itself or one of its own descendants. Pure so both the
 *  dragover highlight and the deferred desktop commit share one rule. */
export function canMoveEntry(
  source: { relPath: string; kind: "file" | "dir"; parentDir: string },
  destDir: string
): boolean {
  const dest = normalizeComparePath(destDir)
  const srcPath = normalizeComparePath(source.relPath)
  if (normalizeComparePath(source.parentDir) === dest) return false
  if (
    source.kind === "dir" &&
    (dest === srcPath || dest.startsWith(`${srcPath}/`))
  )
    return false
  return true
}

export function prefixFileTreeNodePaths(
  nodes: FileTreeNode[],
  prefix: string
): FileTreeNode[] {
  return nodes.map((node) => {
    const nextPath = prefix ? `${prefix}/${node.path}` : node.path
    if (node.kind === "file") {
      return {
        ...node,
        path: nextPath,
      }
    }
    return {
      ...node,
      path: nextPath,
      children: prefixFileTreeNodePaths(node.children, nextPath),
    }
  })
}

export function applyLazyTreeOverrides(
  nodes: FileTreeNode[],
  overrides: ReadonlyMap<string, FileTreeNode[]>
): FileTreeNode[] {
  return nodes.map((node) => {
    if (node.kind === "file") return node
    const overrideChildren = overrides.get(node.path)
    const baseChildren = overrideChildren ?? node.children
    return {
      ...node,
      children: applyLazyTreeOverrides(baseChildren, overrides),
    }
  })
}

export function findDirectoryChildren(
  nodes: FileTreeNode[],
  targetPath: string
): FileTreeNode[] | null {
  for (const node of nodes) {
    if (node.kind !== "dir") continue
    if (normalizeComparePath(node.path) === targetPath) {
      return node.children
    }
    const nested = findDirectoryChildren(node.children, targetPath)
    if (nested) return nested
  }
  return null
}

export function isPathInDirectory(
  path: string,
  directoryPath: string
): boolean {
  const normalizedPath = normalizeComparePath(path)
  const normalizedDir = normalizeComparePath(directoryPath)
  if (!normalizedDir) return normalizedPath.length > 0
  return (
    normalizedPath === normalizedDir ||
    normalizedPath.startsWith(`${normalizedDir}/`)
  )
}
