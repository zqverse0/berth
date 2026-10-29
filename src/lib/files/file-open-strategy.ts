import {
  fileViewerDefinitionFromPath,
  type FileViewerKind,
} from "@/lib/files/file-viewer-definition"

export type FileOpenStrategy =
  | {
      dataMode: "text"
      previewKind: Extract<
        FileViewerKind,
        "text" | "markdown" | "html" | "excalidraw"
      >
      reloadPolicy: "text-buffer"
    }
  | {
      dataMode: "resource"
      previewKind: Extract<FileViewerKind, "image" | "office" | "pdf">
      reloadPolicy: "workspace-resource" | "self-managed"
    }

/**
 * 保持历史策略返回形状，所有分类字段统一来自本地 Viewer 定义表。
 */
export function fileOpenStrategyFromPath(path: string): FileOpenStrategy {
  const definition = fileViewerDefinitionFromPath(path)
  return {
    dataMode: definition.dataMode,
    previewKind: definition.kind as FileOpenStrategy["previewKind"],
    reloadPolicy: definition.reloadPolicy,
  } as FileOpenStrategy
}
