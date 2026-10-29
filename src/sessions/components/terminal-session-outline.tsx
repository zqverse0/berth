"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { listProjectAgentSessions, resolveProjectAgentSession } from "@/lib/api"
import type { AgentType } from "@/lib/types"
import { TranscriptOutline } from "@/sessions/components/transcript-outline"
import { useTranscriptLiveSync } from "@/sessions/transcript-view-store"

// ponytail: 取该项目下此 Agent 最近更新的会话；同项目同时开多个同类 Agent 终端时
// 可能指向另一个，需要精确时由 launch.js 预分配会话 id 并记到终端标签上
const RESOLVE_INTERVAL_MS = 15_000

interface LatestSession {
  conversationId: number
  title: string
}

export async function resolveLatestSession(
  folderId: number,
  agentType: AgentType
): Promise<LatestSession | null> {
  const page = await listProjectAgentSessions({
    folderId,
    agentType,
    limit: 1,
    refresh: true,
  })
  const item = page.items[0]
  if (!item) return null
  let conversationId = item.conversationId
  if (conversationId == null && item.externalId) {
    const resolved = await resolveProjectAgentSession({
      folderId,
      agentType,
      externalId: item.externalId,
    })
    conversationId = resolved.conversation?.id ?? null
  }
  return conversationId == null
    ? null
    : { conversationId, title: item.title ?? String(conversationId) }
}

/** 焦点在 Agent 终端时：实时显示它正在进行的会话，并可一键在阅读区打开。 */
export function TerminalSessionOutline({
  folderId,
  agentType,
}: {
  folderId: number
  agentType: AgentType
}) {
  const t = useTranslations("Folder.sessionViewer")
  const { openTranscriptTab } = useWorkspaceRuntimeActions()
  const [session, setSession] = useState<LatestSession | null | undefined>()

  useEffect(() => {
    let cancelled = false
    const resolve = () =>
      resolveLatestSession(folderId, agentType).then(
        (next) => {
          if (cancelled) return
          setSession((current) =>
            current?.conversationId === next?.conversationId &&
            current?.title === next?.title
              ? current
              : next
          )
        },
        () => {
          if (!cancelled) setSession((current) => current ?? null)
        }
      )
    void resolve()
    const timer = setInterval(() => void resolve(), RESOLVE_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [folderId, agentType])

  useTranscriptLiveSync(session?.conversationId ?? 0, session != null)

  if (session === undefined) return null
  if (session === null) {
    return (
      <p className="p-6 text-center text-sm text-muted-foreground">
        {t("noTerminalSession")}
      </p>
    )
  }
  return (
    <TranscriptOutline
      key={session.conversationId}
      conversationId={session.conversationId}
      onOpen={() =>
        openTranscriptTab({
          folderId,
          conversationId: session.conversationId,
          agentType,
          title: session.title,
        })
      }
    />
  )
}
