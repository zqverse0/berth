"use client"

import { useFormatter, useNow, useTranslations } from "next-intl"
import { type GroupEvent } from "@/lib/agent/berth-group"
import { type ProgressOf } from "./group-model"
import { ProgressBadge } from "./group-timeline"

/** 进行中的委托：谁交给谁、什么事、多久了；点击看收件人的相关消息。 */
export function ActiveDelegations({
  events,
  progressOf,
  labelOf,
  onSelect,
}: {
  events: readonly GroupEvent[]
  progressOf: ProgressOf
  labelOf: (name: string) => string
  onSelect: (event: GroupEvent) => void
}) {
  const t = useTranslations("BerthTasks.group.members")
  const format = useFormatter()
  const now = useNow({ updateInterval: 30_000 })
  if (events.length === 0)
    return (
      <p className="px-2 text-[11px] text-muted-foreground">
        {t("noDelegations")}
      </p>
    )
  return (
    <div className="space-y-0.5">
      {events.map((event) => (
        <button
          key={event.seq}
          type="button"
          data-active-delegation={event.seq}
          className="block w-full min-w-0 rounded-md px-2 py-1.5 text-left hover:bg-accent/40"
          onClick={() => onSelect(event)}
        >
          <span className="flex items-center gap-1.5 text-[11px]">
            <span className="truncate">
              {labelOf(event.author ?? "?")} →{" "}
              <span className="font-medium text-primary">
                @{labelOf(event.to ?? "?")}
              </span>
            </span>
            <ProgressBadge seq={event.seq} progressOf={progressOf} />
            <span className="ml-auto shrink-0 text-muted-foreground/80">
              {format.relativeTime(
                new Date(Math.min(event.timestamp_ms, now.getTime())),
                now
              )}
            </span>
          </span>
          <span className="block truncate text-xs text-muted-foreground">
            {event.text}
          </span>
        </button>
      ))}
    </div>
  )
}
