import { cn } from "@/lib/utils"

/** 统一状态点：侧栏会话图标与 workspace tab 共用同一套颜色。 */
export type StatusDotKind = "attention" | "working" | "new" | "pinned"

const STATUS_DOT_CLASS: Record<StatusDotKind, string> = {
  attention: "bg-amber-500",
  working: "bg-emerald-500 animate-pulse",
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

/** 绝对定位的小圆点；位置由调用方的 `className` 决定。 */
export function StatusDot({
  kind,
  className,
}: {
  kind: StatusDotKind
  className?: string
}) {
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
