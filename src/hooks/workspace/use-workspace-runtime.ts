"use client"

import { useCallback, useMemo, useRef } from "react"
import { useTranslations } from "next-intl"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"
import { confirmDialog } from "@/lib/platform"
import {
  workspaceRuntime,
  type BranchDiffOptions,
  type ReadonlyTextPreviewOptions,
  type BerthSessionTabOptions,
  type TaskTabOptions,
  type TranscriptTabOptions,
  type WorkingTreeDiffOptions,
  type WorkspaceFileOpenOptions,
  type WorkspaceRuntimeDependencies,
} from "@/lib/workspace/workspace-runtime"
import type { FileWorkspaceTab } from "@/lib/files/file-workspace-tab"
import type { FileEditContent } from "@/lib/types"
import type { WorkspaceExternalConflict } from "@/lib/workspace/workspace-file-runtime"

export type { WorkspaceExternalConflict } from "@/lib/workspace/workspace-file-runtime"
export type { FileWorkspaceTab } from "@/lib/files/file-workspace-tab"

export interface BoundWorkspaceRuntimeActions {
  setActivePane: (pane: "conversation" | "files") => void
  activateConversationPane: (preserveGlobalTab?: boolean) => void
  activateFilePane: () => void
  switchFileTab: (tabId: string) => void
  closeFileTab: (tabId: string) => Promise<void>
  closeOtherFileTabs: (tabId: string) => Promise<void>
  closeAllFileTabs: () => Promise<void>
  reorderFileTabs: (tabs: FileWorkspaceTab[]) => void
  openFilePreview: (
    path: string,
    options?: WorkspaceFileOpenOptions
  ) => Promise<void>
  openReadonlyTextPreview: (options: ReadonlyTextPreviewOptions) => void
  openTranscriptTab: (options: TranscriptTabOptions) => void
  openTaskTab: (options: TaskTabOptions) => void
  openBerthSessionTab: (options: BerthSessionTabOptions) => void
  reloadOpenFileBackground: (path: string) => Promise<void>
  bumpResourceRevision: (path: string) => void
  applyExternalReload: (path: string, fetched: FileEditContent) => void
  markTabsStale: (path: string) => void
  markTabsStaleBatch: (paths: string[]) => void
  consumeSelfWriteEcho: (path: string) => boolean
  rejectFileTab: (path: string, errorMessage: string) => void
  consumePendingFileReveal: (requestId: number) => void
  openWorkingTreeDiff: (
    path?: string,
    options?: WorkingTreeDiffOptions
  ) => Promise<void>
  openBranchDiff: (
    branch: string,
    path?: string,
    options?: BranchDiffOptions
  ) => Promise<void>
  openCommitDiff: (
    commit: string,
    path?: string,
    message?: string,
    options?: { folderId?: number }
  ) => Promise<void>
  openSessionFileDiff: (
    filePath: string,
    diffContent: string,
    groupLabel: string,
    options?: { folderId?: number }
  ) => void
  openExternalConflictDiff: (
    filePath: string,
    diskContent: string,
    unsavedContent: string
  ) => void
  enqueueExternalConflict: (
    conflict: WorkspaceExternalConflict,
    options?: { force?: boolean }
  ) => void
  externalConflict: WorkspaceExternalConflict | null
  compareExternalConflict: () => void
  reloadExternalConflict: () => void
  saveExternalConflictCopy: () => Promise<string>
  dismissExternalConflict: () => void
  updateActiveFileContent: (content: string) => void
  updateFileTabContent: (tabId: string, content: string) => void
  saveActiveFile: (options?: { force?: boolean }) => Promise<boolean>
  saveFileTab: (
    tabId: string,
    options?: { force?: boolean }
  ) => Promise<boolean>
  setFileTabComposing: (tabId: string, composing: boolean) => void
  reloadActiveFile: () => Promise<void>
  toggleFileTabPreview: (tabId: string) => void
}

export function useWorkspaceRuntimeDependencies(): WorkspaceRuntimeDependencies {
  const { activeFolderId } = useActiveFolder()
  const folders = useAppWorkspaceStore((state) => state.allFolders)
  const t = useTranslations("Folder.workspaceContext")
  const translate = useCallback(
    (key: string, values?: Record<string, unknown>) =>
      t(key as never, values as never),
    [t]
  )
  const confirm = useCallback((message: string) => confirmDialog(message), [])
  const removeFileViewState = useCallback((path: string) => {
    try {
      window.localStorage.removeItem(
        `berth:file-view-state:v1:${encodeURIComponent(path)}`
      )
    } catch {
      // 位置清理失败不阻塞关闭。
    }
  }, [])
  return useMemo(
    () => ({
      scope: activeFolderId,
      folders,
      translate,
      confirm,
      removeFileViewState,
    }),
    [activeFolderId, confirm, folders, removeFileViewState, translate]
  )
}

