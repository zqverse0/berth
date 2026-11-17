"use client"

import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { Virtualizer, type VirtualizerHandle } from "virtua"
import { ChevronRight } from "lucide-react"
import { useTranslations } from "next-intl"
import type { AdapterMessageText } from "@/lib/adapters/ai-elements-adapter"
import { formatTokenCount } from "@/lib/agent/token-format"
import type { ConversationToc, PartTurn, TocSegment } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  StartupContext,
  STARTUP_CONTEXT_ID,
} from "@/sessions/components/startup-context"
import {
  PromptParts,
  ProcessParts,
  TextPart,
  type PartSource,
  type PlacedPart,
} from "@/sessions/components/part-view"
import {
  filterParts,
  isNarrowed,
  matchesSegment,
  type ExchangeDetail,
  type ProcessFilter,
} from "@/sessions/exchanges"
import {
  cachedParts,
  useStartupContext,
  useTurnParts,
} from "@/sessions/transcript-toc"
import {
  useTranscriptView,
  useTranscriptViewStore,
} from "@/sessions/transcript-view-store"

function range(start: number, end: number): number[] {
  return Array.from({ length: Math.max(0, end - start) }, (_, i) => start + i)
}

function formatTime(iso: string | null): string {
  if (!iso) return ""
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

/** 一轮的 Part 记上轮序号与同种文字块的序号（取原文时用）。 */
function place(turn: PartTurn): PlacedPart[] {
  const seen: Record<string, number> = {}
  return turn.parts.map((part) => {
    const group = part.kind === "thinking" ? "thinking" : part.kind
    const ordinal = seen[group] ?? 0
    seen[group] = ordinal + 1
    return { entry: turn.entry, part, ordinal }
  })
}

interface SegmentRowProps {
  source: PartSource
  segment: TocSegment
  level: ExchangeDetail
  filter: ProcessFilter
  open: boolean
  onToggle: (id: string) => void
  onLoaded: (segment: TocSegment) => void
  text: AdapterMessageText
}

/** 一段：提问、过程开关、过程、回答。显示出来时才按轮取 Part。 */
const SegmentRow = memo(function SegmentRow({
  source,
  segment,
  level,
  filter,
  open,
  onToggle,
  onLoaded,
  text,
}: SegmentRowProps) {
  const t = useTranslations("Folder.sessionViewer")
  const narrowed = isNarrowed(filter)
  const promptOnly = level === "prompts" && segment.prompt
  const showProcess = !promptOnly && (level === "full" || narrowed || open)
  const entries = useMemo(() => {
    if (promptOnly) return [segment.start]
    if (showProcess) return range(segment.start, segment.end)
    const wanted: number[] = []
    if (segment.prompt) wanted.push(segment.start)
    if (segment.answer != null) wanted.push(segment.answer)
    return wanted
  }, [promptOnly, showProcess, segment])
  const { turns, error } = useTurnParts(
    source.conversationId,
    source.generation,
    entries
  )
  const loaded = turns != null
  useEffect(() => {
    if (loaded) onLoaded(segment)
  }, [loaded, segment, onLoaded])

  const { prompt, process, answer } = useMemo(() => {
    if (!turns) return { prompt: [], process: [], answer: null }
    const prompt = segment.prompt
      ? place(turns.get(segment.start) ?? { ...EMPTY_TURN })
      : []
    let answer: PlacedPart | null = null
    if (segment.answer != null) {
      const placed = place(turns.get(segment.answer) ?? { ...EMPTY_TURN })
      for (let i = placed.length - 1; i >= 0; i--) {
        if (placed[i].part.kind === "text" && placed[i].part.text?.trim()) {
          answer = placed[i]
          break
        }
      }
    }
    const body: PlacedPart[] = []
    if (showProcess) {
      for (const entry of range(
        segment.start + (segment.prompt ? 1 : 0),
        segment.end
      )) {
        const turn = turns.get(entry)
        if (!turn) continue
        for (const placed of place(turn)) {
          if (
            answer &&
            placed.entry === answer.entry &&
            placed.part === answer.part
          )
            continue
          body.push(placed)
        }
      }
    }
    const kept = new Set(
      filterParts(
        body.map((placed) => placed.part),
        filter
      )
    )
    return {
      prompt,
      process: body.filter((placed) => kept.has(placed.part)),
      answer,
    }
  }, [turns, segment, showProcess, filter])

  const { stats } = segment
  const processLabel = () => {
    const parts: string[] = []
    if (stats.thinking > 0)
      parts.push(t("processThinking", { count: stats.thinking }))
    if (stats.toolCalls > 0)
      parts.push(t("processTools", { count: stats.toolCalls }))
    const skills = Object.keys(stats.skills)
    if (skills.length > 0)
      parts.push(t("processSkills", { names: skills.join(", ") }))
    if (stats.errors > 0)
      parts.push(t("processErrors", { count: stats.errors }))
    if (parts.length === 0)
      parts.push(t("processSteps", { count: segment.steps }))
    return parts.join(" · ")
  }

  return (
    <div data-session-exchange={segment.id}>
      {segment.prompt && (
        <div className="px-3 pt-5 pb-2">
          <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">
              #{segment.index}
            </span>
            <span>{formatTime(stats.startedAt)}</span>
            {stats.model && <span className="truncate">{stats.model}</span>}
            {stats.contextTokens != null && (
              <span>
                {t("contextTokens", {
                  tokens: formatTokenCount(stats.contextTokens),
                })}
              </span>
            )}
          </div>
          {loaded ? (
            <PromptParts source={source} parts={prompt} />
          ) : (
            <p className="text-sm text-muted-foreground">
              {segment.title ?? ""}
            </p>
          )}
        </div>
      )}
      {!promptOnly && (
        <>
          {segment.steps > 0 && level !== "full" && !narrowed && (
            <div className="px-3 py-1">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => onToggle(segment.id)}
                className="inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
              >
                <ChevronRight
                  aria-hidden="true"
                  className={cn(
                    "size-3 transition-transform",
                    open && "rotate-90"
                  )}
                />
                <span>{t("processSummary", { parts: processLabel() })}</span>
              </button>
            </div>
          )}
          {showProcess && process.length > 0 && (
            <div className="px-3 py-2 opacity-90">
              <ProcessParts source={source} parts={process} text={text} />
            </div>
          )}
          {answer && !narrowed && (
            <div className="px-3 py-2">
              <TextPart source={source} placed={answer} />
            </div>
          )}
        </>
      )}
      {!loaded && !error && (
        <p className="px-3 py-2 text-[11px] text-muted-foreground">
          {t("partLoading")}
        </p>
      )}
      {error && (
        <p className="px-3 py-2 text-[11px] text-destructive">
          {t("partLoadFailed", { error })}
        </p>
      )}
    </div>
  )
})

