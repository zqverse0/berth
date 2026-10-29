import { create } from "zustand"
import { useShallow } from "zustand/react/shallow"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useAppUiStore } from "@/stores/app-ui-store"
import { registerBackendScopedStoreReset } from "@/stores/backend-scoped-store-reset"
import {
  getFolderConversation,
  listPrimaryTabs,
  savePrimaryTabs,
  terminateTerminalSession,
} from "@/lib/api"
import {
  buildPersistItems,
  isConversationTab,
  isTerminalTab,
  type TerminalTab,
} from "@/lib/workspace/primary-tabs"
import { extractAppCommandError } from "@/lib/app-error"
import { resolveDefaultAgent } from "@/lib/agent/resolve-default-agent"
import {
  agentTypeForTool,
  useAgentProfilesStore,
} from "@/hooks/use-agent-profiles"
import { refreshTerminalInventory } from "@/lib/terminal/terminal-inventory-query"
import { formatConversationTitle } from "@/lib/agent/conversation-title"
import {
  pickTabInFolder,
  resolveCloseTabActivation,
  resolveFolderWorkspaceActivation,
  type FolderWorkspacePane,
  type FolderWorkspaceResume,
} from "@/lib/workspace/folder-workspace-resume"
import {
  loadLastActiveContext,
  saveLastActiveContext,
  clearLastActiveContext,
} from "@/lib/workspace/last-active-context-storage"
import type {
  AgentType,
  ConversationChange,
  DbConversationSummary,
  PrimaryTabsChanged,
  TerminalDescriptor,
} from "@/lib/types"

/**
 * Workspace tab state as a Zustand store. Replaces the former single
 * merged-value `TabContext`, whose value changed identity on every tab/status
 * update and re-rendered all ~20 consumers (including the session reader,
 * which reads the store internally and therefore could not be memo-blocked).
 * Consumers now subscribe to the narrowest slice they render via
 * `useTabStore(selector)` / `useTabActions()`.
 *
 * The store owns all state, the cross-derive-stable `tabs` derivation, and every
 * mutation + orchestration action (hydration, debounced CAS save, cross-client
 * `primary-tabs://changed` apply, sub-session summary seeding, provisional-agent
 * correction, post-hydration recovery). `TabRuntimeEffects` (in
 * `contexts/tab-context.tsx`) is a thin component that injects the React-land
 * dependencies (i18n labels, `activateConversationPane`, the
 * agent availability list) and drives the effects that need a React lifecycle
 * (platform subscriptions, timers, gates).
 */

export interface ConversationTabItemInternal {
  id: string
  kind: "conversation"
  folderId: number
  conversationId: number | null
  /** The runtime session key used by ConversationRuntimeContext.
   *  For new conversations this is a virtual (negative) ID that differs
   *  from the persisted `conversationId`. */
  runtimeConversationId?: number
  /** Authoritative shared tab id when `id` remains a local `new-*` runtime key. */
  persistedId?: string
  agentType: AgentType
  title: string
  isPinned: boolean
  workingDir?: string
  /**
   * Marks `agentType` as a system best-guess that should be replaced once
   * the agent list becomes fresh. True for draft tabs whose default came
   * from a stale localStorage seed or the cold-start placeholder;
   * cleared by `confirmDraftAgent` (user click), `bindConversationTab`
   * (draft → real conversation), or the correction effect (fresh agent
   * list arrives). **Not persisted** to primary_tabs — hydrated drafts
   * default to false and are re-evaluated only when their agent_type is
   * no longer in the fresh sorted list (the `!sortedAvailableAgents.
   * includes(...)` branch of correction). Internal-only: no UI component
   * reads it, so a stale `true` value is harmless if correction never
   * runs (e.g. Contract discovery keeps failing).
   */
  agentTypeProvisional?: boolean
  /**
   * Marks a draft tab as "chat mode" (folderless). Set by `openChatModeTab`,
   * cleared implicitly once the draft binds to a real conversation (whose hidden
   * hidden chat folder then drives chat-mode chrome via `useIsActiveChatMode`).
   * **Internal-only and never persisted** — drafts (`conversationId == null`) are
   * not written to primary_tabs, so this flag only ever lives in memory for the
   * pre-send draft. While set, the draft has no resolvable folder, so the
   * composer hides the branch picker and shows the "no-folder" chip.
   */
  isChat?: boolean
}

export type TerminalTabItemInternal = TerminalTab

export type TabItemInternal =
  | ConversationTabItemInternal
  | TerminalTabItemInternal

export type TabItem = TabItemInternal

interface DraftRetargetRequest {
  tabId: string
  expectedAgent: AgentType
  folderId: number
  workingDir: string
  agentType: AgentType
  provisional: boolean
}

/** i18n strings the store needs for seed titles, injected from `TabProvider`
 *  (the store itself is locale-agnostic). Defaults to the raw keys until the
 *  provider's first effect injects the translated values — a one-frame window
 *  that only touches cosmetic seed titles, which the `tabs` derivation then
 *  overwrites from `conversations`. */
export interface TabLabels {
  loadingConversation: string
  newConversation: string
  untitledConversation: string
}

export interface TabStoreState {
  rawTabs: TabItemInternal[]
  activeTabId: string | null
  draftRetargetRequests: DraftRetargetRequest[]
  tabsHydrated: boolean
  terminalInventoryResolved: boolean
  terminalInventoryHasSnapshot: boolean
  childSummaries: Map<number, DbConversationSummary>
  /**
   * Derived from `rawTabs` × `conversations` × `childSummaries`: tab titles and
   * status decorated from the live conversation list, with cross-derive
   * reference reuse so an update that touches no open tab keeps the array (and
   * every item's) identity stable. Recomputed on every relevant write and on
   * `conversations` change (see the module-level app-workspace subscription).
   */
  tabs: TabItemInternal[]
  /** Bumped from a save's resolution to re-run the save effect when the local
   *  set moved while the save was in flight. */
  saveReconcileTick: number

