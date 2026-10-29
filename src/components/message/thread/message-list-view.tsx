"use client"

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import {
  selectTimelineTurns,
  useConversationRuntimeStore,
} from "@/stores/conversation-runtime-store"
import { ContentPartsRenderer } from "./content-parts-renderer"
import { CollapsibleUserMessage } from "../user/collapsible-user-message"
import {
  createMessageTurnAdapter,
  groupGoalRuns,
  mergeAdjacentToolGroups,
  mergeAdjacentDelegationStatusGroups,
  mergeAdjacentBackgroundTaskGroups,
  type AdaptedContentPart,
  type AdaptedMessage,
  type MessageTurnAdapter,
  type UserImageDisplay,
  type UserResourceDisplay,
} from "@/lib/adapters/ai-elements-adapter"
import { TurnStats } from "../cards/turn-stats"
import { ReplyArtifacts } from "../cards/reply-artifacts"
import { UserResourceLinks } from "../user/user-resource-links"
import { UserImageAttachments } from "../user/user-image-attachments"
import { AgentPlanOverlay } from "@/components/chat/agent-plan-overlay"
import {
  MessageThread,
  MessageThreadScrollButton,
} from "@/components/ai-elements/message-thread"
import {
  Message,
  MessageContent,
  MessageAction,
} from "@/components/ai-elements/message"
import {
  AlertCircle,
  CheckIcon,
  ChevronDown,
  ChevronRight,
  CopyIcon,
  Info,
  Loader2,
  Plus,
  RefreshCw,
} from "lucide-react"
import { Button } from "@/components/ui/button"
import { useTranslations } from "next-intl"
import {
  buildPlanKey,
  extractLatestPlanEntriesFromMessages,
} from "@/lib/agent/agent-plan"
import type { MessageTurn } from "@/lib/types"
import { copyTextToClipboard } from "@/lib/utils"
import { VirtualizedMessageThread } from "@/components/message/thread/virtualized-message-thread"
import type { MessageScrollContextValue } from "@/components/message/thread/message-scroll-context"
import type { MessageNavEntry } from "@/lib/message-navigation"
import { extractSessionFilesGrouped } from "@/lib/agent/session-files"
import { unescapeComposerText } from "@/lib/agent/composer-copy-text"
import {
  allocateMessageNavigationOwner,
  useMessageNavigationStore,
} from "@/stores/message-navigation-store"

interface MessageListViewProps {
  conversationId: number
  isActive?: boolean
  detailLoading?: boolean
  detailError?: string | null
  hideEmptyState?: boolean
  onReload?: () => void
  onNewSession?: () => void
  /**
   * Publishes the per-conversation message navigator data. Enabled in the main
   * conversation view; disabled in compact embeds (e.g. the sub-agent dialog).
   */
  showMessageNav?: boolean
  /**
   * Allows a parent-owned viewer to publish navigation data with a stable
   * owner. This keeps compact or inactive viewers from replacing the active
   * conversation's snapshot.
   */
  messageNavigationOwner?: number
  /** Whether this instance is currently allowed to publish its snapshot. */
  messageNavigationActive?: boolean
}

export interface ResolvedMessageGroup {
  id: string
  role: "user" | "assistant" | "system"
  parts: AdaptedContentPart[]
  resources: UserResourceDisplay[]
  images: UserImageDisplay[]
  usage?: import("@/lib/types").TurnUsage | null
  duration_ms?: number | null
  model?: string | null
  models?: string[]
  /**
   * Wall-clock completion time supplied by the Rust parser. For merged
   * sub-turns this is the latest non-null completion across the run — the
   * post-turn metadata patch may sit on any sub-turn, not just the last.
   */
  completed_at?: string | null
}

export type ThreadRenderItem = {
  key: string
  kind: "turn"
  group: ResolvedMessageGroup
  showStats: boolean
  isRoleTransition: boolean
  previousUserIndex: number | null
  /** Raw assistant sub-turn(s) that compose this reply — fed to the
   *  per-reply artifacts card so it can list files changed this reply. */
  sourceTurns: MessageTurn[]
}

