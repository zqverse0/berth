import type {
  Idea,
  KnowledgeDocument,
  KnowledgeEdge,
} from "@/knowledge/model/types"

/**
 * 知识星图的分层：地图在圆心，往外依次是概念、模块、决策与经验（含库里自定义的类型）、想法。
 * 越往里越核心，越往外越具体、越未成形；空的层不占圈。
 */
export const ORBIT_RINGS = [
  "map",
  "concept",
  "module",
  "record",
  "idea",
] as const
export type OrbitRing = (typeof ORBIT_RINGS)[number]

const RING_OF_TYPE: Record<string, OrbitRing> = {
  地图: "map",
  概念: "concept",
  模块: "module",
}
/** 外圈半径（viewBox 单位），按非空层依次取用。 */
const RADII = [130, 225, 305, 375]

export interface OrbitNode {
  id: string
  title: string
  ring: OrbitRing
  x: number
  y: number
  /** 在圈上的角度（弧度）；圆心节点为 null。 */
  angle: number | null
  /** 点的半径：圆心固定，其余按连线数变大。 */
  size: number
  document?: KnowledgeDocument
  idea?: Idea
}

export interface OrbitLayout {
  nodes: OrbitNode[]
  links: { source: string; target: string }[]
  /** 每个非空外圈的半径。 */
  radii: Partial<Record<OrbitRing, number>>
  viewBox: { x: number; y: number; width: number; height: number }
}

const circularMean = (angles: number[]) =>
  Math.atan2(
    angles.reduce((sum, a) => sum + Math.sin(a), 0),
    angles.reduce((sum, a) => sum + Math.cos(a), 0)
  )

export function orbitLayout(
  documents: KnowledgeDocument[],
  edges: KnowledgeEdge[],
  ideas: Idea[]
): OrbitLayout {
  const nodes: OrbitNode[] = [
    ...documents.map((document) => ({
      id: document.id,
      title: document.title,
      ring: RING_OF_TYPE[document.noteType] ?? ("record" as const),
      x: 0,
      y: 0,
      angle: null,
      size: 0,
      document,
    })),
    ...ideas.map((idea) => ({
      id: `idea:${idea.id}`,
      title: idea.text.split("\n")[0].trim() || idea.id,
      ring: "idea" as const,
      x: 0,
      y: 0,
      angle: null,
      size: 0,
      idea,
    })),
  ]
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const seen = new Set<string>()
  const links: OrbitLayout["links"] = []
  const neighbors = new Map(nodes.map((node) => [node.id, new Set<string>()]))
  for (const edge of edges) {
    if (edge.unresolved || edge.source === edge.target) continue
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue
    const key = [edge.source, edge.target].sort().join("\n")
    if (seen.has(key)) continue
    seen.add(key)
    links.push({ source: edge.source, target: edge.target })
    neighbors.get(edge.source)!.add(edge.target)
    neighbors.get(edge.target)!.add(edge.source)
  }

  const radii: OrbitLayout["radii"] = {}
  let next = 0
  for (const ring of ORBIT_RINGS) {
    const items = nodes.filter((node) => node.ring === ring)
    if (items.length === 0) continue
    if (ring === "map") {
      // 地图少时横排在圆心，多了绕一个小圈
      items.forEach((node, index) => {
        if (items.length <= 3) {
          node.x = (index - (items.length - 1) / 2) * 64
        } else {
          const a = (index / items.length) * Math.PI * 2
          node.x = Math.cos(a) * 48
          node.y = Math.sin(a) * 48
        }
        node.size = 11
      })
      continue
    }
    const radius = RADII[Math.min(next++, RADII.length - 1)]
    radii[ring] = radius
    // 外圈按「已排好的邻居的平均角度」排序：相关的笔记挨在一起，连线少交叉
    const score = (node: OrbitNode) => {
      const angles = [...neighbors.get(node.id)!]
        .map((id) => byId.get(id)!.angle)
        .filter((a): a is number => a != null)
      return angles.length ? circularMean(angles) : Infinity
    }
    const ordered =
      ring === "concept"
        ? items.sort((a, b) => a.title.localeCompare(b.title))
        : ring === "idea"
          ? items.sort(
              (a, b) => (b.idea?.modifiedAt ?? 0) - (a.idea?.modifiedAt ?? 0)
            )
          : items
              .map((node) => ({ node, key: score(node) }))
              .sort((a, b) => a.key - b.key)
              .map(({ node }) => node)
    // 从半步处起排，正上方不压点
    const offset = -Math.PI / 2 + Math.PI / ordered.length
    ordered.forEach((node, index) => {
      const a = offset + (index / ordered.length) * Math.PI * 2
      node.angle = a
      node.x = Math.cos(a) * radius
      node.y = Math.sin(a) * radius
      node.size =
        3.5 + Math.min(6, Math.sqrt(neighbors.get(node.id)!.size) * 1.1)
    })
  }

  // 左右留出标签的位置
  const outer = Math.max(80, ...Object.values(radii))
  const viewBox = {
    x: -(outer + 170),
    y: -(outer + 36),
    width: (outer + 170) * 2,
    height: (outer + 36) * 2,
  }
  return { nodes, links, radii, viewBox }
}
