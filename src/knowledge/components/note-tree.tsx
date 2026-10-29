"use client"

import { useMemo, useState, type ReactNode } from "react"
import {
  FileTree,
  FileTreeFile,
  FileTreeFolder,
} from "@/components/ai-elements/file-tree"
import { getFileIconConfig } from "@/components/ai-elements/file-tree-icons"
import type { KnowledgeDocument } from "@/knowledge/model/types"

/** 树的一个分组：笔记在前（保持阅读顺序，首页置顶）、子分组在后。 */
export interface NoteTreeGroup {
  label: string
  notes: KnowledgeDocument[]
  groups: NoteTreeGroup[]
  /** 分组名右侧的计数等 */
  suffix?: ReactNode
  /** 初始是否展开（默认折叠） */
  open?: boolean
}

const markdownIcon = (() => {
  const { icon: Icon, colorClass } = getFileIconConfig("note.md")
  return <Icon className={`size-4 shrink-0 ${colorClass}`} />
})()

/**
 * 笔记树：复用文件树的行组件，外观与项目文件树一致。
 * 同一笔记可出现在多个分组，行 path 以分组路径为前缀保证唯一。
 */
export function NoteTree({
  root,
  activePath,
  onOpen,
  noteSuffix,
}: {
  root: NoteTreeGroup
  /** 主区当前笔记（项目相对路径），对应行高亮 */
  activePath?: string | null
  onOpen: (document: KnowledgeDocument) => void
  noteSuffix?: (document: KnowledgeDocument) => ReactNode
}) {
  const { rows, initiallyExpanded } = useMemo(() => {
    const rows = new Map<string, KnowledgeDocument>()
    const expanded = new Set<string>()
    const walk = (group: NoteTreeGroup, path: string) => {
      group.groups.forEach((child, index) => {
        const childPath = `${path}/${index}`
        if (child.open) expanded.add(childPath)
        walk(child, childPath)
      })
      for (const note of group.notes) rows.set(`${path}:${note.path}`, note)
    }
    walk(root, "g")
    return { rows, initiallyExpanded: expanded }
  }, [root])
  const [expanded, setExpanded] = useState(initiallyExpanded)
  const selectedPath = activePath
    ? [...rows].find(([, note]) => note.path === activePath)?.[0]
    : undefined

  const render = (
    group: NoteTreeGroup,
    path: string,
    depth: number
  ): ReactNode => [
    ...group.notes.map((note) => (
      <FileTreeFile
        key={`${path}:${note.path}`}
        path={`${path}:${note.path}`}
        name={note.title}
        icon={markdownIcon}
        depth={depth}
        title={note.path}
        suffix={noteSuffix?.(note)}
        suffixClassName="font-sans font-normal text-muted-foreground"
      />
    )),
    ...group.groups.map((child, index) => (
      <FileTreeFolder
        key={`${path}/${index}`}
        path={`${path}/${index}`}
        name={child.label}
        suffix={child.suffix}
        suffixClassName="text-muted-foreground/60"
        depth={depth}
      >
        {render(child, `${path}/${index}`, depth + 1)}
      </FileTreeFolder>
    )),
  ]

  return (
    <FileTree
      className="w-max min-w-full rounded-none border-0 bg-transparent px-1.5"
      expanded={expanded}
      onExpandedChange={setExpanded}
      selectedPath={selectedPath}
      onSelect={(path) => {
        const note = rows.get(path)
        if (note) onOpen(note)
      }}
    >
      {render(root, "g", 0)}
    </FileTree>
  )
}

/** 平铺列表（搜索结果、反向提及），同样是文件树行样式。 */
export function NoteRows({
  documents,
  empty,
  onOpen,
  noteSuffix = (document) => document.noteType,
}: {
  documents: KnowledgeDocument[]
  empty: string
  onOpen: (document: KnowledgeDocument) => void
  noteSuffix?: (document: KnowledgeDocument) => ReactNode
}) {
  if (documents.length === 0)
    return <p className="px-3 py-2 text-xs text-muted-foreground">{empty}</p>
  return (
    <NoteTree
      root={{ label: "", notes: documents, groups: [] }}
      onOpen={onOpen}
      noteSuffix={noteSuffix}
    />
  )
}
