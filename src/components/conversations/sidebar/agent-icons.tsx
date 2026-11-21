"use client"

import { memo } from "react"
import { useTranslations } from "next-intl"
import { AgentIcon } from "@/components/agent-icon"
import { StatusDot } from "@/components/ui/status-dot"
import type { SidebarSession } from "./sidebar-sessions"

/** 行尾最多显示几个 Agent，其余折成「+n」。 */
const MAX_ICONS = 4

/**
 * 成员行 / 折叠项目行行尾的 Agent 图标：工作中带慢闪绿点，需关注带黄点；点图标打开它的终端。
 * 只列 Agent，普通终端不进侧栏。
 */
export const AgentIcons = memo(function AgentIcons({
  sessions,
  onOpen,
}: {
  sessions: readonly SidebarSession[]
  onOpen: (session: SidebarSession) => void
}) {
  const t = useTranslations("SidebarSessions")
  const agents = sessions.filter((session) => session.agentType != null)
  if (agents.length === 0) return null
  const shown = agents.slice(0, MAX_ICONS)
  return (
    <span className="flex shrink-0 items-center gap-0.5 pl-1">
      {shown.map((session) => {
        const state =
          session.dot === "attention"
            ? t("attention")
            : session.dot === "working"
              ? t("working")
              : null
        const label = state ? `${session.title} · ${state}` : session.title
        return (
          <button
            key={session.id}
            type="button"
            data-agent-session={session.id}
            onClick={(event) => {
              event.stopPropagation()
              onOpen(session)
            }}
            title={
              session.notification ? `${label}\n${session.notification}` : label
            }
            aria-label={label}
            className="relative flex size-5 items-center justify-center rounded hover:bg-accent"
          >
            <AgentIcon agentType={session.agentType!} className="size-3.5" />
            {session.dot ? (
              <StatusDot kind={session.dot} className="-right-0.5 -top-0.5" />
            ) : null}
          </button>
        )
      })}
      {agents.length > shown.length ? (
        <span className="text-[0.6875rem] text-muted-foreground tabular-nums">
          +{agents.length - shown.length}
        </span>
      ) : null}
    </span>
  )
})