  // ── Mutations ──────────────────────────────────────────────────────────────
  openTab: (
    folderId: number,
    conversationId: number,
    agentType: AgentType,
    pin?: boolean,
    title?: string
  ) => void
  openTerminalTab: (tab: TerminalTab, activate?: boolean) => void
  activateFolderWorkspace: (folderId: number) => void
  rememberFolderWorkspace: (
    folderId: number,
    resume: FolderWorkspaceResume
  ) => void
  getFolderWorkspaceResume: (folderId: number) => FolderWorkspaceResume | null
  /**
   * Compatibility helper for explicitly materializing pinned conversation tabs
   * for every top-level conversation belonging to `folderId`. Uses the exact
   * folder id (no parent/worktree merge). Idempotent: existing tabs are
   * preserved with their runtime state; only missing conversations get new tabs.
   * Hydration, folder selection, and conversation refresh paths must not call
   * this helper; users open individual sessions through `openTab` instead.
   */
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
  openNewConversationTab: (
    folderId: number,
    workingDir: string,
    options?: {
      inheritFromActive?: boolean
      folderDefaultAgent?: AgentType | null
      /** 默认激活。配置页预连接传 false，避免把项目管理顶掉。 */
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
  consumeRemoteActivation: () => boolean

  // ── Orchestration (driven by TabRuntimeEffects) ──────────────────────────────
  hydrate: () => () => void
  runSaveEffect: () => void
  clearSaveTimer: () => void
  reconcileChildSummaries: () => void
  handleChildConversationChange: (change: ConversationChange) => void
  handleTabsChanged: (change: PrimaryTabsChanged) => void
  refetchTabs: () => Promise<void>
  applyTerminalInventory: (descriptors: TerminalDescriptor[]) => void
  markTerminalInventoryUnavailable: () => void
  correctDraftAgents: () => void
  recoverActiveContext: () => void
  consumeDraftRetargets: () => void
  syncActiveFolderId: () => void
  persistLastActiveContext: () => void

  // ── Runtime dependency injection ─────────────────────────────────────────────
  setLabels: (labels: TabLabels) => void
  setSideEffects: (deps: {
    activateConversationPane?: (preserveGlobalTab?: boolean) => void
    applyFolderWorkspace?: (input: {
      folderId: number
      pane: FolderWorkspacePane
    }) => void
  }) => void
  setAgentAvailability: (sortedTypes: AgentType[], fresh: boolean) => void
}

/** Per-window/session identity stamped on every tab save and echoed back on
 *  `primary-tabs://changed`, so this client ignores its own broadcast (echo
 *  suppression). Regenerated each load — it identifies the window for echo
 *  suppression, not the user, so nothing about it needs to persist. */
const TAB_ORIGIN = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`

// ── React-land dependencies, injected by TabRuntimeEffects ─────────────────────
// Kept out of the reactive store state so updating them never notifies
// consumers; actions read them directly.
interface TabRuntime {
  labels: TabLabels
  // Close cleanup can preserve an active global workspace tab; user opens
  // continue to use the default false value and surface the primary tab.
  activateConversationPane: (preserveGlobalTab?: boolean) => void
  applyFolderWorkspace: (input: {
    folderId: number
    pane: FolderWorkspacePane
  }) => void
  sortedAvailableAgents: AgentType[]
  agentsFresh: boolean
}

function defaultRuntime(): TabRuntime {
  return {
    labels: {
      loadingConversation: "loadingConversation",
      newConversation: "newConversation",
      untitledConversation: "untitledConversation",
    },
    activateConversationPane: () => {},
    applyFolderWorkspace: () => {},
    sortedAvailableAgents: [],
    agentsFresh: false,
  }
}

function firstWorkspaceProjectFolderId(): number | null {
  return (
    useAppWorkspaceStore
      .getState()
      .folders.find((folder) => folder.kind !== "chat")?.id ?? null
  )
}

/**
 * 项目作用域只在「进入项目」时改。关 tab、inventory、远端快照都不要走这里。
 */
function adoptWorkspaceFolder(
  folderId: number,
  pane: FolderWorkspacePane | null
) {
  const store = useAppWorkspaceStore.getState()
  if (store.activeFolderId !== folderId) {
    store.setActiveFolderId(folderId)
    runtime.applyFolderWorkspace({
      folderId,
      pane: pane ?? "conversation",
    })
    return
  }
  if (pane != null) {
    runtime.applyFolderWorkspace({ folderId, pane })
  }
}

// Opening a terminal/agent tab must reveal the aux panel that hosts it.
function revealAuxPanel() {
  useAppUiStore.getState().setAuxPanelOpen(true)
}

function focusOpenedTab(folderId: number) {
  revealAuxPanel()
  if (useAppWorkspaceStore.getState().activeFolderId !== folderId) {
    adoptWorkspaceFolder(folderId, "conversation")
  }
  runtime.activateConversationPane()
}

/** 无项目终端不在任何项目里显示：打开它就离开当前项目，落到无项目 scope。 */
function focusFolderlessTab(tab: { kind: string; isPinned?: boolean }) {
  revealAuxPanel()
  if (tab.kind === "terminal" && tab.isPinned !== true) {
    useAppWorkspaceStore.getState().setActiveFolderId(null)
  }
  runtime.activateConversationPane()
}

let runtime: TabRuntime = defaultRuntime()

// ── Cross-client / coordination state (non-reactive; see original TabProvider) ──
// `version` — last workspace tab version this client observed/applied; every
//   save sends it as the CAS `expected_version`.
// `applyingRemote` — one-shot guard so applying a remote snapshot does not echo
//   back as a save.
// `pendingRemote` — a remote change that beat hydration; applied once hydrated.
let version = 0
let applyingRemote = false
let remoteActivationPending = false
let pendingRemote: PrimaryTabsChanged | null = null
// ── Save state machine ─────────────────────────────────────────────────────────
// `lastAcceptedPayload` — JSON of the last payload the server accepted.
// `saveInFlight` — true while exactly one save is in flight (single-flight).
// `saveRetryPayload` — the payload that failed with a transport error. Only
//   retries of this exact payload are blocked. A genuine user mutation that
//   produces a different desired payload is allowed to proceed.
let lastAcceptedPayload: string | null = null
let saveInFlight = false
let saveRetryPayload: string | null = null
let saveTimer: ReturnType<typeof setTimeout> | null = null
const childSummaryInFlight = new Set<number>()
const childSeedBuffer = new Map<
  number,
  { summary?: DbConversationSummary; deleted?: boolean }
>()
let seedEpoch = 0
let correctionRan = false
let recoveryRan = false
let persistedTerminalPreferences: TerminalTabItemInternal[] = []
let latestTerminalInventory: TerminalDescriptor[] = []
// Tracks the last `conversations` reference recomputeTabs derived against, so
// the module-level app-workspace subscription recomputes only when it changes.
let lastConversations: ReturnType<
  typeof useAppWorkspaceStore.getState
>["conversations"] = useAppWorkspaceStore.getState().conversations
let folderActivationGeneration = 0
const folderWorkspaceResume = new Map<number, FolderWorkspaceResume>()

function rememberActivePrimaryTab(state: {
  rawTabs: readonly TabItemInternal[]
  activeTabId: string | null
}) {
  const tab = state.rawTabs.find((item) => item.id === state.activeTabId)
  if (tab?.folderId == null) return
  const existing = folderWorkspaceResume.get(tab.folderId)
  folderWorkspaceResume.set(tab.folderId, {
    primaryTabId: tab.id,
    pane: existing?.pane ?? "conversation",
  })
}

export function getFolderWorkspaceResume(
  folderId: number
): FolderWorkspaceResume | null {
  return folderWorkspaceResume.get(folderId) ?? null
}

export function getFolderActivationGeneration(): number {
  return folderActivationGeneration
}

function makeConversationTabId(
  folderId: number,
  agentType: AgentType,
  conversationId: number
): string {
  return `conv-${folderId}-${agentType}-${conversationId}`
}

function makeNewConversationTabId(): string {
  return `new-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function findTabIndexForConversation(
  tabs: TabItemInternal[],
  folderId: number,
  agentType: AgentType,
  conversationId: number
): number {
  const canonicalId = makeConversationTabId(folderId, agentType, conversationId)
  const idx = tabs.findIndex((t) => t.id === canonicalId)
  if (idx >= 0) return idx
  return tabs.findIndex(
    (t) =>
      isConversationTab(t) &&
      t.folderId === folderId &&
      t.conversationId === conversationId &&
      t.agentType === agentType
  )
}

/** Field-wise equality for derived tab items. Backs the cross-derive reuse in
 *  the `tabs` derivation: an item whose every field matches the previous derive
 *  keeps its old reference, so downstream `Object.is` gates (consumers' memos)
 *  can short-circuit. TabItemInternal is a closed shape — keep this list in sync
 *  when adding fields. */
function sameDerivedTab(a: TabItemInternal, b: TabItemInternal): boolean {
  if (a.kind !== b.kind) return false
  if (isTerminalTab(a) && isTerminalTab(b)) {
    return (
      a.id === b.id &&
      a.terminalId === b.terminalId &&
      a.backendInstanceId === b.backendInstanceId &&
      a.folderId === b.folderId &&
      a.launchSource?.kind === b.launchSource?.kind &&
      (a.launchSource?.kind !== "managed-command" ||
        (b.launchSource?.kind === "managed-command" &&
          a.launchSource.commandId === b.launchSource.commandId)) &&
      a.agentType === b.agentType &&
      a.title === b.title &&
      a.initialCwd === b.initialCwd &&
      a.lastKnownCwd === b.lastKnownCwd &&
      a.shell === b.shell &&
      a.detachedFolderLabel === b.detachedFolderLabel &&
      a.detachedFolderPath === b.detachedFolderPath &&
      a.isPinned === b.isPinned
    )
  }
  if (!isConversationTab(a) || !isConversationTab(b)) return false
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.folderId === b.folderId &&
    a.conversationId === b.conversationId &&
    a.runtimeConversationId === b.runtimeConversationId &&
    a.persistedId === b.persistedId &&
    a.agentType === b.agentType &&
    a.title === b.title &&
    a.isPinned === b.isPinned &&
    a.workingDir === b.workingDir &&
    a.agentTypeProvisional === b.agentTypeProvisional &&
    a.isChat === b.isChat
  )
}

/**
 * Recompute the decorated `tabs` from `rawTabs` × `conversations` ×
 * `childSummaries`, reusing prior-derive references so an update touching no open
 * tab keeps the array identity stable (no consumer re-render). Called after every
 * rawTabs/childSummaries write, on `conversations` change, and when labels change.
 */
function recomputeTabs() {
  const st = useTabStore.getState()
  const { rawTabs, childSummaries } = st
  const conversations = useAppWorkspaceStore.getState().conversations
  const prev = st.tabs

  let next: TabItemInternal[]
  if (conversations.length === 0 && childSummaries.size === 0) {
    next = rawTabs
  } else {
    const conversationMap = new Map<string, (typeof conversations)[number]>()
    for (const c of conversations) {
      conversationMap.set(`${c.folder_id}-${c.agent_type}-${c.id}`, c)
    }
    const prevById = prev.length ? new Map(prev.map((d) => [d.id, d])) : null
    next = rawTabs.map((tab) => {
      if (isConversationTab(tab) && tab.conversationId != null) {
        const conv =
          conversationMap.get(
            `${tab.folderId}-${tab.agentType}-${tab.conversationId}`
          ) ?? childSummaries.get(tab.conversationId)
        if (conv) {
          const newTitle =
            formatConversationTitle(conv.title) ||
            runtime.labels.untitledConversation
          if (tab.title !== newTitle) {
            const derived = { ...tab, title: newTitle }
            const prevItem = prevById?.get(tab.id)
            return prevItem && sameDerivedTab(prevItem, derived)
              ? prevItem
              : derived
          }
        }
      }
      return tab
    })
  }

  const nextActiveTabId = st.activeTabId
  const tabsUnchanged =
    prev.length === next.length && next.every((item, i) => item === prev[i])
  if (tabsUnchanged && nextActiveTabId === st.activeTabId) return
  useTabStore.setState({
    tabs: next,
    ...(nextActiveTabId !== st.activeTabId
      ? { activeTabId: nextActiveTabId }
      : {}),
  })
}

/** Pick the agent + provisional flag for a new draft tab. Wraps the pure
 *  `resolveDefaultAgent` helper with tab-store-scoped lookups (folder default
 *  from the live app-workspace store, latest sorted types, fresh flag). */
function resolveAgentForFolder(
  folderId: number,
  inherit: AgentType | null,
  // `undefined` = look the folder default up; `null` = explicitly none.
  folderDefaultOverride?: AgentType | null
): { agentType: AgentType; provisional: boolean } {
  const folderDefault =
    folderDefaultOverride !== undefined
      ? folderDefaultOverride
      : (useAppWorkspaceStore.getState().folders.find((f) => f.id === folderId)
          ?.default_agent_type ?? null)
  return resolveDefaultAgent({
    folderDefault,
    inherit,
    sortedTypes: runtime.sortedAvailableAgents,
    fresh: runtime.agentsFresh,
  })
}

function terminateRemovedTerminalTabs(tabs: TabItemInternal[]) {
  for (const tab of tabs) {
    if (!isTerminalTab(tab)) continue
    void terminateTerminalSession(tab.terminalId).catch(() => {})
  }
}

type PersistableTabItemInternal =
  | ConversationTabItemInternal
  | TerminalTabItemInternal

function isPersistableTab(
  tab: TabItemInternal
): tab is PersistableTabItemInternal {
  return (
    isTerminalTab(tab) || (isConversationTab(tab) && tab.conversationId != null)
  )
}

function persistableTabs(
  tabs: readonly TabItemInternal[]
): PersistableTabItemInternal[] {
  return tabs.filter(isPersistableTab)
}

function terminalIdentity(terminal: {
  backendInstanceId: string
  terminalId: string
}): string {
  return `${terminal.backendInstanceId}\u0000${terminal.terminalId}`
}

function isGenericProcessTitle(title?: string | null): boolean {
  if (!title) return true
  const lower = title.trim().toLowerCase()
  return (
    lower === "terminal" ||
    lower.startsWith("python3 ·") ||
    lower.startsWith("python ·") ||
    lower.startsWith("bash ·") ||
    lower.startsWith("sh ·") ||
    lower.startsWith("zsh ·") ||
    lower.startsWith("node ·")
  )
}

/** 展示名取插件 `identity.name`（按 projectType 或 id 匹配）；插件未加载时用 id。 */
function agentDisplayLabel(agentType: AgentType): string {
  return (
    useAgentProfilesStore
      .getState()
      .agents.find(
        (agent) => agent.projectType === agentType || agent.id === agentType
      )?.name ?? agentType
  )
}

export function projectTerminalInventory(
  descriptors: readonly TerminalDescriptor[],
  preferences: readonly TerminalTabItemInternal[],
  existingTabs: readonly TabItemInternal[]
): TerminalTabItemInternal[] {
  const running = descriptors.filter(
    (descriptor) => descriptor.status === "running"
  )
  const descriptorsByIdentity = new Map(
    running.map((descriptor) => [terminalIdentity(descriptor), descriptor])
  )
  const preferencesByIdentity = new Map(
    preferences.map((terminal) => [terminalIdentity(terminal), terminal])
  )
  const preferencesByTerminalId = new Map(
    preferences.map((terminal) => [terminal.terminalId, terminal])
  )
  const existingByIdentity = new Map(
    existingTabs
      .filter(isTerminalTab)
      .map((terminal) => [terminalIdentity(terminal), terminal])
  )
  const existingByTerminalId = new Map(
    existingTabs
      .filter(isTerminalTab)
      .map((terminal) => [terminal.terminalId, terminal])
  )
  const terminalIdCounts = new Map<string, number>()
  for (const descriptor of running) {
    terminalIdCounts.set(
      descriptor.terminalId,
      (terminalIdCounts.get(descriptor.terminalId) ?? 0) + 1
    )
  }
  const orderedIdentities = [
    ...preferences.map(terminalIdentity),
    ...running.map(terminalIdentity),
  ]
  const seen = new Set<string>()
  const projected: TerminalTabItemInternal[] = []

  for (const identity of orderedIdentities) {
    if (seen.has(identity)) continue
    seen.add(identity)
    const descriptor = descriptorsByIdentity.get(identity)
    if (!descriptor) continue
    const preference =
      preferencesByIdentity.get(identity) ??
      preferencesByTerminalId.get(descriptor.terminalId)
    const existing =
      existingByIdentity.get(identity) ??
      existingByTerminalId.get(descriptor.terminalId)

    // TerminalTab.folderId 是 UI display scope，不是 daemon 归属的第二份副本。
    // 之前已 detached/stale 的投影在 inventory 刷新后仍须保持 detached；
    // inventory 快照中的 descriptor 才是运行时归属真相。
    const displayFolderId =
      descriptor.folderId == null
        ? null
        : preference
          ? preference.folderId
          : existing
            ? existing.folderId
            : descriptor.folderId
    const detachedFolderPath =
      preference?.detachedFolderPath ??
      existing?.detachedFolderPath ??
      (displayFolderId == null ? descriptor.initialCwd : null)

    // 启动时记下的 AgentType 优先；否则按 termd 识别的 Agent（启动 argv 或前台进程）。
    const candidateAgentType =
      preference?.agentType ??
      existing?.agentType ??
      agentTypeForTool(descriptor.agentId)

    let effectiveTitle: string
    if (preference?.title && !isGenericProcessTitle(preference.title)) {
      effectiveTitle = preference.title
    } else if (descriptor.title && !isGenericProcessTitle(descriptor.title)) {
      effectiveTitle = descriptor.title
    } else if (existing?.title && !isGenericProcessTitle(existing.title)) {
      effectiveTitle = existing.title
    } else if (candidateAgentType) {
      const rawTitle =
        preference?.title || descriptor.title || existing?.title || ""
      const dotIndex = rawTitle.indexOf(" · ")
      const dirSuffix = dotIndex >= 0 ? rawTitle.slice(dotIndex) : ""
      effectiveTitle = `${agentDisplayLabel(candidateAgentType)}${dirSuffix}`
    } else {
      effectiveTitle = preference?.title || existing?.title || descriptor.title
    }

    projected.push({
      kind: "terminal",
      id:
        existing?.id ??
        preference?.id ??
        (terminalIdCounts.get(descriptor.terminalId) === 1
          ? `terminal:${descriptor.terminalId}`
          : `terminal:${encodeURIComponent(descriptor.backendInstanceId)}:${descriptor.terminalId}`),
      terminalId: descriptor.terminalId,
      backendInstanceId: descriptor.backendInstanceId,
      folderId: displayFolderId,
      launchSource:
        preference?.launchSource ??
        existing?.launchSource ??
        ({ kind: "shell" } as const),
      agentType: candidateAgentType,
      title: effectiveTitle,
      initialCwd: descriptor.initialCwd,
      ...(existing?.lastKnownCwd || preference?.lastKnownCwd
        ? { lastKnownCwd: existing?.lastKnownCwd ?? preference?.lastKnownCwd }
        : {}),
      shell: descriptor.shell,
      detachedFolderLabel:
        preference?.detachedFolderLabel ??
        existing?.detachedFolderLabel ??
        null,
      detachedFolderPath: detachedFolderPath,
      isPinned: preference?.isPinned ?? existing?.isPinned ?? false,
    })
  }

  return projected
}

function initialTabState() {
  return {
    rawTabs: [] as TabItemInternal[],
    activeTabId: null as string | null,
    draftRetargetRequests: [] as DraftRetargetRequest[],
    tabsHydrated: false,
    terminalInventoryResolved: false,
    terminalInventoryHasSnapshot: false,
    childSummaries: new Map<number, DbConversationSummary>(),
    tabs: [] as TabItemInternal[],
    saveReconcileTick: 0,
  }
}

export const useTabStore = create<TabStoreState>()((set, get) => ({
  ...initialTabState(),

  openTab: (folderId, conversationId, agentType, pin = false, title) => {
    const prevState = get()
    const existingIndex = findTabIndexForConversation(
      prevState.rawTabs,
      folderId,
      agentType,
      conversationId
    )

    if (existingIndex >= 0) {
      const activateTabId = prevState.rawTabs[existingIndex].id
      if (pin && !prevState.rawTabs[existingIndex].isPinned) {
        const updated = [...prevState.rawTabs]
        updated[existingIndex] = { ...updated[existingIndex], isPinned: true }
        set({ rawTabs: updated, activeTabId: activateTabId })
        recomputeTabs()
      } else if (prevState.activeTabId !== activateTabId) {
        set({ activeTabId: activateTabId })
      }
      focusOpenedTab(folderId)
      return
    }

    // Format the seed title so a draft/conversation title carrying an inline
    // reference link (`[README.md](file://…)`) shows its label, not raw
    // Markdown, before the `tabs` derivation re-derives it from the refreshed
    // conversation list.
    const resolvedTitle =
      formatConversationTitle(
        title ??
          useAppWorkspaceStore
            .getState()
            .conversations.find(
              (c) =>
                c.id === conversationId &&
                c.agent_type === agentType &&
                c.folder_id === folderId
            )?.title
      ) || runtime.labels.untitledConversation

    const tabId = makeConversationTabId(folderId, agentType, conversationId)
    const newTab: TabItemInternal = {
      id: tabId,
      kind: "conversation",
      folderId,
      conversationId,
      agentType,
      title: resolvedTitle,
      isPinned: pin,
    }

    if (pin) {
      set({ rawTabs: [...prevState.rawTabs, newTab], activeTabId: tabId })
      recomputeTabs()
      focusOpenedTab(folderId)
      return
    }

    // New conversations always append a fresh tab. The former preview-replace
    // branch (reusing the first unpinned slot) was removed so tabs no longer
    // disappear under the user.
    set({ rawTabs: [...prevState.rawTabs, newTab], activeTabId: tabId })
    recomputeTabs()
    focusOpenedTab(folderId)
  },

  openTerminalTab: (tab, activate = true) => {
    persistedTerminalPreferences = [
      ...persistedTerminalPreferences.filter(
        (t) => t.id !== tab.id && t.terminalId !== tab.terminalId
      ),
      tab,
    ]
    const prev = get()
    const existingIndex = prev.rawTabs.findIndex((item) => item.id === tab.id)
    if (existingIndex >= 0) {
      const existing = prev.rawTabs[existingIndex]
      const next = [...prev.rawTabs]
      next[existingIndex] = { ...tab, isPinned: existing.isPinned }
      set({
        rawTabs: next,
        ...(activate ? { activeTabId: tab.id } : {}),
      })
      recomputeTabs()
      if (activate && tab.folderId != null) focusOpenedTab(tab.folderId)
      else if (activate) focusFolderlessTab(tab)
      return
    }

    set({
      rawTabs: [...prev.rawTabs, tab],
      ...(activate ? { activeTabId: tab.id } : {}),
    })
    recomputeTabs()
    if (activate && tab.folderId != null) focusOpenedTab(tab.folderId)
    else if (activate) focusFolderlessTab(tab)
  },

  activateFolderWorkspace: (folderId) => {
    folderActivationGeneration += 1
    const state = get()
    const resume = folderWorkspaceResume.get(folderId) ?? null
    const decision = resolveFolderWorkspaceActivation({
      folderId,
      resume,
      rawTabs: state.rawTabs,
      activeTabId: state.activeTabId,
    })
    if (decision.tabId) {
      if (state.activeTabId !== decision.tabId) {
        set({ activeTabId: decision.tabId })
      }
    } else {
      set({ activeTabId: null })
    }
    adoptWorkspaceFolder(folderId, decision.pane)
  },

  rememberFolderWorkspace: (folderId, resume) => {
    folderWorkspaceResume.set(folderId, resume)
  },

  getFolderWorkspaceResume: (folderId) =>
    folderWorkspaceResume.get(folderId) ?? null,

  ensureFolderConversationTabs: (folderId) => {
    const conversations = useAppWorkspaceStore.getState().conversations
    const folderConversations = conversations.filter(
      (c) => c.folder_id === folderId && c.kind !== "chat"
    )
    if (folderConversations.length === 0) return

    const prev = get()
    const existingTabIds = new Set<string>()
    for (const tab of prev.rawTabs) {
      if (isConversationTab(tab) && tab.conversationId != null) {
        existingTabIds.add(
          `${tab.folderId}-${tab.agentType}-${tab.conversationId}`
        )
      }
    }

    let hasNew = false
    const newTabs: TabItemInternal[] = []
    for (const conv of folderConversations) {
      const key = `${folderId}-${conv.agent_type}-${conv.id}`
      if (existingTabIds.has(key)) continue
      // Also check by canonical id in case an existing tab uses a different key
      const canonicalId = makeConversationTabId(
        folderId,
        conv.agent_type,
        conv.id
      )
      if (prev.rawTabs.some((tab) => tab.id === canonicalId)) continue

      const resolvedTitle =
        formatConversationTitle(conv.title) ||
        runtime.labels.untitledConversation
      newTabs.push({
        id: canonicalId,
        kind: "conversation",
        folderId,
        conversationId: conv.id,
        agentType: conv.agent_type,
        title: resolvedTitle,
        isPinned: true,
      })
      hasNew = true
    }

    if (!hasNew) return
    set({ rawTabs: [...prev.rawTabs, ...newTabs] })
    recomputeTabs()
  },

  updateTerminalLastKnownCwd: (terminalId, cwd) => {
    const normalized = cwd.trim()
    if (!normalized) return
    const prev = get()
    const index = prev.rawTabs.findIndex(
      (tab) => isTerminalTab(tab) && tab.terminalId === terminalId
    )
    if (index < 0) return
    const terminal = prev.rawTabs[index]
    if (!isTerminalTab(terminal) || terminal.lastKnownCwd === normalized) return
    const next = [...prev.rawTabs]
    next[index] = { ...terminal, lastKnownCwd: normalized }
    set({ rawTabs: next })
    recomputeTabs()
  },

  closeTab: (tabId) => {
    const shouldActivateConversation = tabId === get().activeTabId

    const prevState = get()
    const index = prevState.rawTabs.findIndex((t) => t.id === tabId)
    if (index >= 0) {
      const closingTab = prevState.rawTabs[index]
      if (isConversationTab(closingTab) && closingTab.conversationId != null) {
        try {
          localStorage.removeItem(
            `berth:session-scroll:v1:${closingTab.conversationId}`
          )
        } catch {
          // 位置清理失败不阻塞关闭。
        }
      }
      if (isTerminalTab(closingTab)) {
        terminateRemovedTerminalTabs([closingTab])
        persistedTerminalPreferences = persistedTerminalPreferences.filter(
          (t) => t.id !== tabId && t.terminalId !== closingTab.terminalId
        )
      }
      const next = prevState.rawTabs.filter((t) => t.id !== tabId)
      const folderId = closingTab.folderId
      const inFolder = prevState.rawTabs.filter(
        (tab) => tab.folderId === folderId
      )
      const closingIndexInFolder = inFolder.findIndex((tab) => tab.id === tabId)
      const remainingInFolder = inFolder.filter((tab) => tab.id !== tabId)
      const decision = resolveCloseTabActivation({
        remainingInFolder,
        closingIndexInFolder,
      })

      if (next.length === 0 && firstWorkspaceProjectFolderId() == null) {
        set({ rawTabs: [], activeTabId: null })
        recomputeTabs()
      } else if (tabId === prevState.activeTabId) {
        const currentFolderId = useAppWorkspaceStore.getState().activeFolderId
        const nextActiveId =
          decision.activeTabId ?? pickTabInFolder(next, currentFolderId)
        set({
          rawTabs: next,
          activeTabId: nextActiveId,
        })
        recomputeTabs()
      } else {
        set({ rawTabs: next })
        recomputeTabs()
      }
    }

    if (shouldActivateConversation) {
      runtime.activateConversationPane(true)
    }
  },

  closeConversationTab: (folderId, conversationId, agentType) => {
    const target = get().rawTabs.find(
      (tab) =>
        isConversationTab(tab) &&
        tab.folderId === folderId &&
        tab.conversationId === conversationId &&
        tab.agentType === agentType
    )
    if (!target) return
    get().closeTab(target.id)
  },

  closeOtherTabs: (tabId) => {
    const prevState = get()
    const target = prevState.rawTabs.find((tab) => tab.id === tabId)
    if (!target) return

    const remaining = prevState.rawTabs.filter((tab) => tab.id === tabId)
    terminateRemovedTerminalTabs(
      prevState.rawTabs.filter((tab) => tab.id !== tabId)
    )

    set({ rawTabs: remaining, activeTabId: tabId })
    recomputeTabs()
    if (target.folderId != null) {
      focusOpenedTab(target.folderId)
    } else if (target.folderId == null) {
      focusFolderlessTab(target)
    } else {
      runtime.activateConversationPane()
    }
  },

  closeAllTabs: () => {
    const prevState = get()
    if (prevState.rawTabs.length === 0) return
    terminateRemovedTerminalTabs(prevState.rawTabs)
    set({ rawTabs: [], activeTabId: null })
    recomputeTabs()
    runtime.activateConversationPane(true)
  },

  closeFolderTabs: () => {
    const prevState = get()
    if (prevState.rawTabs.length === 0) return

    terminateRemovedTerminalTabs(prevState.rawTabs)
    set({ rawTabs: [], activeTabId: null })
    recomputeTabs()
  },

  closeTabsByFolder: (folderId) => {
    const prevState = get()
    const remaining = prevState.rawTabs.filter(
      (tab) => tab.folderId !== folderId
    )
    if (remaining.length === prevState.rawTabs.length) return

    terminateRemovedTerminalTabs(
      prevState.rawTabs.filter((tab) => tab.folderId === folderId)
    )
    folderWorkspaceResume.delete(folderId)

    const currentActive = prevState.activeTabId
    const stillActive =
      currentActive != null && remaining.some((t) => t.id === currentActive)
    const currentFolderId = useAppWorkspaceStore.getState().activeFolderId
    const closedActiveFolder =
      prevState.rawTabs.find((tab) => tab.id === currentActive)?.folderId ===
      folderId

    set({
      rawTabs: remaining,
      ...(stillActive ? { activeTabId: currentActive } : {}),
    })
    recomputeTabs()

    // 删的是当前正在看的项目：这是一次显式离开，按进入项目的合同落到剩下的项目。
    if (!stillActive && (currentFolderId === folderId || closedActiveFolder)) {
      const nextFolderId = remaining[0]?.folderId ?? null
      if (nextFolderId != null) {
        get().activateFolderWorkspace(nextFolderId)
      } else {
        set({ activeTabId: null })
        recomputeTabs()
        useAppWorkspaceStore.getState().setActiveFolderId(null)
      }
    } else if (!stillActive) {
      set({
        activeTabId: pickTabInFolder(remaining, currentFolderId),
      })
      recomputeTabs()
    }
  },

  switchTab: (tabId) => {
    const prevState = get()
    const target = prevState.rawTabs.find((t) => t.id === tabId)
    if (!target) return
    if (prevState.activeTabId !== tabId) {
      set({ activeTabId: tabId })
    }
    const currentFolder = useAppWorkspaceStore.getState().activeFolderId
    if (
      target.folderId != null &&
      (!target.isPinned || currentFolder == null)
    ) {
      focusOpenedTab(target.folderId)
    } else if (target.folderId == null) {
      focusFolderlessTab(target)
    } else {
      runtime.activateConversationPane()
    }
  },

  pinTab: (tabId) => {
    const prev = get().rawTabs
    const idx = prev.findIndex((t) => t.id === tabId)
    if (idx < 0) return
    const target = prev[idx]
    // Toggle semantics: pin = global (visible in every project scope);
    // unpin returns the tab to its owning folder. No tab kind is exempt —
    // every tab (including the project-management home) follows the same rule.
    const nextPinned = !target.isPinned
    const next = prev.map((t, i) =>
      i === idx ? ({ ...t, isPinned: nextPinned } as TabItemInternal) : t
    )
    set({ rawTabs: next })
    // Terminal tabs are re-projected from `persistedTerminalPreferences` on
    // every inventory refresh. Sync that module snapshot so the newly toggled
    // isPinned isn't overwritten by the pre-pin preference when the next
    // projection runs (otherwise a pinned terminal would silently drop out of
    // every other project scope).
    if (isTerminalTab(target)) {
      const identity = terminalIdentity(target)
      persistedTerminalPreferences = persistedTerminalPreferences.map((t) =>
        terminalIdentity(t) === identity ? { ...t, isPinned: nextPinned } : t
      )
    }
    recomputeTabs()
  },

  reorderTabs: (reorderedTabs) => {
    const current = get().rawTabs
    const incomingIds = new Set(reorderedTabs.map((tab) => tab.id))
    if (incomingIds.size !== reorderedTabs.length) return

    if (reorderedTabs.length === current.length) {
      set({ rawTabs: reorderedTabs })
      recomputeTabs()
      return
    }

    let nextIndex = 0
    const merged = current.map((tab) => {
      if (!incomingIds.has(tab.id)) return tab
      const replacement = reorderedTabs[nextIndex]
      nextIndex += 1
      return replacement ?? tab
    })
    if (nextIndex !== reorderedTabs.length) return
    set({ rawTabs: merged })
    recomputeTabs()
  },

  openNewConversationTab: (folderId, workingDir, options) => {
    // Hidden legacy chat folders are read-only compatibility records. New ACP
    // drafts must always target an explicit project/worktree folder.
    if (
      useAppWorkspaceStore.getState().allFolders.find((f) => f.id === folderId)
        ?.kind === "chat"
    ) {
      get().openChatModeTab()
      return
    }
    const activate = options?.activate !== false
    const inheritFromActive = options?.inheritFromActive === true
    let inherit: AgentType | null = null
    if (inheritFromActive) {
      const st = get()
      const activeTab = st.rawTabs.find((t) => t.id === st.activeTabId)
      if (
        activeTab &&
        isConversationTab(activeTab) &&
        (activeTab.conversationId != null || !activeTab.agentTypeProvisional)
      ) {
        inherit = activeTab.agentType
      }
    }
    const { agentType: targetAgent, provisional } = resolveAgentForFolder(
      folderId,
      inherit,
      options?.folderDefaultAgent
    )

    const tabId = makeNewConversationTabId()
    const prevState = get()
    // Singleton: reuse any existing draft tab regardless of folder, so only one
    // new-conversation tab can exist at a time.
    const existingTab = prevState.rawTabs.find(
      (t) => isConversationTab(t) && t.conversationId == null
    ) as ConversationTabItemInternal | undefined

    if (!existingTab) {
      const newTab: TabItemInternal = {
        id: tabId,
        kind: "conversation",
        folderId,
        conversationId: null,
        agentType: targetAgent,
        title: runtime.labels.newConversation,
        isPinned: true,
        workingDir,
        agentTypeProvisional: provisional,
      }
      set({
        rawTabs: [...prevState.rawTabs, newTab],
        ...(activate ? { activeTabId: tabId } : {}),
      })
      recomputeTabs()
      if (activate) focusOpenedTab(folderId)
      return
    }

    const folderChanged = existingTab.folderId !== folderId
    const workingDirChanged = existingTab.workingDir !== workingDir
    const agentChanged = existingTab.agentType !== targetAgent
    const provisionalChanged =
      (existingTab.agentTypeProvisional ?? false) !== provisional

    if (folderChanged || agentChanged) {
      set({
        ...(activate ? { activeTabId: existingTab.id } : {}),
        draftRetargetRequests: [
          ...prevState.draftRetargetRequests,
          {
            tabId: existingTab.id,
            expectedAgent: existingTab.agentType,
            folderId,
            workingDir,
            agentType: targetAgent,
            provisional,
          },
        ],
      })
    } else if (workingDirChanged || provisionalChanged) {
      set({
        rawTabs: prevState.rawTabs.map((tab) =>
          tab.id === existingTab.id
            ? { ...tab, workingDir, agentTypeProvisional: provisional }
            : tab
        ),
        ...(activate ? { activeTabId: existingTab.id } : {}),
      })
      recomputeTabs()
    } else if (activate && prevState.activeTabId !== existingTab.id) {
      set({ activeTabId: existingTab.id })
    }
    if (activate) focusOpenedTab(folderId)
  },

  openChatModeTab: () => {
    const prevState = get()
    const existingChatDraft = prevState.rawTabs.find(
      (tab) =>
        isConversationTab(tab) &&
        tab.conversationId == null &&
        tab.isChat === true
    )
    if (existingChatDraft) {
      if (prevState.activeTabId !== existingChatDraft.id) {
        set({ activeTabId: existingChatDraft.id })
      }
      focusOpenedTab(0)
      return
    }

    const { agentType, provisional } = resolveAgentForFolder(0, null)
    const tab: ConversationTabItemInternal = {
      id: makeNewConversationTabId(),
      kind: "conversation",
      folderId: 0,
      conversationId: null,
      agentType,
      title: runtime.labels.newConversation,
      isPinned: true,
      agentTypeProvisional: provisional,
      isChat: true,
    }
    set({ rawTabs: [...prevState.rawTabs, tab], activeTabId: tab.id })
    recomputeTabs()
    focusOpenedTab(0)
  },

  setChatDraftWorkingDir: (tabId, workingDir) => {
    const prev = get().rawTabs
    const next = prev.map((tab) => {
      if (tab.id !== tabId) return tab
      if (!isConversationTab(tab)) return tab
      // Guard against a stale eager-prepare result landing after the draft
      // already bound, retargeted, or left chat mode. Only patch a still-unbound
      // chat draft, and skip a redundant write to keep the reference stable.
      if (
        tab.conversationId != null ||
        tab.isChat !== true ||
        tab.workingDir === workingDir
      ) {
        return tab
      }
      return { ...tab, workingDir }
    })
    if (next.every((tab, i) => tab === prev[i])) return
    set({ rawTabs: next })
    recomputeTabs()
  },

  confirmDraftAgent: (tabId, agentType) => {
    const prev = get().rawTabs
    const next = prev.map((t) => {
      if (t.id !== tabId) return t
      if (!isConversationTab(t)) return t
      if (t.conversationId != null) return t // not a draft
      if (t.agentType === agentType && !t.agentTypeProvisional) return t
      return { ...t, agentType, agentTypeProvisional: false }
    })
    if (next.every((t, i) => t === prev[i])) return
    set({ rawTabs: next })
    recomputeTabs()
  },

  setDraftAgentFromFallback: (tabId, agentType) => {
    const prev = get().rawTabs
    const next = prev.map((t) => {
      if (t.id !== tabId) return t
      if (!isConversationTab(t)) return t
      if (t.conversationId != null) return t // not a draft
      if (t.agentType === agentType && t.agentTypeProvisional) return t
      return { ...t, agentType, agentTypeProvisional: true }
    })
    if (next.every((t, i) => t === prev[i])) return
    set({ rawTabs: next })
    recomputeTabs()
  },

  bindConversationTab: (
    tabId,
    conversationId,
    agentType,
    title,
    runtimeConversationId,
    folderId,
    workingDir
  ) => {
    const prevState = get()
    const nextTabs = prevState.rawTabs.flatMap((tab) => {
      if (tab.id === tabId) {
        if (!isConversationTab(tab)) return [tab]
        const nextTab: TabItemInternal = {
          ...tab,
          conversationId,
          agentType,
          title: formatConversationTitle(title) || tab.title,
          runtimeConversationId,
          agentTypeProvisional: false,
          ...(folderId != null ? { folderId } : {}),
          ...(workingDir != null ? { workingDir } : {}),
        }
        return [nextTab]
      }
      // Drop any other tab that already represents the same (conversationId,
      // agentType) — conversation IDs are globally unique.
      if (
        isConversationTab(tab) &&
        tab.conversationId === conversationId &&
        tab.agentType === agentType
      ) {
        return []
      }
      return [tab]
    })

    const activeStillExists =
      prevState.activeTabId != null &&
      nextTabs.some((tab) => tab.id === prevState.activeTabId)
    const boundTab = nextTabs.find((tab) => tab.id === tabId)

    set({
      rawTabs: nextTabs,
      activeTabId: activeStillExists
        ? prevState.activeTabId
        : (boundTab?.id ?? nextTabs[0]?.id ?? null),
    })
    recomputeTabs()
  },

  setTabRuntimeConversationId: (tabId, runtimeConversationId) => {
    const prev = get().rawTabs
    const target = prev.find((tab) => tab.id === tabId)
    if (
      !target ||
      !isConversationTab(target) ||
      target.runtimeConversationId === runtimeConversationId
    ) {
      return
    }
    set({
      rawTabs: prev.map((tab) =>
        tab.id === tabId && isConversationTab(tab)
          ? { ...tab, runtimeConversationId }
          : tab
      ),
    })
    recomputeTabs()
  },

  consumeRemoteActivation: () => {
    if (!remoteActivationPending) return false
    remoteActivationPending = false
    return true
  },

  hydrate: () => {
    let cancelled = false
    void (async () => {
      try {
        const snap = await listPrimaryTabs()
        if (cancelled) return
        version = snap.version
        persistedTerminalPreferences = snap.items.filter(isTerminalTab)
        const restoredConversations = snap.items.filter(isConversationTab)
        const restored: TabItemInternal[] = [...restoredConversations]
        const restoredActive = pickTabInFolder(
          restored,
          useAppWorkspaceStore.getState().activeFolderId,
          get().activeTabId
        )
        set({ rawTabs: restored, activeTabId: restoredActive })
        recomputeTabs()
        // Keep the exact server payload until a successful terminal inventory
        // authorizes reconciliation. The later terminal-only payload then
        // cleans legacy ConversationTabs without deleting terminal preferences
        // on an inventory failure.
        lastAcceptedPayload = JSON.stringify(snap.items)
      } catch (err) {
        console.error("[TabStore] listPrimaryTabs failed:", err)
      } finally {
        if (!cancelled) {
          set({ tabsHydrated: true })
          if (get().terminalInventoryHasSnapshot) {
            get().applyTerminalInventory(latestTerminalInventory)
          }
          // Apply a remote change that raced ahead of hydration. Call
          // applyRemoteSnapshot directly (not handleTabsChanged): `pending` is
          // an authoritative server snapshot, and routing it through the live
          // handler's `version` gate would drop an equal-version reconcile.
          const pending = pendingRemote
          if (pending && pending.version > version) {
            pendingRemote = null
            applyRemoteSnapshot(pending)
          }
        }
      }
    })()
    return () => {
      cancelled = true
    }
  },

  runSaveEffect: () => {
    const st = get()
    if (!st.tabsHydrated || !st.terminalInventoryHasSnapshot) return
    // Never write before server truth has been adopted (hydrate / remote
    // snapshot / accepted save). A failed hydrate still flips `tabsHydrated`,
    // and saving its empty local state would wipe the persisted tabs.
    if (lastAcceptedPayload === null) return

    // A remote snapshot just mutated the shared collection — consume the guard
    // so we don't echo it back (which would re-broadcast and ping-pong).
    if (applyingRemote) {
      applyingRemote = false
      return
    }

    const persistedTabs = persistableTabs(st.rawTabs)
    persistedTerminalPreferences = st.rawTabs.filter(isTerminalTab)
    const items = buildPersistItems(persistedTabs)
    const payload = JSON.stringify(items)

    // Desired == last accepted → nothing to persist.
    if (payload === lastAcceptedPayload) {
      if (saveTimer) {
        clearTimeout(saveTimer)
        saveTimer = null
      }
      return
    }

    // Single-flight: if a save is already in flight, just let it finish.
    // When it resolves, it will check whether the desired payload has moved
    // and schedule a follow-up save if needed.
    if (saveInFlight) {
      return
    }

    // Transport failure from a previous attempt: do NOT retry the SAME
    // payload on inventory refresh. A genuine user mutation that produces a
    // different desired payload is allowed to proceed.
    if (saveRetryPayload === payload) {
      return
    }

    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
      saveTimer = null
      saveInFlight = true
      const expectedVersion = version
      savePrimaryTabs(items, expectedVersion, TAB_ORIGIN)
        .then((res) => {
          saveInFlight = false
          version = Math.max(version, res.version)
          if (!res.accepted) {
            // CAS rejected: adopt server truth deterministically.
            // applyRemoteSnapshot reconciles on equal version (its guard is
            // strict `<`). After adopting server truth, if the desired payload
            // still differs from the new accepted payload, schedule one more
            // save — but NOT via saveReconcileTick amplification.
            applyRemoteSnapshot({
              version: res.version,
              origin: "server",
              tabs: res.tabs,
            })
            // After adopting server truth, check if desired still differs.
            const currentDesired = JSON.stringify(
              buildPersistItems(persistableTabs(get().rawTabs))
            )
            lastAcceptedPayload = JSON.stringify(res.tabs)
            if (currentDesired !== lastAcceptedPayload) {
              // Re-arm the save effect for one more attempt with the latest
              // desired state. This is bounded: the next attempt will either
              // succeed (updating accepted) or be rejected again (adopting
              // the new server truth). No infinite loop.
              set({ saveReconcileTick: get().saveReconcileTick + 1 })
            }
            return
          }
          lastAcceptedPayload = payload
          // After success, check if desired moved while in flight.
          const currentDesired = JSON.stringify(
            buildPersistItems(persistableTabs(get().rawTabs))
          )
          if (currentDesired !== lastAcceptedPayload) {
            // One bounded follow-up save for the latest desired state.
            set({ saveReconcileTick: get().saveReconcileTick + 1 })
          }
        })
        .catch((error: unknown) => {
          saveInFlight = false
          saveRetryPayload = payload
          // Safe diagnostic only — never log items, paths, titles,
          // terminal contents, origin, or serialized payload.
          const appError = extractAppCommandError(error)
          const errorType = appError
            ? "AppCommandError"
            : error instanceof Error
              ? "Error"
              : "unknown"
          const code = appError?.code ?? null
          const detail = appError?.detail ?? null
          const message =
            appError?.message ??
            (error instanceof Error ? error.message : String(error))
          console.warn(
            `[TabStore] save_primary_tabs failed (phase=save): ` +
              `type=${errorType}` +
              (code ? ` code=${code}` : "") +
              ` message=${message}` +
              (detail ? ` detail=${detail}` : "")
          )
        })
    }, 500)
  },

  clearSaveTimer: () => {
    if (saveTimer) {
      clearTimeout(saveTimer)
      saveTimer = null
    }
  },

  reconcileChildSummaries: () => {
    const { conversations, conversationsLoading } =
      useAppWorkspaceStore.getState()
    if (conversationsLoading) return
    const conversationKeys = new Set<string>()
    for (const c of conversations) {
      conversationKeys.add(`${c.folder_id}-${c.agent_type}-${c.id}`)
    }
    const rawTabs = get().rawTabs
    const openChildIds = new Set<number>()
    for (const tab of rawTabs) {
      if (!isConversationTab(tab)) continue
      const id = tab.conversationId
      if (id == null) continue
      if (conversationKeys.has(`${tab.folderId}-${tab.agentType}-${id}`)) {
        continue
      }
      openChildIds.add(id)
    }
    // Prune cached summaries for child tabs that have since closed.
    const prevChild = get().childSummaries
    let prunedChild: Map<number, DbConversationSummary> | null = null
    for (const id of prevChild.keys()) {
      if (!openChildIds.has(id)) {
        prunedChild = prunedChild ?? new Map(prevChild)
        prunedChild.delete(id)
      }
    }
    if (prunedChild) {
      set({ childSummaries: prunedChild })
      recomputeTabs()
    }
    // Seed at most the currently active unresolved conversation tab.
    // Non-active unresolved tabs retain their persisted title/status until
    // the user activates them — this prevents an N-request fan-out on startup
    // when many persisted tabs from other folders or archived conversations
    // are absent from the bounded active-only conversation list.
    const activeTabId = get().activeTabId
    const activeTab = activeTabId
      ? get().rawTabs.find((tab) => tab.id === activeTabId)
      : null
    const activeConversationId =
      activeTab && isConversationTab(activeTab)
        ? activeTab.conversationId
        : null
    if (
      activeConversationId != null &&
      openChildIds.has(activeConversationId) &&
      !get().childSummaries.has(activeConversationId) &&
      !childSummaryInFlight.has(activeConversationId)
    ) {
      const id = activeConversationId
      childSummaryInFlight.add(id)
      const epoch = seedEpoch
      void getFolderConversation(id)
        .then((detail) => {
          if (seedEpoch !== epoch) return
          const buffered = childSeedBuffer.get(id)
          if (buffered?.deleted) return
          if (
            !get().rawTabs.some(
              (tab) => isConversationTab(tab) && tab.conversationId === id
            )
          )
            return
          const summary = buffered?.summary ?? detail.summary
          const nextChild = new Map(get().childSummaries)
          nextChild.set(id, summary)
          set({ childSummaries: nextChild })
          recomputeTabs()
        })
        .catch(() => {
          // Leave unseeded (e.g. deleted) — a later pass or live event retries.
        })
        .finally(() => {
          if (seedEpoch !== epoch) return
          childSummaryInFlight.delete(id)
          childSeedBuffer.delete(id)
        })
    }
  },

  handleChildConversationChange: (change) => {
    const id = change.kind === "upsert" ? change.summary.id : change.id
    if (get().childSummaries.has(id)) {
      if (change.kind === "upsert") {
        const summary = change.summary
        const prev = get().childSummaries
        if (!prev.has(summary.id)) return
        const next = new Map(prev)
        next.set(summary.id, summary)
        set({ childSummaries: next })
        recomputeTabs()
      } else {
        const prev = get().childSummaries
        if (!prev.has(change.id)) return
        const next = new Map(prev)
        next.delete(change.id)
        set({ childSummaries: next })
        recomputeTabs()
      }
      return
    }
    // Seed for this id is still in flight — accumulate into the pending buffer.
    if (childSummaryInFlight.has(id)) {
      const pending = childSeedBuffer.get(id) ?? {}
      if (change.kind === "deleted") {
        pending.deleted = true
      } else if (!pending.deleted) {
        if (change.kind === "upsert") {
          pending.summary = change.summary
        }
      }
      childSeedBuffer.set(id, pending)
    }
  },

  handleTabsChanged: (change) => {
    if (change.origin === TAB_ORIGIN) {
      if (change.version > version) version = change.version
      return
    }
    if (change.version <= version) return
    if (!get().tabsHydrated) {
      const pending = pendingRemote
      if (!pending || change.version >= pending.version) {
        pendingRemote = change
      }
      return
    }
    applyRemoteSnapshot(change)
  },

  refetchTabs: async () => {
    try {
      const snap = await listPrimaryTabs()
      const change: PrimaryTabsChanged = {
        version: snap.version,
        origin: "server",
        tabs: snap.items,
      }
      if (!get().tabsHydrated) {
        const pending = pendingRemote
        if (!pending || snap.version >= pending.version) {
          pendingRemote = change
        }
        return
      }
      if (snap.version > version) {
        applyRemoteSnapshot(change)
      } else {
        version = Math.max(version, snap.version)
      }
    } catch (err) {
      console.error("[TabStore] refetchPrimaryTabs failed:", err)
    }
  },

  applyTerminalInventory: (descriptors) => {
    latestTerminalInventory = descriptors
    const st = get()
    if (!st.tabsHydrated) {
      set({
        terminalInventoryResolved: true,
        terminalInventoryHasSnapshot: true,
      })
      return
    }

    const projected = projectTerminalInventory(
      descriptors,
      persistedTerminalPreferences,
      st.rawTabs
    )

    // Semantic stability: compare the projected persist items with the current
    // terminal subset. If they are JSON-identical, the projection has no real
    // effect — skip the store update entirely to prevent rawTabs reference
    // churn, save effect re-fire, and downstream re-renders.
    const currentTerminalPersist = JSON.stringify(
      buildPersistItems(st.rawTabs.filter(isTerminalTab))
    )
    const nextTerminalPersist = JSON.stringify(buildPersistItems(projected))
    if (currentTerminalPersist === nextTerminalPersist) {
      // Even when the projection is stable, ensure the resolved/snapshot flags
      // are set (idempotent — no-op if already true).
      if (st.terminalInventoryResolved && st.terminalInventoryHasSnapshot) {
        return
      }
      set({
        terminalInventoryResolved: true,
        terminalInventoryHasSnapshot: true,
      })
      return
    }

    persistedTerminalPreferences = projected
    const projectedMap = new Map(projected.map((t) => [t.id, t]))
    const nextTabs: TabItemInternal[] = []
    const processedIds = new Set<string>()

    for (const tab of st.rawTabs) {
      if (isTerminalTab(tab)) {
        const updated = projectedMap.get(tab.id)
        if (updated) {
          nextTabs.push(updated)
          processedIds.add(updated.id)
        }
      } else {
        nextTabs.push(tab)
        processedIds.add(tab.id)
      }
    }
    for (const p of projected) {
      if (!processedIds.has(p.id)) {
        nextTabs.push(p)
      }
    }
    const nextActiveId = pickTabInFolder(
      nextTabs,
      useAppWorkspaceStore.getState().activeFolderId,
      st.activeTabId
    )
    set({
      rawTabs: nextTabs,
      activeTabId: nextActiveId,
      terminalInventoryResolved: true,
      terminalInventoryHasSnapshot: true,
    })
    recomputeTabs()
  },

  markTerminalInventoryUnavailable: () => {
    if (get().terminalInventoryResolved) return
    set({ terminalInventoryResolved: true })
  },

  correctDraftAgents: () => {
    const candidates = get().rawTabs.filter((tab) => {
      if (!isConversationTab(tab)) return false
      if (tab.conversationId != null) return false
      if (tab.agentTypeProvisional) return true
      if (!runtime.sortedAvailableAgents.includes(tab.agentType)) return true
      return false
    })
    if (candidates.length === 0) return

    for (const tab of candidates as ConversationTabItemInternal[]) {
      void (async () => {
        const { agentType: newAgent } = resolveAgentForFolder(
          tab.folderId,
          null
        )
        const current = get().rawTabs.find((t) => t.id === tab.id)
        if (
          !current ||
          !isConversationTab(current) ||
          current.conversationId != null
        )
          return

        if (current.agentType === newAgent) {
          if (!current.agentTypeProvisional) return
          const prev = get().rawTabs
          const next = prev.map((t) =>
            t.id === tab.id &&
            isConversationTab(t) &&
            t.conversationId == null &&
            t.agentTypeProvisional
              ? { ...t, agentTypeProvisional: false }
              : t
          )
          if (next.every((t, i) => t === prev[i])) return
          set({ rawTabs: next })
          recomputeTabs()
          return
        }

        const expectedAgent = current.agentType
        const prev = get().rawTabs
        const target = prev.find((t) => t.id === tab.id)
        if (!target || !isConversationTab(target)) return
        if (target.conversationId != null) return
        if (
          target.agentType !== expectedAgent &&
          !target.agentTypeProvisional
        ) {
          return
        }
        set({
          rawTabs: prev.map((t) =>
            t.id === tab.id
              ? { ...t, agentType: newAgent, agentTypeProvisional: false }
              : t
          ),
        })
        recomputeTabs()
      })()
    }
  },

  recoverActiveContext: () => {
    const hint = loadLastActiveContext()
    const folders = useAppWorkspaceStore.getState().folders
    const activateFolder = (folderId: number) => {
      get().activateFolderWorkspace(folderId)
    }
    if (hint && !hint.isChat) {
      const f = folders.find((x) => x.id === hint.folderId)
      if (f) {
        activateFolder(f.id)
        const preferred = hint.primaryTabId
        const state = useTabStore.getState()
        if (
          preferred &&
          state.rawTabs.some(
            (tab) => tab.id === preferred && tab.folderId === f.id
          )
        ) {
          state.switchTab(preferred)
        }
        return
      }
    }
    const first = folders.find((f) => f.kind !== "chat")
    if (first) {
      activateFolder(first.id)
    }
  },

  consumeDraftRetargets: () => {
    const consumedRequests = get().draftRetargetRequests
    if (consumedRequests.length === 0) return

    const prev = get().draftRetargetRequests
    const matchesPrefix = consumedRequests.every(
      (request, index) => prev[index] === request
    )
    if (matchesPrefix) {
      set({
        draftRetargetRequests: prev.slice(consumedRequests.length),
      })
    }

    for (const request of consumedRequests) {
      const rawTabs = get().rawTabs
      const target = rawTabs.find((tab) => tab.id === request.tabId)
      if (!target || !isConversationTab(target)) continue
      if (target.conversationId != null) continue
      if (
        target.agentType !== request.expectedAgent &&
        !target.agentTypeProvisional
      ) {
        continue
      }
      set({
        rawTabs: rawTabs.map((tab) =>
          tab.id === request.tabId && isConversationTab(tab)
            ? {
                ...tab,
                folderId: request.folderId,
                workingDir: request.workingDir,
                agentType: request.agentType,
                agentTypeProvisional: request.provisional,
                isChat: false,
              }
            : tab
        ),
      })
      recomputeTabs()
    }
  },

  syncActiveFolderId: () => {
    // 项目作用域不再从活动 tab 反推。真正进项目只走
    // activateFolderWorkspace / 打开该项目的 tab。
    return
  },

  persistLastActiveContext: () => {
    const st = get()
    // 恢复读完上次位置之前，启动中的空状态不能把它覆盖掉
    if (!st.tabsHydrated || !recoveryRan) return
    const active = st.rawTabs.find((t) => t.id === st.activeTabId)
    if (!active) {
      const activeFolderId = useAppWorkspaceStore.getState().activeFolderId
      if (activeFolderId != null) {
        saveLastActiveContext({
          folderId: activeFolderId,
          isChat: false,
          primaryTabId: undefined,
        })
        return
      }
      clearLastActiveContext()
      return
    }
    if (isConversationTab(active)) {
      saveLastActiveContext({
        folderId: active.folderId,
        isChat: active.conversationId == null && active.isChat === true,
        primaryTabId: active.id,
      })
      return
    }
    if (isTerminalTab(active) && active.folderId != null) {
      saveLastActiveContext({
        folderId: active.folderId,
        isChat: false,
        primaryTabId: active.id,
      })
      return
    }
    clearLastActiveContext()
  },

  setLabels: (labels) => {
    const prev = runtime.labels
    const labelsChanged =
      prev.loadingConversation !== labels.loadingConversation ||
      prev.newConversation !== labels.newConversation ||
      prev.untitledConversation !== labels.untitledConversation
    if (!labelsChanged) return

    runtime.labels = labels
    recomputeTabs()
  },

  setSideEffects: (deps) => {
    if (deps.activateConversationPane) {
      runtime.activateConversationPane = deps.activateConversationPane
    }
    if (deps.applyFolderWorkspace) {
      runtime.applyFolderWorkspace = deps.applyFolderWorkspace
    }
  },

  setAgentAvailability: (sortedTypes, fresh) => {
    runtime.sortedAvailableAgents = sortedTypes
    runtime.agentsFresh = fresh
  },
}))

