import {
  gitDiff,
  gitDiffWithBranch,
  gitShowDiff,
  gitShowFile,
  readFileBase64,
  readFilePreview,
  saveFileCopy,
  type WorkspaceOpenFileOutcome,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { toast } from "@/lib/notify"
import {
  expandHomePath,
  findOwningFolder,
  isVirtualPreviewPath,
  joinRootRel,
  normalizeAbsPath,
  splitAbsPath,
  VIRTUAL_PREVIEW_ROOT,
} from "@/lib/files/file-open-target"
import { isAbsoluteFilePath } from "@/lib/files/file-path-display"
import {
  isHtmlPreviewable,
  languageFromPath,
} from "@/lib/files/language-detect"
import { fileOpenStrategyFromPath } from "@/lib/files/file-open-strategy"
import {
  buildTaskTabId,
  isResourceFileTab,
  isTextFileTab,
  type BaseWorkspaceTab,
  type DiffWorkspaceTab,
  type FileWorkspaceTab,
  type ResourceFileWorkspaceTab,
  type ResourcePreviewState,
  type RichDiffWorkspaceTab,
  type TextFileWorkspaceTab,
} from "@/lib/files/file-workspace-tab"
import { buildFileTabId } from "@/lib/files/file-tab-id"
import {
  fileTabsForFolderScope,
  mergeFileTabsForFolderScope,
  type FolderPathEntry,
} from "@/lib/workspace/tab-scope"
import {
  mergePaneReorder,
  paneForTab,
  type WorkspacePane,
} from "@/lib/workspace/workspace-tab-placement"
import { workspacePlacementForFolder } from "@/stores/workspace-layout-store"
import {
  configureWorkspaceLayoutFileActivator,
  useWorkspaceLayoutStore,
} from "@/stores/workspace-layout-store"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabStore } from "@/stores/tab-store"
import {
  workspaceFileRuntime,
  type WorkspaceExternalConflict,
  type WorkspaceFileRuntimeContext,
} from "@/lib/workspace/workspace-file-runtime"
import type { AgentType, FileEditContent } from "@/lib/types"

export type { WorkspaceExternalConflict } from "@/lib/workspace/workspace-file-runtime"

export interface WorkspaceRuntimeDependencies {
  scope: number | null
  folders: readonly FolderPathEntry[]
  translate: (key: string, values?: Record<string, unknown>) => string
  confirm?: (message: string) => boolean | Promise<boolean>
  /** React-land storage adapter for per-file editor view state cleanup. */
  removeFileViewState?: (path: string) => void
}

export interface WorkspaceRuntimeActions {
  setActivePane: (pane: WorkspacePane) => void
  activateConversationPane: (preserveGlobalTab?: boolean) => void
  activateFilePane: () => void
  switchFileTab: (tabId: string) => void
  closeFileTab: (
    tabId: string,
    deps: WorkspaceRuntimeDependencies
  ) => Promise<void>
  closeOtherFileTabs: (
    tabId: string,
    deps: WorkspaceRuntimeDependencies
  ) => Promise<void>
  closeAllFileTabs: (deps: WorkspaceRuntimeDependencies) => Promise<void>
  reorderFileTabs: (
    tabs: FileWorkspaceTab[],
    deps: WorkspaceRuntimeDependencies
  ) => void
  openFilePreview: (
    path: string,
    options: WorkspaceFileOpenOptions | undefined,
    deps: WorkspaceRuntimeDependencies
  ) => Promise<void>
  openReadonlyTextPreview: (
    options: ReadonlyTextPreviewOptions,
    deps: WorkspaceRuntimeDependencies
  ) => void
  openTranscriptTab: (
    options: TranscriptTabOptions,
    deps: WorkspaceRuntimeDependencies
  ) => void
  openTaskTab: (
    options: TaskTabOptions,
    deps: WorkspaceRuntimeDependencies
  ) => void
  reloadOpenFileBackground: (
    path: string,
    deps: WorkspaceRuntimeDependencies
  ) => Promise<void>
  bumpResourceRevision: (path: string) => void
  applyExternalReload: (
    path: string,
    fetched: FileEditContent,
    deps: WorkspaceRuntimeDependencies
  ) => void
  markTabsStale: (path: string) => void
  markTabsStaleBatch: (paths: string[]) => void
  consumeSelfWriteEcho: (path: string) => boolean
  rejectFileTab: (
    path: string,
    errorMessage: string,
    deps: WorkspaceRuntimeDependencies
  ) => void
  consumePendingFileReveal: (requestId: number) => void
  openWorkingTreeDiff: (
    path: string | undefined,
    options: WorkingTreeDiffOptions | undefined,
    deps: WorkspaceRuntimeDependencies
  ) => Promise<void>
  openBranchDiff: (
    branch: string,
    path: string | undefined,
    options: BranchDiffOptions | undefined,
    deps: WorkspaceRuntimeDependencies
  ) => Promise<void>
  openCommitDiff: (
    commit: string,
    path: string | undefined,
    message: string | undefined,
    options: { folderId?: number } | undefined,
    deps: WorkspaceRuntimeDependencies
  ) => Promise<void>
  openSessionFileDiff: (
    filePath: string,
    diffContent: string,
    groupLabel: string,
    options: { folderId?: number } | undefined,
    deps: WorkspaceRuntimeDependencies
  ) => void
  openExternalConflictDiff: (
    filePath: string,
    diskContent: string,
    unsavedContent: string,
    deps: WorkspaceRuntimeDependencies
  ) => void
  enqueueExternalConflict: (
    conflict: WorkspaceExternalConflict,
    options?: { force?: boolean }
  ) => void
  externalConflict: WorkspaceExternalConflict | null
  compareExternalConflict: (deps: WorkspaceRuntimeDependencies) => void
  reloadExternalConflict: (deps: WorkspaceRuntimeDependencies) => void
  saveExternalConflictCopy: () => Promise<string>
  dismissExternalConflict: () => void
  updateActiveFileContent: (content: string) => void
  updateFileTabContent: (tabId: string, content: string) => void
  saveActiveFile: (
    options: { force?: boolean } | undefined,
    deps: WorkspaceRuntimeDependencies
  ) => Promise<boolean>
  saveFileTab: (
    tabId: string,
    options: { force?: boolean } | undefined,
    deps: WorkspaceRuntimeDependencies
  ) => Promise<boolean>
  setFileTabComposing: (
    tabId: string,
    composing: boolean,
    deps: WorkspaceRuntimeDependencies
  ) => void
  reloadActiveFile: (deps: WorkspaceRuntimeDependencies) => Promise<void>
  toggleFileTabPreview: (tabId: string) => void
  /** >4MB 冷内容 LRU 逐出；不动 dirty/loading/saving 的 tab。 */
  unloadColdTextContent: (
    fileTabs: readonly FileWorkspaceTab[],
    activeFileTabId: string | null,
    recency?: readonly string[]
  ) => number
}

