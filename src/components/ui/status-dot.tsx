"use client"

import { useEffect } from "react"
import { cn } from "@/lib/utils"

/** 统一状态点：侧栏会话图标与 workspace tab 共用同一套颜色。 */
export type StatusDotKind = "attention" | "working" | "new" | "pinned"

const STATUS_DOT_CLASS: Record<StatusDotKind, string> = {
  attention: "bg-amber-500",
  working: "bg-emerald-500 berth-slow-blink",
  new: "bg-emerald-500",
  pinned: "bg-primary",
}

const PRIORITY: readonly StatusDotKind[] = [
  "attention",
  "working",
  "new",
  "pinned",
]

/** 同时成立多个状态时只显示一个：需要关注 > 工作中 > 新开未看 > 钉住。 */
export function pickStatusDot(
  ...states: (StatusDotKind | null | false | undefined)[]
): StatusDotKind | null {
  return PRIORITY.find((kind) => states.includes(kind)) ?? null
}

// 「工作中」慢闪：CSS 无限动画会让 WebKit 每秒出 60 帧，Linux（GTK3）上宿主主线程逐帧软件拷贝
// 整个窗口（实测一个 8px 圆点占 20% CPU）。改为全局一个 1 秒的计时器切换根元素属性，每秒只出 1 帧；
// 只在有「工作中」圆点挂着且页面可见时运行。
const BLINK_MS = 1_000
let blinkUsers = 0
let blinkTimer: number | null = null

function setBlink(dim: boolean) {
  const root = document.documentElement
  if (dim) root.dataset.slowBlink = "dim"
  else delete root.dataset.slowBlink
}

function syncBlink() {
  const run = blinkUsers > 0 && document.visibilityState === "visible"
  if (run && blinkTimer == null) {
    blinkTimer = window.setInterval(
      () => setBlink(document.documentElement.dataset.slowBlink !== "dim"),
      BLINK_MS
    )
  } else if (!run && blinkTimer != null) {
    window.clearInterval(blinkTimer)
    blinkTimer = null
    setBlink(false)
  }
}

export function useSlowBlink(active: boolean) {
  useEffect(() => {
    if (!active) return
    blinkUsers += 1
    if (blinkUsers === 1)
      document.addEventListener("visibilitychange", syncBlink)
    syncBlink()
    return () => {
      blinkUsers -= 1
      if (blinkUsers === 0)
        document.removeEventListener("visibilitychange", syncBlink)
      syncBlink()
    }
  }, [active])
}

/** 「进行中」小圆环：静态缺口圆跟随同一个慢闪，代替 `animate-spin`（理由同上，实测转圈占 GUI 主线程约 18%）。 */
export function BusyRing({ className }: { className?: string }) {
  useSlowBlink(true)
  return (
    <div
      aria-hidden="true"
      className={cn(
        "berth-slow-blink rounded-full border-[1.5px] border-current border-t-transparent",
        className
      )}
    />
  )
}

/** 绝对定位的小圆点；位置由调用方的 `className` 决定。 */
export function StatusDot({
  kind,
  className,
}: {
  kind: StatusDotKind
  className?: string
}) {
  useSlowBlink(kind === "working")
  return (
    <span
      aria-hidden="true"
      data-status-dot={kind}
      className={cn(
        "pointer-events-none absolute size-2 rounded-full",
        STATUS_DOT_CLASS[kind],
        className
      )}
    />
  )
}
