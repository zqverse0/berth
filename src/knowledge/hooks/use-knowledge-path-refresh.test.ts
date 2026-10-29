import { describe, expect, it } from "vitest"
import { knowledgeWatchDirs } from "@/knowledge/hooks/use-knowledge-path-refresh"
import type { KnowledgeSnapshot } from "@/knowledge/model/types"

const snapshot = (paths: string[]) =>
  ({
    root: "/repo/",
    documents: paths.map((path) => ({ path })),
  }) as unknown as KnowledgeSnapshot

describe("knowledgeWatchDirs", () => {
  it("watches .berth while the vault has nothing (it may not exist yet)", () => {
    expect(knowledgeWatchDirs(snapshot([]), false)).toEqual(["/repo/.berth"])
  })

  it("watches the vault, ideas and each note directory once notes exist", () => {
    expect(
      knowledgeWatchDirs(
        snapshot([".berth/knowledge/概念/a.md", ".berth/knowledge/概念/b.md"]),
        true
      )
    ).toEqual([
      "/repo/.berth/knowledge",
      "/repo/.berth/knowledge/想法",
      "/repo/.berth/knowledge/概念",
    ])
  })
})
