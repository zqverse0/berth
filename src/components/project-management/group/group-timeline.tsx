"use client"

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useTranslations } from "next-intl"
import {
  AlertCircle,
  ArrowDown,
  Check,
  ChevronRight,
  CircleDashed,
  Copy,
  Clock,
  GitCommitHorizontal,
  Layers,
  MoreHorizontal,
  Reply,
  SquareTerminal,
  CornerDownRight,
  FileMinus,
  FilePen,
  FilePlus,
} from "lucide-react"
import { AgentIcon } from "@/components/agent-icon"
import { AgentProfileIcon } from "@/components/agents/profile/agent-profile-icon"
import { MessageResponse } from "@/components/ai-elements/message"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import {
  BERTH_MEMBER,
  type GroupEvent,
  GROUP_USER,
  type DeliveryState,
} from "@/lib/agent/berth-group"
import { toast } from "@/lib/notify"
import { joinRootRel } from "@/lib/files/file-open-target"
import { isAbsoluteFilePath } from "@/lib/files/file-path-display"
import {
  PendingAnswer,
  ProcessLog,
  type LiveSession,
  type LogLine,
} from "./group-pending"
import { cn, copyTextToClipboard } from "@/lib/utils"
import {
  delegationProgress,
  isRelay,
  reportBody,
  paneNumber,
  splitCommit,
  timelineItems,
  type Progress,
  type ProgressOf,
} from "./group-model"

/** 距底部小于该像素视为「在底部」：新消息到达时自动滚到底。 */
const STICK_PX = 80
/** 回复超过这么多行才折叠；折叠后露出的高度见 `max-h-[30rem]`（约 20 行）。 */
const FOLD_LINES = 30
/** 首屏只渲染最近这么多条（每条都是 Markdown）；更早的点「更早的消息」分批展开。 */
const PAGE_ITEMS = 60

function clock(ms: number): string {
  return new Date(ms).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  })
}

function day(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    month: "long",
    day: "numeric",
    weekday: "short",
  })
}

/** 成员的色条颜色：主题的图表色，按名字固定取一种，同一成员每条回复同色。 */
const ACCENTS = [
  "border-chart-1",
  "border-chart-2",
  "border-chart-3",
  "border-chart-4",
  "border-chart-5",
]

export function memberAccent(name: string): string {
  let hash = 0
  for (const char of name) hash = (hash * 31 + char.charCodeAt(0)) | 0
  return ACCENTS[Math.abs(hash) % ACCENTS.length]
}

export function MemberAvatar({
  agent,
  name,
  className,
}: {
  agent: string | null
  name: string
  className?: string
}) {
  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-md border border-border/60 bg-secondary/60",
        className
      )}
    >
      {name === BERTH_MEMBER ? (
        // eslint-disable-next-line @next/next/no-img-element -- 静态导出，直接引用软件图标
        <img src="/icon-32x32.png" alt="" className="size-4" />
      ) : agent ? (
        <AgentProfileIcon
          agentId={agent}
          name={name}
          className="size-4"
          fallback={<AgentIcon agentType={agent} className="size-4" />}
        />
      ) : (
        <span className="text-[11px] font-semibold uppercase text-muted-foreground">
          {name.slice(0, 1)}
        </span>
      )}
    </span>
  )
}

const PROGRESS_STYLE: Record<Progress, string> = {
  done: "text-emerald-600 dark:text-emerald-400",
  working: "text-primary",
  interrupted: "text-destructive",
  delivered: "text-emerald-600 dark:text-emerald-400",
  queued: "text-amber-600 dark:text-amber-400",
  undelivered: "text-destructive",
  superseded: "text-muted-foreground",
}

const PROGRESS_ICON: Record<Progress, typeof Check> = {
  done: Check,
  working: CircleDashed,
  interrupted: AlertCircle,
  delivered: Check,
  queued: Clock,
  undelivered: AlertCircle,
  superseded: CornerDownRight,
}

export function ProgressBadge({
  seq,
  progressOf,
  onOpen,
  compact,
}: {
  seq: number
  progressOf: ProgressOf
  /** 已完成时点击跳到结果。 */
  onOpen?: (seq: number) => void
  /** 群发时每位收件人一个：只显示图标。 */
  compact?: boolean
}) {
  const t = useTranslations("BerthTasks.group.delivery")
  const progress = progressOf(seq)
  if (!progress) return null
  const { state, result } = progress
  const Icon = PROGRESS_ICON[state]
  const title = compact
    ? `${t(state)} · ${t(`${state}Hint`)}`
    : t(`${state}Hint`)
  const className = cn("flex items-center gap-0.5", PROGRESS_STYLE[state])
  const content = (
    <>
      <Icon aria-hidden="true" className="size-3" />
      {compact ? null : t(state)}
    </>
  )
  return result != null && onOpen ? (
    <button
      type="button"
      data-delivery={state}
      title={title}
      className={cn(className, "hover:underline")}
      onClick={() => onOpen(result)}
    >
      {content}
    </button>
  ) : (
    <span data-delivery={state} title={title} className={className}>
      {content}
    </span>
  )
}

