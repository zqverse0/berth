import { create } from "zustand"
import { registerBackendScopedStoreReset } from "@/stores/backend-scoped-store-reset"
import {
  getFolder as apiGetFolder,
  listAllConversations,
  listAllFolderDetails,
  listOpenFolderDetails,
  openFolder as apiOpenFolder,
  openFolderById as apiOpenFolderById,
  openWorktreeFolder as apiOpenWorktreeFolder,
  reconcileWorktreeFamily,
  removeFolderFromWorkspace as apiRemoveFolderFromWorkspace,
  reorderFolders as apiReorderFolders,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  AgentStats,
  AgentType,
  DbConversationSummary,
  FolderDetail,
  GitHeadInfo,
} from "@/lib/types"

/**
 * Workspace-level shared state (folders, conversations, branches) as a Zustand
 * store. Components subscribe to the narrowest slice they render via
 * `useAppWorkspaceStore(selector)`; event bridges and callbacks read fresh
 * state through `useAppWorkspaceStore.getState()` instead of ref mirrors.
 *
 * Event wiring (side-channel subscriptions, branch polling, initial fetches)
 * stays in `AppWorkspaceProvider` — the store itself is transport-agnostic.
 */
export interface AppWorkspaceStoreState {
  folders: FolderDetail[]
  allFolders: FolderDetail[]
  foldersHydrated: boolean
  foldersLoading: boolean

  conversations: DbConversationSummary[]
  conversationsLoading: boolean
  conversationsError: string | null

  /**
   * Display branch name per folder (null when detached or non-repo).
   */
  branches: Map<number, string | null>

  /**
   * Full HEAD state per folder (repo-ness, detached, short sha). The poll keeps
   * this in sync alongside `branches`; consumers that only need the display
   * branch name keep reading `branches`. `BranchDropdown` reads this to tell a
   * detached HEAD apart from a non-git folder (issue #279).
   */
  gitHeads: Map<number, GitHeadInfo | null>

  /**
   * Derived from `conversations` on every write so subscribers get a stable
   * reference between conversation changes.
   */
  stats: AgentStats | null

  /**
   * Currently-active folder id as driven by the active tab.
   * TabProvider sets this; `useActiveFolder` / other consumers read it.
   */
  activeFolderId: number | null
  /** 最近激活的项目，最新在前（含当前项目）；仅本次运行内有效，供切换器排序。 */
  recentFolderIds: number[]

  fetchFolders: () => Promise<void>
  /**
   * Refresh only the requested folder scope. With no argument, the current
   * active folder is preferred, otherwise the currently open folders are used.
   * The default active-only query is enough for Sidebar/Tab projections;
   * callers that own the full project session manager pass `true` to retain
   * archived rows too. Scoped refreshes merge into the cached union instead of
   * replacing rows from other folders. `force` waits for an overlapping full
   * refresh and then issues a fresh query for mutation/event completion fences.
   */
  refreshConversations: (
    folderIds?: number[],
    includeArchived?: boolean,
    force?: boolean
  ) => Promise<void>
  /**
   * Non-reactive by-id lookup for callbacks/effects. Render-time reads must
   * use a selector (`useAppWorkspaceStore((s) => s.allFolders.find(...))`)
   * instead, or they won't update when the folder changes.
   */
  getFolder: (id: number) => FolderDetail | undefined
  updateConversationLocal: (
    id: number,
    patch: Partial<Pick<DbConversationSummary, "title" | "pinned_at">>
  ) => void
  applyConversationUpsert: (summary: DbConversationSummary) => void
  applyConversationRemove: (id: number) => void
  getBranch: (folderId: number) => string | null | undefined
  setBranch: (folderId: number, branch: string | null) => void
  /** Equality-guarded merge of one folder's polled HEAD into branches/gitHeads. */
  applyGitHead: (folderId: number, head: GitHeadInfo) => void
  /**
   * Insert/replace a folder in local state, mirroring the backend's list
   * split: a `kind === "chat"` folder goes into `allFolders` only (matching
   * `list_open_folder_details`, which excludes chat folders from the
   * user-facing list), every other kind into both lists.
   */
  upsertFolder: (detail: FolderDetail) => void
  openFolder: (path: string) => Promise<FolderDetail>
  openWorktreeFolder: (
    path: string,
    sourceFolderId: number
  ) => Promise<FolderDetail>
  addFolderToWorkspaceById: (folderId: number) => Promise<FolderDetail>
  removeFolderFromWorkspace: (
    folderId: number,
    deleteWorktree?: boolean
  ) => Promise<void>
  reorderFolders: (ids: number[]) => Promise<void>
  refreshFolder: (id: number) => Promise<void>
  /** 对账各 folder 所在的 worktree 家族（登记新增/移除已删），再全量刷新一次文件夹列表。 */
  refreshWorktreeFamily: (...folderIds: number[]) => Promise<void>
  setActiveFolderId: (id: number | null) => void
}

