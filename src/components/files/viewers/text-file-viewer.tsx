"use client"

import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useTranslations } from "next-intl"
import type { Extension } from "@codemirror/state"
import type { EditorHandle } from "@/lib/editor/contracts"
import {
  invalidateEditorLanguagePacks,
  loadEditorLanguageForPath,
} from "@/lib/editor/language-packs"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"
import { useOptionalPointer } from "@/pointer"
import { findOwningFolder, splitAbsPath } from "@/lib/files/file-open-target"
import type { TextFileWorkspaceTab } from "@/lib/files/file-workspace-tab"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { useZoomLevel, useEditorFont } from "@/hooks/use-appearance"
import { sourceKindFromTab } from "@/lib/content-reference"
import { computeLineDiff } from "@/components/merge/merge-diff"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { HtmlPreview } from "@/components/files/html-preview"
import { useMarkdownLivePreview } from "@/components/files/use-markdown-live-preview"
import { PreviewSelectionLayer } from "@/components/content-reference/preview-selection-layer"
import { useFileReveal } from "./use-file-reveal"
import { useFileTabSave } from "./use-file-tab-save"
import {
  viewerFallback,
  ViewerLoading,
  ViewerLoadingBadge,
} from "./viewer-states"

// 冷路径懒加载：CodeMirror 只在打开文本文件时加载。手写 lazy+Suspense 而非
// next/dynamic：静态导出下后者的 chunk 会被注入 workspace.html 的 script 清单。
const LazyCodeEditor = lazy(() =>
  import("@/components/editor/code-editor").then((m) => ({
    default: m.CodeEditor,
  }))
)

type GitLineMarker = { line: number; kind: "added" | "modified" | "deleted" }

function gitLineMarkersFor(base: string | undefined, current: string) {
  if (base === undefined) return []
  const baseLines = base.split("\n")
  const currentLines = current.split("\n")
  if (baseLines.length + currentLines.length > 20_000) return []
  const markers: GitLineMarker[] = []
  let offset = 0
  for (const hunk of computeLineDiff(baseLines, currentLines)) {
    const startLine = Math.max(1, hunk.baseStart + offset + 1)
    const kind =
      hunk.baseCount === 0
        ? "added"
        : hunk.newLines.length === 0
          ? "deleted"
          : "modified"
    const count = Math.max(1, hunk.newLines.length)
    for (let index = 0; index < count; index += 1) {
      markers.push({ line: startLine + index, kind })
    }
    offset += hunk.newLines.length - hunk.baseCount
  }
  return markers
}

/**
 * 文本类文件（text / markdown / html 源码与预览）。编辑器、自动保存、IME、
 * 语言包、git 行标记与选区上报都归这里，Panel 不再持有编辑器状态。
 */
