import { expect, test } from "vitest"
import type { KnowledgeDocument, KnowledgeEdge } from "@/knowledge/model/types"
import { orbitLayout } from "./orbit-layout"

const doc = (id: string, noteType: string): KnowledgeDocument =>
  ({ id, title: id, noteType }) as KnowledgeDocument
const link = (source: string, target: string): KnowledgeEdge => ({
  id: `${source}->${target}`,
  source,
  target,
  kind: "wikilink",
  unresolved: false,
})

test("按类型分层，空层不占圈，自定义类型落在决策 / 经验那一圈", () => {
  const layout = orbitLayout(
    [doc("首页", "地图"), doc("A", "概念"), doc("M", "模块"), doc("X", "随笔")],
    [],
    []
  )
  const ring = (id: string) => layout.nodes.find((n) => n.id === id)!.ring
  expect([ring("首页"), ring("A"), ring("M"), ring("X")]).toEqual([
    "map",
    "concept",
    "module",
    "record",
  ])
  expect(layout.radii).toEqual({ concept: 130, module: 225, record: 305 })
  const center = layout.nodes.find((n) => n.id === "首页")!
  expect([center.x, center.y]).toEqual([0, 0])
})

test("模块挨着它链接的概念排，断链与重复边不计", () => {
  const concepts = ["C1", "C2", "C3", "C4"].map((id) => doc(id, "概念"))
  const layout = orbitLayout(
    [...concepts, doc("M1", "模块"), doc("M3", "模块")],
    [
      link("M3", "C3"),
      link("M1", "C1"),
      link("C1", "M1"),
      { ...link("M1", "nowhere"), unresolved: true },
    ],
    []
  )
  expect(layout.links).toHaveLength(2)
  const order = layout.nodes
    .filter((n) => n.ring === "module")
    .sort((a, b) => a.angle! - b.angle!)
    .map((n) => n.id)
  expect(order).toEqual(["M1", "M3"])
})