// Module-scope so the reference is stable across renders — lets the memoized
// VirtualizedMessageThread bail out when `items` is unchanged.
const getThreadItemKey = (item: ThreadRenderItem) => item.key

// Stable empty reference so the navigator memo / equality checks don't churn
// when a conversation has no user messages.
const EMPTY_NAV_ENTRIES: MessageNavEntry[] = []

// A single turn's `sourceTurns` is just `[turn]`. Cache the wrapper per turn
// object so an unchanged turn keeps a stable `sourceTurns` reference and
// `HistoricalMessageGroup`'s memo can bail out.
const sourceTurnsSingletonCache = new WeakMap<MessageTurn, MessageTurn[]>()
export function singletonSourceTurns(turn: MessageTurn): MessageTurn[] {
  let cached = sourceTurnsSingletonCache.get(turn)
  if (!cached) {
    cached = [turn]
    sourceTurnsSingletonCache.set(turn, cached)
  }
  return cached
}

const CollapsibleSystemMessage = memo(function CollapsibleSystemMessage({
  group,
}: {
  group: ResolvedMessageGroup
}) {
  const [expanded, setExpanded] = useState(false)
  const t = useTranslations("Folder.chat.messageList")

  return (
    <div className="border rounded-md text-sm border-yellow-500/30 bg-yellow-500/5">
      <button
        onClick={() => setExpanded(!expanded)}
        className="flex items-center gap-2 w-full px-3 py-2.5 text-left hover:bg-yellow-500/10 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-yellow-600 dark:text-yellow-500" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-yellow-600 dark:text-yellow-500" />
        )}
        <Info className="h-3.5 w-3.5 shrink-0 text-yellow-600 dark:text-yellow-500" />
        <span className="font-medium text-yellow-700 dark:text-yellow-400">
          {t("systemMessage")}
        </span>
      </button>
      {expanded && (
        <div className="px-3 pb-3 border-t border-yellow-500/20">
          <div className="text-sm text-muted-foreground mt-2.5 max-h-96 overflow-auto">
            <ContentPartsRenderer parts={group.parts} role={group.role} />
          </div>
        </div>
      )}
    </div>
  )
})

function extractTextFromParts(parts: AdaptedContentPart[]): string {
  return parts
    .flatMap((p): string[] => {
      if (p.type === "text") return [p.text]
      if (p.type === "goal-run") return [extractTextFromParts(p.items)]
      return []
    })
    .filter((text) => text.length > 0)
    .join("\n")
}

type AssistantTurnItem = Extract<ThreadRenderItem, { kind: "turn" }>

/**
 * Cache entry for one merged assistant run, keyed on the run's FIRST member
 * group. Valid only while every member's group reference and item key still
 * match: group identity flows through the per-turn adapter + group caches, so
 * member-group equality implies unchanged content AND sourceTurns, while the
 * keys embed phase/id/index so ordering or phase drift invalidates too. A run
 * containing the streaming turn misses every batch by construction (the
 * streaming turn re-adapts per batch) — that residual rebuild is the point;
 * purely historical runs hit and keep their group/parts/sourceTurns
 * references stable so HistoricalMessageGroup's memo bails out.
 */
export interface MergedAssistantRunCacheEntry {
  memberGroups: ResolvedMessageGroup[]
  memberKeys: string[]
  item: AssistantTurnItem
}
export type MergedAssistantRunCache = WeakMap<
  ResolvedMessageGroup,
  MergedAssistantRunCacheEntry
>

function isEmptyTurnItem(item: ThreadRenderItem): boolean {
  if (item.kind !== "turn") return false
  const g = item.group
  if (g.parts.length > 0) return false
  if (g.resources.length > 0) return false
  if (g.images.length > 0) return false
  return true
}

/**
 * Collapse runs of consecutive assistant turn render items into a single
 * synthetic turn so tool-groups straddling a turn boundary fold into one
 * collapsible. Empty (no-content) turn items are treated as transparent and
 * do not break the run — that handles cases where parsers leave empty
 * placeholder turns between tool exchanges.
 *
 * Exported for tests.
 */
