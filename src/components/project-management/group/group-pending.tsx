"use client"

import { useEffect, useMemo, useState } from "react"
import { useNow, useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"
import { agentTypeForTool } from "@/hooks/use-agent-profiles"
import { resolveProjectAgentSession } from "@/lib/api"
import type { GroupEvent, GroupLogLine } from "@/lib/agent/berth-group"
import type { MessageTurn } from "@/lib/types"
import { cn } from "@/lib/utils"
import { trimSlash } from "@/sessions/project/open-project-session"
import {
  useTranscriptDetail,
  useTranscriptLiveSync,
} from "@/sessions/transcript-view-store"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { MemberAvatar, memberAccent } from "./group-timeline"

/** 成员正在用的会话：工具 id、会话 id、会话目录（定位它所在的项目）。 */
export interface LiveSession {
  folderId: number
  agent: string
  sessionId: string
  cwd: string | null
}

const LOG_LINES = 3
/** 这么久没有新记录就提示可能卡住（或停在确认框）。 */
const QUIET_MS = 90_000

export type LogLine = GroupLogLine

const firstLine = (text: string | null | undefined, max = 120) =>
  (text ?? "")
    .split("\n")
    .find((line) => line.trim())
    ?.trim()
    .slice(0, max) ?? ""

/** 与会话读取（Rust `tool_target`）同一规则：常见参数名优先，否则第一个字符串参数。 */
const TARGET_KEYS = [
  "command",
  "cmd",
  "file_path",
  "path",
  "pattern",
  "url",
  "query",
]

/** 工具参数预览里最能说明「对谁做」的一项；预览被截断、解析不了时按键名从文本里找。 */
export function toolTarget(preview: string | null | undefined): string {
  if (!preview) return ""
  try {
    const input: unknown = JSON.parse(preview)
    if (input && typeof input === "object" && !Array.isArray(input)) {
      const values = input as Record<string, unknown>
      const text = (value: unknown) =>
        typeof value === "string"
          ? value
          : Array.isArray(value) && value.every((v) => typeof v === "string")
            ? value.join(" ")
            : null
      return (
        TARGET_KEYS.map((key) => text(values[key])).find(Boolean) ??
        Object.values(values).map(text).find(Boolean) ??
        ""
      )
    }
  } catch {
    const match = preview.match(
      new RegExp(
        `"(?:${TARGET_KEYS.join("|")})"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`
      )
    )
    if (match) return match[1].replace(/\\(.)/g, "$1")
  }
  return preview
}

/**
 * `[since, until]` 之间 Agent 的动作：思考、工具调用、正文首行、报错（各一行），
 * 与这段里最后一次写入的时间。
 */
export function sessionLog(
  turns: readonly MessageTurn[],
  since: number,
  until = Number.POSITIVE_INFINITY
): { lines: LogLine[]; updatedAt: number | null } {
  const lines: LogLine[] = []
  let updatedAt: number | null = null
  for (const turn of turns) {
    const at = Date.parse(turn.completed_at ?? turn.timestamp)
    if (!(at >= since && at <= until)) continue
    updatedAt = Math.max(updatedAt ?? 0, at)
    for (const block of turn.blocks) {
      if (block.type === "tool_use") {
        const target = firstLine(toolTarget(block.input_preview), 80)
        lines.push({
          text: `→ ${block.tool_name}${target ? ` ${target}` : ""}`,
        })
      } else if (block.type === "tool_result" && block.is_error) {
        lines.push({
          text: `✗ ${firstLine(block.output_preview)}`,
          error: true,
        })
      } else if (block.type === "thinking") {
        const text = firstLine(block.text)
        if (text) lines.push({ text, thinking: true })
      } else if (block.type === "text" && turn.role === "assistant") {
        const text = firstLine(block.text)
        if (text) lines.push({ text })
      }
    }
  }
  return { lines, updatedAt }
}

/** 日志的一行：报错标红，思考弱化。 */
function LogRow({ line }: { line: LogLine }) {
  return (
    <p
      className={cn(
        "truncate",
        line.error && "text-destructive",
        line.thinking && "italic opacity-70"
      )}
    >
      {line.text}
    </p>
  )
}

/** 秒数 → `m:ss`。 */
function elapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`
}

/** 成员会话 → 会话库里的会话 id（解析不到为 null；不为此打开新项目）。 */
function useConversationId(session: LiveSession | null): number | null {
  const [resolved, setResolved] = useState<{ key: string; id: number } | null>(
    null
  )
  const key = session ? `${session.agent}:${session.sessionId}` : ""
  const folderId = useAppWorkspaceStore((state) => {
    if (!session) return null
    const cwd = session.cwd && trimSlash(session.cwd)
    return (
      state.allFolders.find((folder) => trimSlash(folder.path) === cwd)?.id ??
      session.folderId
    )
  })
  useEffect(() => {
    if (!session || folderId == null) return
    const agentType = agentTypeForTool(session.agent)
    if (!agentType) return
    let live = true
    resolveProjectAgentSession({
      folderId,
      agentType,
      externalId: session.sessionId,
    }).then(
      (result) => {
        const id = result.conversation?.id
        if (live && id != null) setResolved({ key, id })
      },
      () => {}
    )
    return () => {
      live = false
    }
    // session 每次渲染是新对象：按 key 与目录重解析。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, folderId])
  return resolved?.key === key ? resolved.id : null
}

/** 会话日志：提问之后的最近几行，随会话文件写入刷新。 */
function LiveLog({
  conversationId,
  since,
  now,
}: {
  conversationId: number
  since: number
  now: number
}) {
  const t = useTranslations("BerthTasks.group.pending")
  useTranscriptLiveSync(conversationId)
  const { detail } = useTranscriptDetail(conversationId)
  const { lines, updatedAt } = useMemo(
    () => sessionLog(detail?.turns ?? [], since),
    [detail, since]
  )
  const quiet = updatedAt != null && now - updatedAt > QUIET_MS
  return (
    <RecentLines lines={lines}>
      {updatedAt != null ? (
        <p
          className={cn(
            "font-sans",
            quiet ? "text-amber-700 dark:text-amber-400" : "opacity-70"
          )}
        >
          {quiet
            ? t("quiet", { minutes: Math.floor((now - updatedAt) / 60_000) })
            : t("updated", {
                seconds: Math.max(0, Math.floor((now - updatedAt) / 1000)),
              })}
        </p>
      ) : null}
    </RecentLines>
  )
}

/** 最近几行日志；还没有时说在等。 */
function RecentLines({
  lines,
  children,
}: {
  lines: readonly LogLine[]
  children?: React.ReactNode
}) {
  const t = useTranslations("BerthTasks.group.pending")
  return (
    <div
      data-pending-log
      className="min-w-0 flex-1 rounded-md border border-border/60 bg-muted/30 px-2 py-1 font-mono text-[11px] leading-5 text-muted-foreground"
    >
      {lines.length === 0 ? (
        <p>{t("waitingLog")}</p>
      ) : (
        lines
          .slice(-LOG_LINES)
          .map((line, index) => <LogRow key={index} line={line} />)
      )}
      {children}
    </div>
  )
}

/**
 * 提问下「还没有结果」的那一行：左边计时（排队 / 思考中），右边它会话日志的最近几行，
 * 看得出它在动、报错了还是停住了。窄屏上下排。没有会话可读的成员（Berth）直接给 `lines`。
 */
export function PendingAnswer({
  ask,
  state,
  label,
  agent,
  session,
  lines,
  bare,
}: {
  ask: GroupEvent
  state: "queued" | "working"
  label: string
  agent: string | null
  session: LiveSession | null
  lines?: readonly LogLine[] | null
  /** 挂在群发回答卡里：不画头像。 */
  bare?: boolean
}) {
  const t = useTranslations("BerthTasks.group.pending")
  const now = useNow({ updateInterval: 1000 }).getTime()
  const conversationId = useConversationId(state === "working" ? session : null)
  return (
    <div
      data-answer-pending={state}
      className={cn(
        "@container flex flex-col gap-1.5 text-xs @md:flex-row @md:items-start",
        !bare && cn("mr-6 border-l-2 py-0.5 pl-3", memberAccent(ask.to ?? ""))
      )}
    >
      <div className="flex h-6 shrink-0 items-center gap-2 text-muted-foreground">
        {bare ? null : (
          <MemberAvatar
            agent={agent}
            name={ask.to ?? ""}
            className="size-6 [&_svg]:size-3.5"
          />
        )}
        <span className="font-medium text-foreground">{label}</span>
        <Loader2
          aria-hidden="true"
          className={cn("size-3", state === "working" && "animate-spin")}
        />
        {t(state)}
        <span className="tabular-nums">{elapsed(now - ask.timestamp_ms)}</span>
      </div>
      {lines ? (
        <RecentLines lines={lines} />
      ) : conversationId != null ? (
        <LiveLog
          conversationId={conversationId}
          since={ask.timestamp_ms}
          now={now}
        />
      ) : null}
    </div>
  )
}

/**
 * 已完成回答的过程日志（默认折叠，展开时才读会话）：从提问到这条回答之间它做了什么。
 * 过程随回答存下的（Berth）直接给 `lines`。
 */
export function ProcessLog({
  session,
  lines,
  since,
  until,
}: {
  session?: LiveSession
  lines?: readonly LogLine[]
  since: number
  until: number
}) {
  const t = useTranslations("BerthTasks.group.pending")
  const conversationId = useConversationId(session ?? null)
  if (lines) return <AllLines lines={lines} empty={t("noLog")} />
  return conversationId == null ? (
    <p className="text-xs text-muted-foreground">{t("waitingLog")}</p>
  ) : (
    <FullLog conversationId={conversationId} since={since} until={until} />
  )
}

function FullLog({
  conversationId,
  since,
  until,
}: {
  conversationId: number
  since: number
  until: number
}) {
  const t = useTranslations("BerthTasks.group.pending")
  const { detail } = useTranscriptDetail(conversationId)
  const { lines } = useMemo(
    () => sessionLog(detail?.turns ?? [], since, until),
    [detail, since, until]
  )
  return (
    <AllLines lines={lines} empty={detail ? t("noLog") : t("waitingLog")} />
  )
}

function AllLines({
  lines,
  empty,
}: {
  lines: readonly LogLine[]
  empty: string
}) {
  return (
    <div
      data-process-log
      className="max-h-60 overflow-y-auto rounded-md border border-border/60 bg-muted/30 px-2 py-1 font-mono text-[11px] leading-5 text-muted-foreground"
    >
      {lines.length === 0 ? (
        <p>{empty}</p>
      ) : (
        lines.map((line, index) => <LogRow key={index} line={line} />)
      )}
    </div>
  )
}
