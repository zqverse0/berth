"use client"

import { memo, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { AgentIcon } from "@/components/agent-icon"
import { ColorTerminalIcon } from "@/components/layout/status-bar/status-bar-terminal"
import { StatusDot } from "@/components/ui/status-dot"
import type { PaneDot } from "@/lib/terminal/agent-panes"
import { cn } from "@/lib/utils"

/**
 * 侧栏一个会话一行：Agent 图标 + 标题 + 状态。需关注写字（不只靠颜色），工作中是绿色脉动点；
 * 当前 tab 左侧色条。`trailing` 放所属项目或设备标记。
 */
export const SessionRow = memo(function SessionRow({
  title,
  notification,
  agentType,
  dot,
  active,
  indent,
  trailing,
  onSelect,
}: {
  title: string
  notification?: string | null
  agentType: string | null
  dot: PaneDot
  active: boolean
  /** 左缩进（与项目名对齐） */
  indent: string
  trailing?: ReactNode
  onSelect: () => void
}) {
  const t = useTranslations("WorkspaceGroups")
  return (
    <button
      type="button"
      onClick={onSelect}
      title={notification ? `${title}\n${notification}` : title}
      aria-label={title}
      aria-current={active ? "true" : undefined}
      className={cn(
        "relative flex h-7 w-full min-w-0 items-center gap-2 rounded-md pr-2 text-left text-[0.8125rem] outline-none",
        "text-sidebar-foreground/85 hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        active && "bg-accent/40 text-sidebar-foreground"
      )}
      style={{ paddingLeft: indent }}
    >
      {active ? (
        <span
          aria-hidden
          className="absolute bottom-1 top-1 w-0.5 rounded-full bg-primary"
          style={{ left: `calc(${indent} - 0.5rem)` }}
        />
      ) : null}
      {agentType ? (
        <AgentIcon agentType={agentType} className="size-3.5 shrink-0" />
      ) : (
        <ColorTerminalIcon size={14} className="size-3.5 shrink-0" />
      )}
      <span className="min-w-0 flex-1 truncate">{title}</span>
      {trailing ? (
        <span className="min-w-0 max-w-[45%] shrink truncate text-xs text-muted-foreground">
          {trailing}
        </span>
      ) : null}
      {dot === "attention" ? (
        <span className="shrink-0 text-[0.6875rem] font-medium text-amber-600 dark:text-amber-400">
          {t("attention")}
        </span>
      ) : dot === "working" ? (
        <span className="relative size-2 shrink-0" aria-label={t("working")}>
          <StatusDot kind="working" className="inset-0" />
        </span>
      ) : null}
    </button>
  )
})
