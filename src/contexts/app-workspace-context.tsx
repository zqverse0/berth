"use client"

import { useEffect, type ReactNode } from "react"
import { getGitHead } from "@/lib/api"
import { subscribe } from "@/lib/platform"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useConversationRuntimeStore } from "@/stores/conversation-runtime-store"
import {
  CONVERSATIONS_BULK_CHANGED_EVENT,
  CONVERSATION_CHANGED_EVENT,
  FOLDER_CHANGED_EVENT,
  type ConversationChange,
  type ConversationsBulkChanged,
  type FolderChange,
} from "@/lib/types"

interface AppWorkspaceProviderProps {
  children: ReactNode
}

/**
 * On a cross-client `conversation://changed` nudge, poll the persisted detail of
 * a conversation THIS client is passively viewing back into sync (its just-
 * completed reply, streamed to whoever owns the agent, isn't on our live path).
 * The runtime store no-ops unless the conversation is open and this client is a
 * pure viewer of it — the owner's in-memory reply is never refetched over.
 */
function syncOpenViewerDetail(conversationId: number): void {
  useConversationRuntimeStore
    .getState()
    .actions.syncViewerDetail(conversationId)
}

/**
 * Event wiring for `useAppWorkspaceStore` — state itself lives in the store
 * (components subscribe to slices via selectors, not through a context value).
 * This component owns the pieces that need a React lifecycle: initial folder
 * hydration, cross-client side-channel subscriptions, and the active-folder
 * branch poll. Agent history is loaded only by explicit on-demand surfaces.
 */
export function AppWorkspaceProvider({ children }: AppWorkspaceProviderProps) {
  const activeFolderId = useAppWorkspaceStore((s) => s.activeFolderId)

  useEffect(() => {
    void useAppWorkspaceStore.getState().fetchFolders()
  }, [])

  // Subscribe to the global `conversation://changed` side-channel so any
  // client's create/rename/delete/status reaches this client's sidebar in real
  // time — independent of whether the conversation is open/attached anywhere.
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    void (async () => {
      const dispose = await subscribe<ConversationChange>(
        CONVERSATION_CHANGED_EVENT,
        (change) => {
          const store = useAppWorkspaceStore.getState()
          if (change.kind === "upsert") {
            store.applyConversationUpsert(change.summary)
            // This side-channel keeps the sidebar in sync but does NOT touch an
            // open conversation's detail. If THIS client is only viewing that
            // conversation (another client owns the live agent), a turn that
            // just completed there has no live promotion path here — so pull the
            // reply from the persisted transcript. No-op unless the conversation
            // is open and this client is a pure viewer of it.
            syncOpenViewerDetail(change.summary.id)
          } else {
            store.applyConversationRemove(change.id)
          }
        }
      )
      if (disposed) dispose()
      else unlisten = dispose
    })()

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  // A batch import (the import-picker window, possibly a different window than
  // this one) announces completion with ONE `conversations://bulk-changed`
  // nudge instead of per-row upserts; refresh only the folders named by the
  // event. Folder creations arrive separately on `folder://changed` below.
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    void (async () => {
      const dispose = await subscribe<ConversationsBulkChanged>(
        CONVERSATIONS_BULK_CHANGED_EVENT,
        (change) => {
          void useAppWorkspaceStore
            .getState()
            .refreshConversations(change.folder_ids, true, true)
        }
      )
      if (disposed) dispose()
      else unlisten = dispose
    })()

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  // Subscribe to the global `folder://changed` side-channel so a folder created
  // headlessly (e.g. an automation per-run worktree) lands in this client's
  // workspace list in real time — without it, a conversation produced in that
  // worktree has no known folder to group under and never renders in the sidebar.
  // Only upserts the list (+ seeds its branch); unlike WorkspaceOpenFolderListener
  // it never opens/focuses a tab, so a background emitter can't steal focus.
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined

    void (async () => {
      const dispose = await subscribe<FolderChange>(
        FOLDER_CHANGED_EVENT,
        (change) => {
          if (change.kind === "upsert") {
            const store = useAppWorkspaceStore.getState()
            store.upsertFolder(change.folder)
            // Only seed the branch when the event actually carries one. A
            // freshly-minted worktree row stores `git_branch: null` (resolved
            // later by git-head detection), and re-broadcasting an existing root
            // must not clobber its already-known in-memory branch with null.
            if (change.folder.git_branch) {
              store.setBranch(change.folder.id, change.folder.git_branch)
            }
          }
        }
      )
      if (disposed) dispose()
      else unlisten = dispose
    })()

    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  // Branch polling: only poll the active folder. Subscribes to the resolved
  // path (a primitive) rather than `allFolders`, so folder-list churn doesn't
  // restart the poll — only an actual active-folder change does.
  // Window focus modulates the cadence: blurred windows fall back to a slow
  // compensation poll (external git activity still converges, just later),
  // and refocusing immediately fast-polls so the branch label is fresh when
  // the user actually looks at it.
  const activeFolderPath = useAppWorkspaceStore((s) =>
    s.activeFolderId == null
      ? null
      : (s.allFolders.find((f) => f.id === s.activeFolderId)?.path ?? null)
  )
  useEffect(() => {
    if (activeFolderId == null || activeFolderPath == null) return
    const folderId = activeFolderId

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    // 首个结果只作基线；之后指纹变化才对账（worktree 以 git 为准）。
    let lastFingerprint: string | null | undefined

    const FOCUSED_REPO_DELAY = 10_000
    const BLURRED_DELAY = 60_000
    const ERROR_DELAY = 60_000

    const schedule = (delay: number) => {
      if (cancelled) return
      if (timer) clearTimeout(timer)
      timer = setTimeout(poll, delay)
    }

    const poll = async () => {
      timer = null
      try {
        const head = await getGitHead(activeFolderPath)
        if (cancelled) return
        const store = useAppWorkspaceStore.getState()
        store.applyGitHead(folderId, head)
        const fingerprint = head.worktrees_fingerprint ?? null
        if (lastFingerprint !== undefined && fingerprint !== lastFingerprint) {
          void store.refreshWorktreeFamily(folderId)
        }
        lastFingerprint = fingerprint
        // Poll a focused repo briskly to catch branch switches; a blurred
        // window keeps only the slow compensation poll.
        const focused = document.visibilityState === "visible"
        schedule(head.is_repo && focused ? FOCUSED_REPO_DELAY : BLURRED_DELAY)
      } catch {
        schedule(ERROR_DELAY)
      }
    }

    const handleVisibility = () => {
      // Refocus short-circuits the pending (slow) tick so the branch label
      // refreshes immediately rather than up to a minute later.
      if (document.visibilityState === "visible") schedule(0)
    }

    void poll()
    document.addEventListener("visibilitychange", handleVisibility)

    return () => {
      cancelled = true
      if (timer) clearTimeout(timer)
      document.removeEventListener("visibilitychange", handleVisibility)
    }
  }, [activeFolderId, activeFolderPath])

  return <>{children}</>
}
