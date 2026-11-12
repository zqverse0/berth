"use client"

/**
 * 知识星图：笔记按类型分层排在同心圆上（`orbit-layout.ts`），连线往圆心弯成弦。
 * 悬停 / 选中高亮一度邻居；选中与筛选词和侧栏「记忆」共用（`useKnowledgeFocus`），详情在侧栏。静态内容画在 SVG 里；选中的轨道与亮起的圈
 * 放在 HTML 层只动 transform（WebKitGTK 上 SVG 内部的动画每帧重画）。
 */

import { useMemo, useState, type CSSProperties } from "react"
import { useTranslations } from "next-intl"
import { RING_COLOR } from "@/knowledge/components/note-detail"
import { useKnowledgeFocus } from "@/knowledge/hooks/use-knowledge-focus"
import {
  ORBIT_RINGS,
  orbitLayout,
  type OrbitNode,
  type OrbitRing,
} from "@/knowledge/lib/orbit-layout"
import type { KnowledgeDocument, KnowledgeEdge } from "@/knowledge/model/types"
import { cn } from "@/lib/utils"

export function KnowledgeOrbit({
  documents,
  edges,
  onSelectNote,
}: {
  documents: KnowledgeDocument[]
  edges: KnowledgeEdge[]
  /** 点了节点（已写进 `useKnowledgeFocus`）：首页借此打开侧栏「记忆」看详情 */
  onSelectNote?: (id: string) => void
}) {
  const t = useTranslations("Knowledge.orbit")
  const layout = useMemo(
    () => orbitLayout(documents, edges),
    [documents, edges]
  )
  const { selected: focused, query, select } = useKnowledgeFocus()
  const [hover, setHover] = useState<string | null>(null)
  const [hidden, setHidden] = useState<ReadonlySet<OrbitRing>>(new Set())

  const byId = useMemo(
    () => new Map(layout.nodes.map((node) => [node.id, node])),
    [layout]
  )
  const relations = useMemo(() => {
    const out = new Map<string, string[]>()
    const back = new Map<string, string[]>()
    for (const { source, target } of layout.links) {
      out.set(source, [...(out.get(source) ?? []), target])
      back.set(target, [...(back.get(target) ?? []), source])
    }
    return { out, back }
  }, [layout])

  const rings = ORBIT_RINGS.filter((ring) =>
    layout.nodes.some((node) => node.ring === ring)
  )
  const ringName = (ring: OrbitRing) => {
    const outer: OrbitRing[] = rings.filter((r) => r !== "map")
    const index = outer.indexOf(ring)
    return ring === "map" ? t("center") : t("ring", { n: index + 1 })
  }
  const selectedNode = focused ? byId.get(focused) : undefined
  // 选中的笔记不在这份 vault 里（换了项目）时当作没选中
  const selected = selectedNode ? focused : null
  const setSelected = (id: string | null) => {
    select(id)
    if (id) onSelectNote?.(id)
  }
  const focus = selected ?? hover
  const near = new Set(
    focus
      ? [
          ...(relations.out.get(focus) ?? []),
          ...(relations.back.get(focus) ?? []),
        ]
      : []
  )
  const visible = (node: OrbitNode) => !hidden.has(node.ring)
  const q = query.trim().toLowerCase()
  const { viewBox: vb } = layout
  // viewBox 坐标 → 舞台百分比（舞台与 viewBox 同宽高比）
  const at = (x: number, y: number, diameter: number): CSSProperties => ({
    left: `${((x - vb.x) / vb.width) * 100}%`,
    top: `${((y - vb.y) / vb.height) * 100}%`,
    width: `${(diameter / vb.width) * 100}%`,
  })

  const toggleRing = (ring: OrbitRing) => {
    // 藏起选中节点所在的层，选中跟着取消，不在看不见的点上画轨道
    if (!hidden.has(ring) && selectedNode?.ring === ring) setSelected(null)
    setHidden((current) => {
      const next = new Set(current)
      if (!next.delete(ring)) next.add(ring)
      return next
    })
  }

  return (
    <div className="overflow-hidden rounded-lg border bg-card">
      <div className="flex items-center gap-3 border-b px-3.5 py-2">
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          {rings.map((ring) => (
            <button
              key={ring}
              type="button"
              aria-pressed={!hidden.has(ring)}
              onClick={() => toggleRing(ring)}
              className={cn(
                "inline-flex items-center gap-1.5 hover:text-foreground",
                hidden.has(ring) && "opacity-40"
              )}
            >
              <i
                className="size-2 rounded-full"
                style={{ background: RING_COLOR[ring] }}
              />
              {t(`rings.${ring}`)} · {ringName(ring)}
            </button>
          ))}
        </div>
        <span className="ml-auto hidden text-xs text-muted-foreground @3xl:inline">
          {t("selectHint")}
        </span>
      </div>

      <div>
        <div
          className="relative self-start"
          style={{ aspectRatio: `${vb.width} / ${vb.height}` }}
          onClick={() => setSelected(null)}
        >
          <svg
            viewBox={`${vb.x} ${vb.y} ${vb.width} ${vb.height}`}
            className="absolute inset-0 size-full"
            onKeyDown={(event) => event.key === "Escape" && setSelected(null)}
          >
            {Object.entries(layout.radii).map(([ring, radius]) => (
              <circle
                key={ring}
                r={radius}
                fill="none"
                stroke="var(--border)"
                strokeDasharray="2 5"
              />
            ))}
            {layout.links.map(({ source, target }) => {
              const a = byId.get(source)!
              const b = byId.get(target)!
              if (!visible(a) || !visible(b)) return null
              const on = focus != null && (source === focus || target === focus)
              // 地图连着大半个库，平时不画它的辐射线，选中时才出现
              const hub = a.ring === "map" || b.ring === "map"
              const drawn = on && focus === selected
              return (
                <path
                  // 换选中项时换 key，画线动画重新播一遍
                  key={`${source}\n${target}${drawn ? `\n${selected}` : ""}`}
                  d={`M${a.x} ${a.y} Q ${((a.x + b.x) / 2) * 0.35} ${((a.y + b.y) / 2) * 0.35} ${b.x} ${b.y}`}
                  fill="none"
                  pathLength={1}
                  className={cn(drawn && "berth-orbit-draw")}
                  stroke={on ? "var(--primary)" : "var(--muted-foreground)"}
                  strokeWidth={on ? 1.6 : 1}
                  strokeOpacity={
                    on
                      ? drawn
                        ? 0.85
                        : 0.5
                      : focus || hub
                        ? hub
                          ? 0
                          : 0.04
                        : 0.13
                  }
                />
              )
            })}
            {layout.nodes.filter(visible).map((node) => {
              const dim =
                focus != null && node.id !== focus && !near.has(node.id)
              const strong = node.id === focus || near.has(node.id)
              const match = q !== "" && node.title.toLowerCase().includes(q)
              let label: {
                x: number
                y: number
                anchor: "start" | "middle" | "end"
              } = { x: 0, y: node.size + 13, anchor: "middle" }
              if (node.angle != null) {
                const cos = Math.cos(node.angle)
                const sin = Math.sin(node.angle)
                const side = Math.abs(cos) < 0.25
                label = {
                  x: cos * (node.size + 6),
                  y:
                    sin * (node.size + 6) + 4 + (side ? (sin > 0 ? 8 : -4) : 0),
                  anchor: side ? "middle" : cos > 0 ? "start" : "end",
                }
              }
              return (
                <g
                  key={node.id}
                  transform={`translate(${node.x} ${node.y})`}
                  tabIndex={0}
                  role="button"
                  aria-label={node.title}
                  className="cursor-pointer outline-none transition-opacity duration-200"
                  opacity={dim ? 0.18 : 1}
                  onClick={(event) => {
                    event.stopPropagation()
                    setSelected(node.id)
                  }}
                  onKeyDown={(event) =>
                    event.key === "Enter" && setSelected(node.id)
                  }
                  onMouseEnter={() => setHover(node.id)}
                  onMouseLeave={() => setHover(null)}
                >
                  <circle r={node.size + 8} fill="transparent" />
                  <circle
                    r={node.size}
                    fill={RING_COLOR[node.ring]}
                    stroke={
                      match
                        ? "var(--primary)"
                        : hover === node.id
                          ? "var(--foreground)"
                          : "none"
                    }
                    strokeWidth={match ? 2 : 1.5}
                  />
                  <text
                    x={label.x}
                    y={label.y}
                    textAnchor={label.anchor}
                    className="pointer-events-none fill-foreground text-[11px]"
                    fontWeight={strong || node.ring === "map" ? 600 : 400}
                    opacity={strong || node.ring === "map" ? 1 : 0.78}
                  >
                    {node.title.length > 12
                      ? `${node.title.slice(0, 11)}…`
                      : node.title}
                  </text>
                </g>
              )
            })}
          </svg>

          {selectedNode && (
            <>
              {layout.radii[selectedNode.ring] != null && (
                // 所在的圈只标出来、不转：常驻动画会让 WebKit 一直出帧
                <div
                  className="pointer-events-none absolute aspect-square -translate-x-1/2 -translate-y-1/2 rounded-full border border-dashed border-primary/55"
                  style={at(0, 0, layout.radii[selectedNode.ring]! * 2)}
                />
              )}
              {/* key：换选中笔记时重新挂载，小轨道再转一圈 */}
              <div
                key={selectedNode.id}
                className="pointer-events-none absolute aspect-square -translate-x-1/2 -translate-y-1/2"
                style={at(
                  selectedNode.x,
                  selectedNode.y,
                  (selectedNode.size + 14) * 2
                )}
              >
                <div className="berth-orbit-spin absolute inset-[21%] rounded-full border border-dashed border-primary/70">
                  <span className="absolute top-1/2 -right-[3px] size-[5px] -translate-y-1/2 rounded-full bg-primary" />
                </div>
                <div className="berth-orbit-spin-slow absolute inset-0 rounded-full border border-dashed border-primary/30">
                  <span className="absolute top-1/2 -left-[2px] size-[4px] -translate-y-1/2 rounded-full bg-primary/70" />
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
