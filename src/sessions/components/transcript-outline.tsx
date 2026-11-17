"use client"

import { useMemo } from "react"
import { BookOpen, Loader2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useTranslations } from "next-intl"
import { SessionDetailsContent } from "@/components/conversations/session-details-content"
import { ScrollArea } from "@/components/ui/scroll-area"
import { formatTokenCount } from "@/lib/agent/token-format"
import { cn } from "@/lib/utils"
import { STARTUP_CONTEXT_ID } from "@/sessions/components/startup-context"
import { matchesSegment, type ProcessFilter } from "@/sessions/exchanges"
import {
  cachedParts,
  useConversationToc,
  useStartupContext,
} from "@/sessions/transcript-toc"
import {
  useTranscriptView,
  useTranscriptViewStore,
} from "@/sessions/transcript-view-store"

const TOP_CHIPS = 12

function topEntries(counts: Record<string, number>): [string, number][] {
  return Object.entries(counts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_CHIPS)
}

/** 左侧“会话详情”面板中的会话阅读导航：会话信息、摘要、技能/工具筛选与提问目录。 */
export function TranscriptOutline({
  conversationId,
  onOpen,
}: {
  conversationId: number
  /** 阅读区尚未打开该会话时提供：显示打开按钮，点击目录先打开再跳转。 */
  onOpen?: () => void
}) {
  const t = useTranslations("Folder.sessionViewer")
  const { toc, error } = useConversationToc(conversationId)
  const context = useStartupContext(conversationId)
  const { filter, query } = useTranscriptView(conversationId)
  const updateView = useTranscriptViewStore((state) => state.updateView)
  const requestJump = useTranscriptViewStore((state) => state.requestJump)

  const segments = useMemo(() => toc?.segments ?? [], [toc])
  const summary = useMemo(() => {
    const tools: Record<string, number> = {}
    const toolTokens: Record<string, number> = {}
    const skills: Record<string, number> = {}
    let toolCalls = 0
    let errors = 0
    let peak = 0
    let model: string | null = null
    for (const { stats } of segments) {
      for (const [name, count] of Object.entries(stats.tools)) {
        tools[name] = (tools[name] ?? 0) + count
      }
      for (const [name, tokens] of Object.entries(stats.toolTokens)) {
        toolTokens[name] = (toolTokens[name] ?? 0) + tokens
      }
      for (const [name, count] of Object.entries(stats.skills)) {
        skills[name] = (skills[name] ?? 0) + count
      }
      toolCalls += stats.toolCalls
      errors += stats.errors
      peak = Math.max(peak, stats.contextTokens ?? 0)
      model = stats.model ?? model
    }
    return {
      prompts: segments.filter((segment) => segment.prompt).length,
      tools: topEntries(tools),
      toolTokens,
      skills: topEntries(skills),
      toolCalls,
      errors,
      peak,
      model,
    }
  }, [segments])
  const visible = useMemo(
    () =>
      segments.filter((segment) =>
        matchesSegment(
          segment,
          filter,
          query,
          query && toc
            ? cachedParts(
                conversationId,
                toc.generation,
                Array.from(
                  { length: segment.end - segment.start },
                  (_, i) => segment.start + i
                )
              )
            : []
        )
      ),
    [segments, filter, query, toc, conversationId]
  )
  const startupTokens = toc?.startup_tokens ?? null

  const setFilter = (patch: Partial<ProcessFilter>) =>
    updateView(conversationId, (view) => ({
      ...view,
      filter: { ...view.filter, ...patch, tools: true },
    }))

  if (error) {
    return <p className="p-4 text-sm text-destructive">{error}</p>
  }
  if (!toc) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    )
  }

  const chips = (
    label: string,
    entries: [string, number][],
    selected: string | null,
    onSelect: (value: string | null) => void,
    /** 名字 → 结果的估算 token，有则附在次数后面。 */
    sizes?: Record<string, number>
  ) =>
    entries.length > 0 && (
      <div role="group" aria-label={label} className="space-y-1">
        <div className="text-[10px] tracking-wide text-muted-foreground uppercase">
          {label}
        </div>
        <div className="flex flex-wrap gap-1">
          {entries.map(([name, count]) => (
            <button
              key={name}
              type="button"
              aria-pressed={selected === name}
              title={
                sizes?.[name]
                  ? t("toolResultTokens", {
                      tokens: formatTokenCount(sizes[name]),
                    })
                  : undefined
              }
              onClick={() => onSelect(selected === name ? null : name)}
              className={cn(
                "max-w-full truncate rounded border px-1.5 py-0.5 font-mono text-[11px]",
                selected === name
                  ? "border-primary bg-primary/10 text-foreground"
                  : "text-muted-foreground hover:bg-muted"
              )}
            >
              {name} {count}
              {sizes?.[name]
                ? ` · ${t("approxTokens", { tokens: formatTokenCount(sizes[name]) })}`
                : null}
            </button>
          ))}
        </div>
      </div>
    )

  return (
    <ScrollArea className="h-full min-h-0">
      <div className="space-y-4 p-3">
        {onOpen && (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="w-full"
            onClick={onOpen}
          >
            <BookOpen className="size-4" />
            {t("openInReader")}
          </Button>
        )}
        <SessionDetailsContent
          summary={toc.summary}
          stats={toc.session_stats ?? null}
          model={summary.model ?? toc.summary.model ?? null}
        />
        <div className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted-foreground">
          <span>{t("summaryExchanges", { count: summary.prompts })}</span>
          <span>{t("processTools", { count: summary.toolCalls })}</span>
          {summary.errors > 0 && (
            <button
              type="button"
              aria-pressed={filter.errorsOnly}
              className="text-destructive hover:underline"
              onClick={() => setFilter({ errorsOnly: !filter.errorsOnly })}
            >
              {t("processErrors", { count: summary.errors })}
            </button>
          )}
          {summary.peak > 0 && (
            <span>
              {t("summaryPeakContext", {
                tokens: formatTokenCount(summary.peak),
              })}
            </span>
          )}
        </div>
        {context && context.length > 0 && (
          <button
            type="button"
            onClick={() => {
              onOpen?.()
              requestJump(conversationId, STARTUP_CONTEXT_ID)
            }}
            className="flex w-full items-center gap-1.5 text-left text-xs text-muted-foreground hover:text-foreground"
          >
            <span className="font-medium text-foreground">
              {t("contextTitle")}
            </span>
            <span>
              {t("contextItems", { count: context.length })}
              {startupTokens != null &&
                ` · ${t("startupTokens", { tokens: formatTokenCount(startupTokens) })}`}
            </span>
          </button>
        )}
        {chips(t("skillsLabel"), summary.skills, filter.skill, (skill) =>
          setFilter({ skill })
        )}
        {chips(
          t("toolsLabel"),
          summary.tools,
          filter.toolName,
          (toolName) => setFilter({ toolName }),
          summary.toolTokens
        )}
        <nav aria-label={t("outlineTitle")} className="space-y-1">
          <div className="text-[10px] tracking-wide text-muted-foreground uppercase">
            {t("outlineTitle")}
          </div>
          {visible.length === 0 ? (
            <p className="text-xs text-muted-foreground">{t("noMatches")}</p>
          ) : (
            <ol className="-mx-3">
              {visible.map((segment) => (
                <li key={segment.id}>
                  <button
                    type="button"
                    onClick={() => {
                      onOpen?.()
                      requestJump(conversationId, segment.id)
                    }}
                    className="flex w-full flex-col gap-0.5 px-3 py-1.5 text-left hover:bg-muted"
                  >
                    <span className="line-clamp-2 text-xs">
                      <span className="mr-1 text-muted-foreground">
                        #{segment.index}
                      </span>
                      {segment.prompt ? (segment.title ?? "") : t("preamble")}
                    </span>
                    <span className="flex gap-2 text-[10px] text-muted-foreground">
                      {segment.stats.toolCalls > 0 && (
                        <span>
                          {t("processTools", {
                            count: segment.stats.toolCalls,
                          })}
                        </span>
                      )}
                      {segment.stats.errors > 0 && (
                        <span className="text-destructive">
                          {t("processErrors", {
                            count: segment.stats.errors,
                          })}
                        </span>
                      )}
                      {segment.stats.contextTokens != null && (
                        <span>
                          {formatTokenCount(segment.stats.contextTokens)}
                        </span>
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </nav>
      </div>
    </ScrollArea>
  )
}
