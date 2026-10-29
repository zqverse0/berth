"use client"

import dynamic from "next/dynamic"
import type { DbConversationDetail } from "@/lib/types"

const SessionAnalysisView = dynamic(
  () =>
    import("@/sessions/components/session-analysis-view").then(
      (module) => module.SessionAnalysisView
    ),
  { ssr: false }
)
const MessageListView = dynamic(
  () =>
    import("@/components/message/thread/message-list-view").then(
      (module) => module.MessageListView
    ),
  { ssr: false }
)

type SessionDetail = Pick<DbConversationDetail, "turns">

interface SessionViewSurfaceProps {
  conversationId: number
  detail: SessionDetail | null
  isActive: boolean
  detailLoading: boolean
  detailError: string | null
  hasPersistedConversation: boolean
  onReload?: () => void
  onNewSession?: () => void
  showMessageNav?: boolean
}

/** 会话正文入口。已加载的详情直接渲染 turns，不走 runtime store。 */
export function SessionViewSurface({
  conversationId,
  detail,
  isActive,
  detailLoading,
  detailError,
  hasPersistedConversation,
  onReload,
  onNewSession,
  showMessageNav = true,
}: SessionViewSurfaceProps) {
  const canShowContent = isActive && hasPersistedConversation && detail != null

  return (
    <div className="relative flex h-full min-h-0 flex-col bg-background ws-transparent-bg">
      <div className="min-h-0 flex-1">
        {canShowContent && detail != null ? (
          <SessionAnalysisView
            conversationId={conversationId}
            detail={detail}
          />
        ) : (
          <MessageListView
            conversationId={conversationId}
            isActive={isActive}
            detailLoading={detailLoading}
            detailError={detailError}
            hideEmptyState={!hasPersistedConversation}
            onReload={onReload}
            onNewSession={onNewSession}
            showMessageNav={showMessageNav}
          />
        )}
      </div>
    </div>
  )
}
