"use client"

import { lazy, Suspense, useCallback, useEffect, useMemo } from "react"
import { FileCode2, FileIcon } from "lucide-react"
import { editorDocumentRegistry } from "@/lib/editor/document-registry"
import { useTranslations } from "next-intl"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"
import { useDocumentContext } from "@/contexts/document-context"
import { useOptionalPointer } from "@/pointer"
import { sourceKindFromTab } from "@/lib/content-reference"
import { findOwningFolder } from "@/lib/files/file-open-target"
import { parseFileTabId } from "@/lib/files/file-tab-id"
import {
  useWorkspaceRuntimeActions,
  type FileWorkspaceTab,
} from "@/hooks/workspace/use-workspace-runtime"
import { fileTabsForFolderScope } from "@/lib/workspace/tab-scope"
import type { DiffViewerSelection } from "@/components/diff/diff-viewer"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
  isResourceFileTab,
  isTextFileTab,
} from "@/lib/files/file-workspace-tab"
import { PreviewSelectionLayer } from "@/components/content-reference/preview-selection-layer"
import {
  fileViewerKindFromTab,
  type FileViewerKind,
} from "@/lib/files/file-viewer-definition"
import { FileViewerHost } from "@/components/files/viewers/registry"
import {
  viewerFallback,
  ViewerLoading,
  ViewerLoadingBadge,
} from "@/components/files/viewers/viewer-states"

// 非文件文档的查看器懒加载（手写 lazy+Suspense，理由见 viewers/text-file-viewer.tsx）。
const LazyTaskDetail = lazy(() =>
  import("@/components/project-management/berth-tasks/task-detail").then(
    (m) => ({ default: m.TaskDetail })
  )
)
const LazyTranscriptReader = lazy(() =>
  import("@/sessions/components/transcript-reader").then((m) => ({
    default: m.TranscriptReader,
  }))
)
const LazyDiffViewer = lazy(() =>
  import("@/components/diff/diff-viewer").then((m) => ({
    default: m.DiffViewer,
  }))
)
const LazyUnifiedDiffPreview = lazy(() =>
  import("@/components/diff/unified-diff-preview").then((m) => ({
    default: m.UnifiedDiffPreview,
  }))
)

// Resource tabs own their renderer lifecycle and are ready even without text
// content. Text and diff tabs keep prior content visible during refresh; only
// a true cold load falls back to the full-pane placeholder.
function isTabRendererReady(tab: FileWorkspaceTab): boolean {
  if (isResourceFileTab(tab)) return true
  if (tab.kind === "transcript" || tab.kind === "task") return true
  if (tab.kind === "rich-diff") {
    return (
      tab.originalContent !== undefined || tab.modifiedContent !== undefined
    )
  }
  return tab.content !== ""
}

interface DiffOutlineFile {
  key: string
  path: string
  startLine: number
  endLine: number
  additions: number
  deletions: number
  hunks: DiffOutlineHunk[]
}

interface DiffOutlineHunk {
  key: string
  startLine: number
  endLine: number
  header: string
  additions: number
  deletions: number
}

interface DiffOutline {
  files: DiffOutlineFile[]
  totalAdditions: number
  totalDeletions: number
  totalHunks: number
}

type DiffListContext =
  | { kind: "commit"; commitHash: string; commitMessage: string | null }
  | { kind: "working"; path: string }
  | { kind: "branch"; branch: string; path: string }

function normalizeDiffPath(rawPath: string): string | null {
  const trimmed = rawPath.trim().replace(/^"|"$/g, "")
  if (!trimmed || trimmed === "/dev/null") return null

  if (trimmed.startsWith("a/") || trimmed.startsWith("b/")) {
    return trimmed.slice(2).replace(/\\/g, "/")
  }

  return trimmed.replace(/\\/g, "/")
}

function parsePathFromDiffGitLine(line: string): string | null {
  if (!line.startsWith("diff --git ")) return null
  const match = line.match(/^diff --git\s+(.+?)\s+(.+)$/)
  if (!match) return null

  return normalizeDiffPath(match[2]) ?? normalizeDiffPath(match[1])
}

