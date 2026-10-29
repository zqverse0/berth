import type { FileWorkspaceTab } from "@/lib/files/file-workspace-tab"
import type { PrimaryTab } from "@/lib/workspace/primary-tabs"

export type WorkspacePane = "conversation" | "files" | "files-split"
export type WorkspaceTabSection = "global" | "regular"
export type WorkspaceTabCollection = "primary" | "file" | "global"

export type WorkspaceTabType =
  | FileWorkspaceTab["kind"]
  | PrimaryTab["kind"]
  | "global"

export interface WorkspaceTabDefinition {
  collection: WorkspaceTabCollection
  defaultPane: WorkspacePane
  section: WorkspaceTabSection
}

/**
 * Workspace Tab 的唯一策略注册表。业务组件只负责内容和生命周期；默认位置
 * 与分区在这里登记，新增 Tab 类型时必须先补齐本表。
 */
export const WORKSPACE_TAB_REGISTRY = {
  file: {
    collection: "file",
    defaultPane: "files",
    section: "regular",
  },
  diff: {
    collection: "file",
    defaultPane: "files",
    section: "regular",
  },
  "rich-diff": {
    collection: "file",
    defaultPane: "files",
    section: "regular",
  },
  transcript: {
    collection: "file",
    defaultPane: "files",
    section: "regular",
  },
  task: {
    collection: "file",
    defaultPane: "files",
    section: "regular",
  },
  conversation: {
    collection: "primary",
    defaultPane: "files",
    section: "regular",
  },
  terminal: {
    collection: "primary",
    defaultPane: "conversation",
    section: "regular",
  },
  global: {
    collection: "global",
    defaultPane: "files",
    section: "global",
  },
} as const satisfies Record<WorkspaceTabType, WorkspaceTabDefinition>

export function workspaceTabDefinition(
  type: WorkspaceTabType
): WorkspaceTabDefinition {
  return WORKSPACE_TAB_REGISTRY[type]
}
