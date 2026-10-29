"use client"

import { memo, useEffect, useMemo, useRef, useState } from "react"
import { Virtualizer, type VirtualizerHandle } from "virtua"
import { ChevronRight } from "lucide-react"
import { useTranslations } from "next-intl"
import { Message, MessageContent } from "@/components/ai-elements/message"
import { CollapsibleUserMessage } from "@/components/message/user/collapsible-user-message"
import { ContentPartsRenderer } from "@/components/message/thread/content-parts-renderer"
import {
  adaptMessageTurn,
  type AdapterMessageText,
} from "@/lib/adapters/ai-elements-adapter"
import { formatTokenCount } from "@/lib/agent/token-format"
import type { DbConversationDetail, MessageTurn } from "@/lib/types"
import { cn } from "@/lib/utils"
import {
  StartupContext,
  STARTUP_CONTEXT_ID,
} from "@/sessions/components/startup-context"
import {
  filterProcess,
  firstCallTokens,
  isNarrowed,
  matchesExchange,
  type SessionExchange,
} from "@/sessions/exchanges"
import {
  exchangesOf,
  useTranscriptView,
  useTranscriptViewStore,
} from "@/sessions/transcript-view-store"

interface SessionAnalysisViewProps {
  conversationId: number
  detail: Pick<DbConversationDetail, "turns" | "context">
}

type Row =
  | { kind: "context" }
  | { kind: "prompt"; exchange: SessionExchange }
  | { kind: "toggle"; exchange: SessionExchange; open: boolean }
  | { kind: "turn"; exchange: SessionExchange; turn: MessageTurn }
  | { kind: "answer"; exchange: SessionExchange; turn: MessageTurn }

const TurnBody = memo(function TurnBody({
  turn,
  text,
}: {
  turn: MessageTurn
  text: AdapterMessageText
}) {
  const adapted = useMemo(() => adaptMessageTurn(turn, text), [turn, text])
  if (adapted.content.length === 0) return null
  if (turn.role === "user") {
    return (
      <Message from="user">
        <MessageContent>
          <CollapsibleUserMessage parts={adapted.content} />
        </MessageContent>
      </Message>
    )
  }
  return (
    <Message from={turn.role === "assistant" ? "assistant" : "system"}>
      <MessageContent>
        <ContentPartsRenderer parts={adapted.content} role={turn.role} />
      </MessageContent>
    </Message>
  )
})

function rowKey(row: Row): string {
  if (row.kind === "context") return STARTUP_CONTEXT_ID
  return row.kind === "turn" || row.kind === "answer"
    ? `${row.kind}-${row.turn.id}`
    : `${row.kind}-${row.exchange.id}`
}

function formatTime(iso: string | null): string {
  if (!iso) return ""
  const date = new Date(iso)
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })
}

/**
 * 会话正文：按一问一答分段渲染。筛选与搜索在工具栏（FileWorkspaceHeader），
 * 摘要与提问目录在左侧“会话详情”面板，三者经 transcript-view-store 同步。
 */
