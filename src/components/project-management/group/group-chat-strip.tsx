"use client"

import { useTranslations } from "next-intl"
import { Users } from "lucide-react"
import { memberAgent, memberLabel } from "@/lib/agent/berth-group"
import { cn } from "@/lib/utils"
import { addressable, type MemberRow } from "./group-model"
import { MEMBER_DOT } from "./group-members"
import { MemberAvatar } from "./group-timeline"

/**
 * 群页顶部的会话切换：点成员就是和它单聊（收件人跟着切），右端「全部」是群聊。
 * 状态点即成员当前状态；手机上横向滑动。
 */
export function GroupChatStrip({
  rows,
  focus,
  onFocus,
}: {
  rows: readonly MemberRow[]
  /** 单聊的成员；null 为群聊。 */
  focus: string | null
  onFocus: (member: string | null) => void
}) {
  const t = useTranslations("BerthTasks.group")
  const { present, offline } = addressable(rows)
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
      {[...present, ...offline]
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
                  agent={row.body?.agent ?? memberAgent(row.member)}
                  name={name}
                  className="size-5 rounded-full [&_svg]:size-3"
                />
                <span
                  aria-hidden="true"
                  className={cn(
                    "absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-background",
                    MEMBER_DOT[row.status]
                  )}
                />
              </span>
              <span className="max-w-24 truncate">
                {memberLabel(row.member)}
              </span>
            </button>
          )
        })}
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
