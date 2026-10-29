"use client"

import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Code,
  Crosshair,
  ExternalLink,
  Eye,
  Minus,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  ShieldOff,
  WrapText,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { openPath } from "@/lib/platform"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"
import { fileTabsForFolderScope } from "@/lib/workspace/tab-scope"
import { cn } from "@/lib/utils"
import {
  fileViewerDefinitionFromPath,
  type FileViewerDefinition,
  type FileViewerToolbarState,
  type FileViewerZoomController,
} from "@/lib/files/file-viewer-definition"
import { isTextFileTab } from "@/lib/files/file-workspace-tab"
import { lazy, Suspense, useMemo } from "react"
import { useEditorFont } from "@/hooks/use-appearance"
import { useOptionalFileViewerRuntime } from "@/components/files/file-viewer-runtime"
import { githubStarredPreviewMetaFromPath } from "@/lib/git/github-starred-preview"
import { GithubStarredHeaderActions } from "@/components/files/github-starred-reader-bar"
import { useSendToAgent } from "@/hooks/use-send-to-agent"
import { isVirtualPreviewPath } from "@/lib/files/file-open-target"
import { sourceKindFromTab } from "@/lib/content-reference/source-kind"
import type { FileWorkspaceTab } from "@/lib/files/file-workspace-tab"

const LazyTranscriptToolbar = lazy(() =>
  import("@/sessions/components/transcript-toolbar").then((m) => ({
    default: m.TranscriptToolbar,
  }))
)

const LazyTaskToolbar = lazy(() =>
  import("@/components/project-management/berth-tasks/task-toolbar").then(
    (m) => ({ default: m.TaskToolbar })
  )
)

const actionBtn =
  "flex h-7 w-7 shrink-0 items-center justify-center rounded hover:bg-primary/8 transition-colors disabled:pointer-events-none disabled:opacity-35"

/** 把当前文件以「请查看 `路径`」放进会话区 Agent 的输入框（不提交）。 */
function SendFileToAgentButton({
  tab,
  path,
  previewMode,
}: {
  tab: FileWorkspaceTab
  path: string
  previewMode: boolean
}) {
  const { label, sendFile } = useSendToAgent()
  return (
    <button
      type="button"
      onClick={() =>
        void sendFile({
          kind: sourceKindFromTab(tab, { previewMode }),
          absolutePath: path,
          fileName: path.split("/").pop() ?? path,
        })
      }
      className={actionBtn}
      aria-label={label}
      title={label}
    >
      <Send className="h-3.5 w-3.5" />
    </button>
  )
}

function ZoomControls({
  zoom,
  zoomOutLabel,
  zoomInLabel,
  resetLabel,
}: {
  zoom: FileViewerZoomController
  zoomOutLabel: string
  zoomInLabel: string
  resetLabel: string
}) {
  return (
    <>
      <button
        type="button"
        onClick={zoom.out}
        disabled={zoom.value <= zoom.min}
        className={actionBtn}
        aria-label={zoomOutLabel}
        title={zoomOutLabel}
      >
        <Minus className="h-4 w-4" />
      </button>
      {zoom.reset ? (
        <button
          type="button"
          onClick={zoom.reset}
          className="min-w-12 rounded px-1.5 py-1 text-center text-xs tabular-nums text-muted-foreground hover:bg-primary/8"
          aria-label={resetLabel}
          title={resetLabel}
        >
          {zoom.value}%
        </button>
      ) : (
        <span className="min-w-12 px-1.5 py-1 text-center text-xs tabular-nums text-muted-foreground">
          {zoom.value}%
        </span>
      )}
      <button
        type="button"
        onClick={zoom.in}
        disabled={zoom.value >= zoom.max}
        className={actionBtn}
        aria-label={zoomInLabel}
        title={zoomInLabel}
      >
        <Plus className="h-4 w-4" />
      </button>
    </>
  )
}