export interface WorkspaceFileOpenOptions {
  /** 绑定本次打开的真实 viewer 回执，不等同于加载 Promise 完成。 */
  onReveal?: (outcome: WorkspaceOpenFileOutcome) => void
  signal?: AbortSignal
  line?: number
  page?: number
  reload?: boolean
  folderId?: number
  readonly?: boolean
  lifetime?: "global" | "project"
  format?: "text" | "json" | "toml" | "yaml"
  /** 用户点击要看：文件属于别的项目时直接切过去，而不是后台打开再提示。 */
  switchToOwner?: boolean
}

export interface ReadonlyTextPreviewOptions {
  id: string
  title: string
  path: string
  content: string
  folderId?: number
  lifetime?: "global" | "project"
}

export interface TranscriptTabOptions {
  conversationId: number
  folderId: number
  agentType: AgentType
  title: string
}

export interface TaskTabOptions {
  folderId: number
  taskDirName: string
  title: string
}

export interface WorkingTreeDiffOptions {
  mode?: "auto" | "unified" | "overview"
  folderId?: number
}

export interface BranchDiffOptions {
  mode?: "default" | "overview"
  folderId?: number
}

type LoadingFileTabBase = Pick<
  BaseWorkspaceTab,
  "id" | "folderId" | "title" | "description" | "path"
>

type ResourceLoad = { tabId: string; generation: number }

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  svg: "image/svg+xml",
  webp: "image/webp",
  bmp: "image/bmp",
  ico: "image/x-icon",
}

function fileName(path: string): string {
  return path.split("/").pop() || path
}

function normalizePath(path: string): string {
  return path.replace(/\\/g, "/")
}

function dirty(tab: FileWorkspaceTab): boolean {
  return isTextFileTab(tab) && tab.isDirty
}

function loadingResourceTab(
  base: LoadingFileTabBase,
  preview: ResourcePreviewState
): ResourceFileWorkspaceTab {
  return {
    ...base,
    path: base.path ?? "",
    kind: "file",
    dataMode: "resource",
    preview,
    readonly: true,
    loading: true,
    saveState: "idle",
    saveError: null,
  }
}

function loadingDiffTab(
  base: LoadingFileTabBase,
  kind: "diff" | "rich-diff",
  language: string
): DiffWorkspaceTab | RichDiffWorkspaceTab {
  const common = {
    ...base,
    loading: true,
    content: "",
    readonly: true as const,
    saveState: "idle" as const,
    saveError: null,
  }
  return kind === "diff"
    ? { ...common, kind, language: "diff" }
    : { ...common, kind, language }
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutMessage: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs)
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

function runtimeContext(
  deps: WorkspaceRuntimeDependencies
): WorkspaceFileRuntimeContext {
  return {
    scope: deps.scope,
    folders: deps.folders,
    translate: deps.translate,
    activateFileTab: (tabId) => {
      // 激活的文件域部分已在本函数所属调用中完成；这里只收敛布局侧副作用，
      // 避免布局 store 再次回调 file-runtime 形成双重执行。
      useWorkspaceLayoutStore.getState().adoptFileActivation(tabId)
    },
    enqueueExternalConflict: (conflict, options) => {
      useWorkspaceFileStore
        .getState()
        .enqueueExternalConflict(conflict, options)
    },
  }
}

function currentTab(tabId: string): FileWorkspaceTab | null {
  return (
    useWorkspaceFileStore.getState().fileTabs.find((tab) => tab.id === tabId) ??
    null
  )
}

function activateTab(
  tabId: string,
  deps: WorkspaceRuntimeDependencies
): boolean {
  return workspaceFileRuntime.activateFileTab(tabId, runtimeContext(deps))
}

/**
 * 单次激活入口：文件域语义在 file-runtime 一处执行；
 * 布局切换由 runtimeContext 注入的 adoptFileActivation 完成。
 */
function activateLayoutTab(
  tabId: string,
  deps: WorkspaceRuntimeDependencies
): void {
  activateTab(tabId, deps)
}

/** 切到文件所属项目并选中它的 tab。 */
function switchToOpenedTab(tabId: string, folderId: number): void {
  const tab = currentTab(tabId)
  if (!tab) return
  useTabStore.getState().activateFolderWorkspace(folderId)
  useWorkspaceLayoutStore.getState().selectWorkspaceTab({
    kind: "file",
    id: tabId,
    type: tab.kind,
  })
}

/** 文件已在所属项目 `folderId` 打开：标「新开未看」，并提示可切过去。 */
function announceOpenedElsewhere(
  tabId: string,
  folderId: number,
  deps: WorkspaceRuntimeDependencies
): void {
  const tab = currentTab(tabId)
  if (!tab) return
  useWorkspaceFileStore.getState().setFileTabUnseen(tabId, true)
  const folder = useAppWorkspaceStore
    .getState()
    .allFolders.find((candidate) => candidate.id === folderId)
  toast(
    deps.translate("openedInOtherProject", {
      file: tab.title,
      project: folder?.alias || folder?.name || String(folderId),
    }),
    {
      action: {
        label: deps.translate("switchToProject"),
        onClick: () => switchToOpenedTab(tabId, folderId),
      },
    }
  )
}

