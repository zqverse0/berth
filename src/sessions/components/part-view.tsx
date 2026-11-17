"use client"

import { memo, useMemo, useState, type ReactNode } from "react"
import {
  ChevronRightIcon,
  CircleAlertIcon,
  FilePenLineIcon,
  FileTextIcon,
  GlobeIcon,
  ImageIcon,
  ListTodoIcon,
  MessageCircleQuestionMarkIcon,
  SearchIcon,
  SparklesIcon,
  TerminalIcon,
  UsersIcon,
  WrenchIcon,
} from "lucide-react"
import { useTranslations } from "next-intl"
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message"
import {
  Reasoning,
  ReasoningContent,
  ReasoningTrigger,
} from "@/components/ai-elements/reasoning"
import { PlanEntriesList } from "@/components/message/cards/plan-card"
import {
  ContentPartsRenderer,
  ToolOpenByDefault,
} from "@/components/message/thread/content-parts-renderer"
import { CollapsibleUserMessage } from "@/components/message/user/collapsible-user-message"
import {
  adaptMessageTurn,
  type AdaptedContentPart,
  type AdapterMessageText,
} from "@/lib/adapters/ai-elements-adapter"
import { toErrorMessage } from "@/lib/app-error"
import type { ContentBlock, SessionPart } from "@/lib/types"
import { cn } from "@/lib/utils"
import { isResultPart, isToolPart } from "@/sessions/exchanges"
import { loadRawTurns } from "@/sessions/transcript-toc"

/** 一块内容与它所在的轮（取原文时按轮读）。 */
export interface PlacedPart {
  entry: number
  part: SessionPart
  /** 同一轮里同种文字块的第几个（取原文后据此找回全文）。 */
  ordinal: number
}

export interface PartSource {
  conversationId: number
  generation: number
}

const ICON = "size-3.5 shrink-0 text-muted-foreground"

/** 按声明的种类给图标，不认工具名。 */
function kindIcon(kind: string): ReactNode {
  switch (kind) {
    case "command":
      return <TerminalIcon className={ICON} />
    case "edit":
      return <FilePenLineIcon className={ICON} />
    case "read":
      return <FileTextIcon className={ICON} />
    case "search":
      return <SearchIcon className={ICON} />
    case "fetch":
      return <GlobeIcon className={ICON} />
    case "plan":
      return <ListTodoIcon className={ICON} />
    case "question":
      return <MessageCircleQuestionMarkIcon className={ICON} />
    case "delegate":
      return <UsersIcon className={ICON} />
    case "skill":
      return <SparklesIcon className={ICON} />
    default:
      return <WrenchIcon className={ICON} />
  }
}

/** 工具组摘要用的分类（沿用 `Folder.chat.contentParts.toolGroup` 的文案）。 */
const GROUP_KIND: Record<string, GroupKind> = {
  command: "command",
  edit: "edit",
  read: "read",
  search: "search",
  fetch: "fetch",
  plan: "todo",
  delegate: "task",
  think: "think",
}
const GROUP_ORDER = [
  "search",
  "read",
  "edit",
  "command",
  "fetch",
  "task",
  "todo",
  "think",
  "other",
] as const
type GroupKind = (typeof GROUP_ORDER)[number]

/** 自成一张卡、不并进工具组的种类。 */
const STANDALONE = new Set(["plan", "question", "delegate"])

function shortPath(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).pop() ?? path
}

/** 截断写明：还剩多少字，点了取这一轮的原文。 */
function CutNotice({
  cut,
  onShowAll,
  loading,
}: {
  cut: number
  onShowAll: () => void
  loading: boolean
}) {
  const t = useTranslations("Folder.sessionViewer")
  return (
    <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
      <span>{t("partCut", { count: cut })}</span>
      <button
        type="button"
        disabled={loading}
        onClick={onShowAll}
        className="underline-offset-2 hover:text-foreground hover:underline disabled:opacity-60"
      >
        {loading ? t("partLoading") : t("partShowAll")}
      </button>
    </div>
  )
}