function parsePathFromFileHeader(
  line: string,
  prefix: "--- " | "+++ "
): string | null {
  if (!line.startsWith(prefix)) return null
  return normalizeDiffPath(line.slice(prefix.length))
}

function parsePathFromApplyPatchLine(line: string): string | null {
  const prefixes = ["*** Update File: ", "*** Add File: ", "*** Delete File: "]

  for (const prefix of prefixes) {
    if (line.startsWith(prefix)) {
      return normalizeDiffPath(line.slice(prefix.length))
    }
  }

  return null
}

function parseMovedPathFromApplyPatchLine(line: string): string | null {
  if (!line.startsWith("*** Move to: ")) return null
  return normalizeDiffPath(line.slice(13))
}

function buildDiffOutline(content: string): DiffOutline | null {
  if (!content.trim()) return null

  const lines = content.split("\n")
  const files: DiffOutlineFile[] = []

  let current: DiffOutlineFile | null = null
  let currentHunk: {
    startLine: number
    header: string
    additions: number
    deletions: number
  } | null = null
  let fileIndex = 1
  let hunkIndex = 1

  const createFile = (
    lineNumber: number,
    path: string | null
  ): DiffOutlineFile => {
    const entry: DiffOutlineFile = {
      key: `${lineNumber}-${fileIndex}`,
      path: path ?? `Diff #${fileIndex}`,
      startLine: lineNumber,
      endLine: lineNumber,
      additions: 0,
      deletions: 0,
      hunks: [],
    }
    fileIndex += 1
    return entry
  }

  const flushHunk = (endLine: number) => {
    if (!current || !currentHunk) return

    const normalizedEnd = Math.max(currentHunk.startLine, endLine)
    current.hunks.push({
      key: `${current.key}:hunk-${hunkIndex}`,
      startLine: currentHunk.startLine,
      endLine: normalizedEnd,
      header: currentHunk.header,
      additions: currentHunk.additions,
      deletions: currentHunk.deletions,
    })
    hunkIndex += 1
    currentHunk = null
  }

  const flushFile = () => {
    if (!current) return

    if (currentHunk) {
      flushHunk(current.endLine)
    }

    if (
      current.hunks.length === 0 &&
      (current.additions > 0 || current.deletions > 0)
    ) {
      current.hunks.push({
        key: `${current.key}:hunk-${hunkIndex}`,
        startLine: current.startLine,
        endLine: current.endLine,
        header: "Change",
        additions: current.additions,
        deletions: current.deletions,
      })
      hunkIndex += 1
    }

    files.push(current)
    current = null
  }

  for (const [index, line] of lines.entries()) {
    const lineNumber = index + 1

    const diffGitPath = parsePathFromDiffGitLine(line)
    if (diffGitPath) {
      flushFile()
      current = createFile(lineNumber, diffGitPath)
      continue
    }

    const applyPatchPath = parsePathFromApplyPatchLine(line)
    if (applyPatchPath) {
      flushFile()
      current = createFile(lineNumber, applyPatchPath)
      continue
    }

    if (line.startsWith("--- ") && currentHunk) {
      flushHunk(lineNumber - 1)
    }

    const movedPath = parseMovedPathFromApplyPatchLine(line)
    if (movedPath && current) {
      current.path = movedPath
    }

    if (!current) {
      const minusPath = parsePathFromFileHeader(line, "--- ")
      if (minusPath) {
        current = createFile(lineNumber, minusPath)
      } else {
        const plusPath = parsePathFromFileHeader(line, "+++ ")
        if (plusPath) current = createFile(lineNumber, plusPath)
      }
    } else {
      const plusPath = parsePathFromFileHeader(line, "+++ ")
      if (plusPath) current.path = plusPath
    }

    if (!current) continue
    current.endLine = lineNumber

    if (line.startsWith("@@ ")) {
      if (currentHunk) {
        flushHunk(lineNumber - 1)
      }
      currentHunk = {
        startLine: lineNumber,
        header: line,
        additions: 0,
        deletions: 0,
      }
      continue
    }

    if (line.startsWith("+") && !line.startsWith("+++")) {
      current.additions += 1
      if (currentHunk) currentHunk.additions += 1
    }
    if (line.startsWith("-") && !line.startsWith("---")) {
      current.deletions += 1
      if (currentHunk) currentHunk.deletions += 1
    }
  }

  flushFile()

  if (files.length === 0) return null

  const totalAdditions = files.reduce((sum, file) => sum + file.additions, 0)
  const totalDeletions = files.reduce((sum, file) => sum + file.deletions, 0)
  const totalHunks = files.reduce((sum, file) => sum + file.hunks.length, 0)

  return {
    files,
    totalAdditions,
    totalDeletions,
    totalHunks,
  }
}

