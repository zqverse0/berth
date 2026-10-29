import {
  isResourceFileTab,
  isTextFileTab,
  type FileWorkspaceTab,
} from "@/lib/files/file-workspace-tab"
import type { ContentSourceKind } from "./types"

/**
 * Map an open workspace tab (+ preview vs edit mode) to a content-reference
 * source kind. Opening strategy remains in file-open-strategy; this only
 * answers "what can we extract for reference".
 */
export function sourceKindFromTab(
  tab: FileWorkspaceTab,
  opts: { previewMode: boolean }
): ContentSourceKind {
  if (tab.kind === "diff" || tab.kind === "rich-diff") return "diff"
  if (isResourceFileTab(tab)) {
    switch (tab.preview.kind) {
      case "image":
        return "image"
      case "pdf":
        return "pdf"
      case "office":
        return "office"
    }
  }
  if (isTextFileTab(tab)) {
    return opts.previewMode ? "text-preview" : "text-editor"
  }
  return "path-only"
}
