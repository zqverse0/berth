import { describe, expect, it } from "vitest"
import {
  buildLinkTable,
  codeMentions,
  isVaultNotePath,
  mapOutline,
  noteLinks,
  outlineNoteIds,
  type OutlineGroup,
  projectRelativePath,
  stripFrontmatter,
  vaultHealth,
} from "./vault"
import type { KnowledgeDocument, KnowledgeSnapshot } from "../model/types"

function doc(title: string, extra: Partial<KnowledgeDocument> = {}) {
  return {
    id: `document:.berth/knowledge/模块/${title}.md`,
    path: `.berth/knowledge/模块/${title}.md`,
    title,
    excerpt: "",
    noteType: "模块",
    status: "已确认",
    tags: [],
    aliases: [],
    code: [],
    sources: [],
    verifiedAt: null,
    headings: [],
    modifiedAt: 0,
    ...extra,
  } satisfies KnowledgeDocument
}

const a = doc("从零读懂 Berth", { aliases: ["intro"] })
const b = doc("终端运行时", {
  status: "草稿",
  code: ["src-tauri/terminal/", "src/x.ts"],
})
const c = doc("孤立")
const snapshot: KnowledgeSnapshot = {
  root: "/p",
  revision: "",
  generatedAt: "",
  diagnostics: [],
  documents: [a, b, c],
  edges: [
    {
      id: "1",
      source: a.id,
      target: b.id,
      kind: "wikilink",
      unresolved: false,
    },
    {
      id: "2",
      source: a.id,
      target: b.id,
      kind: "wikilink",
      unresolved: false,
    },
    {
      id: "3",
      source: b.id,
      target: "unresolved:缺失",
      kind: "wikilink",
      unresolved: true,
    },
  ],
}

describe("vault paths", () => {
  it("recognises vault notes only inside type folders", () => {
    const rel = projectRelativePath(
      "/repo/.berth/knowledge/模块/A.md",
      "/repo/"
    )
    expect(rel).toBe(".berth/knowledge/模块/A.md")
    expect(isVaultNotePath(rel)).toBe(true)
    expect(isVaultNotePath(".berth/knowledge/README.md")).toBe(false)
    expect(isVaultNotePath(".berth/knowledge/z.md")).toBe(true)
    expect(isVaultNotePath("docs/a.md")).toBe(false)
    expect(projectRelativePath("/other/a.md", "/repo")).toBeNull()
  })

  it("strips frontmatter like the backend", () => {
    expect(stripFrontmatter("---\ntype: 模块\n---\n# T\n")).toBe("# T\n")
    expect(stripFrontmatter("# T\n---\n")).toBe("# T\n---\n")
  })
})

describe("buildLinkTable", () => {
  it("resolves titles and aliases case-insensitively, titles first", () => {
    const table = buildLinkTable(snapshot.documents)
    expect(table.get("从零读懂 berth")?.title).toBe("从零读懂 Berth")
    expect(table.get("intro")?.title).toBe("从零读懂 Berth")
    expect(table.get("缺失")).toBeUndefined()
  })
})

describe("vault relations", () => {
  it("lists outgoing, backlinks and broken targets without duplicates", () => {
    expect(noteLinks(snapshot, a.id).outgoing.map((d) => d.title)).toEqual([
      "终端运行时",
    ])
    expect(noteLinks(snapshot, b.id).backlinks.map((d) => d.title)).toEqual([
      "从零读懂 Berth",
    ])
    expect(noteLinks(snapshot, b.id).broken).toEqual(["缺失"])
  })

  it("finds notes whose code covers a file", () => {
    expect(codeMentions(snapshot.documents, "src-tauri/terminal/a.rs")).toEqual(
      [b]
    )
    expect(codeMentions(snapshot.documents, "src/x.ts")).toEqual([b])
    expect(codeMentions(snapshot.documents, "src/x.tsx")).toEqual([])
  })

  it("groups pending work", () => {
    const health = vaultHealth(snapshot, [c.path])
    expect(health.drafts).toEqual([b])
    expect(health.stale).toEqual([c])
    expect(health.broken).toEqual([b])
    expect(health.orphans).toEqual([c])
    expect(health.unreadSources).toEqual([])
    const read = doc("读过", { noteType: "来源", digested: true })
    const unread = doc("没读", { noteType: "来源" })
    expect(
      vaultHealth({ ...snapshot, documents: [read, unread], edges: [] }, [])
        .unreadSources
    ).toEqual([unread])
  })
})

describe("mapOutline", () => {
  it("builds sections, table-row groups and ordered leaves from a map note", () => {
    const docs = [
      "首页",
      "会话历史读取",
      "终端运行时",
      "termd",
      "模型服务商",
    ].map((title) => doc(title))
    const table = buildLinkTable(docs)
    const outline = mapOutline(
      [
        "---",
        "type: 地图",
        "---",
        "# 首页",
        "",
        "## 主线循环",
        "```text",
        "[[termd]]",
        "```",
        "| 步 | 模块 |",
        "|---|---|",
        "| 读 | [[会话历史读取]] |",
        "| **跑** | [[终端运行时]]、[[termd]]、`[[x]]` |",
        "## 卫星",
        "- [[模型服务商]] — [[不存在]]",
        "- [[模型服务商]] 再次出现",
        "## 空分组",
        "没有链接",
      ].join("\n"),
      table
    )
    const shape = (g: OutlineGroup): unknown => ({
      label: g.label,
      notes: g.notes.map((n) => n.title),
      groups: g.groups.map(shape),
    })
    expect(shape(outline)).toEqual({
      label: "",
      notes: [],
      groups: [
        {
          label: "主线循环",
          notes: [],
          groups: [
            { label: "读", notes: ["会话历史读取"], groups: [] },
            { label: "跑", notes: ["终端运行时", "termd"], groups: [] },
          ],
        },
        { label: "卫星", notes: ["模型服务商"], groups: [] },
      ],
    })
    expect(outlineNoteIds(outline).size).toBe(4)
  })
})
