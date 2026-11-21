import { isVirtualPreviewPath } from "@/lib/files/file-open-target"
import type { FileWorkspaceTab } from "@/lib/files/file-workspace-tab"

export const FILE_READER_STATE_KEY = "berth:file-reader-state:v1"

export type PersistedFileReaderTab =
  | {
      kind: "file"
      path: string
      folderId: number | null
      lifetime?: "global" | "project"
      openedInFolderId?: number | null
      readonly: boolean
    }
  | {
      kind: "transcript"
      conversationId: number
      agentType: import("@/lib/types").AgentType
      title: string
      folderId: number
    }
  | { kind: "task"; taskDirName: string; title: string; folderId: number }
  | { kind: "berth-session"; session: string; title: string; folderId: number }

export interface PersistedFileReaderState {
  version: 2
  tabs: PersistedFileReaderTab[]
  activeTabId: string | null
  activeTabIdByFolder: Record<string, string>
}

function isFolderId(value: unknown): value is number | null {
  return value === null || (typeof value === "number" && Number.isFinite(value))
}

function parseTab(value: unknown): PersistedFileReaderTab | null {
  if (!value || typeof value !== "object") return null
  const tab = value as Record<string, unknown>
  if (!isFolderId(tab.folderId)) return null

  if (tab.kind === "file" && typeof tab.path === "string") {
    if (!tab.path || isVirtualPreviewPath(tab.path)) return null
    const lifetime =
      tab.lifetime === "global" || tab.lifetime === "project"
        ? tab.lifetime
        : undefined
    return {
      kind: "file",
      path: tab.path,
      folderId: tab.folderId,
      ...(lifetime ? { lifetime } : {}),
      ...(tab.openedInFolderId !== undefined && isFolderId(tab.openedInFolderId)
        ? { openedInFolderId: tab.openedInFolderId }
        : {}),
      readonly: tab.readonly === true,
    }
  }

  if (
    tab.kind === "transcript" &&
    typeof tab.conversationId === "number" &&
    Number.isFinite(tab.conversationId) &&
    typeof tab.agentType === "string" &&
    typeof tab.title === "string" &&
    typeof tab.folderId === "number"
  ) {
    return {
      kind: "transcript",
      conversationId: tab.conversationId,
      agentType: tab.agentType as import("@/lib/types").AgentType,
      title: tab.title,
      folderId: tab.folderId,
    }
  }

  if (
    tab.kind === "task" &&
    typeof tab.taskDirName === "string" &&
    // 旧版群组页借用任务 tab（`group:<群名>`），群组已移入辅助面板，恢复时丢弃。
    !tab.taskDirName.startsWith("group:") &&
    typeof tab.title === "string" &&
    typeof tab.folderId === "number"
  ) {
    return {
      kind: "task",
      taskDirName: tab.taskDirName,
      title: tab.title,
      folderId: tab.folderId,
    }
  }

  if (
    tab.kind === "berth-session" &&
    typeof tab.session === "string" &&
    typeof tab.title === "string" &&
    typeof tab.folderId === "number"
  ) {
    return {
      kind: "berth-session",
      session: tab.session,
      title: tab.title,
      folderId: tab.folderId,
    }
  }

  // 历史 localStorage 里可能残留 web reader tab(模块已删除);
  // parseTab 对未知 kind 返回 null,由调用侧 flatMap 静默丢弃。

  return null
}

export function serializeFileReaderState(
  tabs: readonly FileWorkspaceTab[],
  activeTabId: string | null,
  activeTabIdByFolder: Readonly<Record<string, string>> = {}
): PersistedFileReaderState {
  return {
    version: 2,
    tabs: tabs.flatMap((tab): PersistedFileReaderTab[] => {
      if (tab.kind === "file" && !isVirtualPreviewPath(tab.path)) {
        return [
          {
            kind: "file",
            path: tab.path,
            folderId: tab.folderId,
            ...(tab.lifetime ? { lifetime: tab.lifetime } : {}),
            ...(tab.openedInFolderId !== undefined
              ? { openedInFolderId: tab.openedInFolderId }
              : {}),
            readonly: tab.dataMode === "resource" || tab.readonly,
          },
        ]
      }
      if (tab.kind === "transcript") {
        return [
          {
            kind: "transcript",
            conversationId: tab.conversationId,
            agentType: tab.agentType,
            title: tab.title,
            folderId: tab.folderId,
          },
        ]
      }
      if (tab.kind === "berth-session") {
        return [
          {
            kind: "berth-session",
            session: tab.session,
            title: tab.title,
            folderId: tab.folderId,
          },
        ]
      }
      if (tab.kind === "task") {
        return [
          {
            kind: "task",
            taskDirName: tab.taskDirName,
            title: tab.title,
            folderId: tab.folderId,
          },
        ]
      }
      return []
    }),
    activeTabId,
    activeTabIdByFolder: { ...activeTabIdByFolder },
  }
}

export function parseFileReaderState(
  raw: string | null
): PersistedFileReaderState {
  if (!raw)
    return {
      version: 2,
      tabs: [],
      activeTabId: null,
      activeTabIdByFolder: {},
    }
  try {
    const value = JSON.parse(raw) as Record<string, unknown>
    if (
      (value.version !== 1 && value.version !== 2) ||
      !Array.isArray(value.tabs)
    ) {
      return {
        version: 2,
        tabs: [],
        activeTabId: null,
        activeTabIdByFolder: {},
      }
    }
    const activeTabIdByFolder: Record<string, string> = {}
    if (
      value.version === 2 &&
      value.activeTabIdByFolder &&
      typeof value.activeTabIdByFolder === "object"
    ) {
      for (const [folderId, tabId] of Object.entries(
        value.activeTabIdByFolder as Record<string, unknown>
      )) {
        if (/^-?\d+$/.test(folderId) && typeof tabId === "string") {
          activeTabIdByFolder[folderId] = tabId
        }
      }
    }
    return {
      version: 2,
      tabs: value.tabs.flatMap((tab) => {
        const parsed = parseTab(tab)
        return parsed ? [parsed] : []
      }),
      activeTabId:
        typeof value.activeTabId === "string" ? value.activeTabId : null,
      activeTabIdByFolder,
    }
  } catch {
    return {
      version: 2,
      tabs: [],
      activeTabId: null,
      activeTabIdByFolder: {},
    }
  }
}
