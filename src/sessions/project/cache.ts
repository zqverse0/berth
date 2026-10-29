import { listProjectAgentSessions } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  AgentType,
  ConversationChange,
  ProjectAgentSessionPage,
  ProjectAgentSessionSummary,
} from "@/lib/types"
import { registerBackendScopedStoreReset } from "@/stores/backend-scoped-store-reset"
import {
  applyConversationChangeToProjectSessions,
  mergeProjectAgentSessionRows,
  projectAgentSessionIdentity,
} from "./reducer"

const MAX_CACHE_ENTRIES = 24

export interface ProjectSessionQueryScope {
  folderId: number
  agentType: AgentType
  query: string
}

export interface ProjectSessionSnapshot {
  items: ProjectAgentSessionSummary[]
  nextCursor: string | null
  scanComplete: boolean
  sourceWarning: string | null
  loading: boolean
  loadingMore: boolean
  error: string | null
  loaded: boolean
}

const EMPTY_SNAPSHOT: ProjectSessionSnapshot = {
  items: [],
  nextCursor: null,
  scanComplete: true,
  sourceWarning: null,
  loading: false,
  loadingMore: false,
  error: null,
  loaded: false,
}

interface CacheEntry {
  scope: ProjectSessionQueryScope
  snapshot: ProjectSessionSnapshot
  listeners: Set<() => void>
  lastAccessed: number
  revision: number
}

const entries = new Map<string, CacheEntry>()
const inFlight = new Map<string, Promise<ProjectAgentSessionPage>>()

export function normalizeProjectSessionQuery(query: string): string {
  return query.trim().toLowerCase()
}

export function projectSessionQueryKey(
  scope: ProjectSessionQueryScope
): string {
  return `${scope.folderId}:${scope.agentType}:${encodeURIComponent(
    normalizeProjectSessionQuery(scope.query)
  )}`
}

function getOrCreateEntry(scope: ProjectSessionQueryScope): CacheEntry {
  const key = projectSessionQueryKey(scope)
  const existing = entries.get(key)
  if (existing) {
    existing.lastAccessed = Date.now()
    return existing
  }
  const entry: CacheEntry = {
    scope: { ...scope, query: normalizeProjectSessionQuery(scope.query) },
    snapshot: EMPTY_SNAPSHOT,
    listeners: new Set(),
    lastAccessed: Date.now(),
    revision: 0,
  }
  entries.set(key, entry)
  evictUnusedEntries()
  return entry
}

function evictUnusedEntries(): void {
  if (entries.size <= MAX_CACHE_ENTRIES) return
  const candidates = [...entries.entries()]
    .filter(([, entry]) => entry.listeners.size === 0)
    .sort((left, right) => left[1].lastAccessed - right[1].lastAccessed)
  for (const [key] of candidates) {
    if (entries.size <= MAX_CACHE_ENTRIES) break
    entries.delete(key)
  }
}

function commit(entry: CacheEntry, snapshot: ProjectSessionSnapshot): void {
  if (entry.snapshot === snapshot) return
  entry.snapshot = snapshot
  entry.lastAccessed = Date.now()
  for (const listener of entry.listeners) listener()
}

export function getProjectSessionSnapshot(
  scope: ProjectSessionQueryScope
): ProjectSessionSnapshot {
  return getOrCreateEntry(scope).snapshot
}

export function subscribeProjectSessionSnapshot(
  scope: ProjectSessionQueryScope,
  listener: () => void
): () => void {
  const entry = getOrCreateEntry(scope)
  entry.listeners.add(listener)
  return () => entry.listeners.delete(listener)
}

export async function loadProjectSessionPage(
  scope: ProjectSessionQueryScope,
  options: {
    append?: boolean
    force?: boolean
    reconcileProvider?: boolean
  } = {}
): Promise<void> {
  const entry = getOrCreateEntry(scope)
  const append = options.append === true
  if (!append && entry.snapshot.loaded && !options.force) return
  const cursor = append ? entry.snapshot.nextCursor : null
  if (append && !cursor) return

  const requestKey = `${projectSessionQueryKey(scope)}:${cursor ?? "first"}:${
    options.reconcileProvider ? "reconcile" : "cached"
  }`
  const revisionAtStart = entry.revision
  let request = inFlight.get(requestKey)
  if (!request) {
    request = listProjectAgentSessions({
      folderId: scope.folderId,
      agentType: scope.agentType,
      cursor,
      search: normalizeProjectSessionQuery(scope.query) || null,
      refresh: options.reconcileProvider === true,
    })
    inFlight.set(requestKey, request)
    void request.then(
      () => {
        if (inFlight.get(requestKey) === request) inFlight.delete(requestKey)
      },
      () => {
        if (inFlight.get(requestKey) === request) inFlight.delete(requestKey)
      }
    )
  }

  commit(entry, {
    ...entry.snapshot,
    loading: append ? entry.snapshot.loading : true,
    loadingMore: append,
    error: null,
  })

  try {
    const page = await request
    const current = entry.snapshot
    commit(entry, {
      // A first-page response is authoritative unless a live event changed the
      // scope while it was in flight; in that race, preserve the event row.
      items:
        append || entry.revision !== revisionAtStart
          ? mergeProjectAgentSessionRows(current.items, page.items)
          : mergeProjectAgentSessionRows([], page.items),
      nextCursor: page.nextCursor,
      scanComplete: page.scanComplete,
      sourceWarning: page.sourceWarning,
      loading: false,
      loadingMore: false,
      error: null,
      loaded: true,
    })
  } catch (error) {
    commit(entry, {
      ...entry.snapshot,
      loading: false,
      loadingMore: false,
      error: toErrorMessage(error),
    })
  }
}

export function updateProjectSessionRow(
  scope: ProjectSessionQueryScope,
  row: ProjectAgentSessionSummary | null,
  identity: ProjectAgentSessionSummary
): void {
  const entry = getOrCreateEntry(scope)
  const items = row
    ? mergeProjectAgentSessionRows(entry.snapshot.items, [row])
    : entry.snapshot.items.filter(
        (candidate) =>
          projectAgentSessionIdentity(candidate) !==
          projectAgentSessionIdentity(identity)
      )
  entry.revision += 1
  commit(entry, { ...entry.snapshot, items })
}

export function applyProjectSessionConversationChange(
  change: ConversationChange
): void {
  for (const entry of entries.values()) {
    const items = applyConversationChangeToProjectSessions(
      entry.snapshot.items,
      change,
      entry.scope
    )
    if (items !== entry.snapshot.items) {
      entry.revision += 1
      commit(entry, { ...entry.snapshot, items })
    }
  }
}

export function resetProjectSessionQueryCache(): void {
  entries.clear()
  inFlight.clear()
}

registerBackendScopedStoreReset(resetProjectSessionQueryCache)