function resolveTargetFolder(
  folderId: number | undefined,
  deps: WorkspaceRuntimeDependencies
): { id: number; path: string } | null {
  if (folderId != null) {
    const folder = deps.folders.find((candidate) => candidate.id === folderId)
    return folder ? { id: folder.id, path: folder.path } : null
  }
  if (deps.scope == null) return null
  const folder = deps.folders.find((candidate) => candidate.id === deps.scope)
  return folder ? { id: folder.id, path: folder.path } : null
}

async function resolveOpenPath(
  rawPath: string,
  folderId: number | undefined,
  deps: WorkspaceRuntimeDependencies
): Promise<string | null> {
  const input = rawPath.startsWith("~/")
    ? await expandHomePath(rawPath)
    : rawPath
  if (isAbsoluteFilePath(input)) {
    const abs = normalizeAbsPath(input)
    const owning = findOwningFolder(abs, deps.folders)
    return owning ? joinRootRel(owning.rootPath, owning.relPath) : abs
  }
  const target = resolveTargetFolder(folderId, deps)
  return target ? joinRootRel(target.path, normalizePath(input)) : null
}

export function createWorkspaceRuntime(): WorkspaceRuntimeActions {
  const resources = new Map<string, number>()
  let nextResourceGeneration = 0
  let nextRevealRequestId = 0

  const beginResource = (tabId: string): ResourceLoad => {
    nextResourceGeneration += 1
    const generation = nextResourceGeneration
    resources.set(tabId, generation)
    return { tabId, generation }
  }

  const settleResource = ({ tabId, generation }: ResourceLoad): boolean => {
    if (resources.get(tabId) !== generation) return false
    resources.delete(tabId)
    return true
  }

  const replaceTab = (
    tab: FileWorkspaceTab,
    deps: WorkspaceRuntimeDependencies
  ) => {
    useWorkspaceFileStore.getState().setFileTabs((previous) => {
      const index = previous.findIndex((candidate) => candidate.id === tab.id)
      if (index < 0) return [...previous, tab]
      const next = [...previous]
      next[index] = tab
      return next
    })
    activateLayoutTab(tab.id, deps)
  }

  const markRefreshing = (tabId: string): void => {
    useWorkspaceFileStore
      .getState()
      .setFileTabs((tabs) =>
        tabs.map((tab) =>
          tab.id === tabId
            ? { ...tab, loading: true, saveState: "idle", saveError: null }
            : tab
        )
      )
  }

  const markRetry = (tabId: string): void => {
    useWorkspaceFileStore.getState().setFileTabs((tabs) =>
      tabs.map((tab) => {
        if (tab.id !== tabId) return tab
        if (isResourceFileTab(tab)) {
          return { ...tab, loading: true, saveState: "idle", saveError: null }
        }
        if (tab.kind === "rich-diff") {
          return {
            ...tab,
            loading: true,
            content: "",
            originalContent: undefined,
            modifiedContent: undefined,
            saveState: "idle",
            saveError: null,
          }
        }
        if (tab.kind === "diff" || tab.kind === "file") {
          return {
            ...tab,
            loading: true,
            content: "",
            saveState: "idle",
            saveError: null,
          }
        }
        return tab
      })
    )
  }

  const loadResource = async (
    seed: ResourceFileWorkspaceTab,
    deps: WorkspaceRuntimeDependencies
  ): Promise<void> => {
    const existing = currentTab(seed.id)
    if (resources.has(seed.id)) {
      activateLayoutTab(seed.id, deps)
      return
    }
    if (!existing) {
      useWorkspaceFileStore.getState().insertFileTab(seed)
      activateLayoutTab(seed.id, deps)
    } else {
      activateLayoutTab(seed.id, deps)
      if (existing.saveState === "error") markRetry(seed.id)
      else markRefreshing(seed.id)
    }
    const load = beginResource(seed.id)
    try {
      if (seed.preview.kind === "office") {
        if (!settleResource(load)) return
        useWorkspaceFileStore.getState().setFileTabs((tabs) =>
          tabs.map((tab) =>
            tab.id === seed.id && isResourceFileTab(tab)
              ? {
                  ...tab,
                  preview: {
                    kind: "office",
                    revision: tab.preview.revision + 1,
                  },
                  loading: false,
                  stale: false,
                  saveState: "idle",
                  saveError: null,
                }
              : tab
          )
        )
        return
      }
      if (seed.preview.kind === "image") {
        const ext = seed.path.split(".").pop()?.toLowerCase() ?? ""
        const b64 = await withTimeout(
          readFileBase64(seed.path),
          15_000,
          deps.translate("previewRequestTimedOut")
        )
        if (!settleResource(load)) return
        useWorkspaceFileStore.getState().setFileTabs((tabs) =>
          tabs.map((tab) =>
            tab.id === seed.id && isResourceFileTab(tab)
              ? {
                  ...tab,
                  preview: {
                    kind: "image",
                    revision: tab.preview.revision + 1,
                    dataUrl: `data:${IMAGE_MIME[ext] ?? "image/png"};base64,${b64}`,
                  },
                  loading: false,
                  stale: false,
                  saveState: "idle",
                  saveError: null,
                }
              : tab
          )
        )
        return
      }
      if (settleResource(load)) {
        useWorkspaceFileStore
          .getState()
          .setFileTabs((tabs) =>
            tabs.map((tab) =>
              tab.id === seed.id
                ? { ...tab, loading: false, stale: false, saveState: "idle" }
                : tab
            )
          )
      }
    } catch (error) {
      if (!settleResource(load)) return
      const errorMessage = toErrorMessage(error)
      toast.error(errorMessage)
      const current = currentTab(seed.id)
      if (current) {
        void closeFileTab(seed.id, deps)
      }
    }
  }

  const openFilePreview = async (
    rawPath: string,
    options: WorkspaceFileOpenOptions | undefined,
    deps: WorkspaceRuntimeDependencies
  ): Promise<void> => {
    options?.signal?.throwIfAborted()
    const path = await resolveOpenPath(rawPath, options?.folderId, deps)
    options?.signal?.throwIfAborted()
    if (!path || isVirtualPreviewPath(path)) {
      if (options?.onReveal)
        throw new Error("file reveal requires a local file path")
      if (path) {
        const tabId = buildFileTabId({ kind: "file", path })
        if (currentTab(tabId)) activateLayoutTab(tabId, deps)
      }
      return
    }
    const requestedLine =
      typeof options?.line === "number" && Number.isFinite(options.line)
        ? Math.max(1, Math.floor(options.line))
        : null
    const requestedPage =
      typeof options?.page === "number" && Number.isFinite(options.page)
        ? Math.max(1, Math.floor(options.page))
        : null
    const revealRequestId = ++nextRevealRequestId
    if (requestedLine !== null || requestedPage !== null || options?.onReveal) {
      useWorkspaceFileStore.getState().setPendingFileReveal({
        requestId: revealRequestId,
        path,
        line: requestedLine,
        page: requestedPage,
        ready: false,
        onComplete: options?.onReveal,
      })
    } else {
      useWorkspaceFileStore.getState().setPendingFileReveal(null)
    }
    const strategy = fileOpenStrategyFromPath(path)
    const owning = findOwningFolder(path, deps.folders)
    const base = {
      id: buildFileTabId({ kind: "file", path }),
      folderId: owning?.folderId ?? null,
      openedInFolderId: deps.scope,
      title: fileName(path),
      description: path,
      path,
    }
    const finishRevealLoad = () => {
      options?.signal?.throwIfAborted()
      if (options?.onReveal && !currentTab(base.id))
        throw new Error("file could not be loaded")
      useWorkspaceFileStore
        .getState()
        .setPendingFileReveal((pending) =>
          pending?.requestId === revealRequestId &&
          pending.path === path &&
          pending.onComplete === options?.onReveal
            ? { ...pending, ready: true }
            : pending
        )
    }
    // tab 只显示在文件所属项目（钉住的到处可见）。在别的项目打开时一律留在当前项目，
    // 给 tab 标绿点并提示可切换——`berth open` 也不切，免得打断正在输入的人。
    const owner = owning?.folderId ?? null
    const elsewhere =
      owner != null &&
      owner !== deps.scope &&
      options?.lifetime !== "global" &&
      currentTab(base.id)?.lifetime !== "global"
    const announce = () => {
      if (!elsewhere || owner == null) return
      if (options?.switchToOwner) return switchToOpenedTab(base.id, owner)
      announceOpenedElsewhere(base.id, owner, deps)
      const onReveal = options?.onReveal
      if (!onReveal) return
      // 后台打开即回执；行定位留在 pendingFileReveal，切过去 tab 可见时再落点。
      useWorkspaceFileStore
        .getState()
        .setPendingFileReveal((pending) =>
          pending?.requestId === revealRequestId
            ? { ...pending, onComplete: undefined }
            : pending
        )
      onReveal({ state: "opened", path, line: requestedLine })
    }
    if (strategy.dataMode === "text") {
      await workspaceFileRuntime.openTextFile(
        path,
        options,
        runtimeContext(deps)
      )
      options?.signal?.throwIfAborted()
      if (isHtmlPreviewable(path)) {
        useWorkspaceFileStore.getState().setPreviewFileTabIds((previous) => {
          const next = new Set(previous)
          // 行定位总回源码
          if (requestedLine === null) next.add(base.id)
          else next.delete(base.id)
          return next
        })
      }
      finishRevealLoad()
      announce()
      return
    }
    const seed = loadingResourceTab(
      { ...base, ...(options?.lifetime ? { lifetime: options.lifetime } : {}) },
      strategy.previewKind === "image"
        ? { kind: "image", revision: 0, dataUrl: null }
        : { kind: strategy.previewKind, revision: 0 }
    )
    const existing = currentTab(seed.id)
    if (existing && (options?.readonly || options?.lifetime === "global")) {
      useWorkspaceFileStore.getState().setFileTabs((tabs) =>
        tabs.map((tab) =>
          tab.id !== seed.id
            ? tab
            : {
                ...tab,
                ...(options?.lifetime === "global"
                  ? { lifetime: "global" as const }
                  : {}),
              }
        )
      )
    }
    await loadResource(seed, deps)
    finishRevealLoad()
    announce()
  }

  const openReadonlyTextPreview = (
    options: ReadonlyTextPreviewOptions,
    deps: WorkspaceRuntimeDependencies
  ): void => {
    const virtualPath = `${VIRTUAL_PREVIEW_ROOT}/${encodeURIComponent(options.id)}/${options.path.replace(/^\/+/, "")}`
    const strategy = fileOpenStrategyFromPath(options.path)
    const previewKind =
      strategy.dataMode === "text" &&
      (strategy.previewKind === "markdown" || strategy.previewKind === "html")
        ? strategy.previewKind
        : "text"
    const tab: TextFileWorkspaceTab = {
      id: buildFileTabId({ kind: "file", path: virtualPath }),
      kind: "file",
      dataMode: "text",
      previewKind,
      folderId: options.folderId ?? null,
      title: options.title,
      description: options.path,
      path: virtualPath,
      language: languageFromPath(options.path),
      content: options.content,
      savedContent: options.content,
      isDirty: false,
      etag: null,
      mtimeMs: null,
      readonly: true,
      lineEnding: "lf",
      loading: false,
      saveState: "idle",
      saveError: null,
      lifetime: options.lifetime ?? "project",
    }
    replaceTab(tab, deps)
    if (previewKind === "html") {
      useWorkspaceFileStore
        .getState()
        .setPreviewFileTabIds((previous) =>
          previous.has(tab.id) ? previous : new Set(previous).add(tab.id)
        )
    }
  }

  const openTranscriptTab = (
    options: TranscriptTabOptions,
    deps: WorkspaceRuntimeDependencies
  ): void => {
    const id = `transcript:${options.conversationId}`
    const existing = currentTab(id)
    if (!existing) {
      useWorkspaceFileStore.getState().insertFileTab({
        id,
        kind: "transcript",
        conversationId: options.conversationId,
        agentType: options.agentType,
        folderId: options.folderId,
        title: options.title,
        description: options.title,
        path: null,
        readonly: true,
        loading: false,
        saveState: "idle",
        saveError: null,
      })
    }
    activateLayoutTab(id, deps)
  }

  const openTaskTab = (
    options: TaskTabOptions,
    deps: WorkspaceRuntimeDependencies
  ): void => {
    const id = buildTaskTabId(options.folderId, options.taskDirName)
    if (!currentTab(id)) {
      useWorkspaceFileStore.getState().insertFileTab({
        id,
        kind: "task",
        folderId: options.folderId,
        taskDirName: options.taskDirName,
        title: options.title,
        description: options.taskDirName,
        path: null,
        readonly: true,
        loading: false,
        saveState: "idle",
        saveError: null,
      })
    }
    activateLayoutTab(id, deps)
  }

  const openExternalConflictDiff = (
    filePath: string,
    diskContent: string,
    unsavedContent: string,
    deps: WorkspaceRuntimeDependencies
  ): void => {
    const path = normalizeAbsPath(filePath)
    const owning = findOwningFolder(path, deps.folders)
    replaceTab(
      {
        id: buildFileTabId({ kind: "diff-external-conflict", path }),
        kind: "rich-diff",
        folderId: owning?.folderId ?? null,
        title: deps.translate("diffTitleConflictFile", {
          name: fileName(path),
        }),
        description: deps.translate("diffDescriptionConflict", { path }),
        path,
        language: languageFromPath(path),
        content: "",
        loading: false,
        originalContent: diskContent,
        modifiedContent: unsavedContent,
        readonly: true,
        saveState: "idle",
        saveError: null,
      },
      deps
    )
  }

  const setDiffContent = (tabId: string, content: string): void => {
    useWorkspaceFileStore
      .getState()
      .setFileTabs((tabs) =>
        tabs.map((tab) =>
          tab.id === tabId ? { ...tab, content, loading: false } : tab
        )
      )
  }
  const setRichDiffContent = (
    tabId: string,
    originalContent: string,
    modifiedContent: string
  ): void => {
    useWorkspaceFileStore.getState().setFileTabs((tabs) =>
      tabs.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              originalContent,
              modifiedContent,
              content: "",
              loading: false,
            }
          : tab
      )
    )
  }
  const beginDiff = (
    seed: FileWorkspaceTab,
    deps: WorkspaceRuntimeDependencies
  ): ResourceLoad | null => {
    if (resources.has(seed.id)) {
      activateLayoutTab(seed.id, deps)
      return null
    }
    const existing = currentTab(seed.id)
    if (!existing) useWorkspaceFileStore.getState().insertFileTab(seed)
    else {
      activateLayoutTab(seed.id, deps)
      if (existing.saveState === "error") markRetry(seed.id)
      else markRefreshing(seed.id)
    }
    activateLayoutTab(seed.id, deps)
    return beginResource(seed.id)
  }
  const rejectDiff = (
    tabId: string,
    error: unknown,
    deps: WorkspaceRuntimeDependencies
  ) => {
    setDiffContent(
      tabId,
      deps.translate("unableLoadContent", { message: toErrorMessage(error) })
    )
    useWorkspaceFileStore
      .getState()
      .setFileTabs((tabs) =>
        tabs.map((tab) =>
          tab.id === tabId
            ? { ...tab, saveState: "error", saveError: toErrorMessage(error) }
            : tab
        )
      )
  }

  const openWorkingTreeDiff = async (
    rawPath: string | undefined,
    options: WorkingTreeDiffOptions | undefined,
    deps: WorkspaceRuntimeDependencies
  ) => {
    const target = resolveTargetFolder(options?.folderId, deps)
    if (!target) return
    const path = rawPath ? normalizePath(rawPath) : null
    const mode = options?.mode ?? "auto"
    const kind = !path
      ? "diff-working-all"
      : mode === "overview"
        ? "diff-working-overview"
        : mode === "unified"
          ? "diff-working-unified"
          : "diff-working"
    const id = !path
      ? buildFileTabId({ kind: "diff-working-all", folderId: target.id })
      : buildFileTabId({
          kind: kind as
            | "diff-working"
            | "diff-working-unified"
            | "diff-working-overview",
          folderId: target.id,
          path,
        })
    const title = !path
      ? deps.translate("diffTitleWorkspace")
      : deps.translate("diffTitleFile", {
          name: fileName(path === "." ? target.path : path),
        })
    const description = !path
      ? deps.translate("diffDescriptionWorkingTree")
      : path
    const rich = Boolean(path && mode === "auto")
    const seed = loadingDiffTab(
      { id, folderId: target.id, title, description, path },
      rich ? "rich-diff" : "diff",
      rich ? languageFromPath(path as string) : "diff"
    )
    const load = beginDiff(seed, deps)
    if (!load) return
    try {
      if (rich) {
        const [original, modified] = await withTimeout(
          Promise.all([
            gitShowFile(target.path, path as string).catch(() => ""),
            readFilePreview(target.path, path as string).catch(() => ({
              content: "",
            })),
          ]),
          20_000,
          deps.translate("diffRequestTimedOut")
        )
        if (settleResource(load))
          setRichDiffContent(id, original, modified.content)
      } else {
        const result = await withTimeout(
          gitDiff(target.path, path ?? undefined),
          20_000,
          deps.translate("diffRequestTimedOut")
        )
        if (settleResource(load))
          setDiffContent(id, result || deps.translate("noChanges"))
      }
    } catch (error) {
      if (settleResource(load)) rejectDiff(id, error, deps)
    }
  }

  const openBranchDiff = async (
    branch: string,
    rawPath: string | undefined,
    options: BranchDiffOptions | undefined,
    deps: WorkspaceRuntimeDependencies
  ) => {
    const target = resolveTargetFolder(options?.folderId, deps)
    const targetBranch = branch.trim()
    if (!target || !targetBranch) return
    const path = rawPath ? normalizePath(rawPath) : null
    const overview = options?.mode === "overview"
    const id = buildFileTabId({
      kind: overview ? "diff-branch-overview" : "diff-branch",
      folderId: target.id,
      branch: targetBranch,
      path,
    })
    const title = path
      ? deps.translate("compareTitleFile", { name: fileName(path) })
      : deps.translate("compareTitleBranch", { branch: targetBranch })
    const description = path
      ? deps.translate("compareDescriptionPath", { path, branch: targetBranch })
      : deps.translate("compareDescriptionBranch", { branch: targetBranch })
    const rich = Boolean(path && !overview)
    const seed = loadingDiffTab(
      { id, folderId: target.id, title, description, path },
      rich ? "rich-diff" : "diff",
      rich ? languageFromPath(path as string) : "diff"
    )
    const load = beginDiff(seed, deps)
    if (!load) return
    try {
      if (rich) {
        const [original, modified] = await withTimeout(
          Promise.all([
            gitShowFile(target.path, path as string, targetBranch).catch(
              () => ""
            ),
            readFilePreview(target.path, path as string).catch(() => ({
              content: "",
            })),
          ]),
          20_000,
          deps.translate("branchCompareRequestTimedOut")
        )
        if (settleResource(load))
          setRichDiffContent(id, original, modified.content)
      } else {
        const result = await withTimeout(
          gitDiffWithBranch(target.path, targetBranch, path ?? undefined),
          20_000,
          deps.translate("branchCompareRequestTimedOut")
        )
        if (settleResource(load))
          setDiffContent(id, result || deps.translate("noChanges"))
      }
    } catch (error) {
      if (settleResource(load)) rejectDiff(id, error, deps)
    }
  }

  const openCommitDiff = async (
    commit: string,
    rawPath: string | undefined,
    message: string | undefined,
    options: { folderId?: number } | undefined,
    deps: WorkspaceRuntimeDependencies
  ) => {
    const target = resolveTargetFolder(options?.folderId, deps)
    if (!target) return
    const path = rawPath ? normalizePath(rawPath) : null
    const id = buildFileTabId({
      kind: "diff-commit",
      folderId: target.id,
      commit,
      path,
    })
    const title = path
      ? deps.translate("diffTitleCommitFile", {
          name: fileName(path),
          hash: commit.slice(0, 7),
        })
      : deps.translate("diffTitleCommit", { hash: commit.slice(0, 7) })
    const description = path
      ? deps.translate("diffDescriptionCommitPath", { path, commit })
      : message || deps.translate("diffDescriptionCommit", { commit })
    const seed = loadingDiffTab(
      { id, folderId: target.id, title, description, path },
      path ? "rich-diff" : "diff",
      path ? languageFromPath(path) : "diff"
    )
    const load = beginDiff(seed, deps)
    if (!load) return
    try {
      if (path) {
        const [original, modified] = await withTimeout(
          Promise.all([
            gitShowFile(target.path, path, `${commit}~1`).catch(() => ""),
            gitShowFile(target.path, path, commit).catch(() => ""),
          ]),
          20_000,
          deps.translate("commitDiffRequestTimedOut")
        )
        if (settleResource(load)) setRichDiffContent(id, original, modified)
      } else {
        const result = await withTimeout(
          gitShowDiff(target.path, commit, undefined),
          20_000,
          deps.translate("commitDiffRequestTimedOut")
        )
        if (settleResource(load))
          setDiffContent(id, result || deps.translate("noDiffOutput"))
      }
    } catch (error) {
      if (settleResource(load)) rejectDiff(id, error, deps)
    }
  }

  const openSessionFileDiff = (
    filePath: string,
    diffContent: string,
    groupLabel: string,
    options: { folderId?: number } | undefined,
    deps: WorkspaceRuntimeDependencies
  ) => {
    const target = resolveTargetFolder(options?.folderId, deps)
    if (!target) return
    const path = normalizePath(filePath)
    replaceTab(
      {
        id: buildFileTabId({
          kind: "diff-session",
          folderId: target.id,
          groupLabel,
          path,
        }),
        kind: "diff",
        folderId: target.id,
        title: deps.translate("diffTitleFile", { name: fileName(path) }),
        description: `${path} · ${groupLabel}`,
        path: null,
        language: "diff",
        content: diffContent,
        loading: false,
        readonly: true,
        saveState: "idle",
        saveError: null,
      },
      deps
    )
  }

  const closeFileTab = async (
    tabId: string,
    deps: WorkspaceRuntimeDependencies
  ) => {
    const state = useWorkspaceFileStore.getState()
    const visible = fileTabsForFolderScope(
      state.fileTabs,
      deps.scope,
      deps.folders
    )
    const index = visible.findIndex((tab) => tab.id === tabId)
    if (index < 0) return
    const tab = visible[index]
    if (dirty(tab) && deps.confirm) {
      const confirmed = await deps.confirm(
        deps.translate("confirmCloseDirtyTab", { title: tab.title })
      )
      if (!confirmed) return
    }
    if (isTextFileTab(tab)) deps.removeFileViewState?.(tab.path)
    workspaceFileRuntime.invalidateFileTab(tabId)
    resources.delete(tabId)
    const pending = useWorkspaceFileStore.getState().pendingFileReveal
    if (
      tab.kind === "file" &&
      pending &&
      normalizeAbsPath(pending.path) === normalizeAbsPath(tab.path)
    ) {
      useWorkspaceFileStore
        .getState()
        .consumePendingFileReveal(pending.requestId)
    }
    const nextVisible = visible.filter((candidate) => candidate.id !== tabId)
    useWorkspaceFileStore
      .getState()
      .setFileTabs((tabs) => tabs.filter((candidate) => candidate.id !== tabId))
    useWorkspaceFileStore.getState().setPreviewFileTabIds((ids) => {
      if (!ids.has(tabId)) return ids
      const next = new Set(ids)
      next.delete(tabId)
      return next
    })
    // 重新打开回到阅读模式
    useWorkspaceFileStore.getState().setFileTabEditing(tabId, false)
    if (state.activeFileTabId === tabId) {
      // Stay in the closed tab's group; never swap what another group shows.
      const placement = workspacePlacementForFolder(deps.scope)
      const paneOf = (candidate: FileWorkspaceTab) =>
        paneForTab(
          { kind: "file", id: candidate.id, type: candidate.kind },
          placement
        )
      const pane = paneOf(tab)
      const samePane = visible.filter((candidate) => paneOf(candidate) === pane)
      const indexInPane = samePane.findIndex(
        (candidate) => candidate.id === tabId
      )
      const remaining = samePane.filter((candidate) => candidate.id !== tabId)
      const shownElsewhere = Object.values(
        useWorkspaceLayoutStore.getState().activeTabByPane
      ).find(
        (ref) =>
          ref?.kind === "file" &&
          nextVisible.some((candidate) => candidate.id === ref.id)
      )
      const next =
        remaining[Math.min(indexInPane, remaining.length - 1)]?.id ??
        shownElsewhere?.id
      if (next) {
        activateLayoutTab(next, deps)
      } else {
        if (nextVisible.length === 0) {
          useWorkspaceLayoutStore.getState().activateConversationPane()
        }
        useWorkspaceFileStore.getState().setActiveFileTabId(null)
      }
    }
  }

  const closeOtherFileTabs = async (
    tabId: string,
    deps: WorkspaceRuntimeDependencies
  ) => {
    const state = useWorkspaceFileStore.getState()
    const visible = fileTabsForFolderScope(
      state.fileTabs,
      deps.scope,
      deps.folders
    )
    if (!visible.some((tab) => tab.id === tabId)) return
    const closing = visible.filter((tab) => tab.id !== tabId)
    if (closing.some(dirty) && deps.confirm) {
      const confirmed = await deps.confirm(
        deps.translate("confirmCloseOtherDirtyTabs")
      )
      if (!confirmed) return
    }
    for (const tab of closing) {
      if (isTextFileTab(tab)) deps.removeFileViewState?.(tab.path)
      workspaceFileRuntime.invalidateFileTab(tab.id)
      resources.delete(tab.id)
    }
    const ids = new Set(closing.map((tab) => tab.id))
    useWorkspaceFileStore
      .getState()
      .setFileTabs((tabs) => tabs.filter((tab) => !ids.has(tab.id)))
    useWorkspaceFileStore
      .getState()
      .setPreviewFileTabIds(
        (previous) => new Set([...previous].filter((id) => !ids.has(id)))
      )
    useWorkspaceFileStore.getState().setActiveFileTabId(tabId)
    activateLayoutTab(tabId, deps)
  }

  const closeAllFileTabs = async (deps: WorkspaceRuntimeDependencies) => {
    const state = useWorkspaceFileStore.getState()
    const visible = fileTabsForFolderScope(
      state.fileTabs,
      deps.scope,
      deps.folders
    )
    if (visible.length === 0) return
    if (visible.some(dirty) && deps.confirm) {
      const confirmed = await deps.confirm(
        deps.translate("confirmCloseAllDirtyTabs")
      )
      if (!confirmed) return
    }
    for (const tab of visible) {
      if (isTextFileTab(tab)) deps.removeFileViewState?.(tab.path)
      workspaceFileRuntime.invalidateFileTab(tab.id)
      resources.delete(tab.id)
    }
    const ids = new Set(visible.map((tab) => tab.id))
    useWorkspaceFileStore
      .getState()
      .setFileTabs((tabs) => tabs.filter((tab) => !ids.has(tab.id)))
    useWorkspaceFileStore
      .getState()
      .setPreviewFileTabIds(
        (previous) => new Set([...previous].filter((id) => !ids.has(id)))
      )
    if (state.activeFileTabId && ids.has(state.activeFileTabId)) {
      useWorkspaceLayoutStore.getState().activateConversationPane()
      useWorkspaceFileStore.getState().setActiveFileTabId(null)
    }
  }

  const reorderFileTabs = (
    reordered: FileWorkspaceTab[],
    deps: WorkspaceRuntimeDependencies
  ) => {
    const state = useWorkspaceFileStore.getState()
    const visible = fileTabsForFolderScope(
      state.fileTabs,
      deps.scope,
      deps.folders
    )
    const next =
      reordered.length === visible.length
        ? mergeFileTabsForFolderScope(
            state.fileTabs,
            reordered,
            deps.scope,
            deps.folders
          )
        : (() => {
            const ids = new Set(reordered.map((tab) => tab.id))
            const anchor = visible.find((tab) => ids.has(tab.id))
            if (!anchor) return state.fileTabs
            const pane = paneForTab(
              {
                kind: "file",
                id: anchor.id,
                type: anchor.kind,
              },
              workspacePlacementForFolder(deps.scope)
            )
            const paneTabs = visible.filter(
              (tab) =>
                paneForTab(
                  {
                    kind: "file",
                    id: tab.id,
                    type: tab.kind,
                  },
                  workspacePlacementForFolder(deps.scope)
                ) === pane
            )
            return mergeFileTabsForFolderScope(
              state.fileTabs,
              mergePaneReorder(visible, paneTabs, reordered),
              deps.scope,
              deps.folders
            )
          })()
    useWorkspaceFileStore.getState().setFileTabs(next)
  }

  const runtime: WorkspaceRuntimeActions = {
    setActivePane: (pane) =>
      useWorkspaceLayoutStore.getState().setActivePane(pane),
    activateConversationPane: (preserve) =>
      useWorkspaceLayoutStore.getState().activateConversationPane(preserve),
    activateFilePane: () =>
      useWorkspaceLayoutStore.getState().activateFilePane(),
    switchFileTab: (tabId) => {
      const folders = useAppWorkspaceStore.getState().allFolders
      const scope = useAppWorkspaceStore.getState().activeFolderId
      // 布局切换由 runtimeContext 注入的 adoptFileActivation 完成，不做双重激活。
      activateTab(tabId, { scope, folders, translate: () => "" })
    },
    closeFileTab,
    closeOtherFileTabs,
    closeAllFileTabs,
    reorderFileTabs,
    openFilePreview,
    openReadonlyTextPreview,
    openTranscriptTab,
    openTaskTab,
    reloadOpenFileBackground: (path, deps) =>
      workspaceFileRuntime.reloadOpenFileBackground(path, runtimeContext(deps)),
    bumpResourceRevision: (path) =>
      workspaceFileRuntime.bumpResourceRevision(path),
    applyExternalReload: (path, fetched, deps) =>
      workspaceFileRuntime.applyExternalReload(
        path,
        fetched,
        runtimeContext(deps)
      ),
    markTabsStale: (path) => workspaceFileRuntime.markTabsStale(path),
    markTabsStaleBatch: (paths) => {
      const ids = new Set(
        paths.map((path) =>
          buildFileTabId({ kind: "file", path: normalizeAbsPath(path) })
        )
      )
      useWorkspaceFileStore
        .getState()
        .setFileTabs((tabs) =>
          tabs.map((tab) =>
            ids.has(tab.id) && tab.kind === "file" && !tab.stale
              ? { ...tab, stale: true }
              : tab
          )
        )
    },
    consumeSelfWriteEcho: (path) =>
      workspaceFileRuntime.consumeSelfWriteEcho(path),
    rejectFileTab: (path, error, deps) =>
      workspaceFileRuntime.rejectFileTab(path, error, runtimeContext(deps)),
    consumePendingFileReveal: (requestId) =>
      useWorkspaceFileStore.getState().consumePendingFileReveal(requestId),
    openWorkingTreeDiff,
    openBranchDiff,
    openCommitDiff,
    openSessionFileDiff,
    openExternalConflictDiff,
    enqueueExternalConflict: (conflict, options) =>
      useWorkspaceFileStore
        .getState()
        .enqueueExternalConflict(conflict, options),
    get externalConflict() {
      return useWorkspaceFileStore.getState().externalConflictQueue[0] ?? null
    },
    compareExternalConflict: (deps) => {
      const head = useWorkspaceFileStore.getState().dequeueExternalConflict()
      if (!head) return
      const tab = currentTab(buildFileTabId({ kind: "file", path: head.path }))
      const content =
        tab && isTextFileTab(tab) && !tab.loading
          ? tab.content
          : head.unsavedContent
      openExternalConflictDiff(head.path, head.diskContent, content, deps)
    },
    reloadExternalConflict: (deps) => {
      const head = useWorkspaceFileStore
        .getState()
        .dequeueExternalConflict({ clearSignature: true })
      if (head) void openFilePreview(head.path, { reload: true }, deps)
    },
    saveExternalConflictCopy: async () => {
      const head = useWorkspaceFileStore.getState().externalConflictQueue[0]
      if (!head) throw new Error("no external conflict to resolve")
      const io = splitAbsPath(head.path)
      if (!io) throw new Error("invalid file path")
      const tab = currentTab(buildFileTabId({ kind: "file", path: head.path }))
      const content =
        tab && isTextFileTab(tab) && !tab.loading
          ? tab.content
          : head.unsavedContent
      const result = await saveFileCopy(io.rootPath, io.ioPath, content)
      useWorkspaceFileStore.getState().dequeueExternalConflict()
      return result.path
    },
    dismissExternalConflict: () => {
      useWorkspaceFileStore.getState().dequeueExternalConflict()
    },
    updateActiveFileContent: (content) => {
      const id = useWorkspaceFileStore.getState().activeFileTabId
      if (id) workspaceFileRuntime.updateFileTabContent(id, content)
    },
    updateFileTabContent: (tabId, content) =>
      workspaceFileRuntime.updateFileTabContent(tabId, content),
    saveActiveFile: (options, deps) => {
      const id = useWorkspaceFileStore.getState().activeFileTabId
      return id
        ? workspaceFileRuntime.saveFileTab(id, options, runtimeContext(deps))
        : Promise.resolve(false)
    },
    saveFileTab: (tabId, options, deps) =>
      workspaceFileRuntime.saveFileTab(tabId, options, runtimeContext(deps)),
    setFileTabComposing: (tabId, composing, deps) =>
      workspaceFileRuntime.setFileTabComposing(
        tabId,
        composing,
        runtimeContext(deps)
      ),
    reloadActiveFile: async (deps) => {
      const id = useWorkspaceFileStore.getState().activeFileTabId
      if (id) await workspaceFileRuntime.reloadFileTab(id, runtimeContext(deps))
    },
    toggleFileTabPreview: (tabId) =>
      useWorkspaceFileStore.getState().toggleFileTabPreview(tabId),
    unloadColdTextContent: (fileTabs, activeFileTabId, recency) =>
      workspaceFileRuntime.unloadColdTextContent(
        fileTabs,
        activeFileTabId,
        recency
      ),
  }
  return runtime
}

// C1：布局 store 的文件域激活语义在此注入，保持 store 层不反向依赖 runtime。
configureWorkspaceLayoutFileActivator(({ tabId, scope, folders }) =>
  workspaceFileRuntime.activateFileTab(tabId, {
    scope,
    folders,
    translate: () => "",
  })
)

export const workspaceRuntime = createWorkspaceRuntime()