function computeStats(conversations: DbConversationSummary[]): AgentStats {
  const byAgent = new Map<AgentType, number>()
  let totalMessages = 0

  for (const s of conversations) {
    byAgent.set(s.agent_type, (byAgent.get(s.agent_type) ?? 0) + 1)
    totalMessages += s.message_count
  }

  return {
    total_conversations: conversations.length,
    total_messages: totalMessages,
    by_agent: Array.from(byAgent.entries()).map(([agent_type, count]) => ({
      agent_type,
      conversation_count: count,
    })),
  }
}

function statsEqual(a: AgentStats | null, b: AgentStats | null): boolean {
  if (a === b) return true
  if (a == null || b == null) return false
  if (
    a.total_conversations !== b.total_conversations ||
    a.total_messages !== b.total_messages ||
    a.by_agent.length !== b.by_agent.length
  ) {
    return false
  }
  return a.by_agent.every(
    (entry, index) =>
      entry.agent_type === b.by_agent[index]?.agent_type &&
      entry.conversation_count === b.by_agent[index]?.conversation_count
  )
}

/** Keep `stats` in lockstep with every `conversations` write. */
function withConversations(
  conversations: DbConversationSummary[],
  previousStats?: AgentStats | null
) {
  const nextStats =
    conversations.length > 0 ? computeStats(conversations) : null
  return {
    conversations,
    stats:
      previousStats !== undefined && statsEqual(previousStats, nextStats)
        ? previousStats
        : nextStats,
  }
}

function conversationSummaryEqual(
  a: DbConversationSummary,
  b: DbConversationSummary
): boolean {
  return (
    a.id === b.id &&
    a.folder_id === b.folder_id &&
    a.title === b.title &&
    a.title_locked === b.title_locked &&
    a.agent_type === b.agent_type &&
    a.kind === b.kind &&
    a.model === b.model &&
    a.git_branch === b.git_branch &&
    a.external_id === b.external_id &&
    a.message_count === b.message_count &&
    a.child_count === b.child_count &&
    a.created_at === b.created_at &&
    a.updated_at === b.updated_at &&
    a.pinned_at === b.pinned_at &&
    a.parent_id === b.parent_id &&
    a.parent_tool_use_id === b.parent_tool_use_id &&
    a.delegation_call_id === b.delegation_call_id
  )
}

function reuseConversationArray(
  previous: DbConversationSummary[],
  next: DbConversationSummary[]
): DbConversationSummary[] {
  if (
    previous.length === next.length &&
    previous.every((conversation, index) => conversation === next[index])
  ) {
    return previous
  }
  return next
}

// fetchFolders 每次都全量重拉；内容没变的行复用旧对象、整表没变复用旧数组，
// 否则所有订阅 folders / activeFolder 的组件都会跟着重渲染。IPC 返回的是纯数据，
// 同一个 serde 结构键序固定，用 JSON 比较即可。
function reuseFolderDetails(
  previous: FolderDetail[],
  next: FolderDetail[]
): FolderDetail[] {
  const byId = new Map(previous.map((folder) => [folder.id, folder]))
  const reused = next.map((folder) => {
    const old = byId.get(folder.id)
    return old && JSON.stringify(old) === JSON.stringify(folder) ? old : folder
  })
  return previous.length === reused.length &&
    previous.every((folder, index) => folder === reused[index])
    ? previous
    : reused
}

// Bound on the soft-delete tombstone set (see `deletedIds`). The eviction
// window — 512 deletions — far exceeds any realistic late/out-of-order event
// delay, so a row can never be resurrected in practice while memory stays
// bounded across a long-lived session.
const DELETED_TOMBSTONE_CAP = 512

// Tombstones for soft-deleted ids: a stale/out-of-order `upsert` that lands
// after a `deleted` (e.g. a concurrent rename racing a delete from another
// client) must not resurrect the row. Ids are DB autoincrement and never
// reused, so the tombstone is permanent; the set is FIFO-bounded.
const deletedIds = new Set<number>()

