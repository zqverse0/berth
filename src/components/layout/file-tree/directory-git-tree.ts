import type { GitStatusEntry } from "@/lib/types"
import { classifyGitFileState } from "@/components/layout/file-tree/git-file-state"
import {
  isPathInDirectory,
  normalizeComparePath,
  normalizeGitStatusPath,
} from "@/components/layout/file-tree/path-utils"

export type DirectoryGitAction = "add" | "rollback"

export interface DirectoryGitCandidateEntry {
  path: string
  status: string
}

export type DirectoryGitTreeNode =
  | DirectoryGitTreeDirNode
  | DirectoryGitTreeFileNode

export interface DirectoryGitTreeDirNode {
  kind: "dir"
  name: string
  path: string
  children: DirectoryGitTreeNode[]
  fileCount: number
}

export interface DirectoryGitTreeFileNode {
  kind: "file"
  name: string
  path: string
  status: string
}

export interface MutableDirectoryGitTreeDirNode {
  kind: "dir"
  name: string
  path: string
  children: Map<
    string,
    MutableDirectoryGitTreeDirNode | DirectoryGitTreeFileNode
  >
}

export const DIRECTORY_GIT_TREE_ROOT_PATH = "__directory_git_tree_root__"

export function scopeGitStatusEntriesForDirectory(
  entries: GitStatusEntry[],
  directoryPath: string
): DirectoryGitCandidateEntry[] {
  const normalizedDirPath = normalizeComparePath(directoryPath)
  const scopedEntries: DirectoryGitCandidateEntry[] = []
  const dedupByPath = new Set<string>()

  for (const entry of entries) {
    const normalizedPath = normalizeComparePath(
      normalizeGitStatusPath(entry.file)
    )
    if (!normalizedPath) continue
    if (!isPathInDirectory(normalizedPath, normalizedDirPath)) continue
    if (normalizedPath === normalizedDirPath) continue
    if (dedupByPath.has(normalizedPath)) continue
    dedupByPath.add(normalizedPath)
    scopedEntries.push({ path: normalizedPath, status: entry.status })
  }

  return scopedEntries.sort((left, right) =>
    left.path.localeCompare(right.path, undefined, { sensitivity: "base" })
  )
}

export function filterDirectoryGitCandidates(
  entries: DirectoryGitCandidateEntry[],
  action: DirectoryGitAction
): DirectoryGitCandidateEntry[] {
  if (action === "add") {
    return entries.filter((entry) => {
      const fileState = classifyGitFileState(entry.status)
      return fileState === "untracked"
    })
  }

  return entries.filter((entry) => {
    const fileState = classifyGitFileState(entry.status)
    return fileState !== "untracked"
  })
}

export function buildDirectoryGitTree(
  entries: DirectoryGitCandidateEntry[],
  directoryPath: string
): DirectoryGitTreeNode[] {
  const normalizedDirPath = normalizeComparePath(directoryPath)
  const root: MutableDirectoryGitTreeDirNode = {
    kind: "dir",
    name: "",
    path: "",
    children: new Map(),
  }

  for (const entry of entries) {
    let relativePath = normalizeComparePath(entry.path)
    if (normalizedDirPath && relativePath.startsWith(`${normalizedDirPath}/`)) {
      relativePath = relativePath.slice(normalizedDirPath.length + 1)
    }
    const segments = relativePath.split("/").filter(Boolean)
    if (segments.length === 0) continue

    let current = root
    for (const [index, segment] of segments.entries()) {
      const isLeaf = index === segments.length - 1
      const nestedPath = segments.slice(0, index + 1).join("/")
      const nodePath = normalizedDirPath
        ? `${normalizedDirPath}/${nestedPath}`
        : nestedPath

      if (isLeaf) {
        current.children.set(`file:${nodePath}`, {
          kind: "file",
          name: segment,
          path: nodePath,
          status: entry.status,
        })
        continue
      }

      const dirKey = `dir:${nodePath}`
      const existing = current.children.get(dirKey)
      if (existing && existing.kind === "dir") {
        current = existing
        continue
      }

      const nextDir: MutableDirectoryGitTreeDirNode = {
        kind: "dir",
        name: segment,
        path: nodePath,
        children: new Map(),
      }
      current.children.set(dirKey, nextDir)
      current = nextDir
    }
  }

  const toSortedTreeNodes = (
    dir: MutableDirectoryGitTreeDirNode
  ): DirectoryGitTreeNode[] => {
    return Array.from(dir.children.values())
      .map<DirectoryGitTreeNode>((node) => {
        if (node.kind === "file") return node
        return {
          kind: "dir" as const,
          name: node.name,
          path: node.path,
          children: toSortedTreeNodes(node),
          fileCount: 0,
        }
      })
      .sort((left, right) => {
        if (left.kind !== right.kind) return left.kind === "dir" ? -1 : 1
        return left.name.localeCompare(right.name, undefined, {
          sensitivity: "base",
        })
      })
  }

  const annotateDirectory = (
    node: DirectoryGitTreeDirNode
  ): DirectoryGitTreeDirNode => {
    const nextChildren = node.children.map((child) => {
      if (child.kind === "file") return child
      return annotateDirectory(child)
    })
    const fileCount = nextChildren.reduce((count, child) => {
      if (child.kind === "file") return count + 1
      return count + child.fileCount
    }, 0)
    return {
      ...node,
      children: nextChildren,
      fileCount,
    }
  }

  return toSortedTreeNodes(root).map((node) => {
    if (node.kind === "file") return node
    return annotateDirectory(node)
  })
}

export function collectDirectoryGitTreeExpandedPaths(
  nodes: DirectoryGitTreeNode[],
  expanded = new Set<string>()
): Set<string> {
  for (const node of nodes) {
    if (node.kind !== "dir") continue
    expanded.add(node.path)
    collectDirectoryGitTreeExpandedPaths(node.children, expanded)
  }
  return expanded
}

export function collectDirectoryGitTreeLeafPaths(
  node: DirectoryGitTreeNode
): string[] {
  if (node.kind === "file") return [node.path]
  return node.children.flatMap(collectDirectoryGitTreeLeafPaths)
}

/**
 * Replace the native drag ghost with a compact labeled chip. The default ghost
 * is a snapshot of the dragged row, which — now that rows are full-width — reads
 * as a big translucent block with a drop shadow (WebKit) that obscures what's
 * being moved. A small off-screen chip is parked for the browser to snapshot,
 * then removed on the next tick. No-op outside the DOM.
 */
