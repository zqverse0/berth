"use client"

import { useEffect, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { useShallow } from "zustand/react/shallow"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useWorkspaceActions } from "@/contexts/workspace-context"
import { useSortedAvailableAgents } from "@/hooks/use-sorted-available-agents"
import { subscribe } from "@/lib/platform"
import {
  refreshTerminalInventory,
  useTerminalInventoryQueryState,
} from "@/lib/terminal/terminal-inventory-query"
import {
  runCorrectionOnce,
  runRecoveryOnce,
  useTabStore,
  type TabItem,
} from "@/stores/tab-store"
import {
  CONVERSATION_CHANGED_EVENT,
  PRIMARY_TABS_CHANGED_EVENT,
  type AgentType,
  type ConversationChange,
  type PrimaryTabsChanged,
  type TerminalEvent,
  type TerminalTab,
} from "@/lib/types"

export type { TabItem }
export { useTabStore, useTabActions } from "@/stores/tab-store"

interface TabProviderProps {
  children: ReactNode
}

/**
 * Thin lifecycle glue for `useTabStore`: injects the React-land dependencies
 * (i18n labels, `activateConversationPane`, agent availability)
 * and drives the effects that need a React lifecycle — the persisted-tab
 * hydration, the debounced CAS save, the cross-client
 * `primary-tabs://changed` and
 * sub-session `conversation://changed` subscriptions, the provisional-agent
 * correction gate, and post-hydration recovery. All state and logic live in the
 * store; this component renders nothing but `children`.
 */
