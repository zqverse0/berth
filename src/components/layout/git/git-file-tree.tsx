"use client"

import { type ReactElement, useCallback, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronsDownUp, ChevronsUpDown } from "lucide-react"
import { CommitFiles } from "@/components/ai-elements/commit"
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "@/components/ai-elements/file-tree"
import { Button } from "@/components/ui/button"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  getDirectoryGitDecoration,
  getGitFileDecoration,
  getGitFileStateClassName,
} from "@/components/layout/file-tree/git-file-state"
import { cn } from "@/lib/utils"
import type { GitLogFileChange } from "@/lib/types"

/**
 * 提交详情与「变更」视图共用的文件树：按目录分组、单子目录链压缩、
 * 状态颜色与角标复用文件树目录的 `git-file-state`（文件名着色 + 右侧 U/M/A/D/R，
 * 目录取子孙里优先级最高的状态），点击看 diff，右键「查看差异 / 打开文件」。
 */

type GitFileTreeDirNode = {
  kind: "dir"
  name: string
  path: string
  children: GitFileTreeNode[]
}

type GitFileTreeFileNode = {
  kind: "file"
  name: string
  path: string
  change: GitLogFileChange
}

type GitFileTreeNode = GitFileTreeDirNode | GitFileTreeFileNode

interface MutableGitFileTreeDirNode {
  kind: "dir"
  name: string
  path: string
  children: Map<string, MutableGitFileTreeDirNode | GitFileTreeFileNode>
}

function normalizePathSegments(path: string): string[] {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
  if (!normalized) return []
  return normalized.split("/").filter(Boolean)
}

function toSortedTreeNodes(dir: MutableGitFileTreeDirNode): GitFileTreeNode[] {
  return Array.from(dir.children.values())
    .map<GitFileTreeNode>((node) => {
      if (node.kind === "file") return node
      return {
        kind: "dir" as const,
        name: node.name,
        path: node.path,
        children: toSortedTreeNodes(node),
      }
    })
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" })
    })
}

// 合并 "dir/dir/dir" 链：目录只有一个子目录时并成一行。
function compressDir(node: GitFileTreeDirNode): GitFileTreeDirNode {
  let next: GitFileTreeDirNode = {
    ...node,
    children: node.children.map((child) =>
      child.kind === "file" ? child : compressDir(child)
    ),
  }
  while (next.children.length === 1 && next.children[0].kind === "dir") {
    const only = next.children[0]
    next = { ...only, name: `${next.name}/${only.name}` }
  }
  return next
}

function buildGitFileTree(files: GitLogFileChange[]): GitFileTreeNode[] {
  const root: MutableGitFileTreeDirNode = {
    kind: "dir",
    name: "",
    path: "",
    children: new Map(),
  }

  for (const change of files) {
    const segments = normalizePathSegments(change.path)
    if (segments.length === 0) continue

    let current = root
    for (const [index, segment] of segments.entries()) {
      const nodePath = segments.slice(0, index + 1).join("/")
      const isLeaf = index === segments.length - 1

      if (isLeaf) {
        current.children.set(`file:${nodePath}`, {
          kind: "file",
          name: segment,
          path: nodePath,
          change,
        })
        continue
      }

      const dirKey = `dir:${nodePath}`
      const existing = current.children.get(dirKey)
      if (existing && existing.kind === "dir") {
        current = existing
        continue
      }

      const nextDir: MutableGitFileTreeDirNode = {
        kind: "dir",
        name: segment,
        path: nodePath,
        children: new Map(),
      }
      current.children.set(dirKey, nextDir)
      current = nextDir
    }
  }

  const sortedNodes = toSortedTreeNodes(root)
  return sortedNodes.map((node) => {
    if (node.kind === "file") return node
    return compressDir(node)
  })
}

function collectExpandedDirectoryPaths(
  nodes: GitFileTreeNode[],
  expanded = new Set<string>()
): Set<string> {
  for (const node of nodes) {
    if (node.kind !== "dir") continue
    expanded.add(node.path)
    collectExpandedDirectoryPaths(node.children, expanded)
  }
  return expanded
}

function collectStatuses(node: GitFileTreeNode, out: string[] = []): string[] {
  if (node.kind === "file") out.push(node.change.status)
  else node.children.forEach((child) => collectStatuses(child, out))
  return out
}

