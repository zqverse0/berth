"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { CircleAlert } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  usageWindowParts,
  type UsageTranslator,
} from "@/lib/agent/usage-window"
import { AgentIcon } from "@/components/agent-icon"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useAgentProfilesStore } from "@/hooks/use-agent-profiles"
import {
  readAccountUsage,
  type UsageState,
  type UsageWindow,
} from "@/lib/transport/usage"
import { cn } from "@/lib/utils"

const USAGE_REFRESH_MS = 5 * 60 * 1000
const STALE_MS = 2 * 60 * 1000

/** SWR 容错合并：若新状态出错但旧数据可用，保留旧进度条展示，避免状态栏突变红警 */
function mergeUsageStates(
  prev: UsageState[] | null,
  next: UsageState[]
): UsageState[] {
  if (!prev || prev.length === 0) return next
  const prevMap = new Map(prev.map((s) => [s.subject, s]))
  return next.map((cur) => {
    const old = prevMap.get(cur.subject)
    if (
      cur.status === "error" &&
      old &&
      old.status === "ready" &&
      old.windows.length > 0
    ) {
      return {
        ...old,
        diagnostics:
          cur.diagnostics.length > 0 ? cur.diagnostics : old.diagnostics,
      }
    }
    return cur
  })
}

/** 未登录/不可用不打扰状态栏。 */
const VISIBLE_STATUSES = new Set(["ready", "error"])

/**
 * 紧急度配色(参考 orca):低用量保持中性,常驻 UI 安静;60%/80% 两档转黄/红。
 * 进度条填充与文字同一语义。
 */
export function barColor(percent: number): string {
  if (percent >= 80) return "bg-red-500"
  if (percent >= 60) return "bg-yellow-500"
  return "bg-muted-foreground/40"
}

export function usageTextColorClass(percent: number): string {
  if (percent >= 80) return "text-red-500"
  if (percent >= 60) return "text-yellow-500"
  return "text-foreground"
}

/** 紧凑倒计时:"47m" / "3h 54m" / "6d 7h"。 */
export function maxPercent(state: UsageState): number | null {
  const values = state.windows
    .map((window) => window.usedPercent)
    .filter((value): value is number => typeof value === "number")
  return values.length > 0 ? Math.max(...values) : null
}

/** agent 目录名 → 显示名(查 tool.json 身份,查不到退目录名)。 */
export function agentName(
  subjects: Map<string, string>,
  subject: string
): string {
  return subjects.get(subject) ?? subject
}

/** 状态栏迷你条:48×6 轨道 + 按用量宽度的填充。 */
export function MiniBar({
  percent,
  className,
}: {
  percent: number
  className?: string
}) {
  return (
    <span
      data-usage-bar
      className={cn(
        "h-[6px] w-12 shrink-0 overflow-hidden rounded-full bg-muted",
        className
      )}
    >
      <span
        className={`block h-full rounded-full transition-all duration-300 ${barColor(percent)}`}
        style={{ width: `${percent}%` }}
      />
    </span>
  )
}

/** Popover 里的单个窗口行:窗口标签 + 进度条(有百分比时) + 统一口径的使用量/重置。 */
export function WindowRow({
  window,
  now,
}: {
  window: UsageWindow
  now: number
}) {
  const t = useTranslations("Folder.statusBar.usage")
  const percent =
    typeof window.usedPercent === "number" ? window.usedPercent : null
  const parts = usageWindowParts(window, t as unknown as UsageTranslator, now)

  return (
    <div className="flex items-center gap-2">
      <span className="w-12 shrink-0 truncate text-[11px] font-medium text-muted-foreground">
        {window.label}
      </span>
      {percent !== null && (
        <>
          <span className="h-[5px] w-8 shrink-0 overflow-hidden rounded-full bg-muted">
            <span
              className={`block h-full rounded-full ${barColor(percent)}`}
              style={{ width: `${percent}%` }}
            />
          </span>
          <span
            className={`w-9 shrink-0 tabular-nums text-[11px] ${usageTextColorClass(percent)}`}
          >
            {percent}%
          </span>
        </>
      )}
      {parts.usage && percent === null && (
        <span className="shrink-0 tabular-nums text-[11px]">{parts.usage}</span>
      )}
      {parts.reset && (
        <span className="ml-auto shrink-0 text-[10px] text-muted-foreground">
          {parts.reset}
        </span>
      )}
    </div>
  )
}

export interface StatusBarUsageProps {
  onStatesChange?: (states: UsageState[] | null) => void
  className?: string
}