/** 取原文里同种文字块的第 `ordinal` 个。 */
function rawText(
  blocks: ContentBlock[],
  kind: "text" | "thinking",
  ordinal: number
): string | null {
  const texts = blocks.filter(
    (block): block is ContentBlock & { type: "text" | "thinking" } =>
      block.type === kind && block.text.trim() !== ""
  )
  return texts[ordinal]?.text ?? null
}

/** 被截断的文字：点「显示全部」后换成原文。 */
function useFullText(source: PartSource, placed: PlacedPart) {
  const [full, setFull] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const kind = placed.part.kind === "thinking" ? "thinking" : "text"
  const load = () => {
    setLoading(true)
    loadRawTurns(source.conversationId, source.generation, [placed.entry])
      .then((turns) => {
        const text = turns[0] && rawText(turns[0].blocks, kind, placed.ordinal)
        if (text) setFull(text)
      })
      .catch((reason) => setError(toErrorMessage(reason)))
      .finally(() => setLoading(false))
  }
  return { text: full ?? placed.part.text ?? "", full, loading, error, load }
}

function PartError({ error }: { error: string }) {
  const t = useTranslations("Folder.sessionViewer")
  return (
    <p className="text-[11px] text-destructive">
      {t("partLoadFailed", { error })}
    </p>
  )
}

/** 提问：用户的文字（多段合在一起）。 */
export const PromptParts = memo(function PromptParts({
  source,
  parts,
}: {
  source: PartSource
  parts: PlacedPart[]
}) {
  const texts = parts.filter((placed) => placed.part.kind === "text")
  const images = parts.filter((placed) => placed.part.kind === "image").length
  const t = useTranslations("Folder.sessionViewer")
  return (
    <Message from="user">
      <MessageContent>
        {texts.map((placed) => (
          <PromptText key={placed.ordinal} source={source} placed={placed} />
        ))}
        {images > 0 && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
            <ImageIcon className="size-3.5" />
            {t("partImages", { count: images })}
          </span>
        )}
      </MessageContent>
    </Message>
  )
})

function PromptText({
  source,
  placed,
}: {
  source: PartSource
  placed: PlacedPart
}) {
  const { text, full, loading, error, load } = useFullText(source, placed)
  const parts = useMemo<AdaptedContentPart[]>(
    () => [{ type: "text", text }],
    [text]
  )
  return (
    <>
      <CollapsibleUserMessage parts={parts} />
      {!full && (placed.part.cut ?? 0) > 0 && (
        <CutNotice cut={placed.part.cut!} onShowAll={load} loading={loading} />
      )}
      {error && <PartError error={error} />}
    </>
  )
}

/** Agent 的一段正文（回答或过程里的话）。 */
export const TextPart = memo(function TextPart({
  source,
  placed,
}: {
  source: PartSource
  placed: PlacedPart
}) {
  const { text, full, loading, error, load } = useFullText(source, placed)
  const role = placed.part.role === "assistant" ? "assistant" : "system"
  return (
    <Message from={role}>
      <MessageContent>
        <MessageResponse>{text}</MessageResponse>
        {!full && (placed.part.cut ?? 0) > 0 && (
          <CutNotice
            cut={placed.part.cut!}
            onShowAll={load}
            loading={loading}
          />
        )}
        {error && <PartError error={error} />}
      </MessageContent>
    </Message>
  )
})

function ThinkingPart({
  source,
  placed,
}: {
  source: PartSource
  placed: PlacedPart
}) {
  const { text, full, loading, error, load } = useFullText(source, placed)
  return (
    <Reasoning isStreaming={false} expandable>
      <ReasoningTrigger />
      <ReasoningContent>{text}</ReasoningContent>
      {!full && (placed.part.cut ?? 0) > 0 && (
        <CutNotice cut={placed.part.cut!} onShowAll={load} loading={loading} />
      )}
      {error && <PartError error={error} />}
    </Reasoning>
  )
}

interface ToolItem {
  call: PlacedPart
  result: PlacedPart | null
}

