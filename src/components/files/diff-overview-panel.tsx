"use client"

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useState,
} from "react"
import {
  Check,
  ChevronDown,
  ChevronRight,
  FileIcon,
  Loader2,
  Lock,
  MessageSquareText,
  Pencil,
  X,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { gitCommit, gitLog } from "@/lib/api"
import { useDiffOverviewStatusStore } from "@/lib/files/diff-overview-status"
import type { GitLogEntry } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { ScrollArea } from "@/components/ui/scroll-area"
import { SplitHandle, SplitPane, SplitView } from "@/components/ui/split-view"
import { viewerFallback } from "@/components/files/viewers/viewer-states"

const LazyUnifiedDiffPreview = lazy(() =>
  import("@/components/diff/unified-diff-preview").then((m) => ({
    default: m.UnifiedDiffPreview,
  }))
)

export interface DiffOutlineHunk {
  key: string
  startLine: number
  endLine: number
  header: string
  additions: number
  deletions: number
}

export interface DiffOutlineFile {
  key: string
  path: string
  startLine: number
  endLine: number
  additions: number
  deletions: number
  hunks: DiffOutlineHunk[]
}

export interface DiffOutline {
  files: DiffOutlineFile[]
  totalAdditions: number
  totalDeletions: number
  totalHunks: number
}

export type DiffListContext =
  | { kind: "commit"; commitHash: string; commitMessage: string | null }
  | { kind: "working"; path: string }
  | { kind: "branch"; branch: string; path: string }

export const EMPTY_DIFF_OUTLINE: DiffOutline = {
  files: [],
  totalAdditions: 0,
  totalDeletions: 0,
  totalHunks: 0,
}

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

export function buildDiffOutline(content: string): DiffOutline | null {
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

/** 按 1-based 行号范围从完整 unified diff 中切出单个文件的片段。 */
export function sliceDiffLines(
  lines: readonly string[],
  startLine: number,
  endLine: number
): string {
  const from = Math.max(0, startLine - 1)
  const to = Math.min(lines.length, Math.max(from, endLine))
  return lines.slice(from, to).join("\n")
}

/** 将提交信息拆成首行标题与可选多行正文。 */
function splitCommitMessage(message: string): {
  subject: string
  body: string
} {
  const normalized = message.replace(/\r\n/g, "\n").trimEnd()
  const newlineIndex = normalized.indexOf("\n")
  if (newlineIndex < 0) {
    return { subject: normalized, body: "" }
  }
  const subject = normalized.slice(0, newlineIndex)
  const body = normalized.slice(newlineIndex + 1).replace(/^\n+/, "")
  return { subject, body }
}

interface CommitMetaState {
  loading: boolean
  entry: GitLogEntry | null
  isHead: boolean
}

export function DiffOverviewPanel({
  tabId,
  diffContent,
  diffOutline,
  context,
  folderId,
  folderPath,
  badge,
  description,
  onOpenDiffInNewTab,
  openFilePreview,
  onCommitAmended,
  onRefresh,
  error,
}: {
  tabId: string
  diffContent: string
  diffOutline: DiffOutline
  context: DiffListContext
  folderId: number | null
  folderPath: string | null
  badge?: string | null
  description?: string | null
  onOpenDiffInNewTab: (path: string) => Promise<void>
  openFilePreview: (path: string) => Promise<void>
  onCommitAmended?: (newHash: string, newMessage: string) => Promise<void>
  onRefresh?: () => void
  /** 读取失败的原因；没有改动时为空。 */
  error?: string | null
}) {
  const t = useTranslations("Folder.fileWorkspacePanel")
  const commitHash = context.kind === "commit" ? context.commitHash : null

  const diffLines = useMemo(() => diffContent.split("\n"), [diffContent])
  const [fileFilter, setFileFilter] = useState("")

  const filteredFiles = useMemo(() => {
    const query = fileFilter.trim().toLowerCase()
    if (!query) return diffOutline.files
    return diffOutline.files.filter((file) =>
      file.path.toLowerCase().includes(query)
    )
  }, [diffOutline.files, fileFilter])

  // 单文件变更默认展开，多文件变更默认折叠，由用户点击逐个展开或通过顶栏全部展开。
  const [expandedKeys, setExpandedKeys] = useState<ReadonlySet<string>>(() =>
    diffOutline.files.length === 1
      ? new Set([diffOutline.files[0].key])
      : new Set()
  )

  const toggleFile = useCallback((key: string) => {
    setExpandedKeys((prev) => {
      const next = new Set(prev)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }, [])

  const allExpanded =
    filteredFiles.length > 0 &&
    filteredFiles.every((file) => expandedKeys.has(file.key))

  const toggleAllFiles = useCallback(() => {
    setExpandedKeys((prev) => {
      if (
        filteredFiles.length > 0 &&
        filteredFiles.every((file) => prev.has(file.key))
      ) {
        return new Set()
      }
      return new Set(filteredFiles.map((file) => file.key))
    })
  }, [filteredFiles])

  // 加载 commit 完整元信息（完整多行提交信息、作者、时间、是否 HEAD 与推送状态）。
  const [commitMeta, setCommitMeta] = useState<CommitMetaState>(() => ({
    loading: Boolean(commitHash && folderPath),
    entry: null,
    isHead: false,
  }))

  // 原地编辑提交信息的状态。
  const [editing, setEditing] = useState(false)
  const [draftMessage, setDraftMessage] = useState("")
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)

  useEffect(() => {
    if (!commitHash || !folderPath) return
    let cancelled = false

    const load = async () => {
      try {
        const headResult = await gitLog(
          folderPath,
          1,
          undefined,
          undefined,
          undefined,
          undefined,
          false,
          false
        )
        if (cancelled) return

        const headEntry = headResult.entries[0] ?? null
        if (headEntry && headEntry.full_hash === commitHash) {
          setCommitMeta({ loading: false, entry: headEntry, isHead: true })
          return
        }

        const targetResult = await gitLog(
          folderPath,
          1,
          commitHash,
          undefined,
          undefined,
          undefined,
          false,
          false
        )
        if (cancelled) return

        setCommitMeta({
          loading: false,
          entry: targetResult.entries[0] ?? null,
          isHead: false,
        })
      } catch {
        if (!cancelled) {
          setCommitMeta({ loading: false, entry: null, isHead: false })
        }
      }
    }

    void load()
    return () => {
      cancelled = true
    }
  }, [commitHash, folderPath])

  const fullCommitMessage = useMemo(() => {
    if (context.kind !== "commit") return null
    return commitMeta.entry?.message ?? context.commitMessage ?? ""
  }, [commitMeta.entry?.message, context])

  const parsedCommitMessage = useMemo(
    () =>
      fullCommitMessage !== null ? splitCommitMessage(fullCommitMessage) : null,
    [fullCommitMessage]
  )

  const canEditCommit = Boolean(
    context.kind === "commit" &&
    folderPath &&
    commitMeta.entry &&
    commitMeta.isHead &&
    commitMeta.entry.pushed !== true
  )

  const editDisabledReason = useMemo(() => {
    if (context.kind !== "commit" || commitMeta.loading || !commitMeta.entry) {
      return null
    }
    if (commitMeta.entry.pushed === true) return t("commitEditDisabledPushed")
    if (!commitMeta.isHead) return t("commitEditDisabledNotHead")
    return null
  }, [commitMeta.entry, commitMeta.isHead, commitMeta.loading, context.kind, t])

  const handleStartEdit = useCallback(() => {
    if (!canEditCommit) return
    setDraftMessage(fullCommitMessage ?? "")
    setSaveError(null)
    setEditing(true)
  }, [canEditCommit, fullCommitMessage])

  const handleCancelEdit = useCallback(() => {
    setEditing(false)
    setSaveError(null)
  }, [])

  // 同步标号、增删统计到最下方全局状态栏，同时把展开/筛选/刷新操作注册到顶部统一工具栏。
  useEffect(() => {
    const statusBadge =
      badge ??
      (context.kind === "commit"
        ? context.commitHash.slice(0, 7)
        : context.kind === "branch"
          ? context.branch
          : t("workingTree"))
    const copyText =
      context.kind === "commit"
        ? (commitMeta.entry?.full_hash ?? context.commitHash)
        : context.path

    useDiffOverviewStatusStore.getState().setStatus(tabId, {
      kind: context.kind,
      badge: statusBadge,
      copyText,
      description: context.kind === "commit" ? null : (description ?? null),
      fileCount: diffOutline.files.length,
      additions: diffOutline.totalAdditions,
      deletions: diffOutline.totalDeletions,
      author: commitMeta.entry?.author ?? null,
      date: commitMeta.entry?.date ?? null,
      pushed: commitMeta.entry?.pushed ?? null,
      allExpanded,
      fileFilter,
      onToggleAllFiles: toggleAllFiles,
      onFileFilterChange: setFileFilter,
      onRefresh,
    })

    return () => {
      useDiffOverviewStatusStore.getState().clearStatus(tabId)
    }
  }, [
    allExpanded,
    badge,
    commitMeta.entry,
    context,
    description,
    diffOutline.files.length,
    diffOutline.totalAdditions,
    diffOutline.totalDeletions,
    fileFilter,
    onRefresh,
    t,
    tabId,
    toggleAllFiles,
  ])

  const handleSaveEdit = useCallback(async () => {
    if (!folderPath || !canEditCommit || saving) return
    const trimmed = draftMessage.trim()
    if (!trimmed) {
      setSaveError(t("commitMessageEmpty"))
      return
    }
    if (trimmed === (fullCommitMessage ?? "").trim()) {
      setEditing(false)
      setSaveError(null)
      return
    }

    setSaving(true)
    setSaveError(null)
    try {
      const result = await gitCommit(folderPath, trimmed, [], folderId, true)
      const nextHash = result.hash || commitHash || ""
      setCommitMeta((prev) =>
        prev.entry
          ? {
              ...prev,
              entry: {
                ...prev.entry,
                message: trimmed,
                full_hash: nextHash || prev.entry.full_hash,
                hash: nextHash ? nextHash.slice(0, 7) : prev.entry.hash,
              },
            }
          : prev
      )
      setEditing(false)
      if (nextHash && onCommitAmended) {
        await onCommitAmended(nextHash, trimmed)
      }
    } catch (err) {
      setSaveError(
        err instanceof Error && err.message
          ? err.message
          : t("commitMessageSaveFailed")
      )
    } finally {
      setSaving(false)
    }
  }, [
    canEditCommit,
    commitHash,
    draftMessage,
    folderId,
    folderPath,
    fullCommitMessage,
    onCommitAmended,
    saving,
    t,
  ])

  const isCommitDiff = context.kind === "commit"

  const filesSection = (
    <section
      aria-label={t("changedFilesHeading")}
      className="flex h-full min-h-0 flex-col"
    >
      <ScrollArea className="h-full min-h-0 flex-1">
        <div className="divide-y divide-border/40">
          {diffOutline.files.length === 0 ? (
            <p
              className={`px-4 py-4 text-xs ${error ? "text-destructive" : "text-muted-foreground"}`}
            >
              {error ?? t("noDiffFiles")}
            </p>
          ) : filteredFiles.length === 0 ? (
            <p className="px-4 py-4 text-xs text-muted-foreground">
              {t("noMatchingDiffFiles")}
            </p>
          ) : null}
          {filteredFiles.map((file) => {
            const isExpanded = expandedKeys.has(file.key)
            return (
              <div key={file.key}>
                <ContextMenu>
                  <ContextMenuTrigger asChild>
                    <button
                      type="button"
                      aria-expanded={isExpanded}
                      className={cn(
                        "group flex w-full items-center gap-1.5 px-3.5 py-2 text-left transition-colors hover:bg-muted/50",
                        isExpanded && "bg-muted/30"
                      )}
                      onClick={() => toggleFile(file.key)}
                      title={file.path}
                    >
                      {isExpanded ? (
                        <ChevronDown className="size-3.5 shrink-0 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="size-3.5 shrink-0 text-muted-foreground" />
                      )}
                      <FileIcon className="size-3.5 shrink-0 text-muted-foreground" />
                      <span className="min-w-0 flex-1 truncate font-mono text-xs">
                        {file.path}
                      </span>
                      <span className="flex shrink-0 items-center gap-2 font-mono text-[10px]">
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
                    <ContextMenuItem onSelect={() => toggleFile(file.key)}>
                      {isExpanded ? t("collapseDiff") : t("expandDiff")}
                    </ContextMenuItem>
                    <ContextMenuItem
                      onSelect={() => {
                        void openFilePreview(file.path)
                      }}
                    >
                      {t("openFile")}
                    </ContextMenuItem>
                    <ContextMenuItem
                      onSelect={() => {
                        void onOpenDiffInNewTab(file.path)
                      }}
                    >
                      {t("openDiffInNewTab")}
                    </ContextMenuItem>
                  </ContextMenuContent>
                </ContextMenu>

                {isExpanded && (
                  <div className="border-t border-border/50 bg-background/60">
                    <Suspense fallback={viewerFallback}>
                      <LazyUnifiedDiffPreview
                        diffText={sliceDiffLines(
                          diffLines,
                          file.startLine,
                          file.endLine
                        )}
                        embedded
                        className="h-auto"
                      />
                    </Suspense>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      </ScrollArea>
    </section>
  )

  if (!isCommitDiff) {
    return <div className="flex h-full min-h-0 flex-col">{filesSection}</div>
  }

  return (
    <SplitView direction="vertical" className="h-full min-h-0">
      {/* 上半区：改动文件与原地折叠差异代码，默认占 50%，可拖拽分界线调节 */}
      <SplitPane
        id="diff-overview-files"
        order={1}
        defaultSize={50}
        minSize={20}
      >
        {filesSection}
      </SplitPane>

      <SplitHandle id="diff-overview-split-handle" />

      {/* 下半区：Commit 完整信息与原地修改区，默认占 50%，超出内部滚动 */}
      <SplitPane
        id="diff-overview-commit"
        order={2}
        defaultSize={50}
        minSize={20}
      >
        <section
          aria-label={t("commitMessageSectionLabel")}
          className="flex h-full min-h-0 flex-col bg-muted/15 px-5 py-3.5"
        >
          <div className="flex shrink-0 items-center justify-between gap-2 pb-2.5">
            <div className="flex min-w-0 items-center gap-2">
              <MessageSquareText className="size-3.5 shrink-0 text-muted-foreground" />
              <span className="text-xs font-medium text-foreground/85">
                {t("commitMessageSectionLabel")}
              </span>
            </div>

            {!editing &&
              (canEditCommit ? (
                <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[10px] font-medium text-primary">
                  {t("commitEditableBadge")}
                </span>
              ) : editDisabledReason ? (
                <span
                  title={editDisabledReason}
                  className="inline-flex items-center gap-1 text-[11px] text-muted-foreground/80"
                >
                  <Lock className="size-3 shrink-0" />
                  <span className="truncate">{editDisabledReason}</span>
                </span>
              ) : null)}
          </div>

          {editing ? (
            <div className="flex min-h-0 flex-1 flex-col gap-2">
              <textarea
                aria-label={t("commitMessageInputLabel")}
                value={draftMessage}
                onChange={(event) => setDraftMessage(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Escape") {
                    event.preventDefault()
                    handleCancelEdit()
                  } else if (
                    event.key === "Enter" &&
                    (event.metaKey || event.ctrlKey)
                  ) {
                    event.preventDefault()
                    void handleSaveEdit()
                  }
                }}
                autoFocus
                disabled={saving}
                className="min-h-0 w-full flex-1 resize-none rounded-lg border border-primary/60 bg-background px-4 py-3 font-mono text-[13px] leading-relaxed text-foreground shadow-xs ring-2 ring-primary/15 outline-none"
              />
              {saveError && (
                <p className="shrink-0 text-[11px] text-destructive">
                  {saveError}
                </p>
              )}
              <div className="flex shrink-0 items-center justify-between gap-2 pt-0.5">
                <span className="text-[11px] text-muted-foreground">
                  {t("commitEditShortcutHint")}
                </span>
                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={handleCancelEdit}
                    className="inline-flex items-center gap-1 rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                  >
                    <X className="size-3" />
                    <span>{t("cancelEdit")}</span>
                  </button>
                  <button
                    type="button"
                    disabled={saving || !draftMessage.trim()}
                    onClick={() => {
                      void handleSaveEdit()
                    }}
                    className="inline-flex items-center gap-1 rounded-md bg-primary px-3 py-1 text-xs font-medium text-primary-foreground shadow-2xs hover:bg-primary/90 disabled:opacity-50"
                  >
                    {saving ? (
                      <Loader2 className="size-3 animate-spin" />
                    ) : (
                      <Check className="size-3" />
                    )}
                    <span>{t("saveCommitMessage")}</span>
                  </button>
                </div>
              </div>
            </div>
          ) : canEditCommit ? (
            <button
              type="button"
              onClick={handleStartEdit}
              aria-label={t("clickToEditCommitMessage")}
              className="group relative flex min-h-0 w-full flex-1 cursor-text flex-col overflow-y-auto rounded-lg border border-border/90 bg-background px-4 py-3.5 text-left shadow-2xs transition-all hover:border-primary/50 hover:bg-accent/15 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            >
              <span className="pointer-events-none absolute top-3 right-3 inline-flex items-center gap-1 rounded-md bg-muted/60 px-2 py-0.5 text-[10px] text-muted-foreground transition-colors group-hover:bg-primary/10 group-hover:text-primary">
                <Pencil className="size-2.5" />
                <span>{t("clickToEditHint")}</span>
              </span>
              {parsedCommitMessage?.subject && (
                <p className="pr-24 text-[15px] font-semibold leading-snug text-foreground break-words">
                  {parsedCommitMessage.subject}
                </p>
              )}
              {parsedCommitMessage?.body && (
                <p className="mt-2.5 text-[13px] leading-relaxed text-foreground/80 whitespace-pre-wrap break-words">
                  {parsedCommitMessage.body}
                </p>
              )}
            </button>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto rounded-lg border border-border/50 bg-muted/35 px-4 py-3.5">
              {parsedCommitMessage?.subject && (
                <p className="text-[15px] font-semibold leading-snug text-foreground/90 break-words">
                  {parsedCommitMessage.subject}
                </p>
              )}
              {parsedCommitMessage?.body && (
                <p className="mt-2.5 text-[13px] leading-relaxed text-muted-foreground whitespace-pre-wrap break-words">
                  {parsedCommitMessage.body}
                </p>
              )}
            </div>
          )}
        </section>
      </SplitPane>
    </SplitView>
  )
}
