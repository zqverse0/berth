import type { WorkspaceFileRef } from "@/lib/files/file-workspace-tab"
import type { PdfDocumentSession } from "./open-pdf-document"

export interface PdfSessionLease {
  session: PdfDocumentSession
  release(): void
}

export interface PdfSessionAcquire {
  promise: Promise<PdfSessionLease>
  release(): void
}

type OpenPdfSession = (signal: AbortSignal) => Promise<PdfDocumentSession>

interface PdfSessionEntry {
  key: string
  refCount: number
  lastUsedAt: number
  idleTimer: ReturnType<typeof setTimeout> | null
  abortController: AbortController
  session: PdfDocumentSession | null
  opening: Promise<PdfDocumentSession>
}

// 在几篇 PDF 之间来回切时不重新解析；每个会话占一份已解析文档的内存。
const MAX_WARM_SESSIONS = 3
const IDLE_EVICTION_MS = 10 * 60 * 1000
const entries = new Map<string, PdfSessionEntry>()

export function pdfSessionKey(
  file: WorkspaceFileRef,
  sourceRevision: number
): string {
  return `${file.rootPath}\0${file.path}\0${sourceRevision}`
}

function clearIdleTimer(entry: PdfSessionEntry): void {
  if (entry.idleTimer === null) return
  clearTimeout(entry.idleTimer)
  entry.idleTimer = null
}

function closeEntry(entry: PdfSessionEntry): Promise<void> {
  if (entries.get(entry.key) !== entry) return Promise.resolve()
  entries.delete(entry.key)
  clearIdleTimer(entry)
  const session = entry.session
  entry.session = null
  if (session) {
    return Promise.resolve()
      .then(() => session.close())
      .catch(() => undefined)
  }
  entry.abortController.abort()
  return entry.opening.then((opened) => opened.close()).catch(() => undefined)
}

function evictWarmOverflow(): void {
  const idleEntries = [...entries.values()]
    .filter((entry) => entry.refCount === 0)
    .sort((left, right) => left.lastUsedAt - right.lastUsedAt)
  while (idleEntries.length > MAX_WARM_SESSIONS) {
    const entry = idleEntries.shift()
    if (entry) void closeEntry(entry)
  }
}

function scheduleIdleEviction(entry: PdfSessionEntry): void {
  clearIdleTimer(entry)
  entry.idleTimer = setTimeout(() => {
    entry.idleTimer = null
    if (entry.refCount === 0) void closeEntry(entry)
  }, IDLE_EVICTION_MS)
}

function releaseEntry(entry: PdfSessionEntry): void {
  if (entry.refCount === 0) return
  entry.refCount -= 1
  entry.lastUsedAt = Date.now()
  if (entry.refCount > 0) return
  if (!entry.session) {
    void closeEntry(entry)
    return
  }
  scheduleIdleEviction(entry)
  evictWarmOverflow()
}

function createEntry(key: string, open: OpenPdfSession): PdfSessionEntry {
  const entry: PdfSessionEntry = {
    key,
    refCount: 0,
    lastUsedAt: Date.now(),
    idleTimer: null,
    abortController: new AbortController(),
    session: null,
    opening: Promise.resolve(null as unknown as PdfDocumentSession),
  }
  entry.opening = Promise.resolve()
    .then(() => open(entry.abortController.signal))
    .then(
      (session) => {
        entry.session = session
        return session
      },
      (error) => {
        if (entries.get(key) === entry) entries.delete(key)
        throw error
      }
    )
  return entry
}

export function acquirePdfSession(
  key: string,
  open: OpenPdfSession
): PdfSessionAcquire {
  let entry = entries.get(key)
  if (!entry) {
    entry = createEntry(key, open)
    entries.set(key, entry)
  }
  clearIdleTimer(entry)
  entry.refCount += 1
  entry.lastUsedAt = Date.now()

  let released = false
  const release = () => {
    if (released) return
    released = true
    releaseEntry(entry!)
  }
  const promise = entry.opening.then((session) => ({ session, release }))
  return { promise, release }
}

export async function __resetPdfSessionCacheForTests(): Promise<void> {
  if (process.env.NODE_ENV !== "test") return
  const currentEntries = [...entries.values()]
  await Promise.all(currentEntries.map((entry) => closeEntry(entry)))
}