/** 一次工具调用：标题、路径、增删行数；点开按这一轮与结果那一轮的位置取原文，用原来的卡片显示。 */
const ToolPartCard = memo(function ToolPartCard({
  source,
  item,
  text,
}: {
  source: PartSource
  item: ToolItem
  text: AdapterMessageText
}) {
  const t = useTranslations("Folder.sessionViewer")
  const { call, result } = item
  const part = call.part
  const [open, setOpen] = useState(false)
  const [raw, setRaw] = useState<AdaptedContentPart[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const failed = result?.part.kind === "error"
  const title = part.title ?? part.tool ?? t("partTool")
  const paths = part.paths ?? []
  const pathHint =
    paths.length > 0 && !title.includes(shortPath(paths[0]))
      ? paths.length > 1
        ? `${shortPath(paths[0])} +${paths.length - 1}`
        : shortPath(paths[0])
      : null

  const expand = () => {
    const next = !open
    setOpen(next)
    if (!next || raw) return
    const entries = [call.entry]
    if (result && result.entry !== call.entry) entries.push(result.entry)
    loadRawTurns(source.conversationId, source.generation, entries)
      .then((turns) => {
        const blocks = turns
          .flatMap((turn) => turn.blocks)
          .filter((block) =>
            block.type === "tool_use"
              ? block.tool_use_id === part.call
              : block.type === "tool_result" && block.tool_use_id === part.call
          )
        if (blocks.length === 0) return
        const adapted = adaptMessageTurn(
          {
            id: `${call.entry}:${part.call}`,
            role: "assistant",
            blocks,
            timestamp: turns[0].timestamp,
          },
          text
        ).content
        // 适配层把单个调用也包成工具组；这里已是用户点开的那一张，直接显示卡片
        setRaw(
          adapted.flatMap((piece) =>
            piece.type === "tool-group" ? piece.items : [piece]
          )
        )
      })
      .catch((reason) => setError(toErrorMessage(reason)))
  }

  if (open && raw) {
    return (
      <ToolOpenByDefault.Provider value>
        <ContentPartsRenderer parts={raw} role="assistant" />
      </ToolOpenByDefault.Provider>
    )
  }

  return (
    <div className="rounded-md border border-border/60">
      <button
        type="button"
        aria-expanded={open}
        onClick={expand}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-2 text-left text-xs hover:bg-muted/50"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-transform",
            open && "rotate-90"
          )}
        />
        {kindIcon(part.kind)}
        <span className="min-w-0 flex-1 truncate font-mono">{title}</span>
        {pathHint && (
          <span
            className="max-w-48 shrink-0 truncate text-muted-foreground"
            title={paths.join("\n")}
          >
            {pathHint}
          </span>
        )}
        {(part.added != null || part.removed != null) && (
          <span className="shrink-0 font-mono tabular-nums">
            <span className="text-emerald-600 dark:text-emerald-400">
              +{part.added ?? 0}
            </span>{" "}
            <span className="text-red-600 dark:text-red-400">
              −{part.removed ?? 0}
            </span>
          </span>
        )}
        {part.background && (
          <span className="shrink-0 rounded bg-muted px-1 text-[10px] text-muted-foreground">
            {t("partBackground")}
          </span>
        )}
        {failed && (
          <CircleAlertIcon
            aria-label={t("partFailed")}
            className="size-3.5 shrink-0 text-destructive"
          />
        )}
      </button>
      {part.plan && part.plan.length > 0 && (
        <div className="px-3 pb-2">
          <PlanEntriesList
            entries={part.plan.map((entry) => ({
              content: entry.text,
              status: entry.status ?? "pending",
              priority: "medium",
            }))}
          />
        </div>
      )}
      {open && (
        <div className="space-y-1 border-t border-border/60 px-3 py-2">
          {error ? (
            <PartError error={error} />
          ) : (
            <>
              {part.text && (
                <pre className="max-h-60 overflow-auto text-xs whitespace-pre-wrap">
                  {part.text}
                </pre>
              )}
              <p className="text-[11px] text-muted-foreground">
                {t("partLoading")}
              </p>
            </>
          )}
        </div>
      )}
    </div>
  )
})