export function StatusBarUsage({
  onStatesChange,
  className,
}: StatusBarUsageProps = {}) {
  const t = useTranslations("Folder.statusBar.usage")
  const agents = useAgentProfilesStore((state) => state.agents)
  const [states, setStates] = useState<UsageState[] | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [popoverOpen, setPopoverOpen] = useState(false)
  const inFlight = useRef(false)
  const lastSuccessAt = useRef(0)

  const load = useCallback(async (force = false) => {
    if (inFlight.current) return
    const nowMs = Date.now()
    if (
      !force &&
      lastSuccessAt.current > 0 &&
      nowMs - lastSuccessAt.current < STALE_MS
    ) {
      return
    }
    inFlight.current = true
    try {
      const next = await readAccountUsage()
      setStates((prev) => mergeUsageStates(prev, next))
      lastSuccessAt.current = Date.now()
      setNow(Date.now())
    } catch {
      // command reject:保留旧值,下一轮轮询再试。
    } finally {
      inFlight.current = false
    }
  }, [])

  useEffect(() => {
    onStatesChange?.(states)
  }, [states, onStatesChange])

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(true), 0)
    const tick = () => {
      if (document.visibilityState === "visible") void load(false)
    }
    const interval = window.setInterval(() => void load(true), USAGE_REFRESH_MS)
    const onVisibility = () => {
      if (document.visibilityState === "visible") tick()
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      window.clearTimeout(timeout)
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [load])

  // 打开弹层即强刷（替代刷新按钮），并启动倒计时时钟（每 10 秒刷新一次当前基准时间）
  useEffect(() => {
    if (!popoverOpen) return
    void load(true)
    setNow(Date.now())
    const interval = window.setInterval(() => {
      setNow(Date.now())
    }, 10000)
    return () => window.clearInterval(interval)
  }, [popoverOpen, load])

  const subjects = useMemo(
    () => new Map(agents.map((agent) => [agent.id, agent.name])),
    [agents]
  )

  const visible = (states ?? []).filter(
    (state) =>
      VISIBLE_STATUSES.has(state.status) &&
      (state.status === "error" || state.windows.length > 0)
  )

  if (visible.length === 0) return null

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "flex items-center gap-3 transition-colors hover:text-foreground",
            className
          )}
          title={t("title")}
          aria-label={t("title")}
          data-berth-status-usage-trigger
        >
          {visible.map((state) => {
            const percent = maxPercent(state)
            if (state.status === "error" || percent === null) {
              return (
                <span key={state.subject} className="flex items-center gap-1.5">
                  <AgentIcon
                    agentType={state.subject}
                    className="size-3.5 shrink-0"
                  />
                  <CircleAlert className="size-3.5 shrink-0 text-red-500" />
                </span>
              )
            }
            return (
              <span
                key={state.subject}
                className="flex items-center gap-1.5"
                title={agentName(subjects, state.subject)}
              >
                <AgentIcon
                  agentType={state.subject}
                  className="size-3.5 shrink-0"
                />
                {/* 手机屏窄：只留图标和百分比 */}
                <MiniBar percent={percent} className="max-md:hidden" />
                <span
                  className={`tabular-nums text-[11px] ${usageTextColorClass(percent)}`}
                >
                  {percent}%
                </span>
              </span>
            )
          })}
        </button>
      </PopoverTrigger>
      <PopoverContent
        side="top"
        align="end"
        className="w-80 p-3"
        data-berth-status-usage-content
      >
        <div className="mb-2.5 text-xs font-semibold text-foreground">
          {t("title")}
        </div>
        <div className="max-h-64 space-y-3 overflow-y-auto">
          {visible.map((state) => (
            <div key={state.subject} className="flex flex-col gap-1.5">
              <div className="flex items-center gap-2 text-xs font-medium">
                <span className="flex size-5 shrink-0 items-center justify-center rounded border border-border bg-secondary/50">
                  <AgentIcon agentType={state.subject} className="size-3" />
                </span>
                <span>{agentName(subjects, state.subject)}</span>
                {state.planType && (
                  <span className="font-normal text-muted-foreground">
                    · {state.planType}
                  </span>
                )}
                {state.status === "error" && (
                  <span className="text-red-500">{t("error")}</span>
                )}
              </div>
              {state.windows.length === 0 ? (
                <div className="pl-7 text-xs text-muted-foreground">
                  {t("noData")}
                </div>
              ) : (
                <div className="space-y-1.5 pl-7">
                  {state.windows.map((window) => (
                    <WindowRow key={window.id} window={window} now={now} />
                  ))}
                </div>
              )}
              {state.diagnostics
                .filter((diagnostic) => diagnostic.severity === "error")
                .map((diagnostic, index) => (
                  <div
                    key={index}
                    className="break-words pl-7 text-[10px] text-red-400"
                  >
                    {diagnostic.message}
                  </div>
                ))}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}