/** 群主的消息；一次发给多位成员的几条合成一条，每位收件人各带送达状态。 */
const UserMessage = memo(function UserMessage({
  event,
  batch,
  progressOf,
  onOpen,
  labelOf,
}: {
  event: GroupEvent
  /** 群发合成的整批（含 `event`）；单条消息不传。 */
  batch?: readonly GroupEvent[]
  progressOf: ProgressOf
  onOpen?: (seq: number) => void
  labelOf: (name: string) => string
}) {
  const events = batch ?? [event]
  const first = events[0]
  const many = events.length > 1
  return (
    <div data-group-event="user" className="flex justify-end pl-12">
      <div className="max-w-[85%] space-y-1">
        <p className="whitespace-pre-wrap break-words rounded-2xl rounded-tr-sm bg-primary/10 px-3 py-1.5 text-sm leading-relaxed">
          {first.text ?? ""}
        </p>
        <div className="flex select-none flex-wrap items-center justify-end gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground">
          <span className="min-w-0 truncate text-link">
            {events.map((event) => `@${labelOf(event.to ?? "")}`).join(" ")}
          </span>
          <span className="tabular-nums">{clock(first.timestamp_ms)}</span>
          {many ? null : (
            <ProgressBadge
              seq={first.seq}
              progressOf={progressOf}
              onOpen={onOpen}
            />
          )}
        </div>
      </div>
    </div>
  )
})

/**
 * 消息右上角的动作：回复常驻，复制、跳到出这条结果的终端、转给另一位成员收进「⋯」。
 * 桌面悬停或键盘聚焦时出现；触屏没有悬停，一直显示。
 */