export function TabProvider({ children }: TabProviderProps) {
  const t = useTranslations("Folder.tabContext")
  const { activateConversationPane } = useWorkspaceActions()
  const { sortedTypes: sortedAvailableAgents, fresh: agentsFresh } =
    useSortedAvailableAgents()

  // App-workspace gates for the correction / recovery / child-reconcile effects.
  const foldersHydrated = useAppWorkspaceStore((s) => s.foldersHydrated)
  const conversations = useAppWorkspaceStore((s) => s.conversations)
  const activeFolderId = useAppWorkspaceStore((s) => s.activeFolderId)
  const conversationsLoading = useAppWorkspaceStore(
    (s) => s.conversationsLoading
  )

  // Tab-store slices used only as effect dependencies (this component renders
  // nothing, so subscribing here doesn't cascade to any consumer).
  const rawTabs = useTabStore((s) => s.rawTabs)
  const activeTabId = useTabStore((s) => s.activeTabId)
  const draftRetargetRequests = useTabStore((s) => s.draftRetargetRequests)
  const tabsHydrated = useTabStore((s) => s.tabsHydrated)
  const terminalInventoryResolved = useTabStore(
    (s) => s.terminalInventoryResolved
  )
  const terminalInventoryHasSnapshot = useTabStore(
    (s) => s.terminalInventoryHasSnapshot
  )
  const saveReconcileTick = useTabStore((s) => s.saveReconcileTick)
  const terminalInventory = useTerminalInventoryQueryState(true)

  // ── Runtime dependency injection ─────────────────────────────────────────────
  // Labels first (declared before hydrate) so seed titles are translated before
  // the hydration effect runs.
  useEffect(() => {
    useTabStore.getState().setLabels({
      loadingConversation: t("loadingConversation"),
      newConversation: t("newConversation"),
      untitledConversation: t("untitledConversation"),
    })
  }, [t])

  useEffect(() => {
    useTabStore.getState().setSideEffects({ activateConversationPane })
  }, [activateConversationPane])

  useEffect(() => {
    useTabStore
      .getState()
      .setAgentAvailability(sortedAvailableAgents, agentsFresh)
  }, [sortedAvailableAgents, agentsFresh])

  // Disconnect + retarget each queued draft-retarget request.
  useEffect(() => {
    useTabStore.getState().consumeDraftRetargets()
  }, [draftRetargetRequests])

  // Hydrate persisted presentation preferences and independently subscribe to
  // the app-level terminal inventory. Runtime TerminalTabs are projected only
  // after the first successful inventory snapshot.
  useEffect(() => useTabStore.getState().hydrate(), [])

  // One-shot startup refresh: ensures the first inventory read happens at
  // TabProvider mount (no periodic poll). Coalesced with any other concurrent
  // refresh via the shared in-flight dedup in the query module.
  useEffect(() => {
    void refreshTerminalInventory().catch(() => {
      // Consumers retain their last good snapshot on transient failures.
    })
  }, [])

  // Project inventory only when the successful snapshot content changes, not
  // on mere loading→ready state churn. The effect depends on the descriptor
  // array identity (stabilized by the query module's sameInventory check) and
  // the hasSuccessfulSnapshot flag, NOT on the whole query-state object.
  const inventoryDescriptors = terminalInventory.descriptors
  const inventoryHasSnapshot = terminalInventory.hasSuccessfulSnapshot
  const inventoryStatus = terminalInventory.status
  useEffect(() => {
    if (inventoryStatus === "ready" && inventoryHasSnapshot) {
      useTabStore.getState().applyTerminalInventory(inventoryDescriptors)
    } else if (inventoryStatus === "error") {
      useTabStore.getState().markTerminalInventoryUnavailable()
    }
  }, [inventoryDescriptors, inventoryHasSnapshot, inventoryStatus])

  // One app-level lifecycle subscriber set for known running terminals.
  // terminal://exit events are an immediate acceleration signal, not the
  // cross-client inventory correctness basis.
  useEffect(() => {
    if (!terminalInventory.hasSuccessfulSnapshot) return
    let disposed = false
    const unsubscribers: Array<() => void> = []
    for (const descriptor of terminalInventory.descriptors) {
      if (descriptor.status !== "running") continue
      void subscribe<TerminalEvent>(
        `terminal://exit/${descriptor.terminalId}`,
        () => {
          if (disposed) return
          void refreshTerminalInventory().catch(() => {})
        }
      )
        .then((unsubscribe) => {
          if (disposed) unsubscribe()
          else unsubscribers.push(unsubscribe)
        })
        .catch(() => {
          // Event subscription is best-effort; explicit refresh boundaries
          // (focus, manager open, manual) remain authoritative.
        })
    }
    return () => {
      disposed = true
      for (const unsubscribe of unsubscribers) unsubscribe()
    }
  }, [terminalInventory.descriptors, terminalInventory.hasSuccessfulSnapshot])

  // Window focus refresh: read terminald once when the GUI regains focus.
  // Registered once at app-level, not per hook instance.
  useEffect(() => {
    const handleFocus = () => {
      void refreshTerminalInventory().catch(() => {})
    }
    if (typeof window !== "undefined") {
      window.addEventListener("focus", handleFocus)
    }
    return () => {
      if (typeof window !== "undefined") {
        window.removeEventListener("focus", handleFocus)
      }
    }
  }, [])

  // Debounced compare-and-set save + broadcast.
  useEffect(() => {
    useTabStore.getState().runSaveEffect()
  }, [rawTabs, tabsHydrated, terminalInventoryHasSnapshot, saveReconcileTick])

  // Clear a pending save only on unmount — NOT on every effect re-run.
  useEffect(() => () => useTabStore.getState().clearSaveTimer(), [])

  // Reconcile the sub-session summary cache to the open child tabs.
  // `activeTabId` is included so switching to a different unresolved
  // conversation tab seeds that one tab's detail (and only that one).
  useEffect(() => {
    useTabStore.getState().reconcileChildSummaries()
  }, [rawTabs, conversations, conversationsLoading, activeTabId])

  // Keep seeded sub-session summaries live off the global conversation channel.
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void (async () => {
      const dispose = await subscribe<ConversationChange>(
        CONVERSATION_CHANGED_EVENT,
        (change) => useTabStore.getState().handleChildConversationChange(change)
      )
      if (disposed) dispose()
      else unlisten = dispose
    })()
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  // Subscribe to the global `primary-tabs://changed` side-channel.
  useEffect(() => {
    let disposed = false
    let unlisten: (() => void) | undefined
    void (async () => {
      const dispose = await subscribe<PrimaryTabsChanged>(
        PRIMARY_TABS_CHANGED_EVENT,
        (change) => useTabStore.getState().handleTabsChanged(change)
      )
      if (disposed) {
        dispose()
        return
      }
      unlisten = dispose
      // Close the initial-connect window (a change committed between the hydrate
      // snapshot read and the subscription going live is dropped by the
      // broadcaster). One reconcile after subscribe is ready catches it.
      void useTabStore.getState().refetchTabs()
    })()
    return () => {
      disposed = true
      unlisten?.()
    }
  }, [])

  // Correction must wait for the fresh agent list, hydrated tabs, and hydrated
  // folders (so folder defaults resolve). One-shot per session via the store.
  useEffect(() => {
    if (!agentsFresh) return
    if (!tabsHydrated) return
    if (!foldersHydrated) return
    runCorrectionOnce()
  }, [agentsFresh, tabsHydrated, foldersHydrated])

  // A project home is derived from the active folder, not persisted in the
  // primary-tabs wire format. Re-establish that invariant after both folder and
  // terminal hydration even when persisted terminal tabs already exist.
  useEffect(() => {
    if (!tabsHydrated || !foldersHydrated || !terminalInventoryResolved) return
    runRecoveryOnce()
  }, [tabsHydrated, foldersHydrated, terminalInventoryResolved])

  // Persist the active draft's context for the next cold start.
  useEffect(() => {
    useTabStore.getState().persistLastActiveContext()
  }, [rawTabs, activeTabId, activeFolderId, tabsHydrated])

  return <>{children}</>
}

