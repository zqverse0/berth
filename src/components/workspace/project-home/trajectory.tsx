"use client"

/**
 * 首页「Agent 轨迹」：一个会话一条泳道，一个节点 = 一问，柱子 = 这一问里的工具调用（颜色 = 类型）。
 * 点节点就地展开这一问（提问、调用清单、回答开头），不跳走；「打开会话」才去会话页。
 * 悬停「最近变更」的文件时，改过它的柱子高亮（`focusFile`）。
 */

import { useEffect, useRef, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import type { ToolKindLabel } from "@/lib/adapters/tool-kind-classifier"
import { cn } from "@/lib/utils"
import { useOpenProjectSession } from "@/sessions/project/open-project-session"
import type { TrajectoryLane, TrajectoryTurn } from "./use-trajectory"

const TICK_LIMIT = 40

/** 图例里列出的类型；其余（思考、待办、子任务……）归「其他」 */
const LEGEND = ["read", "edit", "command", "search", "fetch"] as const
const KIND_CLASS: Partial<Record<ToolKindLabel, string>> = {
  read: "bg-chart-5",
  edit: "bg-primary",
  command: "bg-chart-2",
  search: "bg-chart-3",
  fetch: "bg-chart-4",
}
const kindClass = (kind: ToolKindLabel) =>
  KIND_CLASS[kind] ?? "bg-muted-foreground/50"

export function TrajectoryLegend() {
  const t = useTranslations("ProjectHome.trajectory.kinds")
  return (
    <span className="flex flex-wrap gap-x-2.5 gap-y-0.5">
      {LEGEND.map((kind) => (
        <span key={kind} className="inline-flex items-center gap-1">
          <i className={cn("size-2 rounded-[2px]", kindClass(kind))} />
          {t(kind)}
        </span>
      ))}
    </span>
  )
}

export function Trajectory({
  folderId,
  lanes,
  focusFile,
}: {
  folderId: number
  lanes: TrajectoryLane[]
  focusFile: string | null
}) {
  const t = useTranslations("ProjectHome.trajectory")
  if (lanes.length === 0)
    return <p className="py-2 text-xs text-muted-foreground">{t("empty")}</p>
  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      {lanes.map((lane) => (
        <Lane
          key={lane.key}
          folderId={folderId}
          lane={lane}
          focusFile={focusFile}
        />
      ))}
    </div>
  )
}