function MessageActions({
  event,
  labelOf,
  onReply,
  forwardTo,
  onForward,
  onOpenTerminal,
}: {
  event: GroupEvent
  labelOf: (name: string) => string
  onReply?: (event: GroupEvent) => void
  forwardTo: readonly string[]
  onForward?: (event: GroupEvent, member: string) => void
  onOpenTerminal?: (targetRef: string) => void
}) {
  const t = useTranslations("BerthTasks.group")
  const others = forwardTo.filter((name) => name !== event.author)
  const copy = async () => {
    if (await copyTextToClipboard(event.text ?? event.digest ?? ""))
      toast.success(t("copied"))
  }
  const pane = event.target_ref ? paneNumber(event.target_ref) : null
  const action =
    "flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
  return (
    <span className="ml-auto flex items-center opacity-0 transition-opacity focus-within:opacity-100 group-hover/msg:opacity-100 [@media(hover:none)]:opacity-100">
      {onReply ? (
        <button
          type="button"
          data-reply-seq={event.seq}
          className={action}
          title={t("focus.reply")}
          aria-label={t("focus.reply")}
          onClick={() => onReply(event)}
        >
          <Reply aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            data-more-seq={event.seq}
            className={action}
            title={t("more")}
            aria-label={t("more")}
          >
            <MoreHorizontal aria-hidden="true" className="size-3.5" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-40">
          <DropdownMenuItem
            data-copy-seq={event.seq}
            onSelect={() => void copy()}
          >
            <Copy aria-hidden="true" className="size-3.5" />
            {t("copy")}
          </DropdownMenuItem>
          {event.target_ref && onOpenTerminal ? (
            <DropdownMenuItem
              onSelect={() => onOpenTerminal(event.target_ref!)}
            >
              <SquareTerminal aria-hidden="true" className="size-3.5" />
              {t("fromTerminal", { number: pane ?? "?" })}
            </DropdownMenuItem>
          ) : null}
          {onForward && others.length > 0 ? (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuLabel className="text-xs">
                {t("forwardTo")}
              </DropdownMenuLabel>
              {others.map((name) => (
                <DropdownMenuItem
                  key={name}
                  data-forward-to={name}
                  onSelect={() => onForward(event, name)}
                >
                  @{labelOf(name)}
                </DropdownMenuItem>
              ))}
            </>
          ) : null}
        </DropdownMenuContent>
      </DropdownMenu>
    </span>
  )
}

/** Agent 之间的委托 / 结果：群聊里折成一行（谁 → 谁、首行、进度），点开看全文。 */
function RelayLine({
  event,
  labelOf,
  progressOf,
  children,
}: {
  event: GroupEvent
  labelOf: (name: string) => string
  progressOf: ProgressOf
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  const headline =
    reportBody(event)
      .split("\n")
      .find((line) => line.trim()) ?? ""
  return (
    <div data-relay={event.seq}>
      <button
        type="button"
        aria-expanded={open}
        className="flex w-full min-w-0 items-center gap-1.5 rounded-md px-1.5 py-0.5 text-left text-xs text-muted-foreground hover:bg-accent/50"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight
          aria-hidden="true"
          className={cn(
            "size-3 shrink-0 transition-transform",
            open && "rotate-90"
          )}
        />
        <span className="shrink-0 font-medium text-foreground/80">
          {labelOf(event.author ?? "?")} → {labelOf(event.to ?? "?")}
        </span>
        <span className="min-w-0 flex-1 truncate">{headline}</span>
        {event.source === "transcript" ? null : (
          <ProgressBadge seq={event.seq} progressOf={progressOf} compact />
        )}
        <span className="shrink-0 tabular-nums">
          {clock(event.timestamp_ms)}
        </span>
      </button>
      {open ? <div className="mt-2">{children}</div> : null}
    </div>
  )
}

const MemberMessage = memo(function MemberMessage({
  event,
  agent,
  labelOf,
  progressOf,
  onOpen,
  onOpenCommit,
  onOpenTerminal,
  onReply,
  forwardTo,
  onForward,
  processOf,
  onOpenFile,
  bare,
}: {
  event: GroupEvent
  agent: string | null
  labelOf: (name: string) => string
  progressOf: ProgressOf
  onOpen?: (seq: number) => void
  onOpenCommit?: (hash: string, subject: string) => void
  onOpenTerminal?: (targetRef: string) => void
  onReply?: (event: GroupEvent) => void
  forwardTo: readonly string[]
  onForward?: (event: GroupEvent, member: string) => void
  processOf?: ProcessSource
  onOpenFile?: (path: string) => void
  /** 挂在群发回答卡里：不画头像、外框，留给卡片统一处理。 */
  bare?: boolean
}) {
  const t = useTranslations("BerthTasks.group")
  const [expanded, setExpanded] = useState(false)
  const [showProcess, setShowProcess] = useState(false)
  const previewId = useId()
  const author = event.author ?? "?"
  const report = event.source === "transcript"
  const process = report ? processOf?.(event) : null
  const body = event.text ?? reportBody(event)
  const [overflow, setOverflow] = useState(false)
  // 用实际 Markdown 高度判断，换行、代码块、列表和窗口宽度都计入预览。
  const measureBody = useCallback((node: HTMLDivElement | null) => {
    if (!node) return
    const measure = () => {
      const lineHeight = parseFloat(getComputedStyle(node).lineHeight) || 24
      setOverflow(node.scrollHeight > lineHeight * FOLD_LINES)
    }
    measure()
    if (typeof ResizeObserver === "undefined") return
    const observer = new ResizeObserver(measure)
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  const commits = event.commits ?? []
  return (
    <div
      data-group-event={report ? "report" : "message"}
      className={cn(
        "group/msg",
        // 成员的话左侧一条它自己的色条，与群主靠右的气泡一眼分开。
        !bare && cn("mr-6 border-l-2 py-0.5 pl-3", memberAccent(author))
      )}
    >
      <div className="min-w-0 space-y-1.5">
        <div className="flex h-7 select-none items-center gap-2 text-xs">
          {bare ? null : (
            <MemberAvatar
              agent={agent}
              name={author}
              className="size-6 rounded-full [&_svg]:size-3.5"
            />
          )}
          <span
            title={author}
            className="text-sm font-semibold text-foreground"
          >
            {labelOf(author)}
          </span>
          {event.to && event.to !== GROUP_USER ? (
            <span className="text-muted-foreground">
              → {/* 成员发的委托与用户委托同样醒目；结果回给成员时保持灰色。 */}
              <span
                data-delegate-to={report ? undefined : event.to}
                className={cn(!report && "font-medium text-link")}
              >
                @{labelOf(event.to)}
              </span>
            </span>
          ) : null}
          <span className="tabular-nums text-muted-foreground">
            {clock(event.timestamp_ms)}
          </span>
          {report ? null : (
            <ProgressBadge
              seq={event.seq}
              progressOf={progressOf}
              onOpen={onOpen}
            />
          )}
          <MessageActions
            event={event}
            labelOf={labelOf}
            onReply={onReply}
            forwardTo={forwardTo}
            onForward={onForward}
            onOpenTerminal={onOpenTerminal}
          />
        </div>
        {process ? (
          <div data-process>
            <button
              type="button"
              data-process-toggle={event.seq}
              aria-expanded={showProcess}
              className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
              onClick={() => setShowProcess((value) => !value)}
            >
              <ChevronRight
                aria-hidden="true"
                className={cn(
                  "size-3 transition-transform",
                  showProcess && "rotate-90"
                )}
              />
              {t("process", {
                duration: elapsedLabel(event.timestamp_ms - process.since),
              })}
            </button>
            {showProcess ? (
              <div className="mt-1">
                <ProcessLog {...process} until={event.timestamp_ms} />
              </div>
            ) : null}
          </div>
        ) : null}
        <div className="text-sm">
          {event.notification ? (
            <p className="mb-1.5 flex items-center gap-1 text-xs text-amber-600 dark:text-amber-400">
              <AlertCircle aria-hidden="true" className="size-3" />
              {event.notification}
            </p>
          ) : null}
          <div
            id={previewId}
            data-agent-message-preview
            className={cn(
              "relative text-sm",
              overflow && !expanded && "max-h-[30rem] overflow-hidden"
            )}
          >
            <div ref={measureBody} data-agent-message-content>
              <MessageResponse className="text-sm">{body}</MessageResponse>
            </div>
            {overflow && !expanded ? (
              <div
                aria-hidden="true"
                className={cn(
                  "pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t to-transparent",
                  "from-background"
                )}
              />
            ) : null}
          </div>
          {overflow ? (
            <div className="mt-1 flex justify-center">
              <button
                type="button"
                className="rounded-full border border-border/60 px-3 py-0.5 text-xs text-muted-foreground hover:border-border hover:text-foreground"
                aria-expanded={expanded}
                aria-controls={previewId}
                onClick={() => setExpanded((value) => !value)}
              >
                {expanded ? t("collapse") : t("expand", { count: body.length })}
              </button>
            </div>
          ) : null}
          {commits.length > 0 ? (
            <div className="mt-2 space-y-0.5 rounded-md border border-border/60 bg-muted/30 p-1.5">
              {commits.map((line) => {
                const commit = splitCommit(line)
                return (
                  <button
                    key={line}
                    type="button"
                    title={t("openCommit")}
                    className="flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-accent"
                    onClick={() => onOpenCommit?.(commit.hash, commit.subject)}
                  >
                    <GitCommitHorizontal
                      aria-hidden="true"
                      className="size-3.5 shrink-0 text-chart-4"
                    />
                    <span className="shrink-0 font-mono text-muted-foreground">
                      {commit.hash}
                    </span>
                    <span className="min-w-0 truncate">{commit.subject}</span>
                  </button>
                )
              })}
              {event.diffstat ? (
                <p className="px-1 text-[11px] text-muted-foreground">
                  {event.diffstat}
                </p>
              ) : null}
            </div>
          ) : null}
          {event.files?.length && event.root ? (
            <FileChanges
              files={event.files}
              root={event.root}
              onOpenFile={onOpenFile}
            />
          ) : null}
        </div>
      </div>
    </div>
  )
})

/** 毫秒 → `1分23秒` / `45秒` 这类时长（过程标签用）。 */
function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000))
  const minutes = Math.floor(seconds / 60)
  return minutes > 0
    ? `${minutes}:${String(seconds % 60).padStart(2, "0")}`
    : `${seconds}s`
}

/** 汇报的过程来源：它的会话或随回答存下的日志行，与提问时间（过程日志从提问读到这条汇报）。 */
export type ProcessSource = (
  event: GroupEvent
) =>
  | { session: LiveSession; since: number }
  | { lines: readonly LogLine[]; since: number }
  | null

/** 提问 → 没有会话可读的成员（Berth）正在回答它时的执行过程。 */
export type LiveLogOf = (ask: GroupEvent) => readonly LogLine[] | null

const FILE_ICON = {
  added: { Icon: FilePlus, className: "text-emerald-600" },
  modified: { Icon: FilePen, className: "text-amber-600" },
  deleted: { Icon: FileMinus, className: "text-destructive" },
} as const

/** 增删行数：`+N` 绿、`−M` 红，为 0 的不显示。 */
function LineCounts({
  added,
  removed,
}: {
  added?: number | null
  removed?: number | null
}) {
  return (
    <span className="shrink-0 font-mono tabular-nums">
      {added ? <span className="text-emerald-600">+{added}</span> : null}
      {added && removed ? " " : null}
      {removed ? <span className="text-destructive">−{removed}</span> : null}
    </span>
  )
}

/** 这一轮改了的文件（带增删行数）：点开在工作区查看（删掉的只列出）。 */
function FileChanges({
  files,
  root,
  onOpenFile,
}: {
  files: NonNullable<GroupEvent["files"]>
  root: string
  onOpenFile?: (path: string) => void
}) {
  const t = useTranslations("BerthTasks.group")
  const sum = (key: "added" | "removed") =>
    files.reduce((total, file) => total + (file[key] ?? 0), 0)
  return (
    <div
      data-turn-files
      className="mt-2 rounded-md border border-border/60 bg-muted/30 p-1"
    >
      <p className="flex items-center gap-2 px-1 text-[11px] text-muted-foreground">
        {t("files", { count: files.length })}
        <LineCounts added={sum("added")} removed={sum("removed")} />
      </p>
      {files.map((file) => {
        const { Icon, className } = FILE_ICON[file.status] ?? FILE_ICON.modified
        const deleted = file.status === "deleted"
        return (
          <button
            key={file.path}
            type="button"
            data-turn-file={file.status}
            disabled={deleted || !onOpenFile}
            title={t(`fileStatus.${file.status}`)}
            className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left text-xs enabled:hover:bg-accent disabled:cursor-default"
            onClick={() =>
              onOpenFile?.(
                isAbsoluteFilePath(file.path)
                  ? file.path
                  : joinRootRel(root, file.path)
              )
            }
          >
            <Icon
              aria-hidden="true"
              className={cn("size-3.5 shrink-0", className)}
            />
            <span
              className={cn(
                "min-w-0 flex-1 truncate font-mono",
                deleted && "text-muted-foreground line-through"
              )}
            >
              {file.path}
            </span>
            <LineCounts added={file.added} removed={file.removed} />
          </button>
        )
      })}
    </div>
  )
}

/**
 * 一句提问的回答，挂在提问下面，不论到达先后。
 * 只发给一位：直接展开回答，没回答时显示它在排队 / 处理中。
 * 发给多位：每位收件人一个标签（带进度），切换着看；「全部」把回答依次展开对比；还没回答的显示进度说明。
 */
function AnswerGroup({
  asks,
  answers,
  agentOf,
  labelOf,
  progressOf,
  onOpen,
  liveSessionOf,
  liveLogOf,
  ...actions
}: {
  liveSessionOf?: (member: string) => LiveSession | null
  liveLogOf?: LiveLogOf
  processOf?: ProcessSource
  onOpenFile?: (path: string) => void
  asks: readonly GroupEvent[]
  answers: readonly GroupEvent[]
  agentOf: (name: string) => string | null
  labelOf: (name: string) => string
  progressOf: ProgressOf
  onOpen?: (seq: number) => void
  onOpenCommit?: (hash: string, subject: string) => void
  onOpenTerminal?: (targetRef: string) => void
  onReply?: (event: GroupEvent) => void
  forwardTo: readonly string[]
  onForward?: (event: GroupEvent, member: string) => void
}) {
  const t = useTranslations("BerthTasks.group")
  const answerOf = (ask: GroupEvent) =>
    answers.filter((answer) => answer.reply_to === ask.seq)
  const [picked, setPicked] = useState<number | null>(null)
  const [all, setAll] = useState(false)
  // 没选过时停在第一个已有回答的收件人上。
  const current =
    asks.find((ask) => ask.seq === picked) ??
    asks.find((ask) => answerOf(ask).length > 0) ??
    asks[0]
  const shown = all ? asks : [current]
  if (asks.length === 1) {
    const replies = answerOf(current)
    const state = progressOf(current.seq)?.state
    const name = current.to ?? ""
    if (replies.length > 0)
      return (
        <div data-answer-group={current.seq} className="space-y-3">
          {replies.map((answer) => (
            <MemberMessage
              key={answer.seq}
              event={answer}
              agent={answer.agent ?? agentOf(answer.author ?? "")}
              labelOf={labelOf}
              progressOf={progressOf}
              onOpen={onOpen}
              {...actions}
            />
          ))}
        </div>
      )
    if (state !== "queued" && state !== "working") return null
    return (
      <div data-answer-group={current.seq}>
        <PendingAnswer
          ask={current}
          state={state}
          label={labelOf(name)}
          agent={agentOf(name)}
          session={liveSessionOf?.(name) ?? null}
          lines={liveLogOf?.(current)}
        />
      </div>
    )
  }
  return (
    <div
      data-answer-group={asks[0].seq}
      className="mr-6 overflow-hidden rounded-lg border border-border/60"
    >
      <div
        role="tablist"
        className="flex items-center gap-1 overflow-x-auto border-b border-border/60 bg-muted/30 px-1.5 py-1"
      >
        {asks.map((ask) => {
          const name = ask.to ?? ""
          const selected = !all && ask.seq === current.seq
          return (
            <button
              key={ask.seq}
              type="button"
              role="tab"
              aria-selected={selected}
              data-answer-tab={name}
              className={cn(
                "flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs transition-colors",
                selected
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground"
              )}
              onClick={() => {
                setPicked(ask.seq)
                setAll(false)
              }}
            >
              <MemberAvatar
                agent={agentOf(name)}
                name={name}
                className="size-4 rounded border-0 bg-transparent [&_svg]:size-3.5"
              />
              {labelOf(name)}
              <ProgressBadge seq={ask.seq} progressOf={progressOf} compact />
            </button>
          )
        })}
        <button
          type="button"
          aria-pressed={all}
          data-answer-all
          className={cn(
            "ml-auto flex h-7 shrink-0 items-center gap-1 rounded-md px-2 text-xs",
            all
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground"
          )}
          onClick={() => setAll((value) => !value)}
        >
          <Layers aria-hidden="true" className="size-3.5" />
          {t("answers.all")}
        </button>
      </div>
      <div className="divide-y divide-border/60">
        {shown.map((ask) => {
          const replies = answerOf(ask)
          const progress = progressOf(ask.seq)
          return (
            <div key={ask.seq} role="tabpanel" className="px-3 py-2">
              {replies.length > 0 ? (
                replies.map((answer) => (
                  <MemberMessage
                    key={answer.seq}
                    event={answer}
                    agent={answer.agent ?? agentOf(answer.author ?? "")}
                    labelOf={labelOf}
                    progressOf={progressOf}
                    onOpen={onOpen}
                    bare
                    {...actions}
                  />
                ))
              ) : progress?.state === "queued" ||
                progress?.state === "working" ? (
                <PendingAnswer
                  ask={ask}
                  state={progress.state}
                  label={labelOf(ask.to ?? "")}
                  agent={agentOf(ask.to ?? "")}
                  session={liveSessionOf?.(ask.to ?? "") ?? null}
                  lines={liveLogOf?.(ask)}
                  bare
                />
              ) : (
                <p className="flex items-center gap-1.5 py-1 text-xs text-muted-foreground">
                  <span className="font-medium text-foreground">
                    {labelOf(ask.to ?? "")}
                  </span>
                  {progress
                    ? t(`delivery.${progress.state}Hint`)
                    : t("answers.waiting")}
                </p>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}

const sameName = (name: string) => name

/**
 * 群时间线：群主的消息靠右（带送达状态，群发合成一条），成员的汇报 / 消息靠左（头像、提交、diffstat），
 * 系统事件居中。与任务无关，知识库问答等其他群组复用。新消息到达且在底部附近时自动滚到底。
 */
export const GroupTimeline = memo(function GroupTimeline({
  events,
  delivery,
  agentOf,
  labelOf = sameName,
  onOpenCommit,
  empty,
  allEvents = events,
  scopeKey = "all",
  context,
  onContext,
  onReply,
  onOpenTerminal,
  forwardTo = [],
  onForward,
  liveSessionOf,
  liveLogOf,
  processOf,
  onOpenFile,
}: {
  events: readonly GroupEvent[]
  delivery: Readonly<Record<string, DeliveryState>>
  /** 成员名 → Agent id（头像）。 */
  agentOf: (name: string) => string | null
  /** 成员名 → 显示名。 */
  labelOf?: (name: string) => string
  onOpenCommit?: (hash: string, subject: string) => void
  empty?: React.ReactNode
  allEvents?: readonly GroupEvent[]
  scopeKey?: string
  context?: { seq: number } | null
  onContext?: (seq: number) => void
  onReply?: (event: GroupEvent) => void
  /** 汇报卡片上的终端编号：跳到出这条结果的终端。 */
  onOpenTerminal?: (targetRef: string) => void
  /** 「转给」可选的成员（在群的）。 */
  forwardTo?: readonly string[]
  /** 把一条回答转给另一位成员（引用它发过去）。 */
  onForward?: (event: GroupEvent, member: string) => void
  /** 成员正在用的会话：进行中的提问下显示它的会话日志。 */
  liveSessionOf?: (member: string) => LiveSession | null
  /** 没有会话可读的成员（Berth）正在回答时的执行过程。 */
  liveLogOf?: LiveLogOf
  /** 汇报的过程日志来源（默认折叠）。 */
  processOf?: ProcessSource
  /** 在工作区打开一个文件（汇报里改了的文件）。 */
  onOpenFile?: (path: string) => void
}) {
  const t = useTranslations("BerthTasks.group")
  const contextSeq = context?.seq
  const scrollRef = useRef<HTMLDivElement>(null)
  const stickRef = useRef(true)
  const lastSeqRef = useRef(0)
  const contentRef = useRef<HTMLDivElement>(null)
  const positions = useRef(
    new Map<string, { top: number; bottom: boolean; seen: number }>()
  )
  const previousScope = useRef(scopeKey)
  const eventBySeq = useMemo(
    () => new Map(allEvents.map((event) => [event.seq, event])),
    [allEvents]
  )
  const progressOf = useMemo(
    () => delegationProgress(allEvents, delivery),
    [allEvents, delivery]
  )
  const items = useMemo(() => timelineItems(events), [events])
  const heads = useMemo(
    () =>
      items.map((item) => (item.kind === "ask" ? item.events[0] : item.event)),
    [items]
  )
  // 只挂载末尾一页；跳转上下文时把目标所在位置一并展开。
  const [pageScope, setPageScope] = useState(scopeKey)
  const [limit, setLimit] = useState(PAGE_ITEMS)
  if (pageScope !== scopeKey) {
    setPageScope(scopeKey)
    setLimit(PAGE_ITEMS)
  }
  const contextIndex =
    contextSeq == null
      ? -1
      : items.findIndex((item) =>
          (item.kind === "ask"
            ? [...item.events, ...item.answers]
            : [item.event]
          ).some((event) => event.seq === contextSeq)
        )
  const start = Math.max(
    0,
    Math.min(
      items.length - limit,
      contextIndex >= 0 ? contextIndex : Number.POSITIVE_INFINITY
    )
  )
  const visible = start > 0 ? items.slice(start) : items
  const visibleHeads = start > 0 ? heads.slice(start) : heads
  // 展开更早的一页时保持当前阅读位置：恢复到展开前距底部的距离。
  const restoreFromBottom = useRef<number | null>(null)
  const showEarlier = () => {
    const node = scrollRef.current
    if (node) restoreFromBottom.current = node.scrollHeight - node.scrollTop
    setLimit((value) => value + PAGE_ITEMS)
  }
  useLayoutEffect(() => {
    const node = scrollRef.current
    if (!node || restoreFromBottom.current == null) return
    node.scrollTop = node.scrollHeight - restoreFromBottom.current
    restoreFromBottom.current = null
  }, [limit])
  const tail = items[items.length - 1]
  const lastSeq = !tail
    ? 0
    : tail.kind === "ask"
      ? Math.max(...[...tail.events, ...tail.answers].map((event) => event.seq))
      : tail.event.seq
  // 用户离开底部时看到的最后一条；之后来的算「新消息」。
  const [atBottom, setAtBottom] = useState(true)
  const [seenSeq, setSeenSeq] = useState(0)
  const newCount = heads.filter(
    (event) => event.kind === "message" && event.seq > seenSeq
  ).length
  const behind = !atBottom && newCount > 0

  useLayoutEffect(() => {
    lastSeqRef.current = lastSeq
    const node = scrollRef.current
    if (!node) return
    if (previousScope.current !== scopeKey) {
      previousScope.current = scopeKey
      const saved = positions.current.get(scopeKey)
      stickRef.current = saved?.bottom ?? true
      setAtBottom(stickRef.current)
      setSeenSeq(saved?.seen ?? lastSeq)
      node.scrollTop = saved && !saved.bottom ? saved.top : node.scrollHeight
    } else if (stickRef.current) {
      node.scrollTop = node.scrollHeight
      setSeenSeq(lastSeq)
    }
  }, [lastSeq, scopeKey])

  useLayoutEffect(() => {
    if (contextSeq == null) return
    const node = scrollRef.current
    const target = node?.querySelector<HTMLElement>(
      `[data-event-seqs~="${contextSeq}"]`
    )
    if (!node || !target) return
    stickRef.current = false
    node.scrollTop +=
      target.getBoundingClientRect().top - node.getBoundingClientRect().top - 16
  }, [context, contextSeq])

  useEffect(() => {
    if (typeof ResizeObserver === "undefined" || !contentRef.current) return
    const observer = new ResizeObserver(() => {
      const node = scrollRef.current
      if (node && stickRef.current) node.scrollTop = node.scrollHeight
    })
    observer.observe(contentRef.current)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const node = scrollRef.current
    if (!node) return
    const onScroll = () => {
      const bottom =
        node.scrollHeight - node.scrollTop - node.clientHeight < STICK_PX
      stickRef.current = bottom
      setAtBottom(bottom)
      if (bottom) setSeenSeq(lastSeqRef.current)
      const saved = positions.current.get(scopeKey)
      positions.current.set(scopeKey, {
        top: node.scrollTop,
        bottom,
        seen: bottom ? lastSeqRef.current : (saved?.seen ?? lastSeqRef.current),
      })
    }
    node.addEventListener("scroll", onScroll, { passive: true })
    return () => node.removeEventListener("scroll", onScroll)
  }, [scopeKey])

  const toBottom = () => {
    const node = scrollRef.current
    if (!node) return
    node.scrollTo({ top: node.scrollHeight, behavior: "smooth" })
  }

  // 跨天处插日期分隔。
  const dayBreaks = new Set(
    visibleHeads
      .filter(
        (event, index) =>
          index === 0 ||
          day(event.timestamp_ms) !== day(visibleHeads[index - 1].timestamp_ms)
      )
      .map((event) => event.seq)
  )
  return (
    <div className="relative min-h-0 flex-1">
      <div
        ref={scrollRef}
        data-group-timeline
        className="h-full overflow-y-auto px-5 py-4"
      >
        <div ref={contentRef} className="min-h-full space-y-3 select-text">
          {items.length === 0 ? (
            <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
              {empty ?? t("noEvents")}
            </div>
          ) : null}
          {start > 0 ? (
            <div className="flex justify-center">
              <button
                type="button"
                data-group-earlier={start}
                className="rounded-full bg-muted/70 px-3 py-0.5 text-xs text-muted-foreground hover:text-foreground"
                onClick={showEarlier}
              >
                {t("focus.earlier", { count: start })}
              </button>
            </div>
          ) : null}
          {visible.map((item, index) => {
            const event = item.kind === "ask" ? item.events[0] : item.event
            const previous = index > 0 ? visible[index - 1] : null
            // 回的正是紧挨着的上一条：不再画引用条。
            const quoteAdjacent =
              previous != null &&
              (previous.kind === "ask"
                ? previous.events
                : [previous.event]
              ).some((other) => other.seq === event.reply_to)
            const actions = {
              onReply,
              forwardTo,
              onForward,
              onOpenCommit,
              onOpenTerminal,
              processOf,
              onOpenFile,
            }
            const separator = dayBreaks.has(event.seq) ? (
              <div className="flex items-center gap-3 py-1 text-[11px] text-muted-foreground">
                <span className="h-px flex-1 bg-border/60" />
                {day(event.timestamp_ms)}
                <span className="h-px flex-1 bg-border/60" />
              </div>
            ) : null
            let node: React.ReactNode = null
            if (item.kind === "ask") {
              node = (
                <>
                  <UserMessage
                    event={event}
                    batch={item.events}
                    progressOf={progressOf}
                    onOpen={onContext}
                    labelOf={labelOf}
                  />
                  <div className="mt-3 empty:hidden">
                    <AnswerGroup
                      asks={item.events}
                      answers={item.answers}
                      agentOf={agentOf}
                      labelOf={labelOf}
                      progressOf={progressOf}
                      onOpen={onContext}
                      liveSessionOf={liveSessionOf}
                      liveLogOf={liveLogOf}
                      {...actions}
                    />
                  </div>
                </>
              )
            } else if (event.kind === "message") {
              const message = (
                <MemberMessage
                  event={event}
                  agent={event.agent ?? agentOf(event.author ?? "")}
                  labelOf={labelOf}
                  progressOf={progressOf}
                  onOpen={onContext}
                  {...actions}
                />
              )
              node = isRelay(event) ? (
                <RelayLine
                  event={event}
                  labelOf={labelOf}
                  progressOf={progressOf}
                >
                  {message}
                </RelayLine>
              ) : (
                message
              )
            }
            return node ? (
              <div
                key={event.seq}
                data-event-seq={event.seq}
                data-event-seqs={(item.kind === "ask"
                  ? [...item.events, ...item.answers]
                  : [event]
                )
                  .map((event) => event.seq)
                  .join(" ")}
                className={cn(
                  "rounded-lg",
                  (item.kind === "ask"
                    ? [...item.events, ...item.answers]
                    : [event]
                  ).some((event) => event.seq === contextSeq) &&
                    "ring-2 ring-primary/60"
                )}
              >
                {separator}
                {event.reply_to != null && !quoteAdjacent && !isRelay(event) ? (
                  <button
                    type="button"
                    className="mb-1 block max-w-full truncate border-l-2 border-primary/50 pl-2 text-left text-xs text-muted-foreground hover:text-foreground"
                    disabled={!eventBySeq.has(event.reply_to)}
                    onClick={() => onContext?.(event.reply_to!)}
                  >
                    {eventBySeq.has(event.reply_to)
                      ? `${labelOf(eventBySeq.get(event.reply_to)?.author ?? "?")}: ${reportBody(eventBySeq.get(event.reply_to)!)}`
                      : t("focus.original")}
                  </button>
                ) : null}
                {node}
              </div>
            ) : null
          })}
        </div>
      </div>
      {behind ? (
        <Button
          size="sm"
          variant="secondary"
          className="absolute bottom-3 left-1/2 h-7 -translate-x-1/2 gap-1 rounded-full text-xs shadow"
          onClick={toBottom}
        >
          <ArrowDown aria-hidden="true" className="size-3.5" />
          {t("focus.newCount", { count: newCount })}
        </Button>
      ) : null}
    </div>
  )
})
