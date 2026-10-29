import {
  NOTE_TYPES,
  type KnowledgeDocument,
  type KnowledgeSnapshot,
} from "@/knowledge/model/types"

export const VAULT_PREFIX = ".berth/knowledge/"
/** 断链的占位 href；预览里渲染为不可点击的虚线文字。 */

function trimSlash(path: string) {
  return path.replace(/\\/g, "/").replace(/\/+$/, "")
}

/** 绝对路径 → 项目相对路径；不在项目内返回 null。 */
export function projectRelativePath(absolutePath: string, folderPath: string) {
  const root = `${trimSlash(folderPath)}/`
  const path = absolutePath.replace(/\\/g, "/")
  return path.startsWith(root) ? path.slice(root.length) : null
}

/** 是否是 vault 笔记（vault 里的 .md，根目录 README.md 除外），口径与 Rust `is_note` 一致。 */
export function isVaultNotePath(relativePath: string | null) {
  if (relativePath === null || !relativePath.startsWith(VAULT_PREFIX))
    return false
  const inner = relativePath.slice(VAULT_PREFIX.length).toLowerCase()
  return inner.endsWith(".md") && inner !== "readme.md"
}

/** 去掉开头的 frontmatter，口径与 Rust `split_frontmatter` 一致。 */
export function stripFrontmatter(content: string) {
  if (!content.startsWith("---\n")) return content
  const end = content.indexOf("\n---", 4)
  if (end < 0) return content
  return content.slice(end + 4).replace(/^\r?\n/, "")
}

/** 标题与别名（小写）→ 笔记；标题优先于别名。 */
export function buildLinkTable(documents: KnowledgeDocument[]) {
  const table = new Map<string, KnowledgeDocument>()
  for (const document of documents)
    table.set(document.title.toLowerCase(), document)
  for (const document of documents)
    for (const alias of document.aliases) {
      const key = alias.toLowerCase()
      if (!table.has(key)) table.set(key, document)
    }
  return table
}

function uniqueDocuments(
  ids: Iterable<string>,
  byId: Map<string, KnowledgeDocument>
) {
  return [...new Set(ids)]
    .map((id) => byId.get(id))
    .filter((document): document is KnowledgeDocument => Boolean(document))
}

/** 当前笔记的出链（不含断链）与反向链接。 */
export function noteLinks(snapshot: KnowledgeSnapshot, id: string) {
  const byId = new Map(snapshot.documents.map((d) => [d.id, d]))
  const resolved = snapshot.edges.filter((edge) => !edge.unresolved)
  return {
    outgoing: uniqueDocuments(
      resolved
        .filter((e) => e.source === id && e.target !== id)
        .map((e) => e.target),
      byId
    ),
    backlinks: uniqueDocuments(
      resolved
        .filter((e) => e.target === id && e.source !== id)
        .map((e) => e.source),
      byId
    ),
    broken: snapshot.edges
      .filter((edge) => edge.source === id && edge.unresolved)
      .map((edge) => edge.target.replace(/^unresolved:/, "")),
  }
}

/** 按笔记类型分组，组序同 `NOTE_TYPES`，未知类型排在最后；组内按标题排序。 */
export function groupByType(documents: KnowledgeDocument[]) {
  const known: readonly string[] = NOTE_TYPES
  const types = [
    ...NOTE_TYPES,
    ...new Set(
      documents.map((d) => d.noteType).filter((t) => !known.includes(t))
    ),
  ]
  return types
    .map((type) => ({
      type,
      notes: documents
        .filter((d) => d.noteType === type)
        .sort((a, b) => a.title.localeCompare(b.title)),
    }))
    .filter((group) => group.notes.length > 0)
}

/** `code` 覆盖了该文件（精确匹配或目录前缀）的笔记。 */
export function codeMentions(
  documents: KnowledgeDocument[],
  relativePath: string
) {
  return documents.filter((document) =>
    document.code.some((code) => {
      const prefix = trimSlash(code)
      return relativePath === prefix || relativePath.startsWith(`${prefix}/`)
    })
  )
}