export function SessionAnalysisView({
  conversationId,
  detail,
}: SessionAnalysisViewProps) {
  const t = useTranslations("Folder.sessionViewer")
  const sharedT = useTranslations("Folder.chat.shared")
  const emptyT = useTranslations("Folder.chat.messageList")
  const adapterText = useMemo<AdapterMessageText>(
    () => ({
      attachedResources: sharedT("attachedResources"),
      toolCallFailed: sharedT("toolCallFailed"),
    }),
    [sharedT]
  )
  const listRef = useRef<VirtualizerHandle>(null)
  const scrollRef = useRef<HTMLElement>(null)
  const { level, filter, query } = useTranscriptView(conversationId)
  const jump = useTranscriptViewStore((state) => state.jump)
  const [opened, setOpened] = useState<ReadonlySet<string>>(new Set())

  const exchanges = useMemo(() => exchangesOf(detail), [detail])
  const narrowed = isNarrowed(filter)
  const visible = useMemo(
    () => exchanges.filter((ex) => matchesExchange(ex, filter, query)),
    [exchanges, filter, query]
  )

  const { rows, startRow } = useMemo(() => {
    const rows: Row[] = []
    const startRow = new Map<string, number>()
    // 启动输入在第一个提问之前，排在最前；收窄筛选或搜索时不显示
    if (detail.context?.length && !narrowed && !query) {
      startRow.set(STARTUP_CONTEXT_ID, 0)
      rows.push({ kind: "context" })
    }
    for (const exchange of visible) {
      startRow.set(exchange.id, rows.length)
      if (exchange.prompt) rows.push({ kind: "prompt", exchange })
      if (level === "prompts" && exchange.prompt) continue
      const process = filterProcess(exchange.process, filter)
      if (process.length > 0) {
        const open = level === "full" || narrowed || opened.has(exchange.id)
        if (level !== "full" && !narrowed) {
          rows.push({ kind: "toggle", exchange, open })
        }
        if (open) {
          for (const turn of process)
            rows.push({ kind: "turn", exchange, turn })
        }
      }
      if (exchange.answer && !narrowed) {
        rows.push({ kind: "answer", exchange, turn: exchange.answer })
      }
    }
    return { rows, startRow }
  }, [visible, level, filter, narrowed, opened, detail.context, query])
  const startupTokens = useMemo(
    () => firstCallTokens(detail.turns),
    [detail.turns]
  )

  // 实时追加：停在底部时跟随新内容，向上翻阅或跳转后不打断
  const atBottom = useRef(true)
  useEffect(() => {
    if (jump?.conversationId !== conversationId) return
    atBottom.current = false
    const index = startRow.get(jump.exchangeId)
    if (index != null) listRef.current?.scrollToIndex(index, { align: "start" })
    useTranscriptViewStore.getState().consumeJump()
    // 只响应新的跳转请求；筛选变化导致的行号变化不应再次滚动
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jump])

  useEffect(() => {
    if (atBottom.current && rows.length > 0) {
      listRef.current?.scrollToIndex(rows.length - 1, { align: "end" })
    }
  }, [rows.length, detail])

  const toggleOpen = (id: string) =>
    setOpened((current) => {
      const next = new Set(current)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const processLabel = (exchange: SessionExchange) => {
    const { stats } = exchange
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
    if (parts.length === 0) {
      parts.push(t("processSteps", { count: exchange.process.length }))
    }
    return parts.join(" · ")
  }

  const renderRow = (row: Row) => {
    if (row.kind === "context") {
      return (
        <div className="px-3 pt-4">
          <StartupContext
            items={detail.context ?? []}
            totalTokens={startupTokens}
          />
        </div>
      )
    }
    const { exchange } = row
    if (row.kind === "prompt") {
      const { stats } = exchange
      return (
        <div className="px-3 pt-5 pb-2" data-session-exchange={exchange.id}>
          <div className="mb-1 flex items-center gap-2 text-[11px] text-muted-foreground">
            <span className="font-medium text-foreground">
              #{exchange.index}
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
          <TurnBody turn={exchange.prompt!} text={adapterText} />
        </div>
      )
    }
    if (row.kind === "toggle") {
      return (
        <div className="px-3 py-1">
          <button
            type="button"
            aria-expanded={row.open}
            onClick={() => toggleOpen(exchange.id)}
            className="inline-flex items-center gap-1.5 rounded-full bg-muted/60 px-3 py-1.5 text-xs text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <ChevronRight
              aria-hidden="true"
              className={cn(
                "size-3 transition-transform",
                row.open && "rotate-90"
              )}
            />
            <span>
              {t("processSummary", { parts: processLabel(exchange) })}
            </span>
          </button>
        </div>
      )
    }
    return (
      <div
        className={cn("px-3 py-2", row.kind === "turn" && "opacity-90")}
        data-session-turn={row.turn.id}
      >
        <TurnBody turn={row.turn} text={adapterText} />
      </div>
    )
  }

  if (exchanges.length === 0) {
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
            {rows.map((row) => (
              <div key={rowKey(row)}>{renderRow(row)}</div>
            ))}
          </Virtualizer>
        </div>
      )}
    </section>
  )
}
