"use client"

import { useEffect, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { Loader2 } from "lucide-react"
import { MessageResponse } from "@/components/ai-elements/message"
import {
  readBerthRecord,
  type BerthRecord,
  type BerthRecordItem,
  type BerthRecordTurn,
  type BerthUsage,
} from "@/lib/agent/berth-group"
import type { BerthSessionWorkspaceTab } from "@/lib/files/file-workspace-tab"
import { cn } from "@/lib/utils"
import { toolTarget } from "./group-pending"

/**
 * Berth 一个会话的对话记录（工作区标签页，成员卡片的会话列表里打开）：每一轮的提问、模型的话、
 * 工具调用（参数与完整输出，默认折叠）、回答与用量。切回这个标签时重读，看到最新的轮次。
 */
export function BerthSessionView({ tab }: { tab: BerthSessionWorkspaceTab }) {
  const t = useTranslations("BerthTasks.group.members.recordView")
  const [record, setRecord] = useState<BerthRecord | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    void readBerthRecord(tab.folderId, tab.session).then((response) => {
      if (!live) return
      if (response.ok) setRecord(response.result)
      else setError(response.error.message)
    })
    return () => {
      live = false
    }
  }, [tab.folderId, tab.session])
  return (
    <div data-berth-record className="h-full overflow-y-auto">
      <div className="mx-auto max-w-3xl px-5 py-4">
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : record == null ? (
          <Loader2
            aria-label={t("loading")}
            className="mx-auto size-4 animate-spin text-muted-foreground"
          />
        ) : record.turns.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("empty")}</p>
        ) : (
          <ol className="space-y-5">
            {record.turns.map((turn) => (
              <RecordTurn key={turn.ask} turn={turn} />
            ))}
          </ol>
        )}
      </div>
    </div>
  )
}

function RecordTurn({ turn }: { turn: BerthRecordTurn }) {
  const t = useTranslations("BerthTasks.group.members.recordView")
  const format = useFormatter()
  return (
    <li data-record-turn={turn.ask} className="space-y-2">
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        {turn.at != null ? (
          <span className="tabular-nums">
            {format.dateTime(new Date(turn.at), {
              month: "numeric",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
            })}
          </span>
        ) : null}
        {turn.model ? <span className="font-mono">{turn.model}</span> : null}
        {turn.usage ? <UsageLine usage={turn.usage} /> : null}
      </div>
      <div className="ml-auto max-w-[85%] whitespace-pre-wrap rounded-lg bg-primary/10 px-3 py-2 text-sm">
        {turn.text}
      </div>
      {/* 被停下或出错的一轮只存了那句回答：过程看当时的日志。 */}
      {!turn.complete && turn.steps?.length ? (
        <div className="rounded-md border border-border/60 bg-muted/30 px-2 py-1 font-mono text-[11px] leading-5 text-muted-foreground">
          {turn.steps.map((line, index) => (
            <p
              key={index}
              className={cn("truncate", line.error && "text-destructive")}
            >
              {line.text}
            </p>
          ))}
        </div>
      ) : null}
      {turn.items.map((item, index) => (
        <RecordItem key={index} item={item} />
      ))}
      {turn.complete ? null : (
        <p className="text-[11px] text-muted-foreground">{t("incomplete")}</p>
      )}
    </li>
  )
}

/** 模型的话按 Markdown 显示；工具调用一行摘要，展开看参数与完整输出。 */
function RecordItem({ item }: { item: BerthRecordItem }) {
  const t = useTranslations("BerthTasks.group.members.recordView")
  if (item.kind === "text")
    return <MessageResponse className="text-sm">{item.text}</MessageResponse>
  const args = JSON.stringify(item.args, null, 2)
  const target = toolTarget(JSON.stringify(item.args)).split("\n")[0]
  return (
    <details
      data-record-tool={item.name}
      className="rounded-md border border-border/60 bg-muted/30 text-xs"
    >
      <summary
        className={cn(
          "cursor-pointer truncate px-2 py-1 font-mono text-muted-foreground",
          item.failed && "text-destructive"
        )}
      >
        {item.failed ? "✗" : "→"} {item.name} {target}
      </summary>
      <div className="space-y-1 border-t border-border/60 px-2 py-1.5">
        <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-[11px]">
          {args}
        </pre>
        <pre
          className={cn(
            "max-h-80 overflow-auto whitespace-pre-wrap break-all border-t border-border/40 pt-1 font-mono text-[11px]",
            item.failed && "text-destructive"
          )}
        >
          {item.output ?? t("noOutput")}
        </pre>
      </div>
    </details>
  )
}

function UsageLine({ usage }: { usage: BerthUsage }) {
  const t = useTranslations("BerthTasks.group.members.recordView")
  const format = useFormatter()
  const n = (value: number) =>
    format.number(value, { notation: "compact", maximumFractionDigits: 1 })
  return (
    <span data-record-usage className="tabular-nums">
      {t("usage", {
        calls: usage.calls,
        input: n(usage.input),
        output: n(usage.output),
        cached: n(usage.cached),
        context: n(usage.context),
      })}
    </span>
  )
}
