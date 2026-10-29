/** 与 `src-tauri/src/knowledge/model.rs` 对应；字段语义见 `berth guide knowledge`。 */

/** 笔记类型（面板分组顺序）；另有「来源」（发现页维护）与「未分类」（vault 根目录下没写 type）。 */
export const NOTE_TYPES = ["地图", "概念", "模块", "决策", "经验"] as const

export type NoteStatus = "草稿" | "已确认" | "已取代"

export interface KnowledgeHeading {
  level: number
  text: string
}

export interface KnowledgeDocument {
  id: string
  /** 项目相对路径，如 `.berth/knowledge/模块/终端运行时.md` */
  path: string
  /** 文件名即标题 */
  title: string
  excerpt: string
  noteType: string
  status: string
  tags: string[]
  aliases: string[]
  code: string[]
  sources: string[]
  verifiedAt: string | null
  /** 来源笔记的链接 */
  url?: string
  /** 来源笔记是否已读（专家写过摘要） */
  digested?: boolean
  headings: KnowledgeHeading[]
  /** Unix 秒 */
  modifiedAt: number
}

export interface KnowledgeEdge {
  id: string
  source: string
  target: string
  kind: "wikilink" | "supersedes"
  unresolved: boolean
}

export interface KnowledgeSnapshot {
  /** vault 所在项目（主项目）的绝对路径；worktree 也读这一份，笔记 `path` 相对它。 */
  root: string
  revision: string
  generatedAt: string
  documents: KnowledgeDocument[]
  edges: KnowledgeEdge[]
  diagnostics: Array<{ kind: string; message: string; path: string | null }>
}

/** vault 下的想法目录，与 `berth_project_core::knowledge::ideas` 一致。 */
export const IDEAS_DIR = "想法"

export const IDEA_STATUSES = ["待讨论", "讨论中", "已落地", "已放下"] as const
export type IdeaStatus = (typeof IDEA_STATUSES)[number]

/** 开放的想法；已落地、已放下在 `想法/归档/`，默认收起。 */
export const OPEN_IDEA_STATUSES: ReadonlySet<string> = new Set([
  "待讨论",
  "讨论中",
])

/** 一条想法（`<vault>/想法/<id>.md`）；`text` 是用户原话，不含 Agent 追加的讨论。 */
export interface Idea {
  /** 文件名，即创建时间 `YYYY-MM-DD-HHMMSS`。 */
  id: string
  path: string
  status: IdeaStatus
  tags: string[]
  text: string
  modifiedAt: number
}