useTabStore.subscribe((state, prev) => {
  if (state.activeTabId !== prev.activeTabId) {
    rememberActivePrimaryTab(state)
  }
})

/**
 * Correction / recovery are one-shot per session (module flags). `TabProvider`
 * calls these gate wrappers when their conditions flip, replacing the former
 * `correctionRanRef` / `recoveryRanRef`.
 */
export function runCorrectionOnce() {
  if (correctionRan) return
  correctionRan = true
  useTabStore.getState().correctDraftAgents()
}

export function runRecoveryOnce() {
  if (recoveryRan) return
  recoveryRan = true
  useTabStore.getState().recoverActiveContext()
  useTabStore.getState().persistLastActiveContext()
}

// Recompute `tabs` whenever the app-workspace `conversations` list changes (any
// agent's turn start/stop): titles/status decorate from it. Reference reuse in
// recomputeTabs keeps the array stable when no open tab is affected.
useAppWorkspaceStore.subscribe(() => {
  const ws = useAppWorkspaceStore.getState()
  if (ws.conversations !== lastConversations) {
    lastConversations = ws.conversations
    recomputeTabs()
  }
})

/** All tab actions as a shallow-stable object. Actions never change identity, so
 *  this hook never triggers a re-render — consumers that only dispatch use it
 *  instead of subscribing to any state slice. */