function PdfViewerControls({
  controller,
  labels,
}: {
  controller: FileViewerToolbarState
  labels: {
    previous: string
    next: string
    page: string
    zoomOut: string
    zoomIn: string
    fitWidth: string
    resetZoom: string
  }
}) {
  const pdf = controller.pdf
  const zoom = controller.zoom
  if (!pdf || !zoom) return null

  return (
    <div className="flex min-w-0 items-center gap-0.5">
      <button
        type="button"
        onClick={() => pdf.setPage(pdf.page - 1)}
        disabled={pdf.page <= 1}
        className={actionBtn}
        aria-label={labels.previous}
        title={labels.previous}
      >
        <ChevronLeft className="h-4 w-4" />
        <span className="sr-only">{labels.previous}</span>
      </button>
      <input
        aria-label={labels.page}
        type="number"
        min={1}
        max={pdf.total || undefined}
        value={pdf.page}
        onChange={(event) => pdf.setPage(Number(event.target.value) || 1)}
        className="h-7 w-12 rounded border border-border bg-background px-1 text-center text-xs tabular-nums"
      />
      <span className="px-1 text-xs tabular-nums text-muted-foreground">
        / {pdf.total || "-"}
      </span>
      <button
        type="button"
        onClick={() => pdf.setPage(pdf.page + 1)}
        disabled={pdf.total < 1 || pdf.page >= pdf.total}
        className={actionBtn}
        aria-label={labels.next}
        title={labels.next}
      >
        <ChevronRight className="h-4 w-4" />
        <span className="sr-only">{labels.next}</span>
      </button>
      <ZoomControls
        zoom={zoom}
        zoomOutLabel={labels.zoomOut}
        zoomInLabel={labels.zoomIn}
        resetLabel={labels.resetZoom}
      />
      <button
        type="button"
        onClick={pdf.fitWidth}
        className="rounded px-2 py-1 text-xs text-muted-foreground hover:bg-primary/8"
        aria-label={labels.fitWidth}
        title={labels.fitWidth}
      >
        {labels.fitWidth}
      </button>
    </div>
  )
}

