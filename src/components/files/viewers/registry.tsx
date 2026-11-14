"use client"

import { lazy, Suspense, useMemo, type ReactNode } from "react"
import { useLocale } from "next-intl"
import { toast } from "@/lib/notify"
import type { FileViewerKind } from "@/lib/files/file-viewer-definition"
import {
  isImageResourceFileTab,
  isResourceFileTab,
  isTextFileTab,
  type FileWorkspaceTab,
  type TextFileWorkspaceTab,
} from "@/lib/files/file-workspace-tab"
import { findOwningFolder, splitAbsPath } from "@/lib/files/file-open-target"
import { editorForPath, usePluginViewsStore } from "@/lib/plugins/plugin-views"
import type { PageHost } from "@/lib/plugins/plugin-page"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { PluginPageFrame } from "@/components/plugins/plugin-page-frame"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { useSendToAgent } from "@/hooks/use-send-to-agent"
import { ImagePreview } from "@/components/files/image-preview"
import { PreviewSelectionLayer } from "@/components/content-reference/preview-selection-layer"
import { PdfFileViewer } from "./pdf-file-viewer"
import { useFileReveal } from "./use-file-reveal"
import { useFileTabSave } from "./use-file-tab-save"
import { viewerFallback, ViewerLoading } from "./viewer-states"

// 文本 / Markdown / HTML 都要 CodeMirror（约 100KB gz），打开文件时才加载，不进首屏。
const LazyTextFileViewer = lazy(() =>
  import("./text-file-viewer").then((m) => ({ default: m.TextFileViewer }))
)
const LazyPluginPreview = lazy(() =>
  import("@/components/files/plugin-preview").then((m) => ({
    default: m.PluginPreview,
  }))
)

/** 每个 Viewer 收到的统一输入。 */
export interface FileViewerProps {
  tab: FileWorkspaceTab
  visible: boolean
  active: boolean
}

function ImageFileViewer({ tab, visible }: FileViewerProps) {
  useFileReveal({ tab, visible, textBuffer: false, revealLine: null })
  if (!isImageResourceFileTab(tab)) return null
  return <ImagePreview key={tab.id} tab={tab} visible={visible} />
}

function OfficeFileViewer({ tab, visible }: FileViewerProps) {
  useFileReveal({ tab, visible, textBuffer: false, revealLine: null })
  if (!isResourceFileTab(tab)) return null
  const io = splitAbsPath(tab.path)
  return (
    <PreviewSelectionLayer
      className="h-full min-h-0 w-full"
      absolutePath={tab.path}
      fileName={tab.title}
      documentKind="office"
    >
      <Suspense fallback={viewerFallback}>
        <LazyPluginPreview
          key={tab.id}
          rootPath={io?.rootPath ?? null}
          relPath={io?.ioPath ?? null}
          absolutePath={tab.path}
          title={tab.title}
          visible={visible}
        />
      </Suspense>
    </PreviewSelectionLayer>
  )
}

function PluginEditorViewer({ tab, visible, active }: FileViewerProps) {
  useFileReveal({ tab, visible, textBuffer: true, revealLine: null })
  if (!isTextFileTab(tab)) return null
  return <PluginEditorTextViewer tab={tab} visible={visible} active={active} />
}

/**
 * 插件编辑器（§4.2）：页面只收发内容，读写 / 自动保存 / Ctrl+S / 外部修改走文本 tab 的链路。
 * `files.*` 的根是文件所在项目，不在项目里时是文件所在目录。
 */
function PluginEditorTextViewer({
  tab,
  visible,
  active,
}: FileViewerProps & { tab: TextFileWorkspaceTab }) {
  const { updateFileTabContent, openFilePreview } = useWorkspaceRuntimeActions()
  useFileTabSave(tab, { active })
  const { send: sendToAgent } = useSendToAgent()
  const editors = usePluginViewsStore((state) => state.editors)
  const editor = editorForPath(editors, tab.path)
  const allFolders = useAppWorkspaceStore((state) => state.allFolders)
  const locale = useLocale()
  const { root, project } = useMemo(() => {
    const folder = findOwningFolder(tab.path, allFolders)
    const owner = folder
      ? allFolders.find((item) => item.id === folder.folderId)
      : undefined
    return {
      root: folder?.rootPath ?? splitAbsPath(tab.path)?.rootPath ?? null,
      project: owner
        ? { id: String(owner.id), name: owner.name, root: owner.path }
        : null,
    }
  }, [allFolders, tab.path])
  const relPath =
    root && tab.path.length > root.length
      ? tab.path.slice(root.replace(/[\\/]+$/, "").length + 1)
      : tab.title
  const host = useMemo<PageHost | null>(
    () =>
      editor
        ? {
            plugin: editor.plugin,
            permissions: editor.permissions,
            root,
            project,
            locale,
            context: {
              kind: "editor",
              id: editor.id,
              mode: "edit",
              path: relPath,
              readOnly: tab.readonly,
              content: tab.content,
            },
            onChange: (content) => updateFileTabContent(tab.id, content),
            openFile: (path) => void openFilePreview(path),
            notify: (message, kind) =>
              kind === "error" ? toast.error(message) : toast(message),
            sendToAgent: (text) => void sendToAgent(text),
          }
        : null,
    [
      editor,
      root,
      project,
      locale,
      relPath,
      tab.readonly,
      tab.content,
      tab.id,
      updateFileTabContent,
      openFilePreview,
      sendToAgent,
    ]
  )
  if (!visible || !editor || !host) return null
  if (tab.loading && !tab.content) return <ViewerLoading />
  return (
    <PluginPageFrame
      page={editor.page}
      host={host}
      externalContent={tab.content}
      acceptFileDrop={!tab.readonly}
      title={tab.title}
    />
  )
}

/**
 * 普通本地文件 Viewer 的唯一分发边界：kind 由 `file-viewer-definition` 的纯分类给出，
 * 每类 Viewer 自管加载态、选区上报与定位。非文件文档（transcript、task、diff）
 * 由 Panel 外层分支处理。新增格式：分类 + 这里加一行 + 自己的 Viewer 组件。
 */
const FILE_VIEWERS: Record<
  FileViewerKind,
  (props: FileViewerProps) => ReactNode
> = {
  text: (props) =>
    isTextFileTab(props.tab) ? (
      <Suspense fallback={viewerFallback}>
        <LazyTextFileViewer {...props} tab={props.tab} kind="text" />
      </Suspense>
    ) : null,
  markdown: (props) =>
    isTextFileTab(props.tab) ? (
      <Suspense fallback={viewerFallback}>
        <LazyTextFileViewer {...props} tab={props.tab} kind="markdown" />
      </Suspense>
    ) : null,
  html: (props) =>
    isTextFileTab(props.tab) ? (
      <Suspense fallback={viewerFallback}>
        <LazyTextFileViewer {...props} tab={props.tab} kind="html" />
      </Suspense>
    ) : null,
  plugin: (props) => <PluginEditorViewer {...props} />,
  image: (props) => <ImageFileViewer {...props} />,
  office: (props) => <OfficeFileViewer {...props} />,
  pdf: (props) =>
    isResourceFileTab(props.tab) ? (
      <PdfFileViewer {...props} tab={props.tab} />
    ) : null,
}

export function FileViewerHost({
  kind,
  ...props
}: FileViewerProps & { kind: FileViewerKind }) {
  return FILE_VIEWERS[kind](props)
}

export const FILE_VIEWER_KINDS = Object.keys(FILE_VIEWERS) as FileViewerKind[]
