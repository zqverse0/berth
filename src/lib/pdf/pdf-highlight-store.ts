/**
 * PDF 高亮/注释数据模型与 sidecar 持久化。
 *
 * 复用 Agentero 验证过的 0–1 归一化矩形模型（PdfHighlightRect），
 * 存储走现有工作区文件命令（readFilePreview / createFileTreeEntry /
 * saveFileContent），不新增 Tauri command。
 * sidecar 为 PDF 同目录独立新文件（<basename>.marks.json），不改动源 PDF。
 */

import {
  createFileTreeEntry,
  readFilePreview,
  saveFileContent,
} from "@/lib/api"
import type { WorkspaceFileRef } from "@/lib/files/file-workspace-tab"

/** 0–1 相对页面 box 的矩形 */
export type PdfHighlightRect = {
  x: number
  y: number
  w: number
  h: number
}

/** PDF 高亮/注释条目 */
export type PdfHighlight = {
  version: 1
  kind: "highlight" | "note"
  id: string
  /** 1-based 页码 */
  page: number
  /** 覆盖高亮/注释文本的归一化矩形 */
  rects: PdfHighlightRect[]
  /** 被选中的源文本 */
  quote: string
  /** 调色板 key（yellow|green|blue|pink|purple），高亮缺省 yellow */
  color?: string
  /** 注释内容 */
  comment?: string
  createdAt: string
  updatedAt: string
}

/** sidecar 文件顶层结构 */
export type PdfMarksFile = {
  version: 1
  highlights: PdfHighlight[]
}

export const HIGHLIGHT_OPACITY = 0.4

export const HIGHLIGHT_HEX: Record<string, string> = {
  yellow: "#fcd34d",
  green: "#86efac",
  blue: "#7dd3fc",
  pink: "#f9a8d4",
  purple: "#d8b4fe",
}

export const HIGHLIGHT_COLORS = Object.keys(HIGHLIGHT_HEX)

/** sidecar 相对路径：`docs/paper.pdf` → `docs/paper.pdf.marks.json` */
export function marksSidecarPath(path: string): string {
  return `${path}.marks.json`
}

function isPdfHighlight(value: unknown): value is PdfHighlight {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return (
    record.version === 1 &&
    (record.kind === "highlight" || record.kind === "note") &&
    typeof record.id === "string" &&
    typeof record.page === "number" &&
    Array.isArray(record.rects)
  )
}

function emptyMarks(): PdfMarksFile {
  return { version: 1, highlights: [] }
}

function parseMarks(content: string): PdfMarksFile {
  const parsed = JSON.parse(content) as unknown
  if (!parsed || typeof parsed !== "object") return emptyMarks()
  const record = parsed as Record<string, unknown>
  if (record.version !== 1) return emptyMarks()
  const highlights = record.highlights
  if (!Array.isArray(highlights)) return emptyMarks()
  return { version: 1, highlights: highlights.filter(isPdfHighlight) }
}

/**
 * 读取 sidecar；文件缺失/解析失败时返回空（静默降级，不阻塞阅读）。
 */
export async function loadHighlights(
  file: WorkspaceFileRef
): Promise<PdfHighlight[]> {
  try {
    const preview = await readFilePreview(
      file.rootPath,
      marksSidecarPath(file.path)
    )
    return parseMarks(preview.content).highlights
  } catch {
    return []
  }
}

function splitRelPath(rel: string): { dir: string; name: string } {
  const normalized = rel.replace(/^\/+|\/+$/g, "")
  const lastSlash = normalized.lastIndexOf("/")
  if (lastSlash < 0) return { dir: "", name: normalized }
  return {
    dir: normalized.slice(0, lastSlash),
    name: normalized.slice(lastSlash + 1),
  }
}

/**
 * 写入 sidecar；文件不存在时先创建（createFileTreeEntry），
 * 任一步失败静默降级（返回 false，不阻塞阅读）。
 */
export async function saveHighlights(
  file: WorkspaceFileRef,
  highlights: PdfHighlight[]
): Promise<boolean> {
  const sidecarPath = marksSidecarPath(file.path)
  const payload = JSON.stringify({ version: 1, highlights }, null, 2)
  try {
    await saveFileContent(file.rootPath, sidecarPath, payload)
    return true
  } catch {
    // 文件不存在 → 走创建路径
  }
  try {
    const { dir, name } = splitRelPath(sidecarPath)
    await createFileTreeEntry(file.rootPath, dir, name, "file")
    await saveFileContent(file.rootPath, sidecarPath, payload)
    return true
  } catch {
    return false
  }
}

/** 创建一条高亮（默认黄色，无注释）。 */
export function createHighlight(
  page: number,
  rects: PdfHighlightRect[],
  quote: string,
  color?: string
): PdfHighlight {
  const now = new Date().toISOString()
  return {
    version: 1,
    kind: "highlight",
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `hl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    page,
    rects,
    quote,
    color: color ?? "yellow",
    createdAt: now,
    updatedAt: now,
  }
}

/** 创建一条注释（下划线形式，带批注文本）。 */
export function createNote(
  page: number,
  rects: PdfHighlightRect[],
  quote: string,
  comment: string
): PdfHighlight {
  const now = new Date().toISOString()
  return {
    version: 1,
    kind: "note",
    id:
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `note-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    page,
    rects,
    quote,
    comment,
    createdAt: now,
    updatedAt: now,
  }
}