export function mergeConsecutiveAssistantTurns(
  items: ThreadRenderItem[],
  mergeCache?: MergedAssistantRunCache
): ThreadRenderItem[] {
  const result: ThreadRenderItem[] = []
  const skipped: ThreadRenderItem[] = []
  let buffer: AssistantTurnItem[] = []

  // Push the cached merged item instead of rebuilding when the run's
  // membership (group references + item keys) is unchanged since last render.
  const reuseCachedMergedRun = (): boolean => {
    if (!mergeCache) return false
    const cached = mergeCache.get(buffer[0].group)
    if (!cached || cached.memberGroups.length !== buffer.length) return false
    for (let i = 0; i < buffer.length; i++) {
      if (
        buffer[i].group !== cached.memberGroups[i] ||
        buffer[i].key !== cached.memberKeys[i]
      ) {
        return false
      }
    }
    result.push(cached.item)
    return true
  }

  const flush = () => {
    if (buffer.length === 0) {
      // Drain any skipped (empty) items collected since last flush
      for (const s of skipped) result.push(s)
      skipped.length = 0
      return
    }

    if (buffer.length === 1) {
      result.push(buffer[0])
    } else if (reuseCachedMergedRun()) {
      // Reused — nothing to rebuild.
    } else {
      const allParts = buffer.flatMap((it) => it.group.parts)
      // Fold tool-groups straddling the turn boundary, then collapse runs of
      // single-poll delegation-status and background-task groups (each polling
      // round is its own turn) into one merged card.
      const mergedParts = groupGoalRuns(
        mergeAdjacentBackgroundTaskGroups(
          mergeAdjacentDelegationStatusGroups(mergeAdjacentToolGroups(allParts))
        )
      )
      const last = buffer[buffer.length - 1]
      const first = buffer[0]

      // Aggregate stats across the merged sub-turns so the post-stream
      // stats row reflects the whole assistant response, not just the
      // last sub-turn. Without this, multi-turn agents (Task tool, codex
      // agent loops, etc.) would visibly under-report tokens.
      let mergedUsage: import("@/lib/types").TurnUsage | null = null
      let mergedDuration: number | null = null
      // Post-turn metadata may land on ANY sub-turn (Cursor's reparse patches
      // the FIRST local sub-turn when the parser emits fewer turns than the
      // live stream split into), so the merged completion time is the latest
      // non-null across the run — not whatever the last sub-turn happens to
      // carry.
      let mergedCompletedAt: string | null = null
      const seenModels = new Set<string>()
      const mergedModels: string[] = []
      for (const it of buffer) {
        if (it.group.completed_at) {
          mergedCompletedAt = it.group.completed_at
        }
        const u = it.group.usage
        if (u) {
          if (!mergedUsage) {
            mergedUsage = {
              input_tokens: u.input_tokens,
              output_tokens: u.output_tokens,
              cache_creation_input_tokens: u.cache_creation_input_tokens,
              cache_read_input_tokens: u.cache_read_input_tokens,
            }
          } else {
            mergedUsage.input_tokens += u.input_tokens
            mergedUsage.output_tokens += u.output_tokens
            mergedUsage.cache_creation_input_tokens +=
              u.cache_creation_input_tokens
            mergedUsage.cache_read_input_tokens += u.cache_read_input_tokens
          }
        }
        if (typeof it.group.duration_ms === "number") {
          mergedDuration = (mergedDuration ?? 0) + it.group.duration_ms
        }
        if (it.group.model && !seenModels.has(it.group.model)) {
          seenModels.add(it.group.model)
          mergedModels.push(it.group.model)
        }
      }

      const merged: AssistantTurnItem = {
        ...last,
        key: `merged-${first.key}`,
        // Concatenate every sub-turn's raw turns so the artifacts card sees all
        // file edits across the merged reply, not just the last sub-turn.
        sourceTurns: buffer.flatMap((b) => b.sourceTurns),
        group: {
          ...last.group,
          id: first.group.id,
          parts: mergedParts,
          usage: mergedUsage,
          duration_ms: mergedDuration,
          model: mergedModels[0] ?? last.group.model,
          models: mergedModels.length > 1 ? mergedModels : undefined,
          completed_at: mergedCompletedAt,
        },
      }
      result.push(merged)
      mergeCache?.set(first.group, {
        memberGroups: buffer.map((it) => it.group),
        memberKeys: buffer.map((it) => it.key),
        item: merged,
      })
    }

    // Drop any empty items that were collapsed inside the run
    skipped.length = 0
    buffer = []
  }

  for (const item of items) {
    if (item.kind === "turn" && item.group.role === "assistant") {
      // Flush any leading skipped (empty non-assistant) items before starting
      // a fresh assistant run. This keeps non-assistant placeholders in their
      // original relative order when no merging happens.
      if (buffer.length === 0) {
        for (const s of skipped) result.push(s)
        skipped.length = 0
      }
      buffer.push(item)
      continue
    }

    if (buffer.length > 0 && isEmptyTurnItem(item)) {
      // Transparent: don't break the run, but track in case we end up not
      // merging (single-buffer case still drops them as they're invisible).
      skipped.push(item)
      continue
    }

    flush()
    result.push(item)
  }
  flush()

  return result
}

