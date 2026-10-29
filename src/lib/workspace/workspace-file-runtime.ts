import {
  gitIsTracked,
  gitShowFile,
  readFileForEdit,
  saveFileContent,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import {
  findOwningFolder,
  isVirtualPreviewPath,
  normalizeAbsPath,
  splitAbsPath,
} from "@/lib/files/file-open-target"
import { fileOpenStrategyFromPath } from "@/lib/files/file-open-strategy"
import { languageFromPath } from "@/lib/files/language-detect"
import type { FileEditContent } from "@/lib/types"
import {
  isResourceFileTab,
  isTextFileTab,
  type FileWorkspaceTab,
  type TextFileWorkspaceTab,
} from "@/lib/files/file-workspace-tab"
import {
  fileTabIsInFolderScope,
  fileTabsForFolderScope,
  type FolderPathEntry,
} from "@/lib/workspace/tab-scope"
import { buildFileTabId } from "@/lib/files/file-tab-id"
import { emitWorkspaceFileSaved } from "@/lib/workspace/workspace-file-events"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store"
import { toast } from "@/lib/notify"

export type WorkspaceTranslate = (
  key: string,
  values?: Record<string, unknown>
) => string

export interface WorkspaceExternalConflict {
  path: string
  diskContent: string
  unsavedContent: string
  signature: string
}

export interface WorkspaceFileRuntimeContext {
  scope: number | null
  folders: readonly FolderPathEntry[]
  translate: WorkspaceTranslate
  /** Updates the layout selection after the file store has been changed. */
  activateFileTab?: (tabId: string) => void
  /** Lets the shell surface a dirty-buffer conflict without owning the tab. */
  enqueueExternalConflict?: (
    conflict: WorkspaceExternalConflict,
    options?: { force?: boolean }
  ) => void
}

export type WorkspaceFileChangeDecision =
  | { kind: "none" }
  | { kind: "reload"; path: string; latest: FileEditContent }
  | {
      kind: "conflict"
      path: string
      diskContent: string
      unsavedContent: string
      signature: string
    }
  | { kind: "missing"; path: string; error: string }

/** 冷文本内容预算上限（UTF-16 code units，非严格字节）。与基线
 * `HIDDEN_TAB_CONTENT_BUDGET_CHARS`（48M）保持一致：让几十个普通源文件
 * 永不触发逐出，只有病态的大文件堆积才会回收。 */
export const WORKSPACE_COLD_CONTENT_BUDGET = 48 * 1024 * 1024
const UNKNOWN_RECENCY_RANK = 9999

export interface ColdTextEvictionInput {
  tabs: readonly FileWorkspaceTab[]
  activeTabId: string | null
  /** 最近使用优先的 tab id 序列，未记录者视为最冷。 */
  recency?: readonly string[]
  /** 默认使用 WORKSPACE_COLD_CONTENT_BUDGET；测试可注入小预算。 */
  budget?: number
}

/**
 * 计算需要卸载冷内容的 text tab id 列表（纯函数，无 React、无 store）。
 * 规则：不动 active/dirty/loading/saving 的 tab；仅在总占用超过预算时，
 * 按最久未用优先逐出，直到剩余占用不超过预算。
 */
export function planColdTextEviction(input: ColdTextEvictionInput): string[] {
  const { tabs, activeTabId: activeScopeId, recency } = input
  const budget = input.budget ?? WORKSPACE_COLD_CONTENT_BUDGET
  const candidates = tabs.filter(
    (tab): tab is TextFileWorkspaceTab =>
      isTextFileTab(tab) &&
      tab.id !== activeScopeId &&
      !tab.isDirty &&
      !tab.loading &&
      tab.saveState !== "saving" &&
      tab.content.length > 0
  )
  // 候选占用统一折算为 charCount（content + 非共享的 gitBaseContent），
  // 总量计算与循环扣减共用同一数值，避免共享 gitBase 被双倍扣减导致
  // 提前停止、剩余占用仍超预算。
  const charCount = (tab: TextFileWorkspaceTab): number =>
    tab.content.length +
    (tab.gitBaseContent && tab.gitBaseContent !== tab.content
      ? tab.gitBaseContent.length
      : 0)
  const total = candidates.reduce((sum, tab) => sum + charCount(tab), 0)
  if (total <= budget) {
    return []
  }
  let remaining = total
  const rank = new Map((recency ?? []).map((id, index) => [id, index] as const))
  const unload: string[] = []
  for (const tab of [...candidates].sort(
    (a, b) =>
      (rank.get(b.id) ?? UNKNOWN_RECENCY_RANK) -
      (rank.get(a.id) ?? UNKNOWN_RECENCY_RANK)
  )) {
    if (remaining <= budget || !isTextFileTab(tab)) {
      break
    }
    unload.push(tab.id)
    remaining -= charCount(tab)
  }
  return unload
}

export interface WorkspaceFileOpenOptions {
  line?: number
  page?: number
  reload?: boolean
  readonly?: boolean
  lifetime?: "global" | "project"
  format?: "text" | "json" | "toml" | "yaml"
}

export interface WorkspaceFileRuntime {
  inspectExternalChange(tabId: string): Promise<WorkspaceFileChangeDecision>
  openTextFile(
    path: string,
    options: WorkspaceFileOpenOptions | undefined,
    context: WorkspaceFileRuntimeContext
  ): Promise<void>
  activateFileTab(tabId: string, context: WorkspaceFileRuntimeContext): boolean
  switchFileTab(tabId: string, context: WorkspaceFileRuntimeContext): void
  updateFileTabContent(tabId: string, content: string): void
  saveFileTab(
    tabId: string,
    options: { force?: boolean } | undefined,
    context: WorkspaceFileRuntimeContext
  ): Promise<boolean>
  reloadFileTab(
    tabId: string,
    context: WorkspaceFileRuntimeContext
  ): Promise<void>
  reloadOpenFileBackground(
    path: string,
    context: WorkspaceFileRuntimeContext
  ): Promise<void>
  applyExternalReload(
    path: string,
    fetched: FileEditContent,
    context: WorkspaceFileRuntimeContext
  ): void
  markTabsStale(path: string): void
  rejectFileTab(
    path: string,
    errorMessage: string,
    context: WorkspaceFileRuntimeContext
  ): void
  bumpResourceRevision(path: string): void
  setFileTabComposing(
    tabId: string,
    composing: boolean,
    context: WorkspaceFileRuntimeContext
  ): void
  consumeSelfWriteEcho(path: string): boolean
  /** Invalidates asynchronous work when a tab leaves the collection. */
  invalidateFileTab(tabId: string): void
  /** 冷内容 LRU 预算逐出；返回实际卸载的 tab 数。 */
  unloadColdTextContent(
    fileTabs: readonly FileWorkspaceTab[],
    activeFileTabId: string | null,
    recency?: readonly string[],
    opts?: { budget?: number }
  ): number
}

type LoadDecision = { kind: "skip" } | { kind: "fetch"; generation: number }

function dedupeGitBase(
  content: string,
  gitBaseContent: string | undefined
): string | undefined {
  return gitBaseContent === content ? content : gitBaseContent
}

function fileName(path: string): string {
  return path.split("/").pop() || path
}

function languageFromFormat(
  format: WorkspaceFileOpenOptions["format"]
): string | null {
  switch (format) {
    case "json":
      return "json"
    case "toml":
      return "ini"
    case "yaml":
      return "yaml"
    case "text":
      return "plaintext"
    default:
      return null
  }
}

function loadingTextTab(
  path: string,
  folderId: number | null,
  readonly: boolean,
  lifetime: "global" | "project" | undefined,
  format: WorkspaceFileOpenOptions["format"]
): TextFileWorkspaceTab {
  const strategy = fileOpenStrategyFromPath(path)
  return {
    id: buildFileTabId({ kind: "file", path }),
    kind: "file",
    dataMode: "text",
    previewKind: strategy.dataMode === "text" ? strategy.previewKind : "text",
    folderId,
    title: fileName(path),
    description: path,
    path,
    language: languageFromFormat(format) ?? languageFromPath(path),
    content: "",
    savedContent: "",
    isDirty: false,
    etag: null,
    mtimeMs: null,
    readonly,
    lineEnding: "none",
    loading: true,
    saveState: "idle",
    saveError: null,
    ...(lifetime ? { lifetime } : {}),
  }
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

/**
 * React-free owner of the file-tab state machine.
 *
 * Store updates are deliberately small and functional. All asynchronous work
 * is guarded by a per-tab generation, so a close/reopen or a newer reload can
 * never let an old read write into the new tab instance.
 */
export function createWorkspaceFileRuntime(): WorkspaceFileRuntime {
  const inFlight = new Map<string, number>()
  const composing = new Set<string>()
  const deferredSaves = new Map<string, { force?: boolean }>()
  const selfWriteEcho = new Map<string, { etag: string; at: number }>()
  let nextGeneration = 0

  const beginGeneration = (tabId: string): number => {
    nextGeneration += 1
    inFlight.set(tabId, nextGeneration)
    return nextGeneration
  }

  const settleGeneration = (tabId: string, generation: number): boolean => {
    if (inFlight.get(tabId) !== generation) return false
    inFlight.delete(tabId)
    return true
  }

  const tabFor = (tabId: string): FileWorkspaceTab | null =>
    useWorkspaceFileStore
      .getState()
      .fileTabs.find((candidate) => candidate.id === tabId) ?? null

  const activateFileTab = (
    tabId: string,
    context: WorkspaceFileRuntimeContext
  ): boolean => {
    const tab = tabFor(tabId)
    if (!tab || !fileTabIsInFolderScope(tab, context.scope, context.folders)) {
      return false
    }
    useWorkspaceFileStore.getState().setActiveFileTabId(tabId)
    useWorkspaceFileStore.getState().rememberActiveTab(context.scope, tabId)
    context.activateFileTab?.(tabId)
    return true
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
        if (tab.kind === "file") {
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

  const decideLoad = (
    seed: TextFileWorkspaceTab,
    reload: boolean,
    context: WorkspaceFileRuntimeContext
  ): LoadDecision => {
    const existing = tabFor(seed.id)
    if (inFlight.has(seed.id)) {
      // A backend/store scope reset can remove the tab while its old read is
      // still pending. Do not let that orphaned marker block the next open.
      if (!existing) {
        inFlight.delete(seed.id)
      } else {
        activateFileTab(seed.id, context)
        return { kind: "skip" }
      }
    }
    if (!existing) {
      if (reload) return { kind: "skip" }
      useWorkspaceFileStore.getState().insertFileTab(seed)
      activateFileTab(seed.id, context)
      return { kind: "fetch", generation: beginGeneration(seed.id) }
    }

    activateFileTab(seed.id, context)
    if (existing.saveState === "error") markRetry(existing.id)
    const staleClean =
      isTextFileTab(existing) && existing.stale === true && !existing.isDirty
    if (!reload && !staleClean && existing.saveState !== "error") {
      return { kind: "skip" }
    }
    if (existing.saveState !== "error") markRefreshing(existing.id)
    return { kind: "fetch", generation: beginGeneration(seed.id) }
  }

  const fetchGitBaseForFolders = async (
    path: string,
    folders: readonly FolderPathEntry[]
  ): Promise<string | undefined> => {
    const owning = findOwningFolder(path, folders)
    if (!owning) return undefined
    const tracked = await gitIsTracked(owning.rootPath, owning.relPath).catch(
      () => false
    )
    if (!tracked) return undefined
    return gitShowFile(owning.rootPath, owning.relPath).catch(() => "")
  }

  const inspectExternalChange = async (
    tabId: string
  ): Promise<WorkspaceFileChangeDecision> => {
    const snapshot = tabFor(tabId)
    if (!snapshot || !isTextFileTab(snapshot) || snapshot.loading) {
      return { kind: "none" }
    }
    const io = splitAbsPath(snapshot.path)
    if (!io) return { kind: "none" }
    let latest: FileEditContent
    try {
      latest = await readFileForEdit(io.rootPath, io.ioPath)
    } catch (error) {
      const live = tabFor(tabId)
      if (!live || !isTextFileTab(live) || live.loading) return { kind: "none" }
      return {
        kind: "missing",
        path: snapshot.path,
        error: toErrorMessage(error),
      }
    }
    if (!latest) return { kind: "none" }
    const live = tabFor(tabId)
    if (
      !live ||
      !isTextFileTab(live) ||
      live.loading ||
      live.path !== snapshot.path
    ) {
      return { kind: "none" }
    }
    if ((latest.etag ?? null) === (live.etag ?? null)) return { kind: "none" }
    if (live.isDirty) {
      return {
        kind: "conflict",
        path: live.path,
        diskContent: latest.content,
        unsavedContent: live.content,
        signature: latest.etag ?? "",
      }
    }
    return { kind: "reload", path: live.path, latest }
  }

  const openTextFile = async (
    rawPath: string,
    options: WorkspaceFileOpenOptions | undefined,
    context: WorkspaceFileRuntimeContext
  ): Promise<void> => {
    const path = normalizeAbsPath(rawPath)
    if (isVirtualPreviewPath(path)) return
    const io = splitAbsPath(path)
    if (!io) return
    const owning = findOwningFolder(path, context.folders)
    const seed = {
      ...loadingTextTab(
        path,
        owning?.folderId ?? null,
        Boolean(options?.readonly),
        options?.lifetime,
        options?.format
      ),
      openedInFolderId: context.scope,
    }
    const decision = decideLoad(seed, options?.reload === true, context)
    if (decision.kind === "skip") {
      const existing = tabFor(seed.id)
      if (existing && (options?.readonly || options?.lifetime === "global")) {
        useWorkspaceFileStore.getState().setFileTabs((tabs) =>
          tabs.map((tab) =>
            tab.id !== seed.id
              ? tab
              : {
                  ...tab,
                  ...(options?.readonly && isTextFileTab(tab)
                    ? { readonly: true }
                    : {}),
                  ...(options?.lifetime === "global"
                    ? { lifetime: "global" as const }
                    : {}),
                }
          )
        )
      }
      return
    }

    try {
      const result = await withTimeout(
        readFileForEdit(io.rootPath, io.ioPath),
        15_000,
        context.translate("previewRequestTimedOut")
      )
      if (!settleGeneration(seed.id, decision.generation)) return
      useWorkspaceFileStore.getState().setFileTabs((tabs) =>
        tabs.map((tab) =>
          tab.id === seed.id && isTextFileTab(tab)
            ? {
                ...tab,
                content: result.content,
                savedContent: result.content,
                isDirty: false,
                etag: result.etag,
                mtimeMs: result.mtime_ms,
                readonly: tab.readonly || result.readonly,
                lineEnding: result.line_ending,
                saveState: "idle",
                saveError: null,
                loading: false,
                stale: false,
              }
            : tab
        )
      )

      // Git decoration is cosmetic and must not delay the file becoming
      // interactive. Gate the later patch by the loaded etag so close/reopen
      // and a newer reload cannot inherit an old base snapshot.
      void fetchGitBaseForFolders(path, context.folders).then(
        (gitBaseContent) => {
          useWorkspaceFileStore.getState().setFileTabs((tabs) =>
            tabs.map((tab) =>
              tab.id === seed.id &&
              isTextFileTab(tab) &&
              tab.etag === result.etag
                ? {
                    ...tab,
                    gitBaseContent: dedupeGitBase(tab.content, gitBaseContent),
                  }
                : tab
            )
          )
        }
      )
    } catch (error) {
      if (!settleGeneration(seed.id, decision.generation)) return
      const errorMessage = toErrorMessage(error)
      toast.error(errorMessage)
      const current = tabFor(seed.id)
      if (current && isTextFileTab(current) && !current.isDirty) {
        const state = useWorkspaceFileStore.getState()
        const visible = fileTabsForFolderScope(
          state.fileTabs,
          context.scope,
          context.folders
        )
        const index = visible.findIndex((t) => t.id === seed.id)
        const nextVisible = visible.filter((t) => t.id !== seed.id)
        useWorkspaceFileStore
          .getState()
          .setFileTabs((tabs) => tabs.filter((t) => t.id !== seed.id))
        useWorkspaceFileStore.getState().setPreviewFileTabIds((ids) => {
          if (!ids.has(seed.id)) return ids
          const next = new Set(ids)
          next.delete(seed.id)
          return next
        })
        if (state.activeFileTabId === seed.id) {
          if (nextVisible.length === 0) {
            useWorkspaceLayoutStore.getState().activateConversationPane()
            useWorkspaceFileStore.getState().setActiveFileTabId(null)
          } else {
            const next =
              nextVisible[Math.min(Math.max(0, index), nextVisible.length - 1)]
            useWorkspaceFileStore.getState().setActiveFileTabId(next.id)
            context.activateFileTab?.(next.id)
          }
        }
      } else {
        rejectFileTab(seed.id, errorMessage, context)
      }
    }
  }

  const updateFileTabContent = (tabId: string, content: string): void => {
    useWorkspaceFileStore.getState().setFileTabs((tabs) =>
      tabs.map((tab) => {
        if (
          tab.id !== tabId ||
          !isTextFileTab(tab) ||
          tab.loading ||
          tab.readonly ||
          tab.content === content
        ) {
          return tab
        }
        return {
          ...tab,
          content,
          isDirty: content !== tab.savedContent,
          saveState: tab.saveState === "saving" ? "saving" : "idle",
          saveError: null,
        }
      })
    )
  }

  const saveFileTab = async (
    tabId: string,
    options: { force?: boolean } | undefined,
    context: WorkspaceFileRuntimeContext
  ): Promise<boolean> => {
    if (composing.has(tabId)) {
      const previous = deferredSaves.get(tabId)
      deferredSaves.set(tabId, {
        force: Boolean(previous?.force || options?.force),
      })
      return false
    }
    const tab = tabFor(tabId)
    if (
      !tab ||
      !isTextFileTab(tab) ||
      tab.loading ||
      tab.readonly ||
      !tab.isDirty
    ) {
      return tab != null && isTextFileTab(tab) && !tab.isDirty
    }
    const io = splitAbsPath(tab.path)
    if (!io) return false

    const owning = findOwningFolder(tab.path, context.folders)
    if ((tab.stale || !owning) && !options?.force) {
      try {
        const latest = await readFileForEdit(io.rootPath, io.ioPath)
        if ((latest.etag ?? null) !== (tab.etag ?? null)) {
          useWorkspaceFileStore
            .getState()
            .setFileTabs((tabs) =>
              tabs.map((candidate) =>
                candidate.id === tabId
                  ? { ...candidate, stale: true }
                  : candidate
              )
            )
          context.enqueueExternalConflict?.(
            {
              path: tab.path,
              diskContent: latest.content,
              unsavedContent: tab.content,
              signature: latest.etag ?? "",
            },
            { force: true }
          )
          return false
        }
      } catch (error) {
        const message = toErrorMessage(error)
        useWorkspaceFileStore
          .getState()
          .setFileTabs((tabs) =>
            tabs.map((candidate) =>
              candidate.id === tabId
                ? { ...candidate, saveState: "error", saveError: message }
                : candidate
            )
          )
        return false
      }
    }

    const contentAtSaveStart = tab.content
    const expectedEtag = options?.force ? null : (tab.etag ?? null)
    useWorkspaceFileStore
      .getState()
      .setFileTabs((tabs) =>
        tabs.map((candidate) =>
          candidate.id === tabId
            ? { ...candidate, saveState: "saving", saveError: null }
            : candidate
        )
      )
    try {
      const result = await withTimeout(
        saveFileContent(
          io.rootPath,
          io.ioPath,
          contentAtSaveStart,
          expectedEtag
        ),
        20_000,
        context.translate("saveRequestTimedOut")
      )
      selfWriteEcho.set(tab.path, { etag: result.etag, at: Date.now() })
      useWorkspaceFileStore.getState().setFileTabs((tabs) =>
        tabs.map((candidate) =>
          candidate.id === tabId && isTextFileTab(candidate)
            ? {
                ...candidate,
                etag: result.etag,
                mtimeMs: result.mtime_ms,
                readonly: result.readonly,
                lineEnding: result.line_ending,
                savedContent: contentAtSaveStart,
                isDirty: candidate.content !== contentAtSaveStart,
                stale: false,
                saveState: "idle",
                saveError: null,
              }
            : candidate
        )
      )
      emitWorkspaceFileSaved(tab.path)
      return true
    } catch (error) {
      const message = toErrorMessage(error)
      useWorkspaceFileStore
        .getState()
        .setFileTabs((tabs) =>
          tabs.map((candidate) =>
            candidate.id === tabId
              ? { ...candidate, saveState: "error", saveError: message }
              : candidate
          )
        )
      return false
    }
  }

  const reloadFileTab = async (
    tabId: string,
    context: WorkspaceFileRuntimeContext
  ): Promise<void> => {
    const tab = tabFor(tabId)
    if (!tab || !isTextFileTab(tab) || isVirtualPreviewPath(tab.path)) return
    await openTextFile(tab.path, { reload: true }, context)
  }

  const reloadOpenFileBackground = async (
    rawPath: string,
    context: WorkspaceFileRuntimeContext
  ): Promise<void> => {
    const path = normalizeAbsPath(rawPath)
    const tabId = buildFileTabId({ kind: "file", path })
    const tab = tabFor(tabId)
    if (!tab || !isTextFileTab(tab) || tab.isDirty || inFlight.has(tabId))
      return
    const io = splitAbsPath(path)
    if (!io) return
    markRefreshing(tabId)
    const generation = beginGeneration(tabId)
    try {
      const result = await readFileForEdit(io.rootPath, io.ioPath)
      if (!settleGeneration(tabId, generation)) return
      useWorkspaceFileStore.getState().setFileTabs((tabs) =>
        tabs.map((candidate) =>
          candidate.id === tabId && isTextFileTab(candidate)
            ? {
                ...candidate,
                content: result.content,
                savedContent: result.content,
                gitBaseContent: candidate.gitBaseContent,
                isDirty: false,
                etag: result.etag,
                mtimeMs: result.mtime_ms,
                readonly: candidate.readonly || result.readonly,
                lineEnding: result.line_ending,
                loading: false,
                stale: false,
                saveState: "idle",
                saveError: null,
              }
            : candidate
        )
      )
    } catch (error) {
      if (settleGeneration(tabId, generation)) {
        const candidate = tabFor(tabId)
        if (candidate && isTextFileTab(candidate) && !candidate.isDirty) {
          useWorkspaceFileStore
            .getState()
            .setFileTabs((tabs) => tabs.filter((t) => t.id !== tabId))
        } else {
          rejectFileTab(path, toErrorMessage(error), context)
        }
      }
    }
  }

  const applyExternalReload = (
    rawPath: string,
    fetched: FileEditContent,
    context: WorkspaceFileRuntimeContext
  ): void => {
    const path = normalizeAbsPath(rawPath)
    const tabId = buildFileTabId({ kind: "file", path })
    const tab = tabFor(tabId)
    if (!tab || !isTextFileTab(tab)) return
    const generation = beginGeneration(tabId)
    useWorkspaceFileStore.getState().setFileTabs((tabs) =>
      tabs.map((candidate) => {
        if (candidate.id !== tabId || !isTextFileTab(candidate))
          return candidate
        if (candidate.isDirty) return { ...candidate, stale: true }
        return {
          ...candidate,
          content: fetched.content,
          savedContent: fetched.content,
          isDirty: false,
          etag: fetched.etag,
          mtimeMs: fetched.mtime_ms,
          readonly: candidate.readonly || fetched.readonly,
          lineEnding: fetched.line_ending,
          loading: false,
          stale: false,
          saveState: "idle",
          saveError: null,
        }
      })
    )
    settleGeneration(tabId, generation)

    // Keep the gutter refresh out of the watcher read path, but consume it
    // under the same etag fence. A close/reopen with a newer etag cannot
    // receive this load's late git result.
    if (!tab.isDirty) {
      void fetchGitBaseForFolders(path, context.folders).then(
        (gitBaseContent) => {
          useWorkspaceFileStore.getState().setFileTabs((tabs) =>
            tabs.map((candidate) =>
              candidate.id === tabId &&
              isTextFileTab(candidate) &&
              candidate.etag === fetched.etag
                ? {
                    ...candidate,
                    gitBaseContent: dedupeGitBase(
                      candidate.content,
                      gitBaseContent
                    ),
                  }
                : candidate
            )
          )
        }
      )
    }
  }

  const markTabsStale = (rawPath: string): void => {
    const tabId = buildFileTabId({
      kind: "file",
      path: normalizeAbsPath(rawPath),
    })
    useWorkspaceFileStore
      .getState()
      .setFileTabs((tabs) =>
        tabs.map((tab) => (tab.id === tabId ? { ...tab, stale: true } : tab))
      )
  }

  const rejectFileTab = (
    rawPath: string,
    errorMessage: string,
    context: WorkspaceFileRuntimeContext
  ): void => {
    const tabId = rawPath.startsWith("file:")
      ? rawPath
      : buildFileTabId({ kind: "file", path: normalizeAbsPath(rawPath) })
    useWorkspaceFileStore.getState().setFileTabs((tabs) =>
      tabs.map((tab) => {
        if (tab.id !== tabId || !isTextFileTab(tab)) return tab
        if (tab.isDirty) return { ...tab, stale: true }
        return {
          ...tab,
          content: context.translate("unableLoadContent", {
            message: errorMessage,
          }),
          loading: false,
          stale: false,
          saveState: "error",
          saveError: errorMessage,
        }
      })
    )
  }

  const switchFileTab = (
    tabId: string,
    context: WorkspaceFileRuntimeContext
  ): void => {
    activateFileTab(tabId, context)
  }

  const bumpResourceRevision = (rawPath: string): void => {
    const tabId = buildFileTabId({
      kind: "file",
      path: normalizeAbsPath(rawPath),
    })
    useWorkspaceFileStore.getState().setFileTabs((tabs) =>
      tabs.map((tab) =>
        tab.id === tabId && isResourceFileTab(tab)
          ? {
              ...tab,
              preview: {
                ...tab.preview,
                revision: tab.preview.revision + 1,
              },
              stale: false,
            }
          : tab
      )
    )
  }

  const consumeSelfWriteEcho = (path: string): boolean => {
    const record = selfWriteEcho.get(normalizeAbsPath(path))
    if (!record) return false
    selfWriteEcho.delete(normalizeAbsPath(path))
    if (Date.now() - record.at > 5_000) return false
    const tabId = buildFileTabId({
      kind: "file",
      path: normalizeAbsPath(path),
    })
    const tab = tabFor(tabId)
    return Boolean(
      tab && isTextFileTab(tab) && !tab.isDirty && tab.etag === record.etag
    )
  }

  const invalidateFileTab = (tabId: string): void => {
    inFlight.delete(tabId)
    composing.delete(tabId)
    deferredSaves.delete(tabId)
  }

  const unloadColdTextContent = (
    fileTabs: readonly FileWorkspaceTab[],
    coldActiveId: string | null,
    recency?: readonly string[],
    opts?: { budget?: number }
  ): number => {
    const unloadIds = planColdTextEviction({
      tabs: fileTabs,
      activeTabId: coldActiveId,
      recency,
      budget: opts?.budget,
    })
    if (unloadIds.length === 0) return 0
    const unload = new Set(unloadIds)
    useWorkspaceFileStore.getState().setFileTabs((tabs) =>
      tabs.map((tab) =>
        unload.has(tab.id) &&
        isTextFileTab(tab) &&
        !tab.isDirty &&
        !tab.loading &&
        tab.saveState !== "saving"
          ? {
              ...tab,
              content: "",
              savedContent: "",
              gitBaseContent: undefined,
              stale: true,
            }
          : tab
      )
    )
    return unloadIds.length
  }

  const setFileTabComposing = (
    tabId: string,
    isComposing: boolean,
    context: WorkspaceFileRuntimeContext
  ): void => {
    if (isComposing) {
      composing.add(tabId)
      return
    }
    composing.delete(tabId)
    const deferred = deferredSaves.get(tabId)
    if (!deferred) return
    deferredSaves.delete(tabId)
    queueMicrotask(() => {
      void saveFileTab(tabId, deferred, context)
    })
  }

  return {
    inspectExternalChange,
    openTextFile,
    activateFileTab,
    switchFileTab,
    updateFileTabContent,
    saveFileTab,
    reloadFileTab,
    reloadOpenFileBackground,
    applyExternalReload,
    markTabsStale,
    rejectFileTab,
    bumpResourceRevision,
    setFileTabComposing,
    consumeSelfWriteEcho,
    invalidateFileTab,
    unloadColdTextContent,
  }
}

export const workspaceFileRuntime = createWorkspaceFileRuntime()
