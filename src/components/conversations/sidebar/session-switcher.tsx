"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { AgentIcon } from "@/components/agent-icon"
import { ColorTerminalIcon } from "@/components/layout/status-bar/status-bar-terminal"
import {
  CommandDialog,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import type { SidebarSession } from "./sidebar-sessions"

export interface SwitcherEntry {
  session: SidebarSession
  /** 所属项目（「项目 ⎇ 分支」），未归属为 null */
  project: string | null
  /** 所在工作区名，未归属为「未归属会话」 */
  group: string
}

/**
 * 会话切换器（`Ctrl+Space S`）：已按「最近用过 → 运行中 → 其余」排好，输入即按标题、项目、Agent、工作区搜，
 * 回车切换。
 */
export function SessionSwitcher({
  open,
  onOpenChange,
  entries,
  onSelect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  entries: readonly SwitcherEntry[]
  onSelect: (session: SidebarSession) => void
}) {
  const t = useTranslations("WorkspaceGroups")
  const [query, setQuery] = useState("")
  const q = query.trim().toLocaleLowerCase()
  const shown = q
    ? entries.filter((entry) =>
        [
          entry.session.title,
          entry.session.agentType,
          entry.project,
          entry.group,
        ].some((value) => value?.toLocaleLowerCase().includes(q))
      )
    : entries
  return (
    <CommandDialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setQuery("")
        onOpenChange(next)
      }}
      title={t("switcherTitle")}
      shouldFilter={false}
    >
      <CommandInput
        value={query}
        onValueChange={setQuery}
        placeholder={t("switcherPlaceholder")}
      />
      <CommandList>
        <CommandEmpty>{t("switcherEmpty")}</CommandEmpty>
        {shown.map(({ session, project, group }) => (
          <CommandItem
            key={session.id}
            value={session.id}
            onSelect={() => {
              setQuery("")
              onOpenChange(false)
              onSelect(session)
            }}
            className="flex items-center gap-2"
          >
            {session.agentType ? (
              <AgentIcon
                agentType={session.agentType}
                className="size-3.5 shrink-0"
              />
            ) : (
              <ColorTerminalIcon size={14} className="size-3.5 shrink-0" />
            )}
            <span className="min-w-0 flex-1 truncate">{session.title}</span>
            {session.dot === "attention" ? (
              <span className="shrink-0 text-xs text-amber-600 dark:text-amber-400">
                {t("attention")}
              </span>
            ) : null}
            <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">
              {[project, group].filter(Boolean).join(" · ")}
            </span>
          </CommandItem>
        ))}
      </CommandList>
    </CommandDialog>
  )
}