const UserMessageCopyButton = memo(function UserMessageCopyButton({
  parts,
}: {
  parts: AdaptedContentPart[]
}) {
  const t = useTranslations("Folder.chat.messageList")
  const [isCopied, setIsCopied] = useState(false)
  const timeoutRef = useRef<number>(0)

  const handleCopy = useCallback(async () => {
    if (isCopied) return
    // User text was Markdown-escaped by the composer on send (e.g. a Windows
    // path `C:\…` became `C:\\…`); the transcript renders it back through a
    // Markdown renderer, so the copy must reverse that escaping to match what
    // the user sees. Assistant copies (TurnStats below) keep the raw Markdown.
    const text = unescapeComposerText(extractTextFromParts(parts))
    if (!text) return
    const ok = await copyTextToClipboard(text)
    if (!ok) return
    setIsCopied(true)
    timeoutRef.current = window.setTimeout(() => setIsCopied(false), 2000)
  }, [parts, isCopied])

  useEffect(
    () => () => {
      window.clearTimeout(timeoutRef.current)
    },
    []
  )

  return (
    <MessageAction
      tooltip={isCopied ? t("copied") : t("copyMessage")}
      className="opacity-0 group-hover/user-msg:opacity-100 transition-opacity self-end"
      onClick={handleCopy}
      size="icon-xs"
    >
      {isCopied ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
    </MessageAction>
  )
})

const HistoricalMessageGroup = memo(function HistoricalMessageGroup({
  group,
  showStats = true,
  previousUserIndex = null,
  sourceTurns,
}: {
  group: ResolvedMessageGroup
  showStats?: boolean
  previousUserIndex?: number | null
  sourceTurns?: MessageTurn[]
}) {
  if (group.role === "system") {
    return <CollapsibleSystemMessage group={group} />
  }

  return (
    <div>
      <Message from={group.role}>
        {group.role === "user" && group.images.length > 0 ? (
          <UserImageAttachments images={group.images} className="self-end" />
        ) : null}
        {group.role === "user" ? (
          <div className="group/user-msg flex w-fit ml-auto max-w-full items-start gap-1">
            <UserMessageCopyButton parts={group.parts} />
            <MessageContent>
              <CollapsibleUserMessage parts={group.parts} />
            </MessageContent>
          </div>
        ) : (
          <MessageContent>
            <ContentPartsRenderer parts={group.parts} role={group.role} />
          </MessageContent>
        )}
        {group.role === "user" && group.resources.length > 0 ? (
          <UserResourceLinks resources={group.resources} className="self-end" />
        ) : null}
      </Message>
      {showStats && group.role === "assistant" && sourceTurns && (
        <ReplyArtifacts sourceTurns={sourceTurns} />
      )}
      {showStats && group.role === "assistant" && (
        <TurnStats
          usage={group.usage}
          duration_ms={group.duration_ms}
          model={group.model}
          models={group.models}
          previousUserIndex={previousUserIndex}
          copyText={extractTextFromParts(group.parts)}
          completedAt={group.completed_at}
        />
      )}
    </div>
  )
})

export function MessageListView({
  conversationId,
  isActive = true,
  detailLoading = false,
  detailError = null,
  hideEmptyState = false,
  onReload,
  onNewSession,
  showMessageNav = true,
  messageNavigationOwner,
  messageNavigationActive,
}: MessageListViewProps) {
  const t = useTranslations("Folder.chat.messageList")
  const sharedT = useTranslations("Folder.chat.shared")
  // The timeline selector returns a reference-stable array (memoized per
  // session object), so other conversations' updates are inert here.
  const timelineTurns = useConversationRuntimeStore((s) =>
    selectTimelineTurns(s, conversationId)
  )

  const shouldUseSmoothResize = !(
    isActive &&
    !detailLoading &&
    timelineTurns.length
  )

  const adapterText = useMemo(
    () => ({
      attachedResources: sharedT("attachedResources"),
      toolCallFailed: sharedT("toolCallFailed"),
    }),
    [sharedT]
  )

  // Per-instance turn adapter: caches per-turn `AdaptedMessage` so unchanged
  // turns keep stable refs across re-renders.
  const [turnAdapter] = useState<MessageTurnAdapter>(() =>
    createMessageTurnAdapter()
  )

  // Sibling cache mapping each cached `AdaptedMessage` to its derived
  // `ResolvedMessageGroup`, so `HistoricalMessageGroup`'s `memo` can short-
  // circuit on prop reference equality.
  const [groupCache] = useState<WeakMap<AdaptedMessage, ResolvedMessageGroup>>(
    () => new WeakMap()
  )

  // Reuses merged multi-sub-turn assistant items across re-renders — see
  // MergedAssistantRunCacheEntry for the validity contract.
  const [mergedRunCache] = useState<MergedAssistantRunCache>(
    () => new WeakMap()
  )

  const { threadItems, allAdapted } = useMemo(() => {
    const allTurns = timelineTurns.map((item) => item.turn)
    const allAdapted = turnAdapter.adapt(allTurns, adapterText)

    // Map each adapted message directly to a render item (1:1).
    // Backend group_into_turns() already ensures each turn is a complete unit.
    const rawItems: ThreadRenderItem[] = allAdapted.map((msg, i) => {
      const role = msg.role === "tool" ? "assistant" : msg.role
      let group = groupCache.get(msg)
      if (!group) {
        group = {
          id: msg.id,
          role,
          parts: msg.content,
          resources: msg.userResources ?? [],
          images: msg.userImages ?? [],
          usage: msg.usage,
          duration_ms: msg.duration_ms,
          model: msg.model,
          completed_at: msg.completed_at,
        }
        groupCache.set(msg, group)
      }
      return {
        key: `${msg.id}-${i}`,
        kind: "turn" as const,
        group,
        showStats: false,
        isRoleTransition: false,
        previousUserIndex: null,
        sourceTurns: singletonSourceTurns(allTurns[i]),
      }
    })

    // Collapse consecutive assistant turn render items into a single rendered
    // turn, so tool-groups straddling a turn boundary fold into one collapsible.
    const items = mergeConsecutiveAssistantTurns(rawItems, mergedRunCache)

    // Compute showStats, isRoleTransition, and previousUserIndex for each turn.
    // previousUserIndex points at the closest preceding user turn (used by the
    // post-stream stats row's "jump to previous user message" button).
    let lastUserIdx: number | null = null
    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx]
      if (item.kind !== "turn") continue

      // Reset before recomputing: a cached merged item carries last render's
      // values and the conditions below only ever assign `true`.
      item.showStats = false
      item.isRoleTransition = false
      item.previousUserIndex = null

      // isRoleTransition: role differs from previous turn item
      if (idx > 0) {
        const prev = items[idx - 1]
        if (prev.kind === "turn" && prev.group.role !== item.group.role) {
          item.isRoleTransition = true
        }
      }

      if (item.group.role === "user") {
        lastUserIdx = idx
      }

      // showStats: only on the last assistant turn before a non-assistant or end
      if (item.group.role === "assistant") {
        const next = items[idx + 1]
        if (!next || next.kind !== "turn" || next.group.role !== "assistant") {
          item.showStats = true
          item.previousUserIndex = lastUserIdx
        }
      }
    }

    return { threadItems: items, allAdapted }
  }, [adapterText, timelineTurns, turnAdapter, groupCache, mergedRunCache])

  const historicalPlanEntries = useMemo(
    () => extractLatestPlanEntriesFromMessages(allAdapted),
    [allAdapted]
  )
  const historicalPlanKey = useMemo(
    () => buildPlanKey(historicalPlanEntries),
    [historicalPlanEntries]
  )

  const renderThreadItem = useCallback((item: ThreadRenderItem) => {
    switch (item.kind) {
      case "turn": {
        const pt = item.isRoleTransition ? 16 : 0
        return (
          <div style={pt > 0 ? { paddingTop: pt } : undefined}>
            <HistoricalMessageGroup
              group={item.group}
              showStats={item.showStats}
              previousUserIndex={item.previousUserIndex}
              sourceTurns={item.sourceTurns}
            />
          </div>
        )
      }
      default:
        return null
    }
  }, [])

  const emptyState = useMemo(
    () =>
      hideEmptyState ? null : (
        <div className="px-4 py-12 text-center">
          <p className="text-muted-foreground text-sm">
            {t("emptyConversation")}
          </p>
        </div>
      ),
    [hideEmptyState, t]
  )

  const agentPlanOverlayKey = `plan-history-${conversationId}`

  // --- Message navigator data -------------------------------------------------
  // Lifted scroll handle so the sidebar panel, which lives outside the
  // MessageScrollProvider subtree, can drive scrollToIndex.
  const scrollApiRef = useRef<MessageScrollContextValue | null>(null)
  const messageNavigationOpen = useMessageNavigationStore((state) => state.open)
  const [generatedNavigationOwner] = useState(() =>
    allocateMessageNavigationOwner()
  )
  const navigationOwner = messageNavigationOwner ?? generatedNavigationOwner
  const navigationActive = messageNavigationActive ?? isActive
  const navigationEnabled = showMessageNav && navigationActive

  // Cheap user-message tally — counts user turns without parsing file diffs.
  const userMessageCount = useMemo(() => {
    if (!navigationEnabled || !messageNavigationOpen) return 0
    let count = 0
    for (const item of threadItems) {
      if (item.kind === "turn" && item.group.role === "user") count += 1
    }
    return count
  }, [messageNavigationOpen, navigationEnabled, threadItems])

  // One entry per user message — including ones with no edits (placeholders).
  // Computed lazily: only while the panel is expanded, since
  // `extractSessionFilesGrouped` parses every turn's diffs. Collapsed (the
  // default) it stays EMPTY, keeping the streaming hot path free of diff parsing.
  const navEntries = useMemo<MessageNavEntry[]>(() => {
    if (!navigationEnabled || !messageNavigationOpen) return EMPTY_NAV_ENTRIES
    const turns = timelineTurns.map((item) => item.turn)
    const groups = extractSessionFilesGrouped(turns, { includeEmpty: true })
    if (groups.length === 0) return EMPTY_NAV_ENTRIES

    const indexByTurnId = new Map<string, number>()
    for (let i = 0; i < threadItems.length; i++) {
      const item = threadItems[i]
      if (item.kind === "turn" && item.group.role === "user") {
        indexByTurnId.set(item.group.id, i)
      }
    }

    const entries: MessageNavEntry[] = []
    for (const group of groups) {
      const threadIndex = indexByTurnId.get(group.userTurnId)
      if (threadIndex == null) continue
      let additions = 0
      let deletions = 0
      for (const file of group.files) {
        additions += file.additions
        deletions += file.deletions
      }
      entries.push({
        threadIndex,
        turnId: group.userTurnId,
        ordinal: entries.length + 1,
        label: group.userMessage,
        additions,
        deletions,
        files: group.files,
        hasChanges: group.files.length > 0,
      })
    }
    return entries.length > 0 ? entries : EMPTY_NAV_ENTRIES
  }, [messageNavigationOpen, navigationEnabled, timelineTurns, threadItems])

  const scrollToMessage = useCallback(
    (
      index: number,
      opts?: Parameters<MessageScrollContextValue["scrollToIndex"]>[1]
    ) => {
      scrollApiRef.current?.scrollToIndex(index, opts)
    },
    []
  )

  useEffect(() => {
    if (!navigationEnabled || !messageNavigationOpen || userMessageCount <= 0) {
      useMessageNavigationStore.getState().clear(navigationOwner)
      return
    }

    useMessageNavigationStore.getState().setSnapshot(navigationOwner, {
      count: userMessageCount,
      entries: navEntries,
      scrollToIndex: scrollToMessage,
    })
  }, [
    messageNavigationOpen,
    navEntries,
    navigationEnabled,
    navigationOwner,
    scrollToMessage,
    userMessageCount,
  ])

  useEffect(
    () => () => {
      useMessageNavigationStore.getState().clear(navigationOwner)
    },
    [navigationOwner]
  )

  const hasRenderableContent = threadItems.length > 0

  if (detailLoading && !hasRenderableContent) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          <span>{t("loading")}</span>
        </div>
      </div>
    )
  }

  const fallbackLoadError =
    detailError && !hasRenderableContent ? detailError : null
  const renderedLoadError = fallbackLoadError
  if (renderedLoadError) {
    const showActions = Boolean(onReload || onNewSession)
    const reloading = detailLoading
    return (
      <div role="alert" className="flex h-full items-center justify-center p-6">
        <div className="flex max-w-md flex-col items-center gap-4 text-center">
          <AlertCircle
            aria-hidden="true"
            className="h-8 w-8 text-destructive"
          />
          <div className="space-y-1">
            <h3 className="text-sm font-medium">{t("errorTitle")}</h3>
            <p className="text-sm text-muted-foreground break-words">
              {renderedLoadError}
            </p>
          </div>
          {showActions && (
            <div className="flex flex-wrap items-center justify-center gap-2">
              {onReload && (
                <Button
                  size="sm"
                  onClick={onReload}
                  disabled={reloading}
                  aria-busy={reloading}
                >
                  {reloading ? (
                    <Loader2
                      aria-hidden="true"
                      className="me-1.5 h-4 w-4 animate-spin"
                    />
                  ) : (
                    <RefreshCw aria-hidden="true" className="me-1.5 h-4 w-4" />
                  )}
                  {t("errorActionReload")}
                </Button>
              )}
              {onNewSession && (
                <Button size="sm" variant="outline" onClick={onNewSession}>
                  <Plus aria-hidden="true" className="me-1.5 h-4 w-4" />
                  {t("errorActionNewSession")}
                </Button>
              )}
            </div>
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex h-full min-h-0 flex-col">
      <MessageThread
        className="flex-1 min-h-0"
        resize={shouldUseSmoothResize ? "smooth" : undefined}
      >
        <VirtualizedMessageThread
          items={threadItems}
          getItemKey={getThreadItemKey}
          renderItem={renderThreadItem}
          emptyState={emptyState}
          scrollApiRef={scrollApiRef}
          scrollPersistenceKey={`berth:session-scroll:v1:${conversationId}`}
        />
        <MessageThreadScrollButton />
      </MessageThread>
      {/* Historical plan metadata is positioned outside the message flow. */}
      <div className="pointer-events-none absolute start-0 top-4 z-20 flex max-w-[min(22rem,calc(100%-2rem))] flex-col items-start gap-2">
        <AgentPlanOverlay
          key={agentPlanOverlayKey}
          entries={historicalPlanEntries}
          planKey={historicalPlanKey}
          defaultExpanded={false}
        />
      </div>
    </div>
  )
}