// Local optimistic/event patches carry a revision so a response that started
// earlier cannot roll a just-completed session back to an older execution state.
const conversationMutationVersions = new Map<number, number>()

function bumpConversationMutationVersion(conversationId: number): void {
  conversationMutationVersions.set(
    conversationId,
    (conversationMutationVersions.get(conversationId) ?? 0) + 1
  )
}

// A conversation refresh can be issued by several lifecycle paths at once
// (startup, folder activation, reconnect, and a project manager). Keep the
// latest request per folder so a slower response cannot overwrite a newer
// response for the same scope while independent folder refreshes still merge.
let nextConversationRefreshId = 0
const latestConversationRefreshByFolder = new Map<number, number>()
const refreshIncludesArchived = new Map<number, boolean>()
const refreshFoldersById = new Map<number, Set<number>>()
const inFlightConversationRefreshes = new Set<number>()
// Active refreshes use the same bounded API query for Sidebar, tab hydration,
// reconnect, and folder activation. Coalesce equivalent scopes so those
// lifecycle paths share one request; `force` remains an explicit fresh fence.
const inFlightActiveRefreshPromises = new Map<string, Promise<void>>()
// Full project-session refreshes are archive-inclusive and can be much more
// expensive than the active-only startup projection. Serialize/coalesce them
// per folder so activation, manual refresh, and reconciliation cannot hold
// every SQLite pool connection with duplicate archive queries.
const inFlightFullRefreshPromises = new Map<number, Promise<void>>()

function conversationScope(state: AppWorkspaceStoreState): number[] {
  // Chat folders are intentionally hidden from the regular `folders` list,
  // but their conversations render in Sidebar's flat Chat section. Include
  // only those hidden folders, not every closed regular project in allFolders.
  const chatFolderIds = state.allFolders
    .filter((folder) => folder.kind === "chat")
    .map((folder) => folder.id)
  return uniqueFolderIds([
    ...(state.activeFolderId != null
      ? [state.activeFolderId]
      : state.folders.map((folder) => folder.id)),
    ...chatFolderIds,
  ])
}

function uniqueFolderIds(folderIds: number[]): number[] {
  return Array.from(new Set(folderIds))
}

function hasInFlightFolderRefresh(folderId: number): boolean {
  return Array.from(refreshFoldersById.entries()).some(
    ([refreshId, folderIds]) =>
      inFlightConversationRefreshes.has(refreshId) && folderIds.has(folderId)
  )
}

function resolveRefreshPromise(resolve: (() => void) | null): void {
  resolve?.()
}