/** 连续几次工具调用收成一行摘要，点开逐个列出（与原来的工具组一致）。 */
function ToolRun({
  source,
  items,
  text,
}: {
  source: PartSource
  items: ToolItem[]
  text: AdapterMessageText
}) {
  const t = useTranslations("Folder.chat.contentParts.toolGroup")
  const [open, setOpen] = useState(false)
  const counts = new Map<GroupKind, number>()
  let errors = 0
  for (const { call, result } of items) {
    const kind = GROUP_KIND[call.part.kind] ?? "other"
    counts.set(kind, (counts.get(kind) ?? 0) + 1)
    if (result?.part.kind === "error") errors += 1
  }
  const phrases = GROUP_ORDER.filter((kind) => counts.has(kind)).map((kind) =>
    t(kind, { count: counts.get(kind)! })
  )
  const joiner = t("joiner")
  return (
    <div className="w-full">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="inline-flex max-w-full items-center gap-1.5 rounded-full bg-muted/60 px-3.5 py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <ChevronRightIcon
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 opacity-60 transition-transform",
            open && "rotate-90"
          )}
        />
        <span className="min-w-0 truncate">
          {phrases.join(joiner)}
          {errors > 0 && (
            <span className="text-destructive">
              {joiner}
              {t("errorSuffix", { count: errors })}
            </span>
          )}
        </span>
      </button>
      {open && (
        <div className="mt-3 w-full space-y-2">
          {items.map((item) => (
            <ToolPartCard
              key={`${item.call.entry}:${item.call.part.call ?? item.call.ordinal}`}
              source={source}
              item={item}
              text={text}
            />
          ))}
        </div>
      )}
    </div>
  )
}

/**
 * 过程：按顺序显示正文、思考与工具调用。连续的工具调用收成一行，结果配回调用（按调用 id），
 * 配不上的结果单独成卡。
 */
export const ProcessParts = memo(function ProcessParts({
  source,
  parts,
  text,
}: {
  source: PartSource
  parts: PlacedPart[]
  text: AdapterMessageText
}) {
  const t = useTranslations("Folder.sessionViewer")
  const nodes = useMemo(() => {
    const results = new Map<string, PlacedPart>()
    const calls = new Set<string>()
    for (const placed of parts) {
      if (isResultPart(placed.part) && placed.part.call)
        results.set(placed.part.call, placed)
      if (isToolPart(placed.part) && placed.part.call)
        calls.add(placed.part.call)
    }
    const out: ReactNode[] = []
    let run: ToolItem[] = []
    const flush = () => {
      if (run.length === 0) return
      const items = run
      run = []
      out.push(
        <ToolRun
          key={`run-${items[0].call.entry}-${items[0].call.ordinal}-${items[0].call.part.call}`}
          source={source}
          items={items}
          text={text}
        />
      )
    }
    for (const placed of parts) {
      const { part } = placed
      const key = `${placed.entry}-${part.kind}-${placed.ordinal}-${part.call ?? ""}`
      if (isToolPart(part)) {
        const item = {
          call: placed,
          result: (part.call && results.get(part.call)) || null,
        }
        if (STANDALONE.has(part.kind)) {
          flush()
          out.push(
            <ToolPartCard key={key} source={source} item={item} text={text} />
          )
        } else {
          run.push(item)
        }
        continue
      }
      if (isResultPart(part)) {
        if (part.call && calls.has(part.call)) continue
        flush()
        out.push(
          <ToolPartCard
            key={key}
            source={source}
            item={{
              call: { ...placed, part: { ...part, title: t("partResult") } },
              result: placed,
            }}
            text={text}
          />
        )
        continue
      }
      flush()
      if (part.kind === "thinking") {
        out.push(<ThinkingPart key={key} source={source} placed={placed} />)
      } else if (part.kind === "image") {
        out.push(
          <span
            key={key}
            className="inline-flex items-center gap-1 text-xs text-muted-foreground"
          >
            <ImageIcon className="size-3.5" />
            {part.text ?? t("partImages", { count: 1 })}
          </span>
        )
      } else {
        out.push(<TextPart key={key} source={source} placed={placed} />)
      }
    }
    flush()
    return out
  }, [parts, source, text, t])
  return <div className="space-y-4">{nodes}</div>
})
