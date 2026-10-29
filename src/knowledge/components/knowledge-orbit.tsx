"use client"

/**
 * 知识星图：笔记按类型分层排在同心圆上（`orbit-layout.ts`），连线往圆心弯成弦。
 * 悬停 / 选中高亮一度邻居，右侧是笔记详情。静态内容画在 SVG 里；选中的轨道与亮起的圈
 * 放在 HTML 层只动 transform（WebKitGTK 上 SVG 内部的动画每帧重画）。
 */

import { useMemo, useState, type CSSProperties } from "react"
import { useFormatter, useNow, useTranslations } from "next-intl"
import {
  ORBIT_RINGS,
  orbitLayout,
  type OrbitNode,
  type OrbitRing,
} from "@/knowledge/lib/orbit-layout"
import type {
  Idea,
  KnowledgeDocument,
  KnowledgeEdge,
} from "@/knowledge/model/types"
import { cn } from "@/lib/utils"

const RING_COLOR: Record<OrbitRing, string> = {
  map: "var(--chart-1)",
  concept: "var(--chart-5)",
  module: "var(--chart-2)",
  record: "var(--chart-4)",
  idea: "var(--chart-3)",
}

export function KnowledgeOrbit({
  documents,
  edges,
  ideas,
  onOpenNote,
  onOpenCode,
}: {
  documents: KnowledgeDocument[]
  edges: KnowledgeEdge[]
  ideas: Idea[]
  /** vault 根相对路径（与 `KnowledgeDocument.path` / `Idea.path` 同口径） */
  onOpenNote: (path: string) => void
  onOpenCode: (code: string) => void
}) {
  const t = useTranslations("Knowledge.orbit")
  const tIdea = useTranslations("Knowledge.ideas.status")
  const format = useFormatter()
  const now = useNow({ updateInterval: 60_000 })
  const layout = useMemo(
    () => orbitLayout(documents, edges, ideas),
    [documents, edges, ideas]
  )
  const [selected, setSelected] = useState<string | null>(null)
  const [hover, setHover] = useState<string | null>(null)
  const [hidden, setHidden] = useState<ReadonlySet<OrbitRing>>(new Set())
  const [query, setQuery] = useState("")

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
  const selectedNode = selected ? byId.get(selected) : undefined

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
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("filter")}
          className="ml-auto hidden w-48 rounded border @3xl:block bg-background px-2 py-1 text-xs outline-none focus:border-primary"
        />
      </div>

      {/* 窄屏（移动端）只留星图，选中节点后详情排到星图下方 */}
      <div className="grid @3xl:grid-cols-[minmax(0,1fr)_300px]">
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
              const pending = node.idea?.status === "待讨论"
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
                  {pending && (
                    <circle
                      r={node.size + 3}
                      fill="none"
                      stroke={RING_COLOR.idea}
                      strokeDasharray="2 2"
                    />
                  )}
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
                // 外层定位、里层转：同一元素既 translate 居中又跑 transform 动画，
                // WebKitGTK 合成层上会画偏
                <div
                  className="pointer-events-none absolute aspect-square -translate-x-1/2 -translate-y-1/2"
                  style={at(0, 0, layout.radii[selectedNode.ring]! * 2)}
                >
                  <div className="berth-orbit-ring absolute inset-0 rounded-full border border-dashed border-primary/55" />
                </div>
              )}
              <div
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

        <div
          className={cn(
            "max-h-[640px] overflow-auto border-t p-4 @3xl:block @3xl:border-t-0 @3xl:border-l",
            !selectedNode && "hidden"
          )}
        >
          {selectedNode ? (
            <NodeDetail
              node={selectedNode}
              kind={
                selectedNode.document?.noteType ??
                `${t("rings.idea")} · ${tIdea(selectedNode.idea!.status)}`
              }
              updated={(() => {
                const at =
                  selectedNode.document?.modifiedAt ??
                  selectedNode.idea?.modifiedAt
                return at ? format.relativeTime(new Date(at * 1000), now) : null
              })()}
              outgoing={(relations.out.get(selectedNode.id) ?? []).map(
                (id) => byId.get(id)!
              )}
              backlinks={(relations.back.get(selectedNode.id) ?? []).map(
                (id) => byId.get(id)!
              )}
              onSelect={setSelected}
              onOpenNote={onOpenNote}
              onOpenCode={onOpenCode}
            />
          ) : (
            <div className="text-xs text-muted-foreground">
              <p>{t("hint")}</p>
              <h4 className="mt-4 mb-1.5 font-medium">{t("layers")}</h4>
              {rings.map((ring) => (
                <div key={ring} className="flex items-center gap-1.5 py-0.5">
                  <i
                    className="size-1.5 rounded-full"
                    style={{ background: RING_COLOR[ring] }}
                  />
                  <span className="text-foreground">{t(`rings.${ring}`)}</span>
                  <span className="ml-auto">
                    {layout.nodes.filter((node) => node.ring === ring).length}
                  </span>
                </div>
              ))}
              <h4 className="mt-4 mb-1.5 font-medium">{t("recent")}</h4>
              {[...documents]
                .sort((a, b) => b.modifiedAt - a.modifiedAt)
                .slice(0, 5)
                .map((document) => (
                  <NodeRow
                    key={document.id}
                    node={byId.get(document.id)!}
                    onSelect={setSelected}
                  />
                ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function NodeRow({
  node,
  onSelect,
}: {
  node: OrbitNode
  onSelect: (id: string) => void
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(node.id)}
      className="-mx-1.5 flex w-[calc(100%+12px)] items-center gap-1.5 rounded px-1.5 py-0.5 text-left text-xs text-foreground hover:bg-accent"
    >
      <i
        className="size-1.5 shrink-0 rounded-full"
        style={{ background: RING_COLOR[node.ring] }}
      />
      <span className="truncate">{node.title}</span>
    </button>
  )
}

function NodeDetail({
  node,
  kind,
  updated,
  outgoing,
  backlinks,
  onSelect,
  onOpenNote,
  onOpenCode,
}: {
  node: OrbitNode
  kind: string
  updated: string | null
  outgoing: OrbitNode[]
  backlinks: OrbitNode[]
  onSelect: (id: string) => void
  onOpenNote: (path: string) => void
  onOpenCode: (code: string) => void
}) {
  const t = useTranslations("Knowledge")
  const document = node.document
  const path = document?.path ?? node.idea?.path
  const excerpt = document?.excerpt ?? node.idea?.text ?? ""
  const list = (title: string, nodes: OrbitNode[]) =>
    nodes.length > 0 && (
      <>
        <h4 className="mt-3.5 mb-1.5 text-[11px] font-medium text-muted-foreground">
          {title} {nodes.length}
        </h4>
        {nodes.map((other) => (
          <NodeRow key={other.id} node={other} onSelect={onSelect} />
        ))}
      </>
    )
  return (
    <div>
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <i
          className="size-2 rounded-full"
          style={{ background: RING_COLOR[node.ring] }}
        />
        {[kind, document?.status, updated].filter(Boolean).join(" · ")}
      </div>
      <h3 className="mt-1 mb-2 text-base font-semibold">{node.title}</h3>
      <p className="line-clamp-5 text-xs text-muted-foreground">{excerpt}</p>
      {document && document.code.length > 0 && (
        <>
          <h4 className="mt-3.5 mb-1.5 text-[11px] font-medium text-muted-foreground">
            {t("orbit.code")}
          </h4>
          {document.code.map((code) => (
            <button
              key={code}
              type="button"
              onClick={() => onOpenCode(code)}
              className="-mx-1.5 block w-[calc(100%+12px)] truncate rounded px-1.5 py-0.5 text-left font-mono text-xs text-chart-5 hover:bg-accent"
            >
              {code}
            </button>
          ))}
        </>
      )}
      {list(t("relations.outgoing"), outgoing)}
      {list(t("relations.backlinks"), backlinks)}
      {path && (
        <button
          type="button"
          onClick={() => onOpenNote(path)}
          className="mt-3.5 rounded bg-primary px-3 py-1 text-xs text-primary-foreground hover:bg-primary/90"
        >
          {t("orbit.open")}
        </button>
      )}
    </div>
  )
}