export const useAppWorkspaceStore = create<AppWorkspaceStoreState>()(
  (set, get) => ({
    folders: [],
    allFolders: [],
    foldersHydrated: false,
    foldersLoading: true,

    conversations: [],
    // Agent history is on-demand. Starting `true` leaves the sidebar file-tree
    // search overlay spinning forever because startup only hydrates folders.
    conversationsLoading: false,
    conversationsError: null,

    branches: new Map(),
    gitHeads: new Map(),
    stats: null,
    activeFolderId: null,
    recentFolderIds: [],

    fetchFolders: async () => {
      set({ foldersLoading: true })
      try {
        const [openList, allList] = await Promise.all([
          listOpenFolderDetails(),
          listAllFolderDetails(),
        ])
        let branches = get().branches
        for (const f of allList) {
          if (!branches.has(f.id)) {
            if (branches === get().branches) branches = new Map(branches)
            branches.set(f.id, f.git_branch ?? null)
          }
        }
        const activeFolderId = get().activeFolderId
        set({
          folders: reuseFolderDetails(get().folders, openList),
          allFolders: reuseFolderDetails(get().allFolders, allList),
          branches,
          activeFolderId: allList.some((folder) => folder.id === activeFolderId)
            ? activeFolderId
            : null,
        })
      } catch (err) {
        console.error("[AppWorkspace] fetchFolders failed:", err)
      } finally {
        set({ foldersLoading: false, foldersHydrated: true })
      }
    },

    refreshConversations: async (
      folderIds,
      includeArchived = false,
      force = false
    ) => {
      let requestedFolderIds = uniqueFolderIds(
        folderIds ?? conversationScope(get())
      )

      // A full refresh is the only caller that needs archived rows. If another
      // full refresh already owns a requested folder, wait for it instead of
      // starting a second archive query. Forced callers wait for the current
      // snapshot and then issue a fresh query; this is required after native
      // reconciliation or a destructive mutation has changed the DB.
      if (includeArchived) {
        // Re-check after every await. A separate refresh may be queued in the
        // same microtask window as the prior full query settles; forced callers
        // must wait for that snapshot too rather than reintroducing overlap.
        while (true) {
          const existingFullRefreshes = requestedFolderIds
            .map((folderId) => inFlightFullRefreshPromises.get(folderId))
            .filter((promise): promise is Promise<void> => promise != null)
          if (existingFullRefreshes.length === 0) break

          const pendingFolderIds = requestedFolderIds.filter(
            (folderId) => !inFlightFullRefreshPromises.has(folderId)
          )
          await Promise.allSettled(existingFullRefreshes)
          if (!force) {
            if (pendingFolderIds.length === 0) return
            requestedFolderIds = pendingFolderIds
          }
        }
      }

      // An empty explicit/current scope must never fall through to the API's
      // unscoped query. This is especially important during startup while the
      // folder list is still hydrating.
      if (requestedFolderIds.length === 0) {
        // Invalidate older responses before clearing the union. Otherwise a
        // request started for a folder that was just closed could repopulate
        // stale rows after the workspace has become folderless.
        const invalidationId = ++nextConversationRefreshId
        for (const folderId of latestConversationRefreshByFolder.keys()) {
          latestConversationRefreshByFolder.set(folderId, invalidationId)
        }
        if (inFlightConversationRefreshes.size === 0) {
          latestConversationRefreshByFolder.clear()
        }
        const currentConversations = get().conversations
        const nextConversations =
          currentConversations.length === 0 ? currentConversations : []
        const nextStats = withConversations(
          nextConversations,
          get().stats
        ).stats
        const nextLoading = inFlightConversationRefreshes.size > 0
        if (
          nextConversations !== currentConversations ||
          nextStats !== get().stats ||
          get().conversationsLoading !== nextLoading ||
          get().conversationsError !== null
        ) {
          set({
            conversations: nextConversations,
            stats: nextStats,
            conversationsLoading: nextLoading,
            conversationsError: null,
          })
        }
        return
      }

      const activeRefreshKey = !includeArchived
        ? requestedFolderIds
            .slice()
            .sort((a, b) => a - b)
            .join(",")
        : null
      if (!includeArchived && !force && activeRefreshKey != null) {
        const existing = inFlightActiveRefreshPromises.get(activeRefreshKey)
        if (existing) {
          await existing
          return
        }
      }

      const ownedFolderIds: number[] = []
      const refreshId = ++nextConversationRefreshId
      for (const folderId of requestedFolderIds) {
        const currentRefreshId = latestConversationRefreshByFolder.get(folderId)
        const currentIsFull =
          currentRefreshId != null &&
          inFlightConversationRefreshes.has(currentRefreshId) &&
          refreshIncludesArchived.get(currentRefreshId) === true
        // A lightweight active refresh may run alongside a manager's full
        // refresh, but it must not make that full response stale. Otherwise a
        // reconnect arriving at the same moment could hide archived rows from
        // the manager. Do not issue a request that owns no folders: it would
        // only consume a pool connection and its response would be discarded.
        if (!includeArchived && currentIsFull) continue
        latestConversationRefreshByFolder.set(folderId, refreshId)
        ownedFolderIds.push(folderId)
      }
      if (ownedFolderIds.length === 0) return

      const mutationVersionsAtStart = new Map(
        get().conversations.map((conversation) => [
          conversation.id,
          conversationMutationVersions.get(conversation.id) ?? 0,
        ])
      )
      refreshIncludesArchived.set(refreshId, includeArchived)
      inFlightConversationRefreshes.add(refreshId)
      refreshFoldersById.set(refreshId, new Set(ownedFolderIds))
      let resolveFullRefresh: (() => void) | null = null
      const fullRefreshPromise = includeArchived
        ? new Promise<void>((resolve) => {
            resolveFullRefresh = resolve
          })
        : null
      let resolveActiveRefresh: (() => void) | null = null
      const activeRefreshPromise =
        !includeArchived && !force && activeRefreshKey != null
          ? new Promise<void>((resolve) => {
              resolveActiveRefresh = resolve
            })
          : null
      if (activeRefreshPromise && activeRefreshKey != null) {
        inFlightActiveRefreshPromises.set(
          activeRefreshKey,
          activeRefreshPromise
        )
      }
      if (fullRefreshPromise) {
        for (const folderId of ownedFolderIds) {
          inFlightFullRefreshPromises.set(folderId, fullRefreshPromise)
        }
      }
      set({ conversationsLoading: true, conversationsError: null })

      try {
        const list = await listAllConversations({
          folder_ids: ownedFolderIds,
        })
        const freshFolderIds = ownedFolderIds.filter(
          (folderId) =>
            latestConversationRefreshByFolder.get(folderId) === refreshId
        )
        if (freshFolderIds.length > 0) {
          const freshFolderIdSet = new Set(freshFolderIds)
          const currentRows = new Map(
            get().conversations.map((conversation) => [
              conversation.id,
              conversation,
            ])
          )
          const freshRows = list
            .filter(
              (conversation) =>
                freshFolderIdSet.has(conversation.folder_id) &&
                !deletedIds.has(conversation.id)
            )
            .map((conversation) => {
              const current = currentRows.get(conversation.id)
              const changedAfterStart =
                current != null &&
                (conversationMutationVersions.get(conversation.id) ?? 0) >
                  (mutationVersionsAtStart.get(conversation.id) ?? 0)
              const merged =
                !changedAfterStart || !current
                  ? conversation
                  : {
                      ...conversation,
                      title: current.title,
                      pinned_at: current.pinned_at,
                      updated_at: current.updated_at,
                    }
              return current != null &&
                conversationSummaryEqual(current, merged)
                ? current
                : merged
            })
          const currentConversations = get().conversations
          const next = reuseConversationArray(currentConversations, [
            ...currentConversations.filter(
              (conversation) =>
                !freshFolderIdSet.has(conversation.folder_id) &&
                !deletedIds.has(conversation.id)
            ),
            ...freshRows,
          ])
          const nextState = withConversations(next, get().stats)
          if (
            nextState.conversations !== currentConversations ||
            nextState.stats !== get().stats ||
            get().conversationsError !== null
          ) {
            set({ ...nextState, conversationsError: null })
          }
        }
      } catch (err) {
        const failedFullFolderIds = includeArchived
          ? ownedFolderIds.filter(
              (folderId) =>
                latestConversationRefreshByFolder.get(folderId) === refreshId
            )
          : []
        if (failedFullFolderIds.length > 0) {
          // An active-only refresh may have been intentionally held behind the
          // full manager request. If the full request fails, release that
          // scope and retry the lightweight projection so Sidebar data is not
          // lost just because the manager's archive read failed.
          for (const folderId of failedFullFolderIds) {
            latestConversationRefreshByFolder.delete(folderId)
          }
          void get().refreshConversations(failedFullFolderIds, false)
        }
        if (
          ownedFolderIds.some(
            (folderId) =>
              latestConversationRefreshByFolder.get(folderId) === refreshId
          )
        ) {
          set({ conversationsError: toErrorMessage(err) })
        }
      } finally {
        inFlightConversationRefreshes.delete(refreshId)
        refreshIncludesArchived.delete(refreshId)
        refreshFoldersById.delete(refreshId)
        for (const folderId of ownedFolderIds) {
          const latestRefreshId =
            latestConversationRefreshByFolder.get(folderId)
          if (latestRefreshId === refreshId) {
            latestConversationRefreshByFolder.delete(folderId)
          } else if (
            latestRefreshId != null &&
            !refreshIncludesArchived.has(latestRefreshId) &&
            !hasInFlightFolderRefresh(folderId)
          ) {
            // A folder-removal invalidation is retained until the older request
            // has settled, then its tombstone can be discarded.
            latestConversationRefreshByFolder.delete(folderId)
          }
        }
        if (fullRefreshPromise) {
          for (const folderId of ownedFolderIds) {
            if (
              inFlightFullRefreshPromises.get(folderId) === fullRefreshPromise
            ) {
              inFlightFullRefreshPromises.delete(folderId)
            }
          }
          resolveRefreshPromise(resolveFullRefresh)
        }
        if (activeRefreshPromise && activeRefreshKey != null) {
          if (
            inFlightActiveRefreshPromises.get(activeRefreshKey) ===
            activeRefreshPromise
          ) {
            inFlightActiveRefreshPromises.delete(activeRefreshKey)
          }
          resolveRefreshPromise(resolveActiveRefresh)
        }
        if (inFlightConversationRefreshes.size === 0) {
          set({ conversationsLoading: false })
        }
      }
    },

    getFolder: (id) => get().allFolders.find((f) => f.id === id),

    updateConversationLocal: (id, patch) => {
      const prev = get().conversations
      const idx = prev.findIndex((c) => c.id === id)
      // Unknown id (e.g. a delegation-child status event reaching the global
      // channel) → leave state untouched so `stats` and sidebar consumers
      // don't re-render on a logical no-op.
      if (idx < 0) return
      const current = prev[idx]
      const patchChanges =
        ("title" in patch && current.title !== patch.title) ||
        ("pinned_at" in patch && current.pinned_at !== patch.pinned_at)
      if (!patchChanges) return
      const next = prev.slice()
      bumpConversationMutationVersion(id)
      // A pin toggle is a view preference, not activity — mirror the backend
      // (`update_pin`) and leave `updated_at` untouched so an updated-sorted
      // folder doesn't briefly float the row. Status/title patches still bump.
      const bumpUpdatedAt = !("pinned_at" in patch)
      next[idx] = {
        ...next[idx],
        ...patch,
        ...(bumpUpdatedAt ? { updated_at: new Date().toISOString() } : {}),
      }
      // `stats` (computeStats) depends ONLY on the conversation count and each
      // row's agent_type/message_count. This path replaces a row IN PLACE (count
      // never changes), and the patch type is restricted to status/title/pinned_at
      // — none of which is a stat input — so a patch here can never move a stat.
      // Reuse the existing `stats` reference instead of recomputing O(n) and
      // minting a fresh object: otherwise every turn-boundary
      // `conversation_status_changed` tick (one per turn start/stop, per running
      // agent) would re-render every `stats` subscriber for a no-op. The
      // `statsAffecting` guard keeps this self-correcting if the patch type is
      // ever widened to include a stat input (it recomputes then); today it is
      // always false, i.e. always reuse.
      const statsAffecting = "message_count" in patch || "agent_type" in patch
      set(
        statsAffecting
          ? withConversations(next, get().stats)
          : { conversations: next, stats: get().stats }
      )
    },

    // Insert-or-replace a conversation by id (create + field updates). Root-only:
    // delegation children (parent_id set) are not sidebar rows. New rows prepend
    // (most-recent-first); existing rows replace in place to keep their position.
    applyConversationUpsert: (summary) => {
      if (summary.parent_id != null) return
      if (deletedIds.has(summary.id)) return
      const prev = get().conversations
      const idx = prev.findIndex((c) => c.id === summary.id)
      if (idx >= 0 && conversationSummaryEqual(prev[idx], summary)) return
      bumpConversationMutationVersion(summary.id)
      if (idx < 0) {
        set(withConversations([summary, ...prev], get().stats))
        return
      }
      const next = prev.slice()
      next[idx] = summary
      set(withConversations(next, get().stats))
    },

    // Remove a conversation by id. Idempotent: an unknown id leaves state
    // untouched (no re-render; keeps `stats` stable).
    applyConversationRemove: (id) => {
      deletedIds.add(id)
      conversationMutationVersions.delete(id)
      if (deletedIds.size > DELETED_TOMBSTONE_CAP) {
        // FIFO eviction — Set preserves insertion order.
        const oldest = deletedIds.values().next().value
        if (oldest !== undefined) deletedIds.delete(oldest)
      }
      const prev = get().conversations
      const idx = prev.findIndex((c) => c.id === id)
      if (idx < 0) return
      const next = prev.slice()
      next.splice(idx, 1)
      set(withConversations(next, get().stats))
    },

    getBranch: (folderId) => get().branches.get(folderId),

    setBranch: (folderId, branch) => {
      const next = new Map(get().branches)
      next.set(folderId, branch)
      set({ branches: next })
    },

    applyGitHead: (folderId, head) => {
      const { branches, gitHeads } = get()
      const patch: Partial<AppWorkspaceStoreState> = {}
      // `branches` stays the display branch name (null when detached or
      // non-repo) — unchanged contract for tab-bar/context-bar consumers.
      if (branches.get(folderId) !== head.branch) {
        const next = new Map(branches)
        next.set(folderId, head.branch)
        patch.branches = next
      }
      const existing = gitHeads.get(folderId)
      if (
        !existing ||
        existing.is_repo !== head.is_repo ||
        existing.branch !== head.branch ||
        existing.detached !== head.detached ||
        existing.short_sha !== head.short_sha
      ) {
        const next = new Map(gitHeads)
        next.set(folderId, head)
        patch.gitHeads = next
      }
      if (Object.keys(patch).length > 0) set(patch)
    },

    upsertFolder: (detail) => {
      const upsert = (prev: FolderDetail[]) => {
        const idx = prev.findIndex((f) => f.id === detail.id)
        if (idx >= 0) {
          const updated = [...prev]
          updated[idx] = detail
          return updated
        }
        return [...prev, detail]
      }
      const { folders, allFolders } = get()
      // Mirror the backend's list split: hidden chat folders are excluded from
      // `list_open_folder_details` (the user-facing `folders` list) but kept in
      // `list_all_folder_details` (`allFolders`, for by-id cwd / active-folder
      // lookups). Seeding a chat folder into `folders` would render a "Chat"
      // header row in the sidebar until the next refetch.
      set({
        ...(detail.kind !== "chat" ? { folders: upsert(folders) } : {}),
        allFolders: upsert(allFolders),
      })
    },

    openFolder: async (path) => {
      const previous = get().allFolders.find((folder) => folder.path === path)
      const detail = await apiOpenFolder(path)
      const { upsertFolder, setBranch, refreshConversations, fetchFolders } =
        get()
      upsertFolder(detail)
      setBranch(detail.id, detail.git_branch ?? null)

      // Already-registered paths are a scope switch, not a conversation reload.
      // First-add still hydrates the new folder's summaries.
      if (!previous) {
        void refreshConversations([detail.id], false)
      }

      // A first-time Git project add may register its complete worktree family
      // in one backend operation. Refresh only for that structural add (or when
      // a legacy top-level worktree has just joined its root); ordinary project
      // switching remains a single cheap open call.
      if (
        !previous ||
        (previous.parent_id == null && detail.parent_id != null)
      ) {
        await fetchFolders()
      }
      return detail
    },

    openWorktreeFolder: async (path, sourceFolderId) => {
      const detail = await apiOpenWorktreeFolder(path, sourceFolderId)
      const { upsertFolder, setBranch, refreshConversations } = get()
      upsertFolder(detail)
      setBranch(detail.id, detail.git_branch ?? null)
      void refreshConversations([detail.id], false)
      return detail
    },

    addFolderToWorkspaceById: async (folderId) => {
      const previous = get().allFolders.find((folder) => folder.id === folderId)
      const detail = await apiOpenFolderById(folderId)
      const { upsertFolder, setBranch, refreshConversations } = get()
      upsertFolder(detail)
      setBranch(detail.id, detail.git_branch ?? null)
      // Closed-but-registered folders already have summaries or will load them
      // from an on-demand surface. Only a first-seen id hydrates the list.
      if (!previous) {
        void refreshConversations([detail.id], false)
      }
      return detail
    },

    removeFolderFromWorkspace: async (folderId, deleteWorktree = false) => {
      await apiRemoveFolderFromWorkspace(folderId, deleteWorktree)
      const {
        folders,
        allFolders,
        branches,
        gitHeads,
        conversations,
        activeFolderId,
        refreshConversations,
      } = get()
      // 后端移除 root 时会连带移除其 worktree 家族，这里同步剔除。
      const removedIds = new Set(
        allFolders
          .filter((f) => f.id === folderId || f.parent_id === folderId)
          .map((f) => f.id)
      )
      removedIds.add(folderId)
      for (const id of removedIds) {
        const invalidationId = ++nextConversationRefreshId
        latestConversationRefreshByFolder.set(id, invalidationId)
        if (!hasInFlightFolderRefresh(id)) {
          latestConversationRefreshByFolder.delete(id)
        }
      }
      const dropIds = <V>(map: Map<number, V>) => {
        if (![...removedIds].some((id) => map.has(id))) return undefined
        const next = new Map(map)
        for (const id of removedIds) next.delete(id)
        return next
      }
      const patch: Partial<AppWorkspaceStoreState> = {
        folders: folders.filter((f) => !removedIds.has(f.id)),
        allFolders: allFolders.filter((f) => !removedIds.has(f.id)),
        ...(activeFolderId != null && removedIds.has(activeFolderId)
          ? { activeFolderId: null }
          : {}),
        ...withConversations(
          conversations.filter(
            (conversation) => !removedIds.has(conversation.folder_id)
          ),
          get().stats
        ),
      }
      const nextBranches = dropIds(branches)
      if (nextBranches) patch.branches = nextBranches
      const nextGitHeads = dropIds(gitHeads)
      if (nextGitHeads) patch.gitHeads = nextGitHeads
      set(patch)
      void refreshConversations(undefined, false)
    },

    reorderFolders: async (ids) => {
      const { folders: prevFolders, allFolders: prevAllFolders } = get()

      const reorderByIds = (prev: FolderDetail[]) => {
        const byId = new Map(prev.map((f) => [f.id, f]))
        const next: FolderDetail[] = []
        ids.forEach((id, idx) => {
          const folder = byId.get(id)
          if (folder) {
            next.push({ ...folder, sort_order: idx + 1 })
            byId.delete(id)
          }
        })
        // Keep folders not included in `ids` at the end, preserving relative order.
        for (const f of prev) {
          if (byId.has(f.id)) next.push(f)
        }
        return next
      }

      set({
        folders: reorderByIds(prevFolders),
        allFolders: reorderByIds(prevAllFolders),
      })

      try {
        await apiReorderFolders(ids)
      } catch (err) {
        set({ folders: prevFolders, allFolders: prevAllFolders })
        throw err
      }
    },

    refreshFolder: async (id) => {
      try {
        const detail = await apiGetFolder(id)
        const patchList = (prev: FolderDetail[]) => {
          const idx = prev.findIndex((f) => f.id === id)
          if (idx < 0) return prev
          const updated = [...prev]
          updated[idx] = detail
          return updated
        }
        const { folders, allFolders, branches } = get()
        const patch: Partial<AppWorkspaceStoreState> = {
          folders: patchList(folders),
          allFolders: patchList(allFolders),
        }
        // Only adopt the DB branch when the row actually carries one. A folder's
        // `git_branch` column is always null today — branch state is resolved by
        // git-head polling (`applyGitHead`) — so unconditionally writing it here
        // would clobber the polled branch name with null and make the selector
        // flash "no branch" until the next poll (up to 10s). Mirrors the same
        // null-guard the `folder://changed` handler already applies.
        if (detail.git_branch != null) {
          const nextBranches = new Map(branches)
          nextBranches.set(id, detail.git_branch)
          patch.branches = nextBranches
        }
        set(patch)
      } catch (err) {
        console.error("[AppWorkspace] refreshFolder failed:", err)
      }
    },

    refreshWorktreeFamily: async (...folderIds) => {
      // 对账可能增/删 folder（git 侧 worktree add/remove），结果以全量
      // 重拉为准。某个项目对账失败不能拦住重拉：其他项目已删的 worktree
      // 会一直留在列表里，点进去就是 `Folder does not exist`。
      const results = await Promise.allSettled(
        folderIds.map((id) => reconcileWorktreeFamily(id))
      )
      for (const result of results) {
        if (result.status === "rejected") {
          console.error(
            "[AppWorkspace] refreshWorktreeFamily failed:",
            result.reason
          )
        }
      }
      await get().fetchFolders()
    },

    setActiveFolderId: (id) => {
      if (get().activeFolderId === id) return
      set((state) => ({
        activeFolderId: id,
        recentFolderIds:
          id == null
            ? state.recentFolderIds
            : [id, ...state.recentFolderIds.filter((other) => other !== id)],
      }))
    },
  })
)

