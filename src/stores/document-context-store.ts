import { create } from "zustand"
import { useTabStore } from "@/stores/tab-store"
import {
  clearCurrentDocumentContext,
  setCurrentDocumentContext,
} from "@/lib/api"
import type { TabItem } from "@/stores/tab-store"

/**
 * 登记工作区文档并同步到当前会话，供当前文档读取工具使用。
 * `current` 保留为可观察快照；合并、防抖和串行同步状态由模块统一管理。
 * 会话切换通过唯一的 tab-store 订阅，以 0ms 防抖重新同步当前文档。
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The only document description a renderer needs to provide.  File type
 * details stay inside the renderer/provider; the rest of the workbench only
 * deals with this source-neutral shape.
 */
export interface DocumentContextDocument {
  /** Stable identity within the right-side workspace. */
  id?: string
  kind: string
  title?: string | null
  path?: string | null
  url?: string | null
  mime?: string | null
  /** Unsaved/editor/live-view text, when the renderer already has it. */
  content?: string | null
  revision?: string | null
  /** 用于展示的路径。 */
  displayPath?: string | null
}

interface RegisteredDocumentContext {
  document: DocumentContextDocument
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function documentKey(document: DocumentContextDocument): string {
  const explicit = document.id?.trim()
  if (explicit) return explicit
  return [document.kind, document.path ?? "", document.url ?? ""].join("|")
}

function sameDocument(
  left: DocumentContextDocument,
  right: DocumentContextDocument
): boolean {
  return documentKey(left) === documentKey(right)
}

function sameDocumentState(
  left: DocumentContextDocument,
  right: DocumentContextDocument
): boolean {
  return (
    left.id === right.id &&
    left.kind === right.kind &&
    left.title === right.title &&
    left.path === right.path &&
    left.url === right.url &&
    left.mime === right.mime &&
    left.content === right.content &&
    left.revision === right.revision &&
    left.displayPath === right.displayPath
  )
}

function sameDocumentSource(
  left: DocumentContextDocument,
  right: DocumentContextDocument
): boolean {
  return (
    (right.id === undefined || left.id === right.id) &&
    left.kind === right.kind &&
    (right.path === undefined || left.path === right.path) &&
    (right.url === undefined || left.url === right.url) &&
    (right.mime === undefined || left.mime === right.mime)
  )
}

function mergeDocument(
  current: DocumentContextDocument | null,
  next: DocumentContextDocument
): DocumentContextDocument {
  if (!current || !sameDocument(current, next)) {
    return next
  }

  const sourceChanged = !sameDocumentSource(current, next)
  const revisionChanged =
    next.revision !== undefined &&
    current.revision !== undefined &&
    next.revision !== current.revision

  // Loading events often carry only metadata. Keep the most recent bounded
  // snapshot until a different source or revision explicitly replaces it;
  // this prevents a later metadata event with `content: null` from erasing
  // the current body, while preventing a new page from inheriting the
  // previous page's snapshot.
  const canPreserveSnapshot = !sourceChanged && !revisionChanged
  const content =
    canPreserveSnapshot && next.content == null
      ? (current.content ?? null)
      : next.content

  return {
    ...current,
    ...next,
    id: next.id === undefined ? current.id : next.id,
    title: next.title === undefined ? current.title : next.title,
    path: next.path === undefined ? current.path : next.path,
    url: next.url === undefined ? current.url : next.url,
    mime: next.mime === undefined ? current.mime : next.mime,
    content,
    revision: next.revision === undefined ? current.revision : next.revision,
    displayPath:
      next.displayPath === undefined ? current.displayPath : next.displayPath,
  }
}

/** Active left conversation of the current tab layout, null when not one. */
function activeConversationOf(state: {
  tabs: readonly TabItem[]
  activeTabId: string | null
}): number | null {
  const activeTab = state.tabs.find((tab) => tab.id === state.activeTabId)
  return activeTab?.kind === "conversation" ? activeTab.conversationId : null
}

// ---------------------------------------------------------------------------
// Module-level orchestration state (the refs it replaces)
// ---------------------------------------------------------------------------

/** Latest registered document snapshot — not reactive by design. */
let documentRef: DocumentContextDocument | null = null
/** Latest committed context; may differ from the store's `current` by the
 * equality bail-out (backend sync must still see the newest commit). */
let contextRef: RegisteredDocumentContext | null = null
let syncSequence = 0
let syncQueue: Promise<unknown> = Promise.resolve()
let debounceSequence = 0
let debounceTimer: ReturnType<typeof setTimeout> | null = null
let previousConversationId = activeConversationOf(useTabStore.getState())

// ---------------------------------------------------------------------------
// Backend sync (verbatim queue/debounce semantics)
// ---------------------------------------------------------------------------

async function sync(
  conversationId: number,
  context: RegisteredDocumentContext | null
): Promise<void> {
  if (!context) {
    await clearCurrentDocumentContext(conversationId)
    return
  }
  const { document } = context
  await setCurrentDocumentContext({
    conversationId,
    kind: document.kind,
    title: document.title ?? "",
    path: document.path ?? null,
    url: document.url ?? null,
    mime: document.mime ?? null,
    content: document.content ?? null,
    clearContent: document.content == null,
    revision: document.revision ?? null,
    selection: null,
    clearSelection: true,
  })
}

// IPC requests cannot be canceled reliably across Tauri and HTTP. Serialize
// them and skip superseded queued snapshots so a slow old document update
// cannot become the final backend context after a newer one arrives.
function enqueueSync(
  conversationId: number,
  context: RegisteredDocumentContext | null
): Promise<unknown> {
  const sequence = ++syncSequence
  const operation = syncQueue
    .catch(() => {})
    .then(async () => {
      if (sequence !== syncSequence) return
      await sync(conversationId, context)
    })
  syncQueue = operation
  return operation
}

// The renderer may update while a document is loading.  A single debounced
// sync keeps the service authoritative without turning typing, page text
// layers, or iframe refreshes into an IPC request per event.
function scheduleSync(conversationChanged: boolean): void {
  const sequence = ++debounceSequence
  if (debounceTimer !== null) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(
    () => {
      if (sequence !== debounceSequence) return
      const conversationId = activeConversationOf(useTabStore.getState())
      if (!conversationId) return
      void enqueueSync(conversationId, contextRef).catch(() => {})
    },
    conversationChanged ? 0 : 180
  )
}

// ---------------------------------------------------------------------------
// Commit
// ---------------------------------------------------------------------------

function commit(next: RegisteredDocumentContext | null): void {
  contextRef = next
  const previous = useDocumentContextStore.getState().current
  if (previous === next) return
  if (
    previous &&
    next &&
    sameDocument(previous.document, next.document) &&
    sameDocumentState(previous.document, next.document)
  ) {
    return
  }
  useDocumentContextStore.setState({ current: next })
  scheduleSync(false)
}

// ---------------------------------------------------------------------------
// Reactive slice
// ---------------------------------------------------------------------------

interface DocumentContextState {
  /** Latest committed context; observable for debugging, not consumed by UI. */
  current: RegisteredDocumentContext | null
}

export const useDocumentContextStore = create<DocumentContextState>()(() => ({
  current: null,
}))

// ---------------------------------------------------------------------------
// Public API (module functions — reference-stable, no React needed)
// ---------------------------------------------------------------------------

/**
 * Register (or merge into) the current right-side document. Renderers call
 * this on load and on metadata/snapshot updates.
 */
export function registerDocument(document: DocumentContextDocument): void {
  if (!document.kind.trim()) return
  documentRef = mergeDocument(documentRef, document)
  commit({ document: documentRef })
}

/** Clear the current document (optionally scoped to one document id). */
export function clearDocument(documentId?: string): void {
  if (documentId && documentRef && documentKey(documentRef) !== documentId) {
    return
  }
  documentRef = null
  commit(null)
}

// ---------------------------------------------------------------------------
// Tab-store reaction
// ---------------------------------------------------------------------------

function onTabStoreChange(state: {
  tabs: readonly TabItem[]
  activeTabId: string | null
}): void {
  const conversationId = activeConversationOf(state)
  if (conversationId !== previousConversationId) {
    previousConversationId = conversationId
    // A conversation switch must push the current document context to the
    // new conversation's backend slot (0ms debounce). `documentRef` and
    // `contextRef.document` are identical by construction, so unlike the old
    // provider there is no per-conversation selection state to restore.
    scheduleSync(true)
  }
}

// HMR: a module re-eval must replace the previous subscription instead of
// leaking it (a stale handler would duplicate backend syncs in dev).
const hmr = globalThis as { __berthDocumentContextTabSub?: () => void }
hmr.__berthDocumentContextTabSub?.()
hmr.__berthDocumentContextTabSub = useTabStore.subscribe(onTabStoreChange)

// ---------------------------------------------------------------------------
// Test support
// ---------------------------------------------------------------------------

/** Reset state + module orchestration vars. Used by tests. */
export function resetDocumentContextStore(): void {
  documentRef = null
  contextRef = null
  syncSequence = 0
  syncQueue = Promise.resolve()
  debounceSequence = 0
  if (debounceTimer !== null) clearTimeout(debounceTimer)
  debounceTimer = null
  previousConversationId = activeConversationOf(useTabStore.getState())
  useDocumentContextStore.setState({ current: null })
}
