"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ShieldQuestion } from "lucide-react"
import { toast } from "@/lib/notify"
import {
  answerPermission,
  memberLabel,
  pendingPermissions,
  type GroupEvent,
  type GroupMember,
} from "@/lib/agent/berth-group"
import { cn } from "@/lib/utils"

/**
 * 输入框上方的审批卡片：ACP 成员要执行工具前的 `request_permission`，选项原样来自 Agent；
 * 不应答就一直等。应答后由运行时回给 Agent，下一次读群时卡片消失。
 */
export function GroupPermissions({
  folderId,
  group,
  events,
  members,
  onAnswered,
}: {
  folderId: number
  group: string
  events: readonly GroupEvent[]
  members: readonly GroupMember[]
  onAnswered: () => void
}) {
  const t = useTranslations("BerthTasks.group.permission")
  const [busy, setBusy] = useState<number | null>(null)
  const pending = pendingPermissions(events)
  if (pending.length === 0) return null
  const answer = async (request: number, option?: string) => {
    setBusy(request)
    const response = await answerPermission(
      folderId,
      group,
      request,
      option
    ).catch((cause: unknown) => ({
      ok: false as const,
      error: { message: String(cause) },
    }))
    if (!response.ok) toast.error(response.error.message)
    setBusy(null)
    onAnswered()
  }
  return (
    <div
      data-group-permissions
      aria-live="polite"
      className="shrink-0 space-y-1 border-t border-border/50 px-3 py-1.5"
    >
      {pending.map((event) => {
        const member = members.find((m) => m.name === event.author)
        return (
          <div
            key={event.seq}
            data-permission={event.seq}
            className="space-y-1 rounded-md bg-amber-500/10 px-2 py-1.5 text-xs"
          >
            <div className="flex min-w-0 items-center gap-1.5">
              <ShieldQuestion
                aria-hidden="true"
                className="size-3.5 shrink-0 text-amber-700 dark:text-amber-400"
              />
              <span className="shrink-0 font-medium">
                {memberLabel(member ?? { name: event.author ?? "?" })}
              </span>
              <span className="truncate">{event.text || t("title")}</span>
            </div>
            {event.input != null ? (
              <pre className="max-h-24 overflow-auto rounded bg-background/60 px-1.5 py-1 font-mono text-[11px] whitespace-pre-wrap text-muted-foreground">
                {inputText(event.input)}
              </pre>
            ) : null}
            <div className="flex flex-wrap gap-1">
              {(event.options ?? []).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  disabled={busy === event.seq}
                  data-permission-option={option.id}
                  className={cn(
                    "h-6 rounded px-2 disabled:opacity-50",
                    option.kind.startsWith("allow")
                      ? "bg-primary text-primary-foreground hover:bg-primary/90"
                      : "bg-background hover:bg-accent"
                  )}
                  onClick={() => void answer(event.seq, option.id)}
                >
                  {option.name}
                </button>
              ))}
              <button
                type="button"
                disabled={busy === event.seq}
                className="h-6 rounded px-2 text-muted-foreground hover:bg-accent disabled:opacity-50"
                onClick={() => void answer(event.seq)}
              >
                {t("cancel")}
              </button>
            </div>
          </div>
        )
      })}
    </div>
  )
}

/** 参数原文：字符串直接显示，对象里只有一段字符串（如 `ui.confirm` 的 message）就显示那段。 */
function inputText(input: unknown): string {
  if (typeof input === "string") return input
  if (input && typeof input === "object" && "message" in input) {
    const message = (input as { message: unknown }).message
    if (typeof message === "string") return message
  }
  return JSON.stringify(input, null, 2)
}
