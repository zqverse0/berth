"use client"

import { lazy, Suspense, useMemo } from "react"
import { useTranslations } from "next-intl"
import type { AgentType } from "@/lib/types"
import { useTabStore } from "@/contexts/tab-context"
import { useConversationRuntimeStore } from "@/stores/conversation-runtime-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { resolveActiveSessionDetails } from "@/components/conversations/active-session-details"
import { SessionDetailsContent } from "@/components/conversations/session-details-content"
import { ScrollArea } from "@/components/ui/scroll-area"
import { useAppUiStore } from "@/stores/app-ui-store"
import { isConversationTab } from "@/lib/workspace/primary-tabs"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store"

const LazyTranscriptOutline = lazy(() =>
  import("@/sessions/components/transcript-outline").then((m) => ({
    default: m.TranscriptOutline,
  }))
)
const LazyTerminalSessionOutline = lazy(() =>
  import("@/sessions/components/terminal-session-outline").then((m) => ({
    default: m.TerminalSessionOutline,
  }))
)

/** 焦点标签对应的会话标题（会话阅读标签、Agent 终端或旧对话标签），没有为 null。 */
export function useFocusedSessionTitle(): string | null {
  const activeRef = useWorkspaceLayoutStore((state) => state.activeWorkspaceTab)
  const fileTitle = useWorkspaceFileStore((state) => {
    if (activeRef?.kind !== "file") return null
    const tab = state.fileTabs.find((item) => item.id === activeRef.id)
    return tab?.kind === "transcript" ? tab.title : null
  })
  const primaryTitle = useTabStore((state) => {
    if (activeRef?.kind !== "primary") return null
    const tab = state.tabs.find((item) => item.id === activeRef.id)
    if (tab?.kind === "terminal")
      return tab.agentType && tab.folderId != null ? tab.title : null
    return tab && isConversationTab(tab) && tab.conversationId != null
      ? tab.title
      : null
  })
  return fileTitle ?? primaryTitle
}

/**
 * Shared Session Details view. It shows the active conversation's metadata and
 * token usage (via the shared `SessionDetailsContent`). The fallback aux-panel
 * tab renders the details body without sidebar tools.
 *
 * Details are resolved from live runtime state exactly the way the conversation
 * detail panel does it (`resolveActiveSessionDetails`), so no network fetch is
 * needed for the focused session.
 */
export function SessionDetailsTab() {
  // 焦点标签决定面板内容：会话文件 → 该会话的阅读导航；Agent 终端 → 它正在
  // 进行的会话（实时）。选择器只返回字符串，避免每次渲染分配新对象。
  const activeRef = useWorkspaceLayoutStore((state) => state.activeWorkspaceTab)
  const transcriptId = useWorkspaceFileStore((state) => {
    if (activeRef?.kind !== "file") return null
    const tab = state.fileTabs.find((item) => item.id === activeRef.id)
    return tab?.kind === "transcript" ? tab.conversationId : null
  })
  const terminalKey = useTabStore((state) => {
    if (activeRef?.kind !== "primary") return null
    const tab = state.tabs.find((item) => item.id === activeRef.id)
    return tab?.kind === "terminal" && tab.agentType && tab.folderId != null
      ? `${tab.folderId}:${tab.agentType}`
      : null
  })

  let body = null
  if (transcriptId != null) {
    body = (
      <LazyTranscriptOutline key={transcriptId} conversationId={transcriptId} />
    )
  } else if (terminalKey != null) {
    const [folderId, agentType] = terminalKey.split(":")
    body = (
      <LazyTerminalSessionOutline
        key={terminalKey}
        folderId={Number(folderId)}
        agentType={agentType as AgentType}
      />
    )
  }
  if (!body) return <ConversationSessionDetails />
  return (
    <div
      data-testid="session-details-tab"
      className="flex h-full min-h-0 w-full min-w-0 flex-1 flex-col overflow-hidden"
    >
      <Suspense fallback={null}>{body}</Suspense>
    </div>
  )
}

/** 旧对话标签（conversation tab）的会话元信息。 */
function ConversationSessionDetails() {
  const t = useTranslations("Folder.sessionDetails")
  // Mounted only in the sidebar's session-details view; active while shown.
  const isOpen = useAppUiStore((state) => state.sidebarOpen)

  // Select stable array identity; filter outside the selector (getSnapshot must
  // not allocate or React #185 fires).
  const allPrimaryTabs = useTabStore((s) => s.tabs)
  const tabs = useMemo(
    () => allPrimaryTabs.filter(isConversationTab),
    [allPrimaryTabs]
  )
  const activeTabId = useTabStore((s) => s.activeTabId)
  const activeConversationTab = useMemo(
    () =>
      tabs.find(
        (tab) => tab.id === activeTabId && tab.conversationId != null
      ) ?? null,
    [tabs, activeTabId]
  )

  // A brand-new conversation streams under its virtual `runtimeConversationId`
  // until it reconciles; key the live-session lookup on it first (mirrors the
  // detail panel, exercised by active-session-details.test.ts).
  const activeRuntimeId =
    activeConversationTab?.runtimeConversationId ??
    activeConversationTab?.conversationId ??
    null
  const detail = useConversationRuntimeStore((s) =>
    activeRuntimeId != null
      ? (s.byConversationId.get(activeRuntimeId)?.detail ?? null)
      : null
  )
  const conversations = useAppWorkspaceStore((s) => s.conversations)
  const { summary, stats, model } = resolveActiveSessionDetails(
    activeConversationTab,
    (id) => (id === activeRuntimeId ? { detail } : null),
    conversations
  )

  return (
    <div
      data-testid="session-details-tab"
      className="flex h-full min-h-0 min-w-0 w-full flex-1 flex-col overflow-hidden"
    >
      {summary ? (
        <ScrollArea className="min-h-0 min-w-0 w-full flex-1">
          <div className="min-w-0 w-full p-3">
            <SessionDetailsContent
              summary={summary}
              stats={stats}
              model={model}
              active={isOpen}
            />
          </div>
        </ScrollArea>
      ) : (
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-center text-sm text-muted-foreground">
          {t("noActiveSession")}
        </div>
      )}
    </div>
  )
}
