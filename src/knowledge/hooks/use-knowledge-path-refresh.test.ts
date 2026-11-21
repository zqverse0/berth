import { describe, expect, it } from "vitest"
import { knowledgeWatchDirs } from "@/knowledge/hooks/use-knowledge-path-refresh"
import type { KnowledgeSnapshot } from "@/knowledge/model/types"

const snapshot = (paths: string[]) =>
  ({
    root: "/spaces/1/",
    documents: paths.map((path) => ({ path })),
  }) as unknown as KnowledgeSnapshot

describe("knowledgeWatchDirs", () => {
  it("watches the space directory while the vault has nothing (it may not exist yet)", () => {
    expect(knowledgeWatchDirs(snapshot([]))).toEqual(["/spaces/1"])
  })

  it("watches the vault and each note directory once notes exist", () => {
    expect(
      knowledgeWatchDirs(
        snapshot(["knowledge/概念/a.md", "knowledge/概念/b.md"])
      )
    ).toEqual(["/spaces/1/knowledge", "/spaces/1/knowledge/概念"])
  })
})