const EMPTY_DIFF_OUTLINE: DiffOutline = {
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  totalHunks: 0,
}

function DiffFileList({
  diffOutline,
  badge,
  description,
  onOpenDiff,
  openFilePreview,
  error,
}: {
  diffOutline: DiffOutline
  badge?: string | null
  description?: string | null
  onOpenDiff: (path: string) => Promise<void>
  openFilePreview: (path: string) => Promise<void>
  /** 读取失败的原因；没有改动时为空。 */
  error?: string | null
}) {
  const t = useTranslations("Folder.fileWorkspacePanel")
  return (
    <div className="h-full flex flex-col min-h-0">
      <div className="border-b border-border bg-muted/25 px-3 py-2 space-y-1">
        <div className="text-[11px] text-muted-foreground flex items-center gap-3">
          {badge && (
            <span className="font-medium text-foreground/80 font-mono">
              {badge}
            </span>
          )}
          <span>{t("fileCount", { count: diffOutline.files.length })}</span>
          <span className="font-mono text-green-600 dark:text-green-400">
            +{diffOutline.totalAdditions}
          </span>
          <span className="font-mono text-red-600 dark:text-red-400">
            -{diffOutline.totalDeletions}
          </span>
        </div>
        {description && (
          <p className="text-xs text-foreground/70 line-clamp-2 leading-snug">
            {description}
          </p>
        )}
      </div>
      <ScrollArea className="flex-1 min-h-0">
        <div className="py-1">
          {diffOutline.files.length === 0 ? (
            <p
              className={`px-3 py-2 text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}
            >
              {error ?? t("noDiffFiles")}
            </p>
          ) : null}
          {diffOutline.files.map((file) => (
            <ContextMenu key={file.key}>
              <ContextMenuTrigger asChild>
                <button
                  type="button"
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-muted/50 transition-colors group"
                  onClick={() => {
                    void onOpenDiff(file.path)
                  }}
                  title={file.path}
                >
                  <FileIcon className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  <span className="text-xs truncate flex-1 min-w-0 font-mono">
                    {file.path}
                  </span>
                  <span className="shrink-0 flex items-center gap-2 text-[10px] font-mono">
                    {file.additions > 0 && (
                      <span className="text-green-600 dark:text-green-400">
                        +{file.additions}
                      </span>
                    )}
                    {file.deletions > 0 && (
                      <span className="text-red-600 dark:text-red-400">
                        -{file.deletions}
                      </span>
                    )}
                  </span>
                </button>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem
                  onSelect={() => {
                    void onOpenDiff(file.path)
                  }}
                >
                  {t("viewDiff")}
                </ContextMenuItem>
                <ContextMenuItem
                  onSelect={() => {
                    void openFilePreview(file.path)
                  }}
                >
                  {t("openFile")}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
          ))}
        </div>
      </ScrollArea>
    </div>
  )
}

export function FileWorkspacePanel({
  tabId,
  visible = true,
  active = true,
}: {
  tabId?: string
  visible?: boolean
  active?: boolean
}) {
  const t = useTranslations("Folder.fileWorkspacePanel")
  const { activeFolderId } = useActiveFolder()
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const fileTabs = useWorkspaceFileStore((state) => state.fileTabs)
  const activeFileTabId = useWorkspaceFileStore(
    (state) => state.activeFileTabId
  )
  const previewFileTabIds = useWorkspaceFileStore(
    (state) => state.previewFileTabIds
  )
  const visibleFileTabs = useMemo(
    () => fileTabsForFolderScope(fileTabs, activeFolderId, allFolders),
    [activeFolderId, allFolders, fileTabs]
  )
  const contextActiveFileTab =
    visibleFileTabs.find((tab) => tab.id === activeFileTabId) ?? null
  const activeFileTab = tabId
    ? (fileTabs.find((tab) => tab.id === tabId) ?? null)
    : contextActiveFileTab
  const activeFileViewerKind: FileViewerKind | null =
    activeFileTab?.kind === "file" ? fileViewerKindFromTab(activeFileTab) : null
  const liveEditorDocumentIds = useMemo(
    () => new Set(fileTabs.map((tab) => `file-tab:${tab.id}`)),
    [fileTabs]
  )
  useEffect(() => {
    editorDocumentRegistry.retain(liveEditorDocumentIds, "file-tab:")
  }, [liveEditorDocumentIds])
  const {
    openBranchDiff,
    openCommitDiff,
    openFilePreview,
    openWorkingTreeDiff,
  } = useWorkspaceRuntimeActions()
  const { registerDocument, clearDocument } = useDocumentContext()
  const pointer = useOptionalPointer()
  const isTextPreviewMode = Boolean(
    activeFileTab &&
    isTextFileTab(activeFileTab) &&
    previewFileTabIds.has(activeFileTab.id) &&
    activeFileViewerKind === "html"
  )

  const contentSourceKind = useMemo(() => {
    if (!activeFileTab) return null
    return sourceKindFromTab(activeFileTab, {
      previewMode: isTextPreviewMode,
    })
  }, [activeFileTab, isTextPreviewMode])

  // Register the active left-pane document through the single document
  // context seam. Clean text files are re-read from disk by the provider;
  // dirty buffers and synthetic diffs carry their current snapshot.
  const currentDocumentContext = useMemo(() => {
    if (!activeFileTab) return null
    const owningFolder =
      activeFileTab.kind === "file"
        ? findOwningFolder(activeFileTab.path, allFolders)
        : null

    if (isTextFileTab(activeFileTab)) {
      return {
        id: `file:${activeFileTab.path}`,
        kind: contentSourceKind ?? activeFileTab.previewKind,
        title: activeFileTab.title,
        path: activeFileTab.path,
        displayPath: owningFolder?.relPath ?? activeFileTab.path,
        mime: null,
        content: activeFileTab.isDirty ? activeFileTab.content : null,
        revision: activeFileTab.isDirty
          ? "dirty"
          : activeFileTab.mtimeMs === null
            ? null
            : String(activeFileTab.mtimeMs),
      }
    }

    if (isResourceFileTab(activeFileTab)) {
      return {
        id: `file:${activeFileTab.path}`,
        kind: activeFileTab.preview.kind,
        title: activeFileTab.title,
        path: activeFileTab.path,
        displayPath: owningFolder?.relPath ?? activeFileTab.path,
        mime: null,
        content: null,
        revision: String(activeFileTab.preview.revision),
      }
    }

    if (activeFileTab.kind === "diff" || activeFileTab.kind === "rich-diff") {
      const content =
        activeFileTab.kind === "diff"
          ? activeFileTab.content
          : [
              "=== Original ===",
              activeFileTab.originalContent ?? "",
              "",
              "=== Modified ===",
              activeFileTab.modifiedContent ?? activeFileTab.content,
            ].join("\n")
      return {
        id: `diff:${activeFileTab.id}`,
        kind: activeFileTab.kind,
        title: activeFileTab.title,
        path: activeFileTab.path,
        displayPath: activeFileTab.path,
        mime: "text/plain",
        content,
        revision: null,
      }
    }

    return null
  }, [activeFileTab, allFolders, contentSourceKind])

  useEffect(() => {
    if (!active) return
    if (currentDocumentContext) registerDocument(currentDocumentContext)
    else clearDocument()
  }, [
    active,
    activeFileTab?.kind,
    clearDocument,
    currentDocumentContext,
    registerDocument,
  ])

  // ponytail: rich-diff tab 的 kind 不是 file，这里恒为 null，diff 选区实际从不上报；
  // 待 diff 模块拆分时按 tab.path + folder 解析出绝对路径再修。
  const activeAbsPath =
    activeFileTab?.kind === "file" ? (activeFileTab.path ?? null) : null
  const addDiffSelectionToChat = useCallback(
    (selection: DiffViewerSelection | null) => {
      if (!selection || !activeAbsPath) {
        pointer?.reportSelection(null)
        return
      }
      pointer?.reportSelection({
        excerpt: selection.text,
        editable: false,
        source: {
          identity: { type: "file", path: activeAbsPath },
          span: selection.range
            ? {
                unit: "lines",
                start: selection.range.start,
                end: selection.range.end,
              }
            : undefined,
          excerpt: selection.text,
        },
      })
    },
    [activeAbsPath, pointer]
  )
  const diffListContext = useMemo<DiffListContext | null>(() => {
    if (!activeFileTab) return null
    if (activeFileTab.kind !== "diff") return null

    const parts = parseFileTabId(activeFileTab.id)
    if (!parts) return null

    if (parts.kind === "diff-commit" && parts.path === null) {
      return {
        kind: "commit",
        commitHash: parts.commit,
        commitMessage: activeFileTab.description,
      }
    }

    if (parts.kind === "diff-working-overview") {
      return { kind: "working", path: parts.path }
    }

    if (parts.kind === "diff-branch-overview") {
      return {
        kind: "branch",
        branch: parts.branch,
        path: parts.path ?? "all",
      }
    }

    return null
  }, [activeFileTab])
  const diffOutline = useMemo(() => {
    if (!activeFileTab || activeFileTab.kind !== "diff") return null
    return buildDiffOutline(activeFileTab.content)
  }, [activeFileTab])

  useEffect(
    () => () => {
      pointer?.reportSelection(null)
    },
    [pointer]
  )

  if (!activeFileTab) {
    return (
      <div className="h-full flex flex-col items-center justify-center text-center px-6">
        <FileCode2 className="h-8 w-8 text-muted-foreground/60 mb-3" />
        <p className="text-sm text-muted-foreground">{t("openFileOrDiff")}</p>
      </div>
    )
  }

  if (activeFileTab.kind === "transcript") {
    return (
      <Suspense fallback={viewerFallback}>
        <LazyTranscriptReader key={activeFileTab.id} tab={activeFileTab} />
      </Suspense>
    )
  }

  if (activeFileTab.kind === "task") {
    return (
      <Suspense fallback={viewerFallback}>
        <LazyTaskDetail key={activeFileTab.id} tab={activeFileTab} />
      </Suspense>
    )
  }

  if (activeFileTab.kind === "rich-diff") {
    const richDiffParts = parseFileTabId(activeFileTab.id)
    const isCommitDiff = richDiffParts?.kind === "diff-commit"
    const isExternalConflictDiff =
      richDiffParts?.kind === "diff-external-conflict"
    const commitHash =
      richDiffParts?.kind === "diff-commit"
        ? richDiffParts.commit.slice(0, 7)
        : ""
    const origLabel = isCommitDiff
      ? `${commitHash}~1`
      : isExternalConflictDiff
        ? t("disk")
        : t("head")
    const modLabel = isCommitDiff
      ? commitHash
      : isExternalConflictDiff
        ? t("unsaved")
        : t("workingTree")

    const richDiffColdLoad =
      activeFileTab.loading && !isTabRendererReady(activeFileTab)
    return (
      <div className="h-full relative">
        {activeFileTab.loading && <ViewerLoadingBadge />}
        {richDiffColdLoad ? (
          <ViewerLoading />
        ) : (
          <Suspense fallback={viewerFallback}>
            <LazyDiffViewer
              key={activeFileTab.id}
              original={activeFileTab.originalContent ?? ""}
              modified={activeFileTab.modifiedContent ?? ""}
              originalLabel={origLabel}
              modifiedLabel={modLabel}
              language={activeFileTab.language}
              className="h-full"
              onSelection={addDiffSelectionToChat}
            />
          </Suspense>
        )}
      </div>
    )
  }

  if (
    activeFileTab.kind === "diff" &&
    activeFileTab.id.startsWith("diff:session:")
  ) {
    const sessionDiffColdLoad =
      activeFileTab.loading && !isTabRendererReady(activeFileTab)
    return (
      <div className="h-full relative">
        {activeFileTab.loading && <ViewerLoadingBadge />}
        {sessionDiffColdLoad ? (
          <ViewerLoading />
        ) : (
          <PreviewSelectionLayer
            className="h-full min-h-0"
            fileName={activeFileTab.title}
            documentKind={activeFileTab.kind}
            sourceContent={activeFileTab.content}
            useRegisteredDocument
          >
            <Suspense fallback={viewerFallback}>
              <LazyUnifiedDiffPreview
                diffText={activeFileTab.content}
                className="h-full p-3"
              />
            </Suspense>
          </PreviewSelectionLayer>
        )}
      </div>
    )
  }

  // Diff overview list view (commit / directory)
  // 没有改动时也走总览：显示「没有改动」，不留空白页。
  if (diffListContext) {
    const badge =
      diffListContext.kind === "commit"
        ? diffListContext.commitHash.slice(0, 7)
        : diffListContext.kind === "branch"
          ? diffListContext.branch
          : t("workingTree")

    const description =
      diffListContext.kind === "commit"
        ? diffListContext.commitMessage
        : diffListContext.kind === "branch"
          ? t("compareWithBranch", {
              path: diffListContext.path,
              branch: diffListContext.branch,
            })
          : (activeFileTab.description ?? diffListContext.path)

    // Per-file diffs opened from an overview belong to the overview tab's
    // folder — pass it explicitly so a background-folder overview never
    // routes its rows through the active folder. (Diff tabs always carry a
    // numeric folderId; the ?? undefined only satisfies the option type.)
    const overviewFolderId = activeFileTab.folderId ?? undefined
    const handleOpenDiff = async (path: string) => {
      if (diffListContext.kind === "commit") {
        await openCommitDiff(diffListContext.commitHash, path, undefined, {
          folderId: overviewFolderId,
        })
        return
      }

      if (diffListContext.kind === "branch") {
        await openBranchDiff(diffListContext.branch, path, {
          folderId: overviewFolderId,
        })
        return
      }

      await openWorkingTreeDiff(path, { folderId: overviewFolderId })
    }

    const diffListColdLoad =
      activeFileTab.loading && !isTabRendererReady(activeFileTab)
    return (
      <div className="h-full relative">
        {activeFileTab.loading && <ViewerLoadingBadge />}
        {diffListColdLoad ? (
          <ViewerLoading />
        ) : (
          <DiffFileList
            diffOutline={diffOutline ?? EMPTY_DIFF_OUTLINE}
            error={
              activeFileTab.kind === "diff" && activeFileTab.saveError
                ? activeFileTab.content
                : null
            }
            badge={badge}
            description={description}
            onOpenDiff={handleOpenDiff}
            openFilePreview={(path) =>
              // Rows belong to the overview tab's folder — never the
              // active workspace folder.
              openFilePreview(path, { folderId: overviewFolderId })
            }
          />
        )}
      </div>
    )
  }

  if (activeFileViewerKind) {
    return (
      <FileViewerHost
        kind={activeFileViewerKind}
        tab={activeFileTab}
        visible={visible}
        active={active}
      />
    )
  }

  return null
}