export interface TabContextValue {
  tabs: TabItem[]
  activeTabId: string | null
  tabsHydrated: boolean
  openTab: (
    folderId: number,
    conversationId: number,
    agentType: AgentType,
    pin?: boolean,
    title?: string
  ) => void
  openTerminalTab: (tab: TerminalTab, activate?: boolean) => void
  activateFolderWorkspace: (folderId: number) => void
  ensureFolderConversationTabs: (folderId: number) => void
  updateTerminalLastKnownCwd: (terminalId: string, cwd: string) => void
  closeTab: (tabId: string) => void
  closeConversationTab: (
    folderId: number,
    conversationId: number,
    agentType: AgentType
  ) => void
  closeOtherTabs: (tabId: string) => void
  closeAllTabs: () => void
  closeTabsByFolder: (folderId: number) => void
  switchTab: (tabId: string) => void
  pinTab: (tabId: string) => void
  consumeRemoteActivation: () => boolean
  openNewConversationTab: (
    folderId: number,
    workingDir: string,
    options?: {
      inheritFromActive?: boolean
      folderDefaultAgent?: AgentType | null
      activate?: boolean
    }
  ) => void
  openChatModeTab: () => void
  setChatDraftWorkingDir: (tabId: string, workingDir: string) => void
  confirmDraftAgent: (tabId: string, agentType: AgentType) => void
  setDraftAgentFromFallback: (tabId: string, agentType: AgentType) => void
  bindConversationTab: (
    tabId: string,
    conversationId: number,
    agentType: AgentType,
    title: string,
    runtimeConversationId?: number,
    folderId?: number,
    workingDir?: string
  ) => void
  setTabRuntimeConversationId: (
    tabId: string,
    runtimeConversationId: number
  ) => void
  reorderTabs: (reorderedTabs: TabItem[]) => void
}

/**
 * Backwards-compatible whole-value accessor over the tab store. Kept so existing
 * consumers keep working during the incremental selector migration; new/hot
 * consumers should read `useTabStore(selector)` / `useTabActions()` directly to
 * subscribe to the narrowest slice they render. `useShallow` keeps the returned
 * object stable, so this re-renders only when a read field
 * (tabs/activeTabId/tabsHydrated) changes — matching the former context's behavior.
 */
export function useTabContext(): TabContextValue {
  return useTabStore(
    useShallow((s) => ({
      tabs: s.tabs,
      activeTabId: s.activeTabId,
      tabsHydrated: s.tabsHydrated,
      openTab: s.openTab,
      openTerminalTab: s.openTerminalTab,
      activateFolderWorkspace: s.activateFolderWorkspace,
      ensureFolderConversationTabs: s.ensureFolderConversationTabs,
      updateTerminalLastKnownCwd: s.updateTerminalLastKnownCwd,
      closeTab: s.closeTab,
      closeConversationTab: s.closeConversationTab,
      closeOtherTabs: s.closeOtherTabs,
      closeAllTabs: s.closeAllTabs,
      closeTabsByFolder: s.closeTabsByFolder,
      switchTab: s.switchTab,
      pinTab: s.pinTab,
      consumeRemoteActivation: s.consumeRemoteActivation,
      openNewConversationTab: s.openNewConversationTab,
      openChatModeTab: s.openChatModeTab,
      setChatDraftWorkingDir: s.setChatDraftWorkingDir,
      confirmDraftAgent: s.confirmDraftAgent,
      setDraftAgentFromFallback: s.setDraftAgentFromFallback,
      bindConversationTab: s.bindConversationTab,
      setTabRuntimeConversationId: s.setTabRuntimeConversationId,
      reorderTabs: s.reorderTabs,
    }))
  )
}
