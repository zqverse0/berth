import { gitLog, gitStatus } from "@/lib/api"
import { registerBackendScopedStoreReset } from "@/stores/backend-scoped-store-reset"
import type { GitLogResult, GitStatusEntry } from "@/lib/types"

const TTL_MS = 12_000

type CacheEntry<T> = { at: number; value: Promise<T> }

const statusCache = new Map<string, CacheEntry<GitStatusEntry[]>>()
const logCache = new Map<string, CacheEntry<GitLogResult>>()

function getOrLoad<T>(
  cache: Map<string, CacheEntry<T>>,
  key: string,
  load: () => Promise<T>,
  force?: boolean
): Promise<T> {
  const now = Date.now()
  const hit = cache.get(key)
  if (!force && hit && now - hit.at < TTL_MS) return hit.value
  const value = load().catch((error: unknown) => {
    const current = cache.get(key)
    if (current?.value === value) cache.delete(key)
    throw error
  })
  cache.set(key, { at: now, value })
  return value
}

function deleteKeysWithPrefix(cache: Map<string, unknown>, prefix: string) {
  for (const key of cache.keys()) {
    if (key.startsWith(prefix)) cache.delete(key)
  }
}

export function invalidateGitFolderCache(path?: string): void {
  if (!path) {
    statusCache.clear()
    logCache.clear()
    return
  }
  const prefix = `${path}\0`
  deleteKeysWithPrefix(statusCache, prefix)
  deleteKeysWithPrefix(logCache, prefix)
}

export function loadCachedGitStatus(
  path: string,
  showAllUntracked?: boolean,
  options?: { force?: boolean }
): Promise<GitStatusEntry[]> {
  const key = `${path}\0${showAllUntracked ? "1" : "0"}`
  return getOrLoad(
    statusCache,
    key,
    () => gitStatus(path, showAllUntracked),
    options?.force
  )
}

export function loadCachedGitLog(
  path: string,
  args: {
    limit?: number
    branch?: string
    remote?: string
    skip?: number
    author?: string
    allBranches?: boolean
    withFiles?: boolean
  } = {},
  options?: { force?: boolean }
): Promise<GitLogResult> {
  const key = `${path}\0${JSON.stringify([
    args.limit ?? null,
    args.branch ?? null,
    args.remote ?? null,
    args.skip ?? null,
    args.author ?? null,
    args.allBranches ?? null,
    args.withFiles ?? null,
  ])}`
  return getOrLoad(
    logCache,
    key,
    () =>
      gitLog(
        path,
        args.limit,
        args.branch,
        args.remote,
        args.skip,
        args.author,
        args.allBranches,
        args.withFiles
      ),
    options?.force
  )
}

registerBackendScopedStoreReset(() => invalidateGitFolderCache())
