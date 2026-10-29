import type { FileWorkspaceTab } from "@/lib/files/file-workspace-tab"

/** 工作区支持的本地文件阅读 Surface。 */
export type FileViewerKind =
  | "text"
  | "markdown"
  | "html"
  | "excalidraw"
  | "image"
  | "office"
  | "pdf"

export type FileViewerDataMode = "text" | "resource"
export type FileViewerReloadPolicy =
  | "text-buffer"
  | "workspace-resource"
  | "self-managed"

export interface FileViewerCapabilities {
  readonly zoom?: boolean
  readonly wordWrap?: boolean
  readonly sourcePreview?: boolean
  readonly openExternal?: boolean
  readonly elementGrab?: boolean
}

/** 单个本地文件阅读器的静态事实，不包含序列化或运行时状态。 */
export interface FileViewerDefinition {
  readonly kind: FileViewerKind
  readonly dataMode: FileViewerDataMode
  readonly reloadPolicy: FileViewerReloadPolicy
  readonly capabilities: FileViewerCapabilities
}

export interface FileViewerToolbarMetadata {
  label: string
  value: string
}

export interface FileViewerZoomController {
  value: number
  min: number
  max: number
  in: () => void
  out: () => void
  reset?: () => void
}

export interface FileViewerPdfController {
  page: number
  total: number
  setPage: (page: number) => void
  fitWidth: () => void
}

/** 已挂载 Viewer 向顶部 Header 桥接的动态操作与状态。 */
export interface FileViewerToolbarState {
  kind: FileViewerKind
  zoom?: FileViewerZoomController
  pdf?: FileViewerPdfController
  metadata?: readonly FileViewerToolbarMetadata[]
  refresh?: () => void
  openExternal?: () => void
  elementGrab?: {
    active: boolean
    toggle: () => void
  }
  /** HTML 预览：允许脚本与联网（放宽沙箱）。 */
  scriptsTrust?: {
    active: boolean
    toggle: () => void
  }
}

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "bmp",
  "ico",
])
// Berth 的文档格式目录：这些后缀交给文件工具插件（预览 / 抽取）。插件只在其中
// 提供实现，不能扩展它；与 berth-tool-core `file_tools::DOCUMENT_FORMATS` 同步（测试比对）。
export const OFFICE_EXTENSIONS = new Set(["docx", "xlsx", "pptx"])

/**
 * Office 套件打开文档时放在旁边的锁文件（`~$x.docx`、WPS 的 `.~x.docx`）带着
 * 文档后缀却不是文档，不能交给预览插件。与后端 `is_ignored_workspace_file_name` 同步。
 */
export function isOfficeLockFileName(base: string): boolean {
  return base.startsWith("~$") || base.startsWith(".~")
}

/**
 * 此表不得依赖 React 或运行时状态，是文件加载与工作区工具栏共同消费的
 * 唯一静态契约。
 */
export const FILE_VIEWER_DEFINITIONS: Readonly<
  Record<FileViewerKind, FileViewerDefinition>
> = {
  text: {
    kind: "text",
    dataMode: "text",
    reloadPolicy: "text-buffer",
    capabilities: { zoom: true, wordWrap: true },
  },
  markdown: {
    kind: "markdown",
    dataMode: "text",
    reloadPolicy: "text-buffer",
    capabilities: { zoom: true, wordWrap: true },
  },
  html: {
    kind: "html",
    dataMode: "text",
    reloadPolicy: "text-buffer",
    capabilities: {
      zoom: true,
      wordWrap: true,
      sourcePreview: true,
      openExternal: true,
      elementGrab: true,
    },
  },
  excalidraw: {
    kind: "excalidraw",
    dataMode: "text",
    reloadPolicy: "text-buffer",
    capabilities: {},
  },
  image: {
    kind: "image",
    dataMode: "resource",
    reloadPolicy: "workspace-resource",
    capabilities: { zoom: true },
  },
  office: {
    kind: "office",
    dataMode: "resource",
    reloadPolicy: "self-managed",
    // 元素抓取依赖可见 native WebView 的页内命中；Office 预览改为沙箱文档
    // 后该能力下线（design §4），按钮在 Header 消失而非灰置。
    capabilities: { openExternal: true },
  },
  pdf: {
    kind: "pdf",
    dataMode: "resource",
    reloadPolicy: "workspace-resource",
    capabilities: { zoom: true, openExternal: true },
  },
}

/** 不导入组件、不读取运行时状态，仅根据路径分类。 */
export function fileViewerKindFromPath(path: string): FileViewerKind {
  // Obsidian Excalidraw 的 `*.excalidraw.md` 先于 markdown 判定
  if (/\.excalidraw(\.md)?$/i.test(path)) return "excalidraw"

  const base = path.split(/[\\/]/).pop() ?? path
  const ext = base.split(".").pop()?.toLowerCase() ?? ""
  if (IMAGE_EXTENSIONS.has(ext)) return "image"
  if (OFFICE_EXTENSIONS.has(ext) && !isOfficeLockFileName(base)) return "office"
  if (ext === "pdf") return "pdf"
  if (ext === "html" || ext === "htm") return "html"
  if (ext === "md" || ext === "markdown") return "markdown"
  return "text"
}

export function fileViewerDefinitionForKind(
  kind: FileViewerKind
): FileViewerDefinition {
  return FILE_VIEWER_DEFINITIONS[kind]
}

export function fileViewerDefinitionFromPath(
  path: string
): FileViewerDefinition {
  return fileViewerDefinitionForKind(fileViewerKindFromPath(path))
}

/** Resolve a persisted/runtime tab to the same seven-kind local contract. */
export function fileViewerKindFromTab(
  tab: FileWorkspaceTab
): FileViewerKind | null {
  if (tab.kind !== "file") return null
  if (tab.dataMode === "resource") return tab.preview.kind

  // 路径分类兼容旧的/手工构造的文本 Tab；对于虚拟或无扩展名文档，
  // 持久化的 previewKind 作为后备结果。
  const pathKind = fileViewerKindFromPath(tab.path)
  return pathKind === "text" ? tab.previewKind : pathKind
}

export function fileViewerDefinitionFromTab(
  tab: FileWorkspaceTab
): FileViewerDefinition | null {
  const kind = fileViewerKindFromTab(tab)
  return kind ? fileViewerDefinitionForKind(kind) : null
}
