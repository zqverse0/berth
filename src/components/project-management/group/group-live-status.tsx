"use client"

import { useTranslations } from "next-intl"
import { AlertTriangle, SquareTerminal } from "lucide-react"
import { memberAgent, memberLabel } from "@/lib/agent/berth-group"
import type { MemberRow } from "./group-model"
import { MemberAvatar } from "./group-timeline"

/**
 * 输入框上方：只列停下来等你的成员（授权 / 选择，附它的提示，一键到终端）。
 * 处理中、排队看成员条的状态点和提问下的进度，这里不重复；没有就不占位置。
 */
export function GroupLiveStatus({
  rows,
  onOpenTerminal,
}: {
  rows: readonly MemberRow[]
  onOpenTerminal: (row: MemberRow) => void
}) {
  const t = useTranslations("BerthTasks.group.live")
  const waiting = rows.filter((row) => row.status === "attention")
  if (waiting.length === 0) return null
  return (
    <div
      data-group-live
      aria-live="polite"
      className="shrink-0 space-y-0.5 border-t border-border/50 px-3 py-1.5"
    >
      {waiting.map((row) => {
        const name = row.member.name
        const notice = row.pane?.descriptor.agentSignal?.notification
        return (
          <div
            key={name}
            data-live-member={name}
            data-live-state={row.status}
            className="flex h-7 items-center gap-2 rounded-md bg-amber-500/10 px-1.5 text-xs"
          >
            <MemberAvatar
              agent={row.body?.agent ?? memberAgent(row.member)}
              name={name}
              className="size-5 rounded-full [&_svg]:size-3"
            />
            <span className="shrink-0 font-medium">
              {memberLabel(row.member)}
            </span>
            <span className="flex min-w-0 items-center gap-1 text-amber-700 dark:text-amber-400">
              <AlertTriangle aria-hidden="true" className="size-3 shrink-0" />
              <span className="truncate">{notice || t("attention")}</span>
            </span>
            {row.pane ? (
              <button
                type="button"
                className="ml-auto flex h-6 shrink-0 items-center gap-1 rounded bg-amber-500/15 px-1.5 text-amber-800 hover:bg-amber-500/25 dark:text-amber-300"
                onClick={() => onOpenTerminal(row)}
              >
                <SquareTerminal aria-hidden="true" className="size-3.5" />
                {t("handle")}
              </button>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