/**
 * Restore the pristine initial state (including tombstones). Used by tests, and
 * by the backend-scoped reset registry if a realm's backend identity ever
 * changes (an invariant-violating transition that does not occur today — see
 * `RemoteConnectionGate`). In normal operation the store lives for the window's
 * lifetime and is never reset.
 */
export function resetAppWorkspaceStore() {
  // NOTE: this clears state only; `fetchFolders` / `refreshConversations` have no
  // backend epoch, so a pre-reset in-flight fetch could re-commit stale data. Moot
  // today (the backend-identity guard never fires); a real in-place backend switch
  // would need per-store fetch epochs. See `RemoteConnectionGate`.
  deletedIds.clear()
  conversationMutationVersions.clear()
  latestConversationRefreshByFolder.clear()
  refreshIncludesArchived.clear()
  refreshFoldersById.clear()
  inFlightConversationRefreshes.clear()
  inFlightActiveRefreshPromises.clear()
  inFlightFullRefreshPromises.clear()
  useAppWorkspaceStore.setState(useAppWorkspaceStore.getInitialState(), true)
}

// Reset this backend-scoped store on any (currently-unreachable) in-realm
// backend switch. See `backend-scoped-store-reset.ts`.
registerBackendScopedStoreReset(resetAppWorkspaceStore)