export function useTabActions() {
  return useTabStore(
    useShallow((s) => ({
      openTab: s.openTab,
      openTerminalTab: s.openTerminalTab,
      activateFolderWorkspace: s.activateFolderWorkspace,
      rememberFolderWorkspace: s.rememberFolderWorkspace,
      ensureFolderConversationTabs: s.ensureFolderConversationTabs,
      updateTerminalLastKnownCwd: s.updateTerminalLastKnownCwd,
      closeTab: s.closeTab,
      closeConversationTab: s.closeConversationTab,
      closeOtherTabs: s.closeOtherTabs,
      closeAllTabs: s.closeAllTabs,
      closeTabsByFolder: s.closeTabsByFolder,
      switchTab: s.switchTab,
      pinTab: s.pinTab,
      openNewConversationTab: s.openNewConversationTab,
      openChatModeTab: s.openChatModeTab,
      setChatDraftWorkingDir: s.setChatDraftWorkingDir,
      confirmDraftAgent: s.confirmDraftAgent,
      setDraftAgentFromFallback: s.setDraftAgentFromFallback,
      bindConversationTab: s.bindConversationTab,
      setTabRuntimeConversationId: s.setTabRuntimeConversationId,
      reorderTabs: s.reorderTabs,
      consumeRemoteActivation: s.consumeRemoteActivation,
    }))
  )
}