/** 文件阅读器的统一操作栏；文件名由上方 Tab 展示，这里只保留可执行操作。 */
export function FileWorkspaceHeader({ tabId }: { tabId?: string }) {
  const t = useTranslations("Folder.fileWorkspace")
  const tPanel = useTranslations("Folder.fileWorkspacePanel")
  const runtime = useOptionalFileViewerRuntime()
  const { activeFolderId } = useActiveFolder()
  const allFolders = useAppWorkspaceStore((state) => state.allFolders)
  const fileTabs = useWorkspaceFileStore((state) => state.fileTabs)
  const storeActiveFileTabId = useWorkspaceFileStore(
    (state) => state.activeFileTabId
  )
  const previewFileTabIds = useWorkspaceFileStore(
    (state) => state.previewFileTabIds
  )
  const fileZoomByTab = useWorkspaceFileStore((state) => state.fileZoomByTab)
  const setFileZoom = useWorkspaceFileStore((state) => state.setFileZoom)
  const toggleFileTabPreview = useWorkspaceFileStore(
    (state) => state.toggleFileTabPreview
  )
  const editingFileTabIds = useWorkspaceFileStore(
    (state) => state.editingFileTabIds
  )
  const setFileTabEditing = useWorkspaceFileStore(
    (state) => state.setFileTabEditing
  )
  const { editorWordWrap, setEditorWordWrap } = useEditorFont()
  const visibleFileTabs = fileTabsForFolderScope(
    fileTabs,
    activeFolderId,
    allFolders
  )
  const fallbackActiveFileTab =
    visibleFileTabs.find((tab) => tab.id === storeActiveFileTabId) ?? null
  const activeFileTab = runtime
    ? runtime.tab
    : tabId
      ? (fileTabs.find((tab) => tab.id === tabId) ?? null)
      : fallbackActiveFileTab
  const activeFileTabId = activeFileTab?.id ?? storeActiveFileTabId
  const starredMeta = useMemo(
    () => githubStarredPreviewMetaFromPath(activeFileTab?.path),
    [activeFileTab?.path]
  )
  const definition: FileViewerDefinition | null = runtime
    ? runtime.definition
    : activeFileTab?.kind === "file"
      ? fileViewerDefinitionFromPath(activeFileTab.path)
      : null

  if (!activeFileTab) return null
  if (!definition) {
    // 非普通本地文件（diff/transcript 等）仍保留统一 Header 的固定高度，
    // 避免切换文档类型时阅读 Surface 上下跳动；会话标签在此放阅读筛选，任务标签放状态与操作。
    return (
      <div className="h-10 min-w-0 shrink-0 border-b border-border/50 bg-card ws-transparent-bg">
        {activeFileTab.kind === "transcript" && (
          <Suspense fallback={null}>
            <LazyTranscriptToolbar
              key={activeFileTab.id}
              conversationId={activeFileTab.conversationId}
            />
          </Suspense>
        )}
        {activeFileTab.kind === "task" && (
          <Suspense fallback={null}>
            <LazyTaskToolbar
              key={activeFileTab.id}
              folderId={activeFileTab.folderId}
              task={activeFileTab.taskDirName}
            />
          </Suspense>
        )}
      </div>
    )
  }

  const isText = isTextFileTab(activeFileTab)
  const canPreview = Boolean(isText && definition.capabilities.sourcePreview)
  const isPreviewActive = Boolean(
    canPreview && activeFileTabId && previewFileTabIds.has(activeFileTabId)
  )
  const canTextZoom = Boolean(
    isText &&
    definition.capabilities.zoom &&
    !(definition.kind === "html" && isPreviewActive)
  )
  // 阅读 / 编辑切换：可写的文本源码视图才有（HTML 渲染预览时不显示）
  const canToggleEditing = Boolean(
    isText && !activeFileTab.readonly && !isPreviewActive
  )
  const isEditing = Boolean(
    activeFileTabId && editingFileTabIds.has(activeFileTabId)
  )
  const canWordWrap = Boolean(
    isText && definition.capabilities.wordWrap && !isPreviewActive
  )
  const textZoom = activeFileTabId
    ? (fileZoomByTab[activeFileTabId] ?? 100)
    : 100
  const textZoomController: FileViewerZoomController = {
    value: textZoom,
    min: 50,
    max: 200,
    in: () => {
      if (activeFileTabId) setFileZoom(activeFileTabId, textZoom + 10)
    },
    out: () => {
      if (activeFileTabId) setFileZoom(activeFileTabId, textZoom - 10)
    },
    reset: () => {
      if (activeFileTabId) setFileZoom(activeFileTabId, 100)
    },
  }
  const controller = runtime?.controller ?? null
  const imageController = controller?.kind === "image" ? controller : null
  const pdfController = controller?.kind === "pdf" ? controller : null
  const canOpenHtmlExternally =
    definition.kind === "html" && activeFileTab.kind === "file"
  const canOpenExternally = Boolean(
    canOpenHtmlExternally ||
    (definition.capabilities.openExternal && controller?.openExternal)
  )
  const externalLabel =
    definition.kind === "pdf" ? tPanel("pdfOpenExternal") : t("openExternal")

  const openHtmlExternally = () => {
    if (activeFileTab.kind !== "file") return
    void openPath(activeFileTab.path).catch(() => {})
  }

  return (
    <div className="flex h-10 min-w-0 shrink-0 items-center border-b border-border/50 bg-card ws-transparent-bg px-3">
      <div className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto">
        {canTextZoom && (
          <ZoomControls
            zoom={textZoomController}
            zoomOutLabel={t("zoomOut")}
            zoomInLabel={t("zoomIn")}
            resetLabel={t("resetZoom")}
          />
        )}
        {imageController?.zoom && (
          <ZoomControls
            zoom={imageController.zoom}
            zoomOutLabel={tPanel("imageZoomOut")}
            zoomInLabel={tPanel("imageZoomIn")}
            resetLabel={tPanel("imageZoomReset")}
          />
        )}
        {pdfController && (
          <PdfViewerControls
            controller={pdfController}
            labels={{
              previous: tPanel("pdfPrevious"),
              next: tPanel("pdfNext"),
              page: tPanel("pdfPage"),
              zoomOut: tPanel("pdfZoomOut"),
              zoomIn: tPanel("pdfZoomIn"),
              fitWidth: tPanel("pdfFitWidth"),
              resetZoom: t("resetZoom"),
            }}
          />
        )}
        {canWordWrap && (
          <button
            type="button"
            onClick={() => setEditorWordWrap(!editorWordWrap)}
            className={cn(actionBtn, editorWordWrap && "text-primary")}
            aria-label={t("wordWrap")}
            title={t("wordWrap")}
          >
            <WrapText className="h-4 w-4" />
          </button>
        )}
        {controller?.metadata && controller.metadata.length > 0 && (
          <div className="ml-auto flex shrink-0 items-center gap-3 px-2 text-[11px] text-muted-foreground">
            {controller.metadata.map((item) => (
              <span key={item.label}>
                {item.label}: {item.value}
              </span>
            ))}
          </div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-0.5">
        {starredMeta && <GithubStarredHeaderActions meta={starredMeta} />}
        {activeFileTab.kind === "file" &&
          activeFileTab.path &&
          !isVirtualPreviewPath(activeFileTab.path) && (
            <SendFileToAgentButton
              tab={activeFileTab}
              path={activeFileTab.path}
              previewMode={isPreviewActive}
            />
          )}
        {canToggleEditing && activeFileTabId && (
          <button
            type="button"
            onClick={() => setFileTabEditing(activeFileTabId)}
            className={cn(actionBtn, isEditing && "text-primary")}
            aria-label={isEditing ? t("stopEditing") : t("startEditing")}
            title={isEditing ? t("stopEditing") : t("startEditing")}
            aria-pressed={isEditing}
          >
            {isEditing ? (
              <BookOpen className="h-4 w-4" />
            ) : (
              <Pencil className="h-4 w-4" />
            )}
          </button>
        )}
        {canPreview && activeFileTabId && (
          <button
            type="button"
            onClick={() => toggleFileTabPreview(activeFileTabId)}
            className={cn(actionBtn, isPreviewActive && "text-primary")}
            aria-label={isPreviewActive ? t("editSource") : t("preview")}
            title={isPreviewActive ? t("editSource") : t("preview")}
          >
            {isPreviewActive ? (
              <Code className="h-4 w-4" />
            ) : (
              <Eye className="h-4 w-4" />
            )}
          </button>
        )}
        {definition.kind === "office" && controller?.refresh && (
          <button
            type="button"
            onClick={controller.refresh}
            className={actionBtn}
            aria-label={tPanel("previewWatchRetry")}
            title={tPanel("previewWatchRetry")}
          >
            <RefreshCw className="h-4 w-4" />
          </button>
        )}
        {definition.capabilities.elementGrab && controller?.elementGrab && (
          <button
            type="button"
            onClick={controller.elementGrab.toggle}
            className={cn(
              actionBtn,
              controller.elementGrab.active && "text-primary"
            )}
            aria-label={tPanel("previewElementGrab")}
            title={tPanel("previewElementGrab")}
            aria-pressed={controller.elementGrab.active}
          >
            <Crosshair className="h-4 w-4" />
          </button>
        )}
        {controller?.scriptsTrust && (
          <button
            type="button"
            onClick={controller.scriptsTrust.toggle}
            className={cn(
              actionBtn,
              controller.scriptsTrust.active &&
                "text-amber-600 dark:text-amber-500"
            )}
            aria-label={tPanel("htmlPreviewTrust")}
            title={tPanel("htmlPreviewTrustHint")}
            aria-pressed={controller.scriptsTrust.active}
          >
            {controller.scriptsTrust.active ? (
              <ShieldOff className="h-4 w-4" />
            ) : (
              <ShieldCheck className="h-4 w-4" />
            )}
          </button>
        )}
        {canOpenExternally && (
          <button
            type="button"
            onClick={() => {
              if (canOpenHtmlExternally) openHtmlExternally()
              else controller?.openExternal?.()
            }}
            className={actionBtn}
            aria-label={externalLabel}
            title={externalLabel}
          >
            <ExternalLink className="h-4 w-4" />
          </button>
        )}
      </div>
    </div>
  )
}