const EMPTY_TURN: PartTurn = { entry: -1, id: "", role: "user", parts: [] }

type Row = { kind: "context" } | { kind: "segment"; segment: TocSegment }

/**
 * 会话正文（阅读器）：按目录分段，每段显示出来时才取它的 Part。筛选与搜索在工具栏
 * （FileWorkspaceHeader），摘要与提问目录在左侧「会话详情」面板，三者经 transcript-view-store 同步。
 */
export function TranscriptView({
  conversationId,
  toc,
}: {
  conversationId: number
  toc: ConversationToc
}) {
  const t = useTranslations("Folder.sessionViewer")
  const sharedT = useTranslations("Folder.chat.shared")
  const emptyT = useTranslations("Folder.chat.messageList")
  const text = useMemo<AdapterMessageText>(
    () => ({
      attachedResources: sharedT("attachedResources"),
      toolCallFailed: sharedT("toolCallFailed"),
    }),
    [sharedT]
  )
  const source = useMemo<PartSource>(
    () => ({ conversationId, generation: toc.generation }),
    [conversationId, toc.generation]
  )
  const context = useStartupContext(conversationId)
  const listRef = useRef<VirtualizerHandle>(null)
  const scrollRef = useRef<HTMLElement>(null)
  const { level, filter, query } = useTranscriptView(conversationId)
  const jump = useTranscriptViewStore((state) => state.jump)
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())
  const narrowed = isNarrowed(filter)

  const { rows, startRow } = useMemo(() => {
    const rows: Row[] = []
    const startRow = new Map<string, number>()
    // 启动输入在第一个提问之前，排在最前；收窄筛选或搜索时不显示
    if (context?.length && !narrowed && !query) {
      startRow.set(STARTUP_CONTEXT_ID, 0)
      rows.push({ kind: "context" })
    }
    for (const segment of toc.segments) {
      const loaded = query
        ? cachedParts(
            conversationId,
            toc.generation,
            range(segment.start, segment.end)
          )
        : []
      if (!matchesSegment(segment, filter, query, loaded)) continue
      startRow.set(segment.id, rows.length)
      rows.push({ kind: "segment", segment })
    }
    return { rows, startRow }
  }, [toc, filter, query, narrowed, context, conversationId])

  // 实时追加：停在底部时跟随新内容（包括最后一段取到 Part 后变高），向上翻阅或跳转后不打断
  const atBottom = useRef(true)
  const followBottom = () => {
    if (atBottom.current && rows.length > 0) {
      listRef.current?.scrollToIndex(rows.length - 1, { align: "end" })
    }
  }
  const lastId = toc.segments[toc.segments.length - 1]?.id
  const follow = useRef(followBottom)
  follow.current = followBottom
  const handleLoaded = useCallback(
    (segment: TocSegment) => {
      if (segment.id === lastId) follow.current()
    },
    [lastId]
  )

  useEffect(() => {
    if (jump?.conversationId !== conversationId) return
    atBottom.current = false
    const index = startRow.get(jump.exchangeId)
    if (index != null) listRef.current?.scrollToIndex(index, { align: "start" })
    useTranscriptViewStore.getState().consumeJump()
    // 只响应新的跳转请求；筛选变化导致的行号变化不应再次滚动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump])

  useEffect(followBottom, [rows.length, toc])

  const toggleOpen = useCallback(
    (id: string) =>
      setOpened((current) => {
        const next = new Set(current)
        if (next.has(id)) next.delete(id)
        else next.add(id)
        return next
      }),
    []
  )

  if (toc.segments.length === 0) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        {emptyT("emptyConversation")}
      </p>
    )
  }

  return (
    <section
      ref={scrollRef}
      onScroll={(event) => {
        const el = event.currentTarget
        atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80
      }}
      aria-label={t("contentTitle")}
      className="h-full min-h-0 overflow-auto pb-6"
    >
      {rows.length === 0 ? (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {t("noMatches")}
        </p>
      ) : (
        <div className="mx-auto max-w-4xl">
          <Virtualizer ref={listRef} scrollRef={scrollRef}>
            {rows.map((row) =>
              row.kind === "context" ? (
                <div key={STARTUP_CONTEXT_ID} className="px-3 pt-4">
                  <StartupContext
                    items={context ?? []}
                    totalTokens={toc.startup_tokens}
                  />
                </div>
              ) : (
                <SegmentRow
                  key={row.segment.id}
                  source={source}
                  segment={row.segment}
                  level={level}
                  filter={filter}
                  open={opened.has(row.segment.id)}
                  onToggle={toggleOpen}
                  onLoaded={handleLoaded}
                  text={text}
                />
              )
            )}
          </Virtualizer>
        </div>
      )}
    </section>
  )
}
