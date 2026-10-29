"use client"

/**
 * 港湾：一个泊位 = 一个 worktree，船 = 在那里干活的 Agent。
 * 满帆起伏 = 有 Agent 在干活；靠岸收帆 = 有 Agent 但都没在干活；灰色空船 = 没有 Agent；
 * 甲板货箱 = 未提交的改动；船头 `!` = 有 Agent 等你处理。下方卡片用文字写明同样的事：
 * 任务与步骤进度、实时 +/- 行数、Agent 此刻在做什么。
 * 容器够宽时船停在卡片正上方的水面；窄（手机、窄栏）时竖排卡片，船缩进卡片左侧。
 * 动画都在 HTML 层只动 transform（globals.css `.berth-harbor-*`）。
 */

import type { CSSProperties } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import { useWorkspaceStateStore } from "@/hooks/workspace/use-workspace-state-store"
import type { PaneAgentState } from "@/lib/terminal/agent-panes"
import { cn } from "@/lib/utils"
import { AFT_SAIL, FORE_SAIL, HULL, MAIN_SAIL } from "./boat-layout"
import { LineCounts } from "./recent-changes"
import type { WorktreeGit } from "./use-home-data"

/** 分到这个 worktree 的任务；`done` = 已提交的步骤数。 */
export interface BerthTask {
  title: string
  done: number
  total: number
}

export interface HarborBerth {
  folderId: number
  path: string
  name: string
  /** 分支名；detached 时为短哈希 */
  branch: string | null
  current: boolean
  git: WorktreeGit | undefined
  /** null = 没有分到任务；undefined = 项目没启用 Berth，不显示任务行 */
  task: BerthTask | null | undefined
  /** 已退出的终端不算 */
  agents: {
    terminalId: string
    agent: string
    state: Exclude<PaneAgentState, "exited">
    /** 终端标题（Agent 多半把它设成当前在做的事） */
    title: string
    notification: string | null
  }[]
}

type BoatState = "sailing" | "docked" | "empty"

const boatState = (berth: HarborBerth): BoatState =>
  berth.agents.some((a) => a.state === "working")
    ? "sailing"
    : berth.agents.length > 0
      ? "docked"
      : "empty"

function Boat({ state, crates }: { state: BoatState; crates: number }) {
  return (
    <svg viewBox="0 0 1024 1024" className="h-full w-full overflow-visible">
      {state === "sailing" ? (
        <>
          <path
            d={MAIN_SAIL}
            fill="var(--card)"
            stroke="var(--foreground)"
            strokeOpacity={0.55}
            strokeWidth={22}
          />
          <path
            d={FORE_SAIL}
            fill="var(--card)"
            stroke="var(--foreground)"
            strokeOpacity={0.55}
            strokeWidth={22}
          />
          <path d={AFT_SAIL} fill="var(--primary)" opacity={0.85} />
        </>
      ) : (
        <path
          d="M512 250 L512 640"
          stroke="var(--foreground)"
          strokeOpacity={0.5}
          strokeWidth={22}
          strokeLinecap="round"
        />
      )}
      {Array.from({ length: crates }, (_, i) => (
        <rect
          key={i}
          x={300 + (i % 3) * 120 + (i >= 3 ? 60 : 0)}
          y={i >= 3 ? 470 : 560}
          width={104}
          height={88}
          rx={10}
          fill="var(--chart-3)"
          stroke="var(--foreground)"
          strokeOpacity={0.35}
          strokeWidth={12}
        />
      ))}
      <path
        d={HULL}
        fill={state === "empty" ? "var(--muted-foreground)" : "var(--primary)"}
        opacity={state === "empty" ? 0.45 : 1}
      />
    </svg>
  )
}

/** 一段 200 宽的浪，横向平铺；层宽 200% 左移一半即无缝循环。 */
function Waves({ className }: { className: string }) {
  return (
    <div className={cn("absolute left-0 h-3 w-[200%]", className)}>
      <svg className="h-full w-full" preserveAspectRatio="none">
        <defs>
          <pattern
            id="berth-harbor-wave"
            width="200"
            height="12"
            patternUnits="userSpaceOnUse"
          >
            <path
              d="M0 6 q 25 -5 50 0 t 50 0"
              fill="none"
              stroke="var(--chart-5)"
              strokeOpacity={0.22}
              strokeWidth={1.5}
            />
          </pattern>
        </defs>
        <rect width="100%" height="100%" fill="url(#berth-harbor-wave)" />
      </svg>
    </div>
  )
}

function BoatFigure({
  berth,
  crates,
  className,
}: {
  berth: HarborBerth
  crates: number
  className?: string
}) {
  const state = boatState(berth)
  return (
    <div
      className={cn(
        state === "sailing" ? "berth-harbor-bob" : "berth-harbor-sway",
        className
      )}
    >
      <Boat state={state} crates={state === "sailing" ? 0 : crates} />
      {berth.agents.some((a) => a.state === "attention") && (
        <span className="absolute -top-1 right-0 flex size-[18px] items-center justify-center rounded-full bg-primary text-[11px] font-bold text-primary-foreground">
          !
        </span>
      )}
    </div>
  )
}

function Steps({ task }: { task: BerthTask }) {
  return (
    <span className="flex shrink-0 gap-0.5" aria-hidden>
      {Array.from({ length: Math.min(task.total, 8) }, (_, i) => (
        <i
          key={i}
          className={cn(
            "h-1 w-2.5 rounded-sm bg-border",
            i < task.done && "bg-chart-2",
            i === task.done && "bg-primary"
          )}
        />
      ))}
    </span>
  )
}

