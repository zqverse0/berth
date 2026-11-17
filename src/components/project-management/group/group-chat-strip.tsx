"use client"

import { useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { ChevronLeft, Plus, Users } from "lucide-react"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { memberAgent, memberLabel } from "@/lib/agent/berth-group"
import { cn } from "@/lib/utils"
import type { MemberRow } from "./group-model"
import { MemberDot } from "./group-members"
import { MemberAvatar } from "./group-timeline"

/**
 * 群页顶部的会话切换：点成员就是和它单聊（收件人跟着切），右端「全部」是群聊。
 * 状态点即成员当前状态；手机上横向滑动。
 */
export function GroupChatStrip({
  rows,
  focus,
  onFocus,
  addable = [],
  addForm,
}: {
  rows: readonly MemberRow[]
  /** 单聊的成员；null 为群聊。 */
  focus: string | null
  onFocus: (member: string | null) => void
  /** 能以 ACP 成员入群的 Agent（tool.json 声明 `agent.acp`）。 */
  addable?: readonly { id: string; name: string }[]
  /** 选中 Agent 后的入群表单（启动栏：专家、服务商、模型…）；`close` 收起弹层。 */
  addForm?: (agent: string, close: () => void) => ReactNode
}) {
  const t = useTranslations("BerthTasks.group")
  const [adding, setAdding] = useState(false)
  const [agent, setAgent] = useState<string | null>(null)
  const chip =
    "flex h-8 shrink-0 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors"
  const picked = "border-primary/50 bg-primary/10 font-medium text-foreground"
  const idle =
    "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground"
  return (
    <div
      data-group-chats
      role="tablist"
      className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-border/50 px-2 py-1.5"
    >
      {/* 内置的 Berth 排最前（打开群默认和它单聊）。 */}
      {[...rows]
        .sort((a, b) => Number(!!b.member.builtin) - Number(!!a.member.builtin))
        .map((row) => {
          const name = row.member.name
          const selected = focus === name
          return (
            <button
              key={name}
              type="button"
              role="tab"
              aria-selected={selected}
              data-chat={name}
              className={cn(
                chip,
                selected ? picked : idle,
                row.unread && "ring-1 ring-amber-500/60"
              )}
              onClick={() => onFocus(name)}
            >
              <span className="relative">
                <MemberAvatar
                  agent={memberAgent(row.member)}
                  name={name}
                  className="size-5 rounded-full [&_svg]:size-3"
                />
                <MemberDot
                  status={row.status}
                  className="absolute -bottom-0.5 -right-0.5 size-2 ring-2 ring-background"
                />
              </span>
              <span className="max-w-24 truncate">
                {memberLabel(row.member)}
              </span>
            </button>
          )
        })}
      {addForm ? (
        <Popover
          open={adding}
          onOpenChange={(open) => {
            setAdding(open)
            if (!open) setAgent(null)
          }}
        >
          <PopoverTrigger asChild>
            <button
              type="button"
              data-group-add
              aria-label={t("add.title")}
              title={t("add.title")}
              className={cn(chip, idle, "px-2")}
            >
              <Plus aria-hidden="true" className="size-3.5" />
            </button>
          </PopoverTrigger>
          <PopoverContent align="start" className="w-72 p-2">
            {agent ? (
              <div className="flex flex-col gap-2">
                <button
                  type="button"
                  className="flex items-center gap-1 self-start rounded px-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
                  onClick={() => setAgent(null)}
                >
                  <ChevronLeft aria-hidden="true" className="size-3.5" />
                  {addable.find((item) => item.id === agent)?.name ?? agent}
                </button>
                {addForm(agent, () => {
                  setAdding(false)
                  setAgent(null)
                })}
              </div>
            ) : (
              <div className="flex flex-col">
                <span className="px-2 py-1 text-xs text-muted-foreground">
                  {addable.length ? t("add.title") : t("add.empty")}
                </span>
                {addable.map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    data-group-add-agent={item.id}
                    className="flex items-center gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-accent"
                    onClick={() => setAgent(item.id)}
                  >
                    <MemberAvatar
                      agent={item.id}
                      name={item.id}
                      className="size-5 rounded-full [&_svg]:size-3"
                    />
                    {item.name}
                  </button>
                ))}
              </div>
            )}
          </PopoverContent>
        </Popover>
      ) : null}
      <button
        type="button"
        role="tab"
        aria-selected={focus == null}
        data-chat="all"
        className={cn(chip, "ml-auto", focus == null ? picked : idle)}
        onClick={() => onFocus(null)}
      >
        <Users aria-hidden="true" className="size-3.5" />
        {t("chat.all")}
      </button>
    </div>
  )
}
