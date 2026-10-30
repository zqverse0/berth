import type { FileViewerKind } from "@/lib/files/file-viewer-definition"

export type FileSaveState = "idle" | "saving" | "error"
export type LineEnding = "lf" | "crlf" | "mixed" | "none"

/** How a file tab follows folder switches. */
export type FileTabLifetime = "global" | "project"

export interface BaseWorkspaceTab {
  id: string
  folderId: number | null
  title: string
  description: string | null
  path: string | null
  loading: boolean
  saveState: FileSaveState
  saveError: string | null
  stale?: boolean
  /**
   * Global config (central skills, expert packages) stays visible across
   * projects. Project files follow the owning folder. Omitted = project.
   */
  lifetime?: FileTabLifetime
  /**
   * 文件 tab 在哪个项目打开（null = 无项目）；非全局 tab 只在这里显示，与文件
   * 归属（folderId）无关。缺省时按归属显示（旧数据）。
   */
  openedInFolderId?: number | null
}

export interface TextFileWorkspaceTab extends BaseWorkspaceTab {
  kind: "file"
  dataMode: "text"
  previewKind: Extract<
    FileViewerKind,
    "text" | "markdown" | "html" | "excalidraw"
  >
  path: string
  language: string
  content: string
  gitBaseContent?: string
  savedContent: string
  isDirty: boolean
  etag: string | null
  mtimeMs: number | null
  readonly: boolean
  lineEnding: LineEnding
}

export type ResourcePreviewState =
  | {
      kind: Extract<FileViewerKind, "image">
      revision: number
      dataUrl: string | null
    }
  | { kind: Extract<FileViewerKind, "office">; revision: number }
  | { kind: Extract<FileViewerKind, "pdf">; revision: number }

export interface ResourceFileWorkspaceTab extends BaseWorkspaceTab {
  kind: "file"
  dataMode: "resource"
  path: string
  preview: ResourcePreviewState
  readonly: true
}

export type ImageResourceFileWorkspaceTab = ResourceFileWorkspaceTab & {
  preview: Extract<ResourcePreviewState, { kind: "image" }>
}

export interface DiffWorkspaceTab extends BaseWorkspaceTab {
  kind: "diff"
  language: "diff"
  content: string
  readonly: true
}

export interface RichDiffWorkspaceTab extends BaseWorkspaceTab {
  kind: "rich-diff"
  language: string
  content: string
  originalContent?: string
  modifiedContent?: string
  readonly: true
}

/** A persisted Agent transcript rendered as a read-only reader document. */
export interface TranscriptWorkspaceTab extends BaseWorkspaceTab {
  kind: "transcript"
  conversationId: number
  agentType: import("@/lib/types").AgentType
  folderId: number
  path: null
  readonly: true
}

/** 项目任务详情：进度、执行（分工 / 交接 / 派发）与 PRD。 */
export interface TaskWorkspaceTab extends BaseWorkspaceTab {
  kind: "task"
  folderId: number
  taskDirName: string
  path: null
  readonly: true
}

/** 内置成员 Berth 的一个会话（`experts/sessions/<项目>/<会话>.jsonl`）的对话记录。 */
export interface BerthSessionWorkspaceTab extends BaseWorkspaceTab {
  kind: "berth-session"
  folderId: number
  session: string
  path: null
  readonly: true
}

export interface WorkspaceFileRef {
  rootPath: string
  path: string
}

export function buildTranscriptTabId(conversationId: number): string {
  return `transcript:${conversationId}`
}

export function buildTaskTabId(folderId: number, taskDirName: string): string {
  return `task:${folderId}:${taskDirName}`
}

export function buildBerthSessionTabId(
  folderId: number,
  session: string
): string {
  return `berth-session:${folderId}:${session}`
}

export type FileWorkspaceTab =
  | TextFileWorkspaceTab
  | ResourceFileWorkspaceTab
  | DiffWorkspaceTab
  | RichDiffWorkspaceTab
  | TranscriptWorkspaceTab
  | TaskWorkspaceTab
  | BerthSessionWorkspaceTab

export function isTextFileTab(
  tab: FileWorkspaceTab
): tab is TextFileWorkspaceTab {
  return tab.kind === "file" && tab.dataMode === "text"
}

export function isResourceFileTab(
  tab: FileWorkspaceTab
): tab is ResourceFileWorkspaceTab {
  return tab.kind === "file" && tab.dataMode === "resource"
}

export function isImageResourceFileTab(
  tab: FileWorkspaceTab
): tab is ImageResourceFileWorkspaceTab {
  return isResourceFileTab(tab) && tab.preview.kind === "image"
}