/** 首页「待处理」与图谱高亮用的分组。 */
export function vaultHealth(
  snapshot: KnowledgeSnapshot,
  stalePaths: readonly string[]
) {
  const byId = new Map(snapshot.documents.map((d) => [d.id, d]))
  const stale = new Set(stalePaths)
  const linked = new Set<string>()
  for (const edge of snapshot.edges) {
    if (edge.unresolved) continue
    linked.add(edge.source)
    linked.add(edge.target)
  }
  return {
    drafts: snapshot.documents.filter((d) => d.status === "草稿"),
    stale: snapshot.documents.filter((d) => stale.has(d.path)),
    unreadSources: snapshot.documents.filter(
      (d) => d.noteType === "来源" && d.digested !== true
    ),
    broken: uniqueDocuments(
      snapshot.edges.filter((e) => e.unresolved).map((e) => e.source),
      byId
    ),
    orphans: snapshot.documents.filter((d) => !linked.has(d.id)),
  }
}

export type VaultHealth = ReturnType<typeof vaultHealth>

export interface OutlineGroup {
  label: string
  notes: KnowledgeDocument[]
  groups: OutlineGroup[]
}

const LINK = /\[\[([^\]\n]+?)\]\]/g

/** 去掉 markdown 修饰，用作分组名。 */
function plainLabel(text: string) {
  return text
    .replace(
      /\[\[([^\]|]+)\|?([^\]]*)\]\]/g,
      (_, target: string, display: string) => display || target
    )
    .replace(/[*_`]/g, "")
    .trim()
}

/**
 * 地图笔记 → 目录树：`##` 为一级分组、`###` 为二级分组；表格行以首列为二级分组；
 * 其余行里的双链按出现顺序成为当前分组的叶子。断链与代码块内的链接忽略，组内去重。
 */
export function mapOutline(
  markdown: string,
  table: Map<string, KnowledgeDocument>
): OutlineGroup {
  const root: OutlineGroup = { label: "", notes: [], groups: [] }
  let section: OutlineGroup | null = null
  let sub: OutlineGroup | null = null
  let inFence = false
  const subgroup = (label: string) => {
    const parent = section ?? root
    let group = parent.groups.find((g) => g.label === label)
    if (!group) {
      group = { label, notes: [], groups: [] }
      parent.groups.push(group)
    }
    return group
  }
  for (const line of stripFrontmatter(markdown).split("\n")) {
    if (/^\s*```/.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const heading = /^(#{2,3})\s+(.+)$/.exec(line)
    if (heading) {
      if (heading[1] === "##") {
        section = { label: plainLabel(heading[2]), notes: [], groups: [] }
        root.groups.push(section)
        sub = null
      } else {
        sub = subgroup(plainLabel(heading[2]))
      }
      continue
    }
    const notes = [...line.replace(/`[^`\n]*`/g, "").matchAll(LINK)]
      .map((match) => table.get(match[1].split(/[|#]/)[0].trim().toLowerCase()))
      .filter((note): note is KnowledgeDocument => Boolean(note))
    if (notes.length === 0) continue
    const row = /^\s*\|(.*)\|\s*$/.exec(line)
    const target = row
      ? subgroup(plainLabel(row[1].split("|")[0]))
      : (sub ?? section ?? root)
    for (const note of notes)
      if (!target.notes.includes(note)) target.notes.push(note)
  }
  const prune = (group: OutlineGroup): OutlineGroup => ({
    ...group,
    groups: group.groups
      .map(prune)
      .filter((g) => g.notes.length > 0 || g.groups.length > 0),
  })
  return prune(root)
}

/** 目录树里出现过的笔记 id。 */
export function outlineNoteIds(group: OutlineGroup, ids = new Set<string>()) {
  for (const note of group.notes) ids.add(note.id)
  for (const child of group.groups) outlineNoteIds(child, ids)
  return ids
}