/** 一个泊位：宽时船在上、卡片在下；窄时船缩进卡片。git 改动走工作区实时流。 */
function BerthColumn({
  berth,
  onOpen,
}: {
  berth: HarborBerth
  onOpen: (folderId: number) => void
}) {
  const t = useTranslations("ProjectHome")
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  // ponytail: 每个 worktree 一路实时流（后端各一个 watcher），worktree 多到几十个再改成按需
  const live = useWorkspaceStateStore(berth.path)
  const files = live.git.filter((e) => !e.path.endsWith("/"))
  const added = files.reduce((sum, e) => sum + e.additions, 0)
  const removed = files.reduce((sum, e) => sum + e.deletions, 0)
  const crates = Math.min(4, Math.ceil(files.length / 4))
  const sailing = boatState(berth) === "sailing"
  const asking = berth.agents.find((a) => a.state === "attention")
  const working = berth.agents.find((a) => a.state === "working")
  const doing = asking
    ? `⏸ ${asking.notification || asking.title}`
    : working
      ? `→ ${working.title}`
      : berth.git?.commit
        ? `${berth.git.commit.message} · ${format.relativeTime(new Date(berth.git.commit.date), now)}`
        : null

  return (
    <div className="relative min-w-0">
      <div className="relative hidden h-[150px] @2xl:block" aria-hidden>
        <div className="absolute bottom-[6px] left-[calc(50%-3px)] h-[34px] w-1.5 rounded-[1px] bg-border" />
        <BoatFigure
          berth={berth}
          crates={crates}
          className={cn(
            "absolute size-[84px]",
            sailing
              ? "bottom-[46px] left-[calc(50%-26px)]"
              : "bottom-[20px] left-[calc(50%-42px)]"
          )}
        />
      </div>
      <button
        type="button"
        onClick={() => onOpen(berth.folderId)}
        className={cn(
          "flex w-full min-w-0 gap-3 rounded-lg border bg-card px-3 py-2.5 text-left transition-[border-color,box-shadow] hover:border-primary/50 hover:shadow-sm",
          berth.current && "border-primary/60"
        )}
      >
        <BoatFigure
          berth={berth}
          crates={crates}
          className="relative mt-0.5 size-11 shrink-0 @2xl:hidden"
        />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="max-w-[65%] shrink-0 truncate font-semibold">
              {berth.name}
            </span>
            {berth.branch && (
              <span className="min-w-0 truncate rounded bg-muted px-1.5 font-mono text-[11px] text-muted-foreground">
                {berth.branch}
              </span>
            )}
            <span
              className="ml-auto shrink-0 font-mono text-[11px] whitespace-nowrap text-muted-foreground"
              title={
                files.length
                  ? t("worktrees.dirty", { count: files.length })
                  : undefined
              }
            >
              {!live.isGitRepo ? null : added + removed > 0 ? (
                <LineCounts additions={added} deletions={removed} />
              ) : files.length > 0 ? (
                // 只有未跟踪文件时 numstat 是 0/0，显示文件数
                <span className="text-primary">±{files.length}</span>
              ) : (
                t("worktrees.clean")
              )}
            </span>
          </div>
          {berth.task !== undefined && (
            <div className="mt-1 flex min-w-0 items-center gap-1.5 text-xs">
              {berth.task ? (
                <>
                  {berth.task.total > 0 && <Steps task={berth.task} />}
                  <span className="truncate">{berth.task.title}</span>
                  {berth.task.total > 0 && (
                    <span className="shrink-0 text-muted-foreground">
                      {berth.task.done}/{berth.task.total}
                    </span>
                  )}
                </>
              ) : (
                <span className="text-muted-foreground">
                  {t("worktrees.noTask")}
                </span>
              )}
            </div>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {berth.agents.length === 0 ? (
              <span className="text-xs text-muted-foreground">
                {t("worktrees.noAgent")}
              </span>
            ) : (
              berth.agents.map((agent) => (
                <span
                  key={agent.terminalId}
                  className={cn(
                    "inline-flex items-center gap-1.5 rounded-full bg-muted py-px pr-2 pl-1.5 text-xs",
                    agent.state === "attention" && "bg-primary/15 text-primary"
                  )}
                >
                  <span
                    className={cn(
                      "size-1.5 rounded-full bg-muted-foreground",
                      agent.state === "working" &&
                        "berth-harbor-pulse bg-chart-2",
                      agent.state === "attention" && "bg-primary"
                    )}
                  />
                  {agent.agent} · {t(`agentState.${agent.state}`)}
                </span>
              ))
            )}
          </div>
          <div
            className="mt-1.5 truncate text-xs text-muted-foreground"
            title={doing ?? undefined}
          >
            {doing ?? " "}
          </div>
        </div>
      </button>
    </div>
  )
}

export function Harbor({
  berths,
  onOpen,
}: {
  berths: HarborBerth[]
  onOpen: (folderId: number) => void
}) {
  return (
    <div className="@2xl:overflow-x-auto">
      <div
        className="relative grid gap-3 @2xl:grid-cols-[repeat(var(--berths),minmax(180px,1fr))]"
        style={{ "--berths": berths.length } as CSSProperties}
      >
        {/* 水面横跨所有泊位，船停在各自卡片正上方 */}
        <div
          className="pointer-events-none absolute inset-x-0 top-0 hidden h-[150px] overflow-hidden @2xl:block"
          aria-hidden
        >
          <Waves className="berth-harbor-wave bottom-3" />
          <Waves className="berth-harbor-wave-slow bottom-0 opacity-70" />
          <div className="absolute inset-x-0 bottom-[34px] h-1.5 rounded-sm bg-border" />
        </div>
        {berths.map((berth) => (
          <BerthColumn key={berth.folderId} berth={berth} onOpen={onOpen} />
        ))}
      </div>
    </div>
  )
}
