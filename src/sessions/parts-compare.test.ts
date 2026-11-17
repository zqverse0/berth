// 会话读取任务 S2 的对照：同一批真实工具调用，「前端现有推断」（对 4000 字预览猜）与 Rust 按声明算的 Part
// 逐项比标题、路径、增删行数、计划条目。数据由 berth-tool-core 的 `dump_parts_for_comparison` 导出；
// 没有 `PARTS_DUMP` 时跳过。S5 删前端推断时一起删。
import { readFileSync, writeFileSync } from "node:fs"
import { describe, expect, it } from "vitest"
import { normalizeToolName } from "@/lib/agent/tool-call-normalization"
import { extractFilePaths } from "@/lib/agent/session-files"
import { isPlanLikeToolName, parseTodosFromJson } from "@/lib/plan-parse"
import {
  deriveToolTitle,
  extractEditLineChangeStats,
  shortPath,
} from "@/components/message/thread/tool-call-parsing"

interface Row {
  agent: string
  file: string
  name: string
  input: string
  output: string | null
  part: {
    kind: string
    title?: string
    paths?: string[]
    added?: number
    removed?: number
    plan?: { text: string; status?: string }[]
  }
}

const TITLE_PREFIX =
  /^(Read|Edit|Write|NotebookEdit|Glob|Grep|WebFetch|WebSearch:|Skill:|TaskCreate:|Plan ·)\s+/

const norm = (text: string) =>
  text
    .replace(/…$/, "")
    .replace(/\.\.\.$/, "")
    .replace(/\s+/g, " ")
    .trim()

function sameTitle(front: string, rust: string, paths: string[]): boolean {
  const fronts = [norm(front), norm(front.replace(TITLE_PREFIX, ""))]
  const b = norm(rust)
  const rusts = [b, ...paths.map(shortPath), ...paths]
  return fronts.some((a) =>
    rusts.some((c) => {
      const n = Math.min(a.length, c.length, 40)
      return (
        n > 0 && (a.slice(0, n) === c.slice(0, n) || a.includes(c.slice(0, n)))
      )
    })
  )
}

const samePaths = (front: string[], rust: string[]) =>
  front.length === rust.length &&
  front.every((p) =>
    rust.some((r) => r === p || r.endsWith(`/${p}`) || p.endsWith(`/${r}`))
  )

const dump = process.env.PARTS_DUMP

describe.skipIf(!dump)("S2 对照：前端推断 vs Rust Part", () => {
  it("逐项比对并写出差异", () => {
    const rows: Row[] = readFileSync(dump!, "utf8")
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    type Stat = {
      same: number
      differ: number
      frontOnly: number
      rustOnly: number
    }
    const stats: Record<string, Record<string, Stat>> = {}
    const examples: Record<string, unknown[]> = {}
    const examplesCount: Record<string, number> = {}
    const note = (
      agent: string,
      field: string,
      kind: keyof Stat,
      tool: string,
      example: unknown
    ) => {
      const byAgent = (stats[agent] ??= {})
      const stat = (byAgent[field] ??= {
        same: 0,
        differ: 0,
        frontOnly: 0,
        rustOnly: 0,
      })
      stat[kind] += 1
      if (kind === "same") return
      const key = `${agent} ${field} ${kind} ${tool}`
      const list = (examples[key] ??= [])
      if (list.length < 3) list.push(example)
      examplesCount[key] = (examplesCount[key] ?? 0) + 1
    }
    for (const row of rows) {
      const tool = normalizeToolName(row.name)
      const lower = tool.toLowerCase()
      const front = {
        title: deriveToolTitle(tool, row.input, row.output),
        stats:
          lower === "edit" || lower === "apply_patch"
            ? (extractEditLineChangeStats(row.output) ??
              extractEditLineChangeStats(row.input))
            : null,
        paths: extractFilePaths(row.input),
        plan: isPlanLikeToolName(row.name) ? parseTodosFromJson(row.input) : [],
      }
      const rust = row.part
      const compare = (
        field: string,
        f: unknown,
        r: unknown,
        same: () => boolean,
        sample: unknown
      ) => {
        const hasF = f != null && !(Array.isArray(f) && f.length === 0)
        const hasR = r != null && !(Array.isArray(r) && r.length === 0)
        if (!hasF && !hasR) return
        const kind =
          hasF && hasR
            ? same()
              ? "same"
              : "differ"
            : hasF
              ? "frontOnly"
              : "rustOnly"
        note(row.agent, field, kind, row.name, sample)
      }
      compare(
        "title",
        front.title,
        rust.title,
        () => sameTitle(front.title!, rust.title!, rust.paths ?? []),
        { front: front.title, rust: rust.title, input: row.input.slice(0, 160) }
      )
      const rustStats =
        rust.added == null
          ? null
          : { additions: rust.added, deletions: rust.removed ?? 0 }
      // 前端只把 +0 −0 当作没有统计
      const frontStats =
        front.stats && (front.stats.additions > 0 || front.stats.deletions > 0)
          ? front.stats
          : null
      const rustShown =
        rustStats && (rustStats.additions > 0 || rustStats.deletions > 0)
          ? rustStats
          : null
      compare(
        "lines",
        frontStats,
        rustShown,
        () =>
          frontStats!.additions === rustShown!.additions &&
          frontStats!.deletions === rustShown!.deletions,
        { front: frontStats, rust: rustShown, inputChars: row.input.length }
      )
      compare(
        "paths",
        front.paths,
        rust.paths,
        () => samePaths(front.paths, rust.paths ?? []),
        { front: front.paths, rust: rust.paths, input: row.input.slice(0, 160) }
      )
      compare(
        "plan",
        front.plan,
        rust.plan,
        () =>
          front.plan.length === rust.plan!.length &&
          front.plan.every(
            (entry, i) => entry.content === rust.plan![i].text.trim()
          ),
        {
          front: front.plan.map((e) => `${e.status}:${e.content}`).slice(0, 4),
          rust: rust.plan?.map((e) => `${e.status}:${e.text}`).slice(0, 4),
        }
      )
    }
    writeFileSync(
      `${dump}.compare.json`,
      JSON.stringify(
        { calls: rows.length, stats, examples, examplesCount },
        null,
        2
      )
    )
    expect(rows.length).toBeGreaterThan(0)
  })
})