/**
 * Restore pristine state (store + module coordination vars + injected runtime).
 * Used by tests, and by the backend-scoped reset registry if a realm's backend
 * identity ever changes (an invariant-violating transition that does not occur
 * today — see `RemoteConnectionGate`). In normal operation the store lives for
 * the window's lifetime and is never reset.
 */
export function resetTabStore() {
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  version = 0
  applyingRemote = false
  remoteActivationPending = false
  pendingRemote = null
  lastAcceptedPayload = null
  saveInFlight = false
  saveRetryPayload = null
  childSummaryInFlight.clear()
  childSeedBuffer.clear()
  seedEpoch = 0
  correctionRan = false
  recoveryRan = false
  persistedTerminalPreferences = []
  latestTerminalInventory = []
  runtime = defaultRuntime()
  lastConversations = useAppWorkspaceStore.getState().conversations
  folderWorkspaceResume.clear()
  folderActivationGeneration = 0
  // Merge (not replace) so the action methods are preserved; only the data
  // fields reset to their initial values.
  useTabStore.setState(initialTabState())
}

// Reset this backend-scoped store on any (currently-unreachable) in-realm
// backend switch. See `backend-scoped-store-reset.ts`.
registerBackendScopedStoreReset(resetTabStore)

/**
 * Standalone `applyRemoteSnapshot` (not a store method: it is only called
 * internally by handleTabsChanged / refetchTabs / hydrate, and closing over the
 * module coordination vars keeps the semantics identical to the former
 * `applyRemoteSnapshot` callback).
 */
