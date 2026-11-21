"use client"

import { lazy, Suspense, useCallback, useEffect, useMemo } from "react"
import { FileCode2 } from "lucide-react"
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
  buildDiffOutline,
  DiffOverviewPanel,
  EMPTY_DIFF_OUTLINE,
  type DiffListContext,
} from "@/components/files/diff-overview-panel"
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
import { usePluginViewsStore } from "@/lib/plugins/plugin-views"
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
const LazyBerthSessionView = lazy(() =>
  import("@/components/project-management/group/berth-record").then((m) => ({
    default: m.BerthSessionView,
  }))
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
  if (
    tab.kind === "transcript" ||
    tab.kind === "task" ||
    tab.kind === "berth-session"
  )
    return true
  if (tab.kind === "rich-diff") {
    return (
      tab.originalContent !== undefined || tab.modifiedContent !== undefined
    )
  }
  return tab.content !== ""
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
  const editorSuffixes = usePluginViewsStore((state) => state.editorSuffixes)
  const activeFileViewerKind: FileViewerKind | null =
    activeFileTab?.kind === "file"
      ? fileViewerKindFromTab(activeFileTab, editorSuffixes)
      : null
  const liveEditorDocumentIds = useMemo(
    () => new Set(fileTabs.map((tab) => `file-tab:${tab.id}`)),
    [fileTabs]
  )
  useEffect(() => {
    editorDocumentRegistry.retain(liveEditorDocumentIds, "file-tab:")
  }, [liveEditorDocumentIds])
  const {
    closeFileTab,
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

  if (activeFileTab.kind === "berth-session") {
    return (
      <Suspense fallback={viewerFallback}>
        <LazyBerthSessionView key={activeFileTab.id} tab={activeFileTab} />
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
  if (diffListContext && activeFileTab.kind === "diff") {
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
    const overviewFolder =
      overviewFolderId != null
        ? (allFolders.find((folder) => folder.id === overviewFolderId) ?? null)
        : null
    const handleOpenDiffInNewTab = async (path: string) => {
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

    const handleCommitAmended = async (newHash: string, newMessage: string) => {
      if (diffListContext.kind !== "commit") return
      if (overviewFolderId != null) {
        const store = useAppWorkspaceStore.getState()
        const existingHead = store.gitHeads.get(overviewFolderId)
        if (existingHead) {
          store.applyGitHead(overviewFolderId, {
            ...existingHead,
            short_sha: newHash.slice(0, 7),
          })
        }
      }
      if (newHash && newHash !== diffListContext.commitHash) {
        const previousTabId = activeFileTab.id
        await openCommitDiff(newHash, undefined, newMessage, {
          folderId: overviewFolderId,
        })
        await closeFileTab(previousTabId)
      }
    }

    const handleRefreshOverview = () => {
      if (diffListContext.kind === "commit") {
        void openCommitDiff(
          diffListContext.commitHash,
          undefined,
          diffListContext.commitMessage ?? undefined,
          { folderId: overviewFolderId }
        )
        return
      }

      if (diffListContext.kind === "branch") {
        void openBranchDiff(
          diffListContext.branch,
          diffListContext.path === "all" ? undefined : diffListContext.path,
          { folderId: overviewFolderId }
        )
        return
      }

      void openWorkingTreeDiff(
        diffListContext.path === "all" ? undefined : diffListContext.path,
        { folderId: overviewFolderId }
      )
    }

    const diffListColdLoad =
      activeFileTab.loading && !isTabRendererReady(activeFileTab)
    return (
      <div className="h-full relative">
        {activeFileTab.loading && <ViewerLoadingBadge />}
        {diffListColdLoad ? (
          <ViewerLoading />
        ) : (
          <DiffOverviewPanel
            key={activeFileTab.id}
            tabId={activeFileTab.id}
            diffContent={activeFileTab.content}
            diffOutline={diffOutline ?? EMPTY_DIFF_OUTLINE}
            context={diffListContext}
            folderId={activeFileTab.folderId}
            folderPath={overviewFolder?.path ?? null}
            error={activeFileTab.saveError ? activeFileTab.content : null}
            badge={badge}
            description={description}
            onOpenDiffInNewTab={handleOpenDiffInNewTab}
            openFilePreview={(path) =>
              // Rows belong to the overview tab's folder — never the
              // active workspace folder.
              openFilePreview(path, { folderId: overviewFolderId })
            }
            onCommitAmended={handleCommitAmended}
            onRefresh={handleRefreshOverview}
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