export function TextFileViewer({
  tab,
  kind,
  visible,
  active,
}: {
  tab: TextFileWorkspaceTab
  kind: "text" | "markdown" | "html"
  visible: boolean
  active: boolean
}) {
  const t = useTranslations("Folder.fileWorkspacePanel")
  const tPointer = useTranslations("Pointer")
  const allFolders = useAppWorkspaceStore((s) => s.allFolders)
  const isPreviewTab = useWorkspaceFileStore((state) =>
    state.previewFileTabIds.has(tab.id)
  )
  // 默认阅读模式（只读防误触），Header 按钮或 Ctrl+E 进入编辑
  const isEditing = useWorkspaceFileStore((state) =>
    state.editingFileTabIds.has(tab.id)
  )
  const setFileTabEditing = useWorkspaceFileStore(
    (state) => state.setFileTabEditing
  )
  const fileZoom = useWorkspaceFileStore(
    (state) => state.fileZoomByTab[tab.id] ?? 100
  )
  const { openFilePreview, updateFileTabContent, setFileTabComposing } =
    useWorkspaceRuntimeActions()
  const pointer = useOptionalPointer()
  const scope = tab.id
  const path = tab.path
  const io = useMemo(() => splitAbsPath(path), [path])
  const owningFolder = useMemo(
    () => findOwningFolder(path, allFolders),
    [path, allFolders]
  )
  // HTML/markdown 子资源解析根：文件在已登记文件夹内时用文件夹根，保证 ../ 与
  // 根相对引用可用；文件夹外的文件只能访问自己的目录。
  const previewRoot = owningFolder?.rootPath ?? io?.rootPath ?? null
  const isMarkdownEditor = kind === "markdown"
  const isHtmlPreview = isPreviewTab && kind === "html"
  const markdownLivePreview = useMarkdownLivePreview({
    enabled: isMarkdownEditor,
    path,
    docDir: io?.rootPath ?? null,
    previewRoot,
    owningFolder,
    revision: tab.etag,
    openFilePreview,
  })

  const [languageExtension, setLanguageExtension] = useState<Extension>([])
  useEffect(() => {
    if (isMarkdownEditor) return
    let cancelled = false
    const load = () => {
      void loadEditorLanguageForPath(path)
        .then((extension) => {
          if (!cancelled) setLanguageExtension(extension)
        })
        .catch(() => {
          if (!cancelled) setLanguageExtension([])
        })
    }
    const reload = () => {
      invalidateEditorLanguagePacks()
      load()
    }
    load()
    window.addEventListener("berth:language-packs-changed", reload)
    return () => {
      cancelled = true
      window.removeEventListener("berth:language-packs-changed", reload)
    }
  }, [path, isMarkdownEditor])

  const { zoomLevel } = useZoomLevel()
  const {
    editorFontStack,
    editorFontSize,
    editorLigatures,
    editorWordWrap,
    setEditorWordWrap,
    editorVim,
  } = useEditorFont()

  const editorRef = useRef<EditorHandle | null>(null)
  const [hasEditorSelection, setHasEditorSelection] = useState(false)
  const [isComposing, setIsComposing] = useState(false)
  // 切到 HTML 预览时定位到编辑器最后的光标行；编辑器跨 tab 复用，只认同一文件的光标。
  const [cursor, setCursor] = useState<{ path: string; line: number } | null>(
    null
  )
  const handleCursorLineChange = useCallback(
    (line: number) => setCursor({ path, line }),
    [path]
  )
  const content = tab.content
  // 保存只看文件可写（见 useFileTabSave）；是否可输入看编辑模式
  const canEdit = !tab.readonly
  const isEditable = canEdit && isEditing
  const gitLineMarkers = useMemo(
    () => gitLineMarkersFor(tab.gitBaseContent, content),
    [tab.gitBaseContent, content]
  )

  const handleEditorChange = useCallback(
    (value: string) => updateFileTabContent(scope, value),
    [scope, updateFileTabContent]
  )

  const editorSelectionRef = useRef<{
    text: string
    start: number
    end: number
  } | null>(null)
  const handleEditorSelection = useCallback(
    (text: string, start: number, end: number) => {
      const selection = text.trim() ? { text, start, end } : null
      editorSelectionRef.current = selection
      setHasEditorSelection(Boolean(selection))
      if (!selection) {
        pointer?.reportSelection(null)
        return
      }
      pointer?.reportSelection({
        excerpt: selection.text,
        editable: true,
        source: {
          identity: { type: "file", path },
          span: { unit: "lines", start: selection.start, end: selection.end },
          excerpt: selection.text,
        },
      })
    },
    [path, pointer]
  )
  const copyEditorSource = useCallback(() => {
    const selection = editorSelectionRef.current
    if (!selection) return
    void pointer?.copySource({
      identity: { type: "file", path },
      span: { unit: "lines", start: selection.start, end: selection.end },
      excerpt: selection.text,
    })
  }, [path, pointer])

  const jumpToLine = useCallback((lineNumber: number) => {
    const editor = editorRef.current
    if (!editor) return null
    return editor.revealLine(lineNumber)
  }, [])
  const completeFileReveal = useFileReveal({
    tab,
    visible,
    textBuffer: true,
    revealLine: jumpToLine,
    waitForLine: isHtmlPreview,
  })

  // 进入编辑直接可输入；只认模式切换，切 tab 不抢焦点
  useEffect(() => {
    if (isEditable && active) editorRef.current?.focus()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEditable])

  useFileTabSave(tab, { active, isComposing })

  useEffect(() => {
    if (!active) return
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.metaKey || event.ctrlKey
      if (mod && event.key === "e" && canEdit && !isHtmlPreview) {
        event.preventDefault()
        setFileTabEditing(scope)
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [active, scope, canEdit, isHtmlPreview, setFileTabEditing])

  if (isHtmlPreview) {
    return (
      <PreviewSelectionLayer
        className="h-full min-h-0 w-full"
        absolutePath={path}
        fileName={tab.title}
        documentKind={
          sourceKindFromTab(tab, { previewMode: true }) ?? "text-preview"
        }
        sourceContent={content}
        sourceLines
      >
        <HtmlPreview
          key={tab.id}
          tab={tab}
          rootPath={previewRoot}
          revealLine={cursor?.path === path ? cursor.line : null}
        />
      </PreviewSelectionLayer>
    )
  }

  return (
    <div className="h-full relative">
      {tab.loading && <ViewerLoadingBadge />}
      <div className="h-full min-h-0 min-w-0 max-w-full overflow-hidden">
        {content !== "" || !tab.loading ? (
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                className="h-full min-h-0 min-w-0 max-w-full overflow-hidden"
                data-pointer-surface=""
              >
                <Suspense fallback={viewerFallback}>
                  <LazyCodeEditor
                    ref={editorRef}
                    documentId={`file-tab:${scope}`}
                    value={content}
                    appearance={{
                      fontFamily: editorFontStack,
                      fontSize:
                        (editorFontSize * zoomLevel * fileZoom) / 10_000,
                      fontLigatures: editorLigatures,
                      wordWrap: editorWordWrap,
                    }}
                    capabilities={{
                      readOnly: !isEditable || tab.loading,
                      search: true,
                      lineNumbers: !isMarkdownEditor,
                      vim: editorVim,
                    }}
                    languageExtension={
                      isMarkdownEditor
                        ? (markdownLivePreview.extension ?? [])
                        : languageExtension
                    }
                    lineMarkers={gitLineMarkers}
                    onReady={completeFileReveal}
                    onChange={handleEditorChange}
                    onCursorLineChange={handleCursorLineChange}
                    onSelectionChange={handleEditorSelection}
                    onCompositionChange={(composing) => {
                      setIsComposing(composing)
                      setFileTabComposing(scope, composing)
                    }}
                    className="h-full min-h-0 min-w-0 max-w-full overflow-hidden"
                  />
                </Suspense>
                {markdownLivePreview.overlays}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuItem
                disabled={!hasEditorSelection}
                onSelect={copyEditorSource}
              >
                {tPointer("copyContentAndSource")}
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => setEditorWordWrap(!editorWordWrap)}
              >
                {t("toggleWordWrap")}
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>
        ) : (
          <ViewerLoading label={t("loadingEditor")} />
        )}
      </div>
    </div>
  )
}
