"use client"

import { Search, X } from "lucide-react"
import { useTranslations } from "next-intl"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"
import type { ExchangeDetail, ProcessFilter } from "@/sessions/exchanges"
import {
  useTranscriptView,
  useTranscriptViewStore,
} from "@/sessions/transcript-view-store"
import { ClassifyPopover } from "./classify-popover"

const DETAILS: ExchangeDetail[] = ["prompts", "answers", "full"]

const pill =
  "h-7 shrink-0 rounded px-2 text-xs transition-colors hover:bg-primary/8 aria-pressed:bg-primary/10 aria-pressed:text-foreground"

/** 会话标签的工具栏：详细程度、显隐开关、当前收窄条件与搜索。 */
export function TranscriptToolbar({
  conversationId,
}: {
  conversationId: number
}) {
  const t = useTranslations("Folder.sessionViewer")
  const tSessions = useTranslations("Folder.sessionsView")
  const { level, filter, query } = useTranscriptView(conversationId)
  const detail = useTranscriptViewStore(
    (state) => state.details[conversationId]
  )
  const link = detail?.group_link
  const updateView = useTranscriptViewStore((state) => state.updateView)
  const setFilter = (patch: Partial<ProcessFilter>) =>
    updateView(conversationId, (view) => ({
      ...view,
      filter: { ...view.filter, ...patch },
    }))

  const narrowing = [
    filter.skill && {
      label: t("filterSkill", { name: filter.skill }),
      clear: () => setFilter({ skill: null }),
    },
    filter.toolName && {
      label: t("filterTool", { name: filter.toolName }),
      clear: () => setFilter({ toolName: null }),
    },
  ].filter((item) => !!item)

  return (
    <div className="flex h-full min-w-0 items-center gap-1 px-2 text-muted-foreground">
      <div
        role="group"
        aria-label={t("detailLabel")}
        className="flex shrink-0 items-center rounded-md border border-border/60 p-0.5"
      >
        {DETAILS.map((value) => (
          <button
            key={value}
            type="button"
            aria-pressed={level === value}
            className={cn(pill, "h-6")}
            onClick={() =>
              updateView(conversationId, (view) => ({ ...view, level: value }))
            }
          >
            {t(`detail.${value}`)}
          </button>
        ))}
      </div>
      {level !== "prompts" && (
        <>
          <button
            type="button"
            aria-pressed={filter.thinking}
            className={pill}
            onClick={() => setFilter({ thinking: !filter.thinking })}
          >
            {t("showThinking")}
          </button>
          <button
            type="button"
            aria-pressed={filter.tools}
            className={pill}
            onClick={() => setFilter({ tools: !filter.tools })}
          >
            {t("showTools")}
          </button>
          <button
            type="button"
            aria-pressed={filter.errorsOnly}
            className={pill}
            onClick={() => setFilter({ errorsOnly: !filter.errorsOnly })}
          >
            {t("errorsOnly")}
          </button>
        </>
      )}
      {narrowing.map((item) => (
        <button
          key={item.label}
          type="button"
          onClick={item.clear}
          aria-label={t("clearFilter", { name: item.label })}
          className="flex h-6 max-w-48 min-w-0 shrink items-center gap-1 rounded border border-primary/50 bg-primary/10 px-1.5 font-mono text-[11px] text-foreground"
        >
          <span className="truncate">{item.label}</span>
          <X className="size-3 shrink-0" />
        </button>
      ))}
      {link ? (
        <span
          data-session-link
          className="ml-auto min-w-0 shrink truncate pl-2 text-[11px]"
        >
          {link.group_name} · {tSessions(`origins.${link.origin}`)}
          {link.live_member ? (
            <span className="text-emerald-600 dark:text-emerald-400">
              {" · "}
              {tSessions("liveAs", { member: link.live_member })}
            </span>
          ) : null}
        </span>
      ) : null}
      {detail?.summary.external_id ? (
        <ClassifyPopover
          folderId={detail.summary.folder_id}
          agentType={detail.summary.agent_type}
          sessionId={detail.summary.external_id}
        />
      ) : null}
      <div className={cn("relative w-56 min-w-28 shrink", !link && "ml-auto")}>
        <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2" />
        <Input
          value={query}
          onChange={(event) =>
            updateView(conversationId, (view) => ({
              ...view,
              query: event.target.value,
            }))
          }
          placeholder={t("searchPlaceholder")}
          aria-label={t("searchPlaceholder")}
          className="h-7 pl-7 text-xs"
        />
      </div>
    </div>
  )
}
