"use client"

import { useEffect, useMemo, useState } from "react"
import { useFormatter, useTranslations } from "next-intl"
import { projectTokenUsage } from "@/lib/api"
import type { TokenUsageRow } from "@/lib/types"

const DAYS = 14
/** 分类色按 Agent 名字排序固定分配（不按用量排名，避免数据一变就换色）；超过 5 个的并进最后一色。 */
const COLORS = [
  "var(--chart-5)",
  "var(--chart-1)",
  "var(--chart-2)",
  "var(--chart-3)",
  "var(--chart-4)",
]
const W = 520
const H = 140
const X0 = 36

const total = (row: TokenUsageRow) =>
  row.input + row.output + row.cacheRead + row.cacheWrite

/** Token 用量（参考 cc-switch）：汇总数字 + 近 14 天按 Agent 堆叠的每日用量。只算本项目的会话。 */
export function TokenUsage({ folderId }: { folderId: number }) {
  const t = useTranslations("ProjectHome.tokens")
  const format = useFormatter()
  const [rows, setRows] = useState<TokenUsageRow[] | null>(null)
  useEffect(() => {
    let disposed = false
    projectTokenUsage(folderId, DAYS)
      .then((value) => !disposed && setRows(value))
      .catch(() => !disposed && setRows([]))
    return () => {
      disposed = true
    }
  }, [folderId])

  const view = useMemo(() => {
    if (!rows) return null
    const agents = [...new Set(rows.map((row) => row.agent))].sort()
    const today = new Date()
    const days = Array.from({ length: DAYS }, (_, index) => {
      const date = new Date(today)
      date.setDate(today.getDate() - (DAYS - 1 - index))
      const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`
      const byAgent = agents.map((agent) =>
        rows
          .filter((row) => row.date === key && row.agent === agent)
          .reduce((sum, row) => sum + total(row), 0)
      )
      return { label: `${date.getMonth() + 1}-${date.getDate()}`, byAgent }
    })
    const sum = (pick: (row: TokenUsageRow) => number) =>
      rows.reduce((value, row) => value + pick(row), 0)
    const context = sum((row) => row.input + row.cacheRead + row.cacheWrite)
    return {
      agents,
      days,
      tokens: sum(total),
      requests: sum((row) => row.requests),
      output: sum((row) => row.output),
      cacheHit: context ? sum((row) => row.cacheRead) / context : null,
      max: Math.max(
        1,
        ...days.map((day) => day.byAgent.reduce((a, b) => a + b, 0))
      ),
    }
  }, [rows])

  if (!view) return <div className="h-40" />
  const compact = (value: number) =>
    format.number(value, { notation: "compact", maximumFractionDigits: 1 })
  const stats = [
    { label: t("tokens"), value: compact(view.tokens) },
    { label: t("requests"), value: format.number(view.requests) },
    {
      label: t("cacheHit"),
      value:
        view.cacheHit == null
          ? "—"
          : format.number(view.cacheHit, { style: "percent" }),
    },
    { label: t("output"), value: compact(view.output) },
  ]
  const y = (value: number) => (value / view.max) * (H - 22)
  const barWidth = (W - X0) / DAYS - 4
  const color = (index: number) => COLORS[Math.min(index, COLORS.length - 1)]

  return (
    <div>
      <div className="mb-2.5 grid grid-cols-4 gap-1.5">
        {stats.map((stat) => (
          <div key={stat.label} className="rounded-md bg-muted px-2 py-1.5">
            <div className="text-[10px] text-muted-foreground">
              {stat.label}
            </div>
            <div className="text-[15px] font-semibold tabular-nums">
              {stat.value}
            </div>
          </div>
        ))}
      </div>
      {view.tokens === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">
          {t("empty")}
        </p>
      ) : (
        <>
          <div className="mb-1 flex flex-wrap gap-x-3 text-[11px] text-muted-foreground">
            {view.agents.map((agent, index) => (
              <span key={agent} className="inline-flex items-center gap-1">
                <i
                  className="size-2 rounded-[2px]"
                  style={{ background: color(index) }}
                />
                {agent}
              </span>
            ))}
          </div>
          <svg
            viewBox={`0 0 ${W} ${H}`}
            className="w-full"
            role="img"
            aria-label={t("aria", { days: DAYS })}
          >
            {[0.5, 1].map((fraction) => {
              const lineY = H - 16 - (H - 22) * fraction
              return (
                <g key={fraction}>
                  <line
                    x1={X0}
                    x2={W}
                    y1={lineY}
                    y2={lineY}
                    stroke="var(--border)"
                    strokeDasharray="2 3"
                  />
                  <text
                    x={0}
                    y={lineY + 3}
                    className="fill-muted-foreground text-[10px]"
                  >
                    {compact(view.max * fraction)}
                  </text>
                </g>
              )
            })}
            {view.days.map((day, index) => {
              const x = X0 + index * (barWidth + 4)
              let base = H - 16
              return (
                <g key={day.label}>
                  {day.byAgent.map((value, agent) => {
                    if (!value) return null
                    const height = y(value)
                    base -= height
                    return (
                      <rect
                        key={agent}
                        x={x}
                        y={base + 1}
                        width={barWidth}
                        height={Math.max(height - 2, 1)}
                        rx={2}
                        fill={color(agent)}
                      >
                        <title>
                          {`${day.label} · ${view.agents[agent]} ${compact(value)}`}
                        </title>
                      </rect>
                    )
                  })}
                  {index % 3 === 0 && (
                    <text
                      x={x}
                      y={H - 2}
                      className="fill-muted-foreground text-[10px]"
                    >
                      {day.label}
                    </text>
                  )}
                </g>
              )
            })}
          </svg>
        </>
      )}
    </div>
  )
}
