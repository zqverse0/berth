import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { HOME_NOTE_PATH, VaultEmpty, VaultTree } from "./vault-browse"
import type { VaultHealth } from "@/knowledge/lib/vault"
import type { KnowledgeDocument } from "@/knowledge/model/types"

vi.mock("next-intl", () => ({
  useTranslations: () => (key: string) => key,
}))

const note = (path: string, noteType: string) =>
  ({
    id: `document:${path}`,
    path,
    title: path.split("/").pop()!.replace(/\.md$/, ""),
    noteType,
    aliases: [],
  }) as unknown as KnowledgeDocument

const healthy: VaultHealth = {
  drafts: [],
  stale: [],
  unreadSources: [],
  broken: [],
  orphans: [],
}

describe("VaultTree", () => {
  it("follows the home map with every group collapsed", () => {
    const home = note(HOME_NOTE_PATH, "地图")
    const moduleNote = note(".berth/knowledge/模块/终端运行时.md", "模块")
    const concept = note(".berth/knowledge/概念/termd.md", "概念")
    const onOpen = vi.fn()
    render(
      <VaultTree
        documents={[home, moduleNote, concept]}
        homeContent={"# 首页\n## 主线循环\n| 跑 | [[终端运行时]] |"}
        health={{ ...healthy, stale: [moduleNote] }}
        mentions={[]}
        activePath={null}
        onOpen={onOpen}
      />
    )
    const rows = screen
      .getAllByRole("treeitem")
      .map((row) => row.textContent?.trim())
    expect(rows[0]).toBe("首页")
    expect(screen.getByText("outline.others")).toBeTruthy()
    expect(screen.getByText("maintenance.title")).toBeTruthy()
    // 分组默认折叠：子分组与笔记都不可见
    expect(screen.queryByText("跑")).toBeNull()
    expect(screen.queryByText("终端运行时")).toBeNull()

    fireEvent.click(screen.getByText("主线循环"))
    fireEvent.click(screen.getByText("跑"))
    fireEvent.click(screen.getByText("终端运行时"))
    expect(onOpen).toHaveBeenCalledWith(moduleNote)
  })

  it("falls back to type groups and opens notes mentioning the code file", () => {
    const concept = note(".berth/knowledge/概念/termd.md", "概念")
    render(
      <VaultTree
        documents={[concept]}
        homeContent={null}
        health={healthy}
        mentions={[concept]}
        activePath={null}
        onOpen={vi.fn()}
      />
    )
    expect(screen.getByText("概念")).toBeTruthy()
    expect(screen.queryByText("maintenance.title")).toBeNull()
    // 「引用当前文件」默认展开
    expect(screen.getByText("current.mentions")).toBeTruthy()
    expect(screen.getByText("termd")).toBeTruthy()
  })
})

describe("VaultEmpty", () => {
  it("hands the first notes to an Agent", () => {
    const onAskAgent = vi.fn()
    render(<VaultEmpty busy={false} onAskAgent={onAskAgent} />)
    fireEvent.click(screen.getByText("empty.askAgent"))
    expect(onAskAgent).toHaveBeenCalledOnce()
  })
})