function applyRemoteSnapshot(change: PrimaryTabsChanged) {
  // Stale-safe: a snapshot older than what we've applied must not move the UI or
  // version backwards. Equal versions still reconcile.
  if (change.version < version) return
  version = change.version
  // A newer remote truth supersedes any debounced local save still waiting.
  if (saveTimer) {
    clearTimeout(saveTimer)
    saveTimer = null
  }
  const prev = useTabStore.getState()
  const remoteTerminalPreferences = change.tabs.filter(isTerminalTab)
  persistedTerminalPreferences = remoteTerminalPreferences

  // Persisted conversations are shared primary-tab truth. Only local drafts stay outside the snapshot.
  const localTabs = prev.rawTabs.filter(
    (tab) => isConversationTab(tab) && tab.conversationId == null
  )
  const remoteConversations = change.tabs.filter(isConversationTab)
  const projectedTerminals = prev.terminalInventoryHasSnapshot
    ? projectTerminalInventory(
        latestTerminalInventory,
        remoteTerminalPreferences,
        prev.rawTabs
      )
    : []
  if (prev.terminalInventoryHasSnapshot) {
    persistedTerminalPreferences = projectedTerminals
  }
  const nextTabs: TabItemInternal[] = [
    ...remoteConversations,
    ...projectedTerminals,
    ...localTabs,
  ]
  const nextActiveId = pickTabInFolder(
    nextTabs,
    useAppWorkspaceStore.getState().activeFolderId,
    prev.activeTabId
  )

  if (nextActiveId !== prev.activeTabId) {
    remoteActivationPending = true
  }

  const serverPayload = JSON.stringify(change.tabs)
  const reconciledPayload = JSON.stringify(
    buildPersistItems([...remoteConversations, ...projectedTerminals])
  )
  lastAcceptedPayload = serverPayload
  // 对方的终端集合与本端的 inventory 不一致：多半是一端的 inventory 过期（别的客户端新建 /
  // 关闭了终端，本端没有刷新边界）。先不按旧 inventory 回写——两端各按自己的旧快照覆盖对方，
  // 会无限互相保存——而是重读终端真相，再按它投影（需要时保存一次）。
  const inventoryDiverges =
    prev.terminalInventoryHasSnapshot &&
    !sameTerminalIds(remoteTerminalPreferences, latestTerminalInventory)
  // Exact remote terminal preferences need no echo. If inventory discovered
  // additional live terminals (or rejected dead ones), allow the save effect to
  // converge the shared preference set to runtime truth.
  applyingRemote = serverPayload === reconciledPayload || inventoryDiverges
  useTabStore.setState({ rawTabs: nextTabs, activeTabId: nextActiveId })
  recomputeTabs()
  if (inventoryDiverges) {
    void refreshTerminalInventory()
      .then((descriptors) =>
        useTabStore.getState().applyTerminalInventory(descriptors)
      )
      .catch(() => {})
  }
}

function sameTerminalIds(
  preferences: readonly TerminalTabItemInternal[],
  inventory: readonly TerminalDescriptor[]
): boolean {
  const running = new Set(
    inventory
      .filter((descriptor) => descriptor.status === "running")
      .map((descriptor) => descriptor.terminalId)
  )
  const preferred = new Set(preferences.map((tab) => tab.terminalId))
  return (
    running.size === preferred.size &&
    [...running].every((terminalId) => preferred.has(terminalId))
  )
}