function Lane({
  folderId,
  lane,
  focusFile,
}: {
  folderId: number
  lane: TrajectoryLane
  focusFile: string | null
}) {
  const t = useTranslations("ProjectHome.trajectory")
  const format = useFormatter()
  const openSession = useOpenProjectSession(folderId)
  const [selected, setSelected] = useState<string | null>(null)
  const track = useRef<HTMLDivElement>(null)
  const turns = lane.turns ?? []
  const calls = turns.reduce((sum, turn) => sum + turn.calls.length, 0)
  const lastKey = turns[turns.length - 1]?.key
  const turn = turns.find((item) => item.key === selected) ?? null

  // 最新的一问在最右：有新的一问时滚到底
  useEffect(() => {
    const element = track.current
    if (element) element.scrollLeft = element.scrollWidth
  }, [lastKey])

  return (
    <div
      className={cn(
        "grid border-t first:border-t-0 @2xl:grid-cols-[160px_1fr]",
        !lane.live && "opacity-65"
      )}
    >
      <div className="min-w-0 px-3 pt-2.5 text-xs @2xl:border-r @2xl:pb-2.5">
        <div className="flex items-center gap-1.5 font-semibold">
          <span
            className={cn(
              "size-1.5 shrink-0 rounded-full bg-muted-foreground",
              lane.live && "berth-harbor-pulse bg-chart-2"
            )}
          />
          <span className="truncate">{lane.item.agent}</span>
          {lane.item.liveMember && (
            <span className="truncate font-normal text-muted-foreground">
              · {lane.item.liveMember}
            </span>
          )}
        </div>
        <div
          className="truncate text-[11px] text-muted-foreground"
          title={lane.item.title ?? undefined}
        >
          {lane.item.title || lane.item.groupName}
        </div>
        <div className="text-[11px] text-muted-foreground">
          {lane.turns == null
            ? "…"
            : t("count", { turns: turns.length, calls })}
        </div>
      </div>

      <div ref={track} className="min-w-0 overflow-x-auto px-3 py-2.5">
        <div className="flex min-w-max items-end gap-2.5">
          {turns.map((item) => (
            <TurnNode
              key={item.key}
              turn={item}
              selected={item.key === selected}
              running={lane.live && item.key === lastKey && !item.answer}
              focusFile={focusFile}
              time={
                item.startedAt
                  ? format.dateTime(new Date(item.startedAt), {
                      hour: "2-digit",
                      minute: "2-digit",
                    })
                  : ""
              }
              onSelect={() =>
                setSelected((prev) => (prev === item.key ? null : item.key))
              }
            />
          ))}
          {lane.turns != null && turns.length === 0 && (
            <span className="text-xs text-muted-foreground">
              {t("noTurns")}
            </span>
          )}
        </div>
      </div>

      {turn && (
        <div className="border-t border-dashed bg-muted/40 px-3.5 py-2.5 text-xs @2xl:col-span-2">
          <div className="mb-1.5 line-clamp-3 text-sm whitespace-pre-wrap">
            <b className="mr-1">#{turn.index}</b>
            {turn.prompt}
          </div>
          <div className="grid max-h-56 gap-0.5 overflow-y-auto">
            {turn.calls.map((call, index) => (
              <div key={index} className="flex min-w-0 items-center gap-2">
                <i
                  className={cn(
                    "size-1.5 shrink-0 rounded-[2px]",
                    kindClass(call.kind)
                  )}
                />
                <span
                  className="min-w-0 truncate font-mono text-muted-foreground"
                  title={call.title}
                >
                  {call.title}
                </span>
              </div>
            ))}
          </div>
          <div className="mt-2 line-clamp-3 border-l-2 pl-2 whitespace-pre-wrap text-muted-foreground">
            {turn.answer ?? (lane.live ? t("running") : "—")}
          </div>
          {lane.item.sessionId && (
            <button
              type="button"
              onClick={() =>
                void openSession({
                  agent: lane.item.agent,
                  sessionId: lane.item.sessionId!,
                  cwd: lane.item.cwd,
                  title: lane.item.title,
                })
              }
              className="mt-2 rounded-md border bg-card px-2.5 py-0.5 hover:bg-accent"
            >
              {t("open")}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

function TurnNode({
  turn,
  selected,
  running,
  focusFile,
  time,
  onSelect,
}: {
  turn: TrajectoryTurn
  selected: boolean
  running: boolean
  focusFile: string | null
  time: string
  onSelect: () => void
}) {
  const shown = turn.calls.slice(-TICK_LIMIT)
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-expanded={selected}
      title={turn.prompt}
      className={cn(
        "flex max-w-40 flex-col items-start gap-1 rounded-md border border-transparent px-1.5 py-1 text-left hover:bg-accent",
        selected && "border-primary/50 bg-accent"
      )}
    >
      <span className="text-[10px] text-muted-foreground">
        #{turn.index} · {time}
      </span>
      <span className="flex h-4 items-end gap-0.5">
        {turn.calls.length > shown.length && (
          <span className="mr-0.5 text-[9px] text-muted-foreground">
            +{turn.calls.length - shown.length}
          </span>
        )}
        {shown.map((call, index) => {
          const hit = focusFile != null && call.files.includes(focusFile)
          return (
            <i
              key={index}
              className={cn(
                "h-3 w-1 rounded-[1px] transition-[opacity,transform]",
                kindClass(call.kind),
                focusFile != null && !hit && "opacity-20",
                hit && "origin-bottom scale-y-[1.35]"
              )}
            />
          )
        })}
        {running && (
          <i className="berth-harbor-pulse h-3 w-1 rounded-[1px] bg-chart-2" />
        )}
      </span>
      <span
        className={cn(
          "w-full truncate text-[11px] text-muted-foreground",
          running && "text-primary"
        )}
      >
        {turn.prompt || "…"}
      </span>
    </button>
  )
}
