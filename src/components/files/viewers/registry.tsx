"use client"

import { lazy, Suspense, type ReactNode } from "react"
import dynamic from "next/dynamic"
import type { FileViewerKind } from "@/lib/files/file-viewer-definition"
import {
  isImageResourceFileTab,
  isResourceFileTab,
  isTextFileTab,
  type FileWorkspaceTab,
  type TextFileWorkspaceTab,
} from "@/lib/files/file-workspace-tab"
import { splitAbsPath } from "@/lib/files/file-open-target"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { ImagePreview } from "@/components/files/image-preview"
import { PreviewSelectionLayer } from "@/components/content-reference/preview-selection-layer"
import { PdfFileViewer } from "./pdf-file-viewer"
import { useFileReveal } from "./use-file-reveal"
import { useFileTabSave } from "./use-file-tab-save"
import { viewerFallback, ViewerLoading } from "./viewer-states"

const ExcalidrawFileSurface = dynamic(
  () =>
    import("@/components/files/excalidraw-file-surface").then(
      (module) => module.ExcalidrawFileSurface
    ),
  { ssr: false }
)
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
  return <ImagePreview key={tab.id} tab={tab} />
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

function ExcalidrawFileViewer({ tab, visible, active }: FileViewerProps) {
  useFileReveal({ tab, visible, textBuffer: true, revealLine: null })
  if (!isTextFileTab(tab)) return null
  return <ExcalidrawTextViewer tab={tab} visible={visible} active={active} />
}

function ExcalidrawTextViewer({
  tab,
  visible,
  active,
}: FileViewerProps & { tab: TextFileWorkspaceTab }) {
  const { updateFileTabContent } = useWorkspaceRuntimeActions()
  useFileTabSave(tab, { active })
  if (!visible) return null
  if (tab.loading && !tab.content) return <ViewerLoading />
  return (
    <ExcalidrawFileSurface
      tab={tab}
      onContentChange={(value) => updateFileTabContent(tab.id, value)}
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
  excalidraw: (props) => <ExcalidrawFileViewer {...props} />,
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
