"use client"

import { useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { gitCommitDays } from "@/lib/api"

const DAY = 86_400_000
/** 从首次提交那周画起（新项目不留一大片空白），至少 26 周、至多 52 周。 */
const MIN_WEEKS = 26
const MAX_WEEKS = 52

const dateKey = (date: Date) =>
  `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`

const level = (count: number) =>
  count === 0 ? 0 : count < 3 ? 1 : count < 8 ? 2 : count < 16 ? 3 : 4
/** 单色由浅到深：项目主色按比例混进底色。 */
const shade = (level: number) =>
  level === 0
    ? "var(--muted)"
    : `color-mix(in oklch, var(--primary) ${level * 25}%, var(--muted))`

/** 提交热力：本仓库（所有分支）每天的提交数，一列一周、周日在上。 */
export function CommitHeatmap({ path }: { path: string }) {
  const t = useTranslations("ProjectHome.commits")
  const [counts, setCounts] = useState<Map<string, number> | null>(null)
  useEffect(() => {
    let disposed = false
    gitCommitDays(path, MAX_WEEKS * 7 + 7)
      .then((rows) => {
        if (!disposed)
          setCounts(new Map(rows.map((row) => [row.date, row.count])))
      })
      .catch(() => {
        if (!disposed) setCounts(new Map())
      })
    return () => {
      disposed = true
    }
  }, [path])

  const view = useMemo(() => {
    if (!counts) return null
    const end = new Date()
    end.setHours(12, 0, 0, 0)
    const first = [...counts.keys()].sort()[0]
    const span = first
      ? Math.ceil((+end - +new Date(`${first}T12:00`)) / DAY / 7) + 1
      : 0
    const weeks = Math.min(MAX_WEEKS, Math.max(MIN_WEEKS, span))
    const start = new Date(+end - ((weeks - 1) * 7 + end.getDay()) * DAY)
    const days: { date: Date; count: number }[] = []
    for (let at = +start; at <= +end; at += DAY) {
      const date = new Date(at)
      days.push({ date, count: counts.get(dateKey(date)) ?? 0 })
    }
    let streak = 0
    let best = 0
    for (const { count } of days) {
      streak = count ? streak + 1 : 0
      best = Math.max(best, streak)
    }
    const months = days.flatMap(({ date }, index) =>
      date.getDate() === 1 && (weeks < 40 || date.getMonth() % 2 === 0)
        ? [{ column: Math.floor(index / 7) + 1, month: date.getMonth() + 1 }]
        : []
    )
    return {
      weeks,
      days,
      best,
      months,
      total: days.reduce((sum, day) => sum + day.count, 0),
      week: days.slice(-7).reduce((sum, day) => sum + day.count, 0),
    }
  }, [counts])

  if (!view) return <div className="h-40" />
  const columns = { gridTemplateColumns: `repeat(${view.weeks}, 1fr)` }
  return (
    <div>
      <div className="mb-2.5 flex items-baseline gap-1.5">
        <b className="text-[22px] leading-none font-semibold tabular-nums">
          {view.total}
        </b>
        <span className="text-xs text-muted-foreground">
          {t("total", { weeks: view.weeks })}
        </span>
        <span className="ml-auto text-xs text-muted-foreground">
          {t("stats", { week: view.week, streak: view.best })}
        </span>
      </div>
      <div
        className="grid grid-flow-col grid-rows-7 gap-[3px]"
        style={columns}
        role="img"
        aria-label={t("aria", { total: view.total, weeks: view.weeks })}
      >
        {view.days.map(({ date, count }) => (
          <i
            key={+date}
            className="aspect-square rounded-[3px]"
            style={{ background: shade(level(count)) }}
            title={t("cell", {
              date: `${date.getMonth() + 1}-${date.getDate()}`,
              count,
            })}
          />
        ))}
      </div>
      <div className="mt-2 flex items-center gap-2 text-[11px] text-muted-foreground">
        <div className="grid flex-1" style={columns}>
          {view.months.map(({ column, month }) => (
            <span
              key={column}
              style={{ gridColumnStart: column }}
              className="whitespace-nowrap"
            >
              {t("month", { month })}
            </span>
          ))}
        </div>
        <span className="flex items-center gap-[3px]">
          {t("less")}
          {[0, 1, 2, 3, 4].map((value) => (
            <i
              key={value}
              className="size-[9px] rounded-[2px]"
              style={{ background: shade(value) }}
            />
          ))}
          {t("more")}
        </span>
      </div>
    </div>
  )
}