/** Binds the React-free workspace runtime to the current folder snapshot. */
export function useWorkspaceRuntimeActions(options?: {
  withExternalConflict?: boolean
}): BoundWorkspaceRuntimeActions {
  // action 在调用时读最新 deps，函数引用整个生命周期不变：scope / folders 变化不会让
  // 29 个调用方拿到一整套新函数、把 memo 子组件（如侧栏项目行）全部打穿。
  const depsRef = useRef<WorkspaceRuntimeDependencies>(null!)
  depsRef.current = useWorkspaceRuntimeDependencies()
  const withExternalConflict = options?.withExternalConflict === true
  const externalConflict = useWorkspaceFileStore((state) =>
    withExternalConflict ? (state.externalConflictQueue[0] ?? null) : null
  )

  const actions = useMemo(() => {
    const deps: WorkspaceRuntimeDependencies = {
      get scope() {
        return depsRef.current.scope
      },
      get folders() {
        return depsRef.current.folders
      },
      get translate() {
        return depsRef.current.translate
      },
      get confirm() {
        return depsRef.current.confirm
      },
      get removeFileViewState() {
        return depsRef.current.removeFileViewState
      },
    }
    return {
      setActivePane: workspaceRuntime.setActivePane,
      activateConversationPane: workspaceRuntime.activateConversationPane,
      activateFilePane: workspaceRuntime.activateFilePane,
      switchFileTab: workspaceRuntime.switchFileTab,
      closeFileTab: (id: string) => workspaceRuntime.closeFileTab(id, deps),
      closeOtherFileTabs: (id: string) =>
        workspaceRuntime.closeOtherFileTabs(id, deps),
      closeAllFileTabs: () => workspaceRuntime.closeAllFileTabs(deps),
      reorderFileTabs: (tabs: FileWorkspaceTab[]) =>
        workspaceRuntime.reorderFileTabs(tabs, deps),
      openFilePreview: (path: string, options?: WorkspaceFileOpenOptions) =>
        workspaceRuntime.openFilePreview(path, options, deps),
      openReadonlyTextPreview: (options: ReadonlyTextPreviewOptions) =>
        workspaceRuntime.openReadonlyTextPreview(options, deps),
      openTranscriptTab: (options: TranscriptTabOptions) =>
        workspaceRuntime.openTranscriptTab(options, deps),
      openTaskTab: (options: TaskTabOptions) =>
        workspaceRuntime.openTaskTab(options, deps),
      openBerthSessionTab: (options: BerthSessionTabOptions) =>
        workspaceRuntime.openBerthSessionTab(options, deps),
      reloadOpenFileBackground: (path: string) =>
        workspaceRuntime.reloadOpenFileBackground(path, deps),
      bumpResourceRevision: workspaceRuntime.bumpResourceRevision,
      applyExternalReload: (path: string, fetched: FileEditContent) =>
        workspaceRuntime.applyExternalReload(path, fetched, deps),
      markTabsStale: workspaceRuntime.markTabsStale,
      markTabsStaleBatch: workspaceRuntime.markTabsStaleBatch,
      consumeSelfWriteEcho: workspaceRuntime.consumeSelfWriteEcho,
      rejectFileTab: (path: string, error: string) =>
        workspaceRuntime.rejectFileTab(path, error, deps),
      consumePendingFileReveal: workspaceRuntime.consumePendingFileReveal,
      openWorkingTreeDiff: (path?: string, options?: WorkingTreeDiffOptions) =>
        workspaceRuntime.openWorkingTreeDiff(path, options, deps),
      openBranchDiff: (
        branch: string,
        path?: string,
        options?: BranchDiffOptions
      ) => workspaceRuntime.openBranchDiff(branch, path, options, deps),
      openCommitDiff: (
        commit: string,
        path?: string,
        message?: string,
        options?: { folderId?: number }
      ) =>
        workspaceRuntime.openCommitDiff(commit, path, message, options, deps),
      openSessionFileDiff: (
        filePath: string,
        content: string,
        groupLabel: string,
        options?: { folderId?: number }
      ) =>
        workspaceRuntime.openSessionFileDiff(
          filePath,
          content,
          groupLabel,
          options,
          deps
        ),
      openExternalConflictDiff: (
        path: string,
        diskContent: string,
        unsavedContent: string
      ) =>
        workspaceRuntime.openExternalConflictDiff(
          path,
          diskContent,
          unsavedContent,
          deps
        ),
      enqueueExternalConflict: workspaceRuntime.enqueueExternalConflict,
      compareExternalConflict: () =>
        workspaceRuntime.compareExternalConflict(deps),
      reloadExternalConflict: () =>
        workspaceRuntime.reloadExternalConflict(deps),
      saveExternalConflictCopy: workspaceRuntime.saveExternalConflictCopy,
      dismissExternalConflict: workspaceRuntime.dismissExternalConflict,
      updateActiveFileContent: workspaceRuntime.updateActiveFileContent,
      updateFileTabContent: workspaceRuntime.updateFileTabContent,
      saveActiveFile: (options?: { force?: boolean }) =>
        workspaceRuntime.saveActiveFile(options, deps),
      saveFileTab: (id: string, options?: { force?: boolean }) =>
        workspaceRuntime.saveFileTab(id, options, deps),
      setFileTabComposing: (id: string, composing: boolean) =>
        workspaceRuntime.setFileTabComposing(id, composing, deps),
      reloadActiveFile: () => workspaceRuntime.reloadActiveFile(deps),
      toggleFileTabPreview: workspaceRuntime.toggleFileTabPreview,
    }
  }, [])

  return useMemo(
    () => ({ ...actions, externalConflict }),
    [actions, externalConflict]
  )
}
