"use client"

import { useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { useTranslations } from "next-intl"
import { confirmDialog, isDesktop, subscribe } from "@/lib/platform"
import { useActiveFolder } from "@/contexts/active-folder-context"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabStore } from "@/stores/tab-store"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"
import {
  persistSplitFold,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { useWorkspaceLayoutProjection } from "@/hooks/workspace/use-workspace-layout"
import { useOpenFileTabsWatch } from "@/hooks/workspace/use-open-file-tabs-watch"
import { useWorkspaceStateStore } from "@/hooks/workspace/use-workspace-state-store"
import { useOfficeAutoPreview } from "@/lib/files/office-preview-prefs"
import { isOfficePreviewable } from "@/lib/files/language-detect"
import { joinRootRel } from "@/lib/files/file-open-target"
import {
  FILE_READER_STATE_KEY,
  parseFileReaderState,
  serializeFileReaderState,
  type PersistedFileReaderTab,
} from "@/lib/files/file-tab-persistence"
import { buildFileTabId } from "@/lib/files/file-tab-id"
import {
  buildTaskTabId,
  buildTranscriptTabId,
} from "@/lib/files/file-workspace-tab"
import type { TabItem } from "@/stores/tab-store"
import { fileOpenStrategyFromPath } from "@/lib/files/file-open-strategy"
import { languageFromPath } from "@/lib/files/language-detect"
import {
  isTextFileTab,
  type BaseWorkspaceTab,
  type FileWorkspaceTab,
  type ResourcePreviewState,
} from "@/lib/files/file-workspace-tab"
import { fileTabsForFolderScope } from "@/lib/workspace/tab-scope"
import { resolveFolderWorkspaceChrome } from "@/lib/workspace/folder-workspace-chrome"
import { workspaceRuntime } from "@/lib/workspace/workspace-runtime"
import { type WorkspaceTabRef } from "@/lib/workspace/workspace-tab-placement"

function primaryRef(id: string, type?: TabItem["kind"]): WorkspaceTabRef {
  return { kind: "primary", id, type }
}

function fileRef(id: string, type?: FileWorkspaceTab["kind"]): WorkspaceTabRef {
  return { kind: "file", id, type }
}

function restoreTab(tab: PersistedFileReaderTab): FileWorkspaceTab {
  if (tab.kind === "task") {
    return {
      id: buildTaskTabId(tab.folderId, tab.taskDirName),
      kind: "task",
      folderId: tab.folderId,
      taskDirName: tab.taskDirName,
      title: tab.title,
      description: tab.taskDirName,
      path: null,
      readonly: true,
      loading: false,
      saveState: "idle",
      saveError: null,
    }
  }
  if (tab.kind === "transcript") {
    return {
      id: buildTranscriptTabId(tab.conversationId),
      kind: "transcript",
      conversationId: tab.conversationId,
      agentType: tab.agentType,
      folderId: tab.folderId,
      title: tab.title,
      description: tab.title,
      path: null,
      readonly: true,
      loading: false,
      saveState: "idle",
      saveError: null,
    }
  }
  const strategy = fileOpenStrategyFromPath(tab.path)
  const base: BaseWorkspaceTab = {
    id: buildFileTabId({ kind: "file", path: tab.path }),
    folderId: tab.folderId,
    title: tab.path.split("/").pop() || tab.path,
    description: tab.path,
    path: tab.path,
    loading: false,
    saveState: "idle",
    saveError: null,
    ...(tab.openedInFolderId !== undefined
      ? { openedInFolderId: tab.openedInFolderId }
      : {}),
  }
  if (strategy.dataMode === "text") {
    return {
      ...base,
      kind: "file",
      dataMode: "text",
      previewKind: strategy.previewKind,
      path: tab.path,
      language: languageFromPath(tab.path),
      content: "",
      savedContent: "",
      isDirty: false,
      etag: null,
      mtimeMs: null,
      readonly: tab.readonly,
      lineEnding: "none",
      stale: true,
      ...(tab.lifetime ? { lifetime: tab.lifetime } : {}),
    }
  }
  const preview: ResourcePreviewState =
    strategy.previewKind === "image"
      ? { kind: "image", revision: 0, dataUrl: null }
      : { kind: strategy.previewKind, revision: 0 }
  return {
    ...base,
    kind: "file",
    dataMode: "resource",
    path: tab.path,
    preview,
    readonly: true,
    stale: true,
    ...(tab.lifetime ? { lifetime: tab.lifetime } : {}),
  }
}

// 与 Rust `windows::QUIT_REQUESTED_EVENT` 同步。
const QUIT_REQUESTED_EVENT = "app://quit-requested"

function hasDirtyFileTabs(): boolean {
  return useWorkspaceFileStore
    .getState()
    .fileTabs.some((tab) => isTextFileTab(tab) && tab.isDirty)
}

/**
 * Render-null owner for workspace file runtime lifecycle. It is deliberately
 * not a Provider: React supplies only current folder/translation snapshots;
 * all file and surface mutations are performed by the headless runtime.
 */
export function WorkspaceRuntimeHost() {
  const tWorkspace = useTranslations("Folder.workspaceContext")
  const { activeFolder, activeFolderId } = useActiveFolder()
  const folders = useAppWorkspaceStore((state) => state.allFolders)
  const actions = useWorkspaceRuntimeActions()
  const activePane = useWorkspaceLayoutStore((state) => state.activePane)
  const previousPaneRef = useRef(activePane)
  const initialScopeRef = useRef(activeFolderId)
  const initialFoldersRef = useRef(folders)
  const fileTabs = useWorkspaceFileStore((state) => state.fileTabs)
  const activeFileTabId = useWorkspaceFileStore(
    (state) => state.activeFileTabId
  )
  const persistenceReady = useRef(false)
  const fileTabsRef = useRef(fileTabs)
  const activeFileTabIdRef = useRef(activeFileTabId)
  const activeScopeRef = useRef<number | null>(activeFolderId)
  const recencyRef = useRef<string[]>([])

  useEffect(() => {
    fileTabsRef.current = fileTabs
  }, [fileTabs])
  useEffect(() => {
    activeFileTabIdRef.current = activeFileTabId
  }, [activeFileTabId])

  useEffect(() => {
    let raw: string | null = null
    try {
      raw = window.localStorage.getItem(FILE_READER_STATE_KEY)
    } catch {
      // 无 localStorage 时使用内存态。
    }
    const stored = parseFileReaderState(raw)
    const tabs = stored.tabs.map(restoreTab)
    const visible = fileTabsForFolderScope(
      tabs,
      initialScopeRef.current,
      initialFoldersRef.current
    )
    const active = visible.some((tab) => tab.id === stored.activeTabId)
      ? stored.activeTabId
      : (visible[0]?.id ?? null)
    useWorkspaceFileStore.getState().restoreFileTabs({
      tabs,
      activeTabId: active,
      activeTabIdByScope: stored.activeTabIdByFolder,
    })
    activeFileTabIdRef.current = active
    if (active) {
      useWorkspaceLayoutStore.getState().activateFileTab(active)
    }
    persistenceReady.current = true
  }, [])

  // 未保存内容不持久化：reload 前让 webview 弹确认框；退出（托盘「退出」、
  // 无托盘平台的关闭按钮）由宿主发 quit-requested，确认后再退出。
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (!hasDirtyFileTabs()) return
      // WebKitGTK 只认 returnValue，单调 preventDefault 不弹框。
      event.preventDefault()
      event.returnValue = ""
    }
    window.addEventListener("beforeunload", onBeforeUnload)
    return () => window.removeEventListener("beforeunload", onBeforeUnload)
  }, [])

  useEffect(() => {
    if (!isDesktop()) return
    let disposed = false
    let unsubscribe: (() => void) | undefined
    void subscribe(QUIT_REQUESTED_EVENT, async () => {
      if (
        hasDirtyFileTabs() &&
        !(await confirmDialog(tWorkspace("confirmQuitWithDirtyTabs")))
      ) {
        return
      }
      const { exit } = await import("@tauri-apps/plugin-process")
      await exit(0)
    }).then((dispose) => {
      if (disposed) dispose()
      else unsubscribe = dispose
    })
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [tWorkspace])

  useEffect(() => {
    if (!persistenceReady.current) return
    // 读 store 当前值而非闭包：恢复 effect 与本 effect 同一次提交执行，闭包里仍是
    // 首帧的空列表；StrictMode 重跑恢复时会读到被写回的空状态，tab 全部丢失。
    const current = useWorkspaceFileStore.getState()
    const activeByFolder = Object.fromEntries(
      Object.entries(current.activeTabIdByScope).filter(
        ([key]) => key !== "none"
      )
    )
    try {
      window.localStorage.setItem(
        FILE_READER_STATE_KEY,
        JSON.stringify(
          serializeFileReaderState(
            current.fileTabs,
            current.activeFileTabId,
            activeByFolder
          )
        )
      )
    } catch {
      // 持久化失败不影响当前阅读状态。
    }
  }, [activeFileTabId, fileTabs])

  useEffect(() => {
    const changed = previousPaneRef.current !== activePane
    previousPaneRef.current = activePane
    if (!changed || activeFolderId == null) return
    const tabState = useTabStore.getState()
    const active = tabState.rawTabs.find(
      (tab) => tab.id === tabState.activeTabId
    )
    if (active?.folderId !== activeFolderId) return
    tabState.rememberFolderWorkspace(activeFolderId, {
      primaryTabId: active.id,
      pane: activePane === "files" ? "file" : "conversation",
    })
  }, [activeFolderId, activePane])

  useLayoutEffect(() => {
    useTabStore.getState().setSideEffects({
      applyFolderWorkspace: ({ folderId, pane }) => {
        const previousScope = activeScopeRef.current
        const current = useWorkspaceFileStore.getState()
        if (previousScope !== folderId && current.activeFileTabId) {
          current.rememberActiveTab(previousScope, current.activeFileTabId)
        }
        activeScopeRef.current = folderId
        const nextTabs = fileTabsForFolderScope(
          current.fileTabs,
          folderId,
          useAppWorkspaceStore.getState().allFolders
        )
        const chrome = resolveFolderWorkspaceChrome({
          resumePane: pane,
          visibleFileTabIds: nextTabs.map((tab) => tab.id),
          rememberedFileTabId:
            folderId == null
              ? null
              : (current.activeTabIdByScope[String(folderId)] ?? null),
        })
        current.setActiveFileTabId(chrome.fileTabId)
        if (chrome.pane) {
          useWorkspaceLayoutStore.getState().setActivePane(chrome.pane)
        }
        const tabState = useTabStore.getState()
        const activePrimary = tabState.rawTabs.find(
          (tab) => tab.id === tabState.activeTabId
        )
        const next =
          chrome.pane === "files" && chrome.fileTabId
            ? fileRef(chrome.fileTabId)
            : chrome.pane === "conversation" && activePrimary
              ? primaryRef(activePrimary.id, activePrimary.kind)
              : null
        if (next) {
          // 选中态收敛走 store 显式 action，不在组件里裸写布局字段（C2）。
          useWorkspaceLayoutStore
            .getState()
            .adoptFolderSelection(folderId, next)
        }
      },
    })
  }, [])

  useEffect(() => {
    if (!activeFileTabId) return
    const next = [
      activeFileTabId,
      ...recencyRef.current.filter((id) => id !== activeFileTabId),
    ].slice(0, 512)
    recencyRef.current = next
    useWorkspaceFileStore
      .getState()
      .rememberActiveTab(activeFolderId, activeFileTabId)
  }, [activeFileTabId, activeFolderId])

  useEffect(() => {
    // 冷内容逐出策略在无 React 的 runtime 层；effect 只负责订阅与委托（C3）。
    workspaceRuntime.unloadColdTextContent(
      fileTabs,
      activeFileTabId,
      recencyRef.current
    )
  }, [activeFileTabId, fileTabs])

  // 拆分视图里另一侧正在显示的 tab 不是 activeFileTab，按激活加载 stale 内容的逻辑
  // （use-open-file-tabs-watch）轮不到它，会一直空白：后台补读，不抢激活。
  const splitShownTabIds = useWorkspaceLayoutProjection(({ activeTabByPane }) =>
    (["files", "files-split"] as const).map((pane) => {
      const ref = activeTabByPane[pane]
      return ref?.kind === "file" ? ref.id : null
    })
  )
  useEffect(() => {
    for (const id of splitShownTabIds) {
      if (!id || id === activeFileTabId) continue
      const tab = fileTabs.find((candidate) => candidate.id === id)
      if (tab && isTextFileTab(tab) && tab.stale && !tab.loading) {
        void actions.reloadOpenFileBackground(tab.path)
      }
    }
  }, [actions, activeFileTabId, fileTabs, splitShownTabIds])

  useEffect(() => {
    // 左栏清空后把右栏折叠写回持久化；判定在布局 store，这里只订阅与委托（C3）。
    const unsubscribers = [
      useWorkspaceLayoutStore.subscribe(persistSplitFold),
      useTabStore.subscribe(persistSplitFold),
      useWorkspaceFileStore.subscribe(persistSplitFold),
      useAppWorkspaceStore.subscribe(persistSplitFold),
    ]
    return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
  }, [])

  const activeFileTab = useMemo(
    () =>
      fileTabsForFolderScope(fileTabs, activeFolderId, folders).find(
        (tab) => tab.id === activeFileTabId
      ) ?? null,
    [activeFileTabId, fileTabs, activeFolderId, folders]
  )

  useEffect(() => {
    if (
      !activeFileTab ||
      !isTextFileTab(activeFileTab) ||
      activeFileTab.loading ||
      activeFileTab.isDirty
    ) {
      return
    }
    useWorkspaceFileStore
      .getState()
      .clearExternalConflictsForPath(activeFileTab.path)
  }, [activeFileTab])

  const autoPreview = useOfficeAutoPreview()
  // Office auto-preview is the only runtime feature that needs a project-wide
  // path stream. Without it, open-file tabs subscribe to their own parent
  // directories below; do not keep an idle active-folder watcher alive.
  const watchStore = useWorkspaceStateStore(
    autoPreview ? (activeFolder?.path ?? null) : null,
    "paths"
  )
  const subscribeOfficeEnvelopes = watchStore.subscribeEnvelopes
  useEffect(() => {
    if (!autoPreview || !activeFolder || !subscribeOfficeEnvelopes) return
    const opened = new Set<string>()
    return subscribeOfficeEnvelopes(({ changed_paths }) => {
      for (const changed of changed_paths ?? []) {
        if (!isOfficePreviewable(changed)) continue
        const path = joinRootRel(activeFolder.path, changed)
        if (
          opened.has(path) ||
          fileTabsRef.current.some((tab) => tab.path === path)
        )
          continue
        opened.add(path)
        void actions.openFilePreview(path)
      }
    })
  }, [actions, activeFolder, autoPreview, subscribeOfficeEnvelopes])

  useOpenFileTabsWatch({
    fileTabs,
    fileTabsRef,
    activeFileTabIdRef,
    activeFileTab,
    allFolders: folders,
    openFilePreview: actions.openFilePreview,
    closeFileTab: actions.closeFileTab,
    bumpResourceRevision: actions.bumpResourceRevision,
    applyExternalReload: actions.applyExternalReload,
    markTabsStale: actions.markTabsStale,
    markTabsStaleBatch: actions.markTabsStaleBatch,
    rejectFileTab: actions.rejectFileTab,
    enqueueExternalConflict: actions.enqueueExternalConflict,
    consumeSelfWriteEcho: actions.consumeSelfWriteEcho,
  })

  return null
}
