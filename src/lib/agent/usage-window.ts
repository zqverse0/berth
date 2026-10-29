import type { UsageWindow } from "@/lib/transport/usage"

/**
 * 用量窗口的统一展示口径（所有界面共用这一处实现）。
 *
 * 每个窗口固定回答两件事：**当前使用量**、**什么时候重置**。
 * 上游给什么就用什么，缺的部分不显示：
 *   使用量 → 百分比 → 绝对值用量（已用 N）→ 余量（余 N）
 *   重置   → 还有多久重置（倒计时）；没有 resetsAt 就不显示
 * 不同服务商字段不同（百分比 / used / remaining），这里统一成同一句话，
 * 界面不再各自拼字段。
 */
export type UsageTranslator = (
  key: string,
  values?: Record<string, string | number>
) => string

/** 倒计时文本：`3d 5h` / `2h 10m` / `45m`。 */
export function formatResetDuration(ms: number): string | null {
  if (ms <= 0) return null
  const totalMins = Math.floor(ms / 60_000)
  if (totalMins < 60) return `${totalMins}m`
  const hours = Math.floor(totalMins / 60)
  const mins = totalMins % 60
  if (hours >= 24) {
    const days = Math.floor(hours / 24)
    const remHours = hours % 24
    return remHours > 0 ? `${days}d ${remHours}h` : `${days}d`
  }
  return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`
}

function formatAmount(value: number): string {
  return value % 1 === 0 ? String(value) : value.toFixed(2)
}

export interface UsageWindowParts {
  /** 当前使用量：百分比或绝对值（带单位）；上游什么都没给时为 null。 */
  usage: string | null
  /** 重置描述（倒计时）；没有可用重置时间时为 null。 */
  reset: string | null
}

/** 把一个窗口压成「使用量 + 重置」两段确定性文本。 */
export function usageWindowParts(
  window: UsageWindow,
  t: UsageTranslator,
  now = Date.now()
): UsageWindowParts {
  const percent =
    typeof window.usedPercent === "number" ? `${window.usedPercent}%` : null
  const absolute =
    typeof window.used === "number"
      ? t("usedFormat", {
          value: formatAmount(window.used),
          unit: window.unit ?? "",
        })
      : typeof window.remaining === "number"
        ? t("remainingFormat", {
            value: formatAmount(window.remaining),
            unit: window.unit ?? "",
          })
        : null
  // 两条信息都有时并排显示（百分比在上，绝对值跟在括号里），只有一条就显示那一条。
  const usage =
    percent && absolute
      ? t("usageWithAbsoluteFormat", { percent, absolute })
      : (percent ?? absolute)
  const countdown =
    typeof window.resetsAt === "number" && window.resetsAt > now
      ? formatResetDuration(window.resetsAt - now)
      : null
  return {
    usage,
    reset: countdown ? t("resetCountdown", { duration: countdown }) : null,
  }
}

/** 单行摘要：`窗口名 · 使用量 · 重置`（缺的部分省略）。 */
export function formatUsageWindowLine(
  window: UsageWindow,
  t: UsageTranslator,
  now = Date.now()
): string {
  const parts = usageWindowParts(window, t, now)
  return [window.label, parts.usage, parts.reset].filter(Boolean).join(" · ")
}