export function GitFileTree({
  files,
  folderName,
  onOpenDiff,
  onOpenFilePreview,
  className,
  defaultCollapsed = false,
}: {
  files: GitLogFileChange[]
  folderName: string
  onOpenDiff: (path: string) => void
  onOpenFilePreview: (path: string) => void
  /** 覆盖树容器样式（默认 max-h-[32rem] 适合嵌在提交详情里）。 */
  className?: string
  /** 仅展开根目录，子目录默认折叠；文件列表刷新时保留用户的展开状态。 */
  defaultCollapsed?: boolean
}) {
  const t = useTranslations("Folder.gitLogTab")
  const tCommon = useTranslations("Folder.common")
  const rootPath = "__commit_file_tree_root__"
  const treeNodes = useMemo(() => buildGitFileTree(files), [files])
  const allDirectoryPaths = useMemo(() => {
    const paths = collectExpandedDirectoryPaths(treeNodes)
    paths.add(rootPath)
    return paths
  }, [treeNodes])
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
    defaultCollapsed ? new Set([rootPath]) : allDirectoryPaths
  )

  // 文件列表变化时（渲染期同步，避免 effect 里 setState）重置为全展开；
  // defaultCollapsed 模式保留用户当前的展开状态。
  const [prevPaths, setPrevPaths] = useState(allDirectoryPaths)
  if (prevPaths !== allDirectoryPaths) {
    setPrevPaths(allDirectoryPaths)
    if (!defaultCollapsed) setExpandedPaths(allDirectoryPaths)
  }

  const canExpandAll = useMemo(() => {
    if (allDirectoryPaths.size === 0) return false
    for (const path of allDirectoryPaths) {
      if (!expandedPaths.has(path)) return true
    }
    return false
  }, [allDirectoryPaths, expandedPaths])

  const canCollapseAll = expandedPaths.size > 0

  const toggleExpanded = useCallback(() => {
    if (canExpandAll) {
      setExpandedPaths(new Set(allDirectoryPaths))
      return
    }
    setExpandedPaths(new Set())
  }, [allDirectoryPaths, canExpandAll])

  const renderNode = (node: GitFileTreeNode): ReactElement => {
    if (node.kind === "dir") {
      const dirDecoration = getDirectoryGitDecoration(collectStatuses(node))
      return (
        <FileTreeFolder
          key={node.path}
          path={node.path}
          name={node.name}
          nameClassName={dirDecoration?.className}
          suffix={dirDecoration?.badge}
          suffixClassName={dirDecoration?.className}
          title={node.path}
        >
          {node.children.map(renderNode)}
        </FileTreeFolder>
      )
    }

    const file = node.change
    const decoration = getGitFileDecoration(file.status)
    const hasCounts = file.additions > 0 || file.deletions > 0
    return (
      <ContextMenu key={file.path}>
        <ContextMenuTrigger>
          <FileTreeFile
            className={cn(
              "w-full min-w-0 cursor-pointer",
              getGitFileStateClassName(file.status)
            )}
            name={node.name}
            onClick={() => {
              void onOpenDiff(file.path)
            }}
            path={node.path}
            title={file.path}
            suffix={
              hasCounts || decoration ? (
                <span className="flex items-center gap-1.5">
                  {file.additions > 0 ? (
                    <span className="text-emerald-600 dark:text-emerald-400">
                      +{file.additions}
                    </span>
                  ) : null}
                  {file.deletions > 0 ? (
                    <span className="text-red-600 dark:text-red-400">
                      -{file.deletions}
                    </span>
                  ) : null}
                  {decoration ? (
                    <span className={decoration.className}>
                      {decoration.badge}
                    </span>
                  ) : null}
                </span>
              ) : null
            }
          />
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuItem
            onSelect={() => {
              void onOpenDiff(file.path)
            }}
          >
            {tCommon("viewDiff")}
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => {
              void onOpenFilePreview(file.path)
            }}
          >
            {tCommon("openFile")}
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>
    )
  }

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <p className="text-[11px] text-muted-foreground">{t("filesTitle")}</p>
        <div className="flex items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            className="size-5"
            onClick={toggleExpanded}
            disabled={!canExpandAll && !canCollapseAll}
            title={canExpandAll ? t("expandAllFiles") : t("collapseAllFiles")}
            aria-label={
              canExpandAll ? t("expandAllFiles") : t("collapseAllFiles")
            }
          >
            {canExpandAll ? (
              <ChevronsUpDown className="size-3.5" />
            ) : (
              <ChevronsDownUp className="size-3.5" />
            )}
          </Button>
        </div>
      </div>
      <CommitFiles>
        <FileTree
          className={cn(
            "max-h-[32rem] overflow-auto rounded-md border-border/60 bg-transparent text-xs [&>div]:p-1",
            className
          )}
          expanded={expandedPaths}
          onExpandedChange={setExpandedPaths}
        >
          <FileTreeFolder
            path={rootPath}
            name={folderName}
            suffix={`(${files.length})`}
            suffixClassName="text-muted-foreground/45"
            title={folderName}
          >
            {treeNodes.map(renderNode)}
          </FileTreeFolder>
        </FileTree>
      </CommitFiles>
    </div>
  )
}
