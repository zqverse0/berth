import type { ContentBlock, MessageTurn } from "@/lib/types"

/**
 * 会话按“一问一答”分段：一个真实提问 + 到下一次提问前 Agent 做的所有事。
 *
 * 只用通用结构规则，不按 Agent 品牌分支：
 * - 提问 = 含文本或图片的 user 轮；只带工具结果的 user 轮属于过程。
 * - 精简回答 = 本段最后一个 assistant 文本块。
 * - 过程 = 其余块；连续的 assistant / 工具结果轮合并成一轮，
 *   让适配层按 `tool_use_id` 把调用与结果配对，并折叠成工具组。
 */

export type ExchangeDetail = "prompts" | "answers" | "full"

export interface ExchangeStats {
  /** 工具名 → 调用次数。 */
  tools: Record<string, number>
  /** 工具名 → 结果的估算 token 合计（截断前），看哪个工具最占上下文。 */
  toolTokens: Record<string, number>
  /** 技能名 → 加载次数（reader 写入的 `meta["berth.skills"]`）。 */
  skills: Record<string, number>
  toolCalls: number
  errors: number
  thinking: number
  /** 本段最后一次请求的输入侧 token（input + cache），近似当时的上下文占用。 */
  contextTokens: number | null
  model: string | null
  startedAt: string | null
  endedAt: string | null
}

export interface SessionExchange {
  id: string
  /** 从 1 开始；0 表示首个提问之前的开场内容。 */
  index: number
  prompt: MessageTurn | null
  process: MessageTurn[]
  answer: MessageTurn | null
  stats: ExchangeStats
}

export interface ProcessFilter {
  thinking: boolean
  tools: boolean
  /** 只保留该工具的调用（及其结果）。 */
  toolName: string | null
  /** 只保留加载该技能的调用（及其结果）。 */
  skill: string | null
  errorsOnly: boolean
}

type Narrowing = Pick<ProcessFilter, "toolName" | "skill" | "errorsOnly">

const SKILL_META_KEY = "berth.skills"

// ponytail: 按固定调用数切块，避免单行渲染上百个工具；需要更细时改按时间切
const MAX_TOOL_CALLS_PER_SEGMENT = 40

/** reader 按 sessions.json 声明或 `skills/<名字>/SKILL.md` 约定标注的技能名。 */
export function toolSkills(block: ContentBlock): string[] {
  if (block.type !== "tool_use") return []
  const names = block.meta?.[SKILL_META_KEY]
  return Array.isArray(names)
    ? names.filter((name): name is string => typeof name === "string")
    : []
}

function hasText(block: ContentBlock): boolean {
  return block.type === "text" && block.text.trim() !== ""
}

function isPromptTurn(turn: MessageTurn): boolean {
  return (
    turn.role === "user" &&
    turn.blocks.some((block) => hasText(block) || block.type === "image")
  )
}

function isToolResultOnly(turn: MessageTurn): boolean {
  return (
    turn.blocks.length > 0 &&
    turn.blocks.every((block) => block.type === "tool_result")
  )
}

function contextTokens(turn: MessageTurn): number | null {
  const usage = turn.usage
  if (!usage) return null
  const total =
    usage.input_tokens +
    usage.cache_read_input_tokens +
    usage.cache_creation_input_tokens
  return total > 0 ? total : null
}

/** 首次请求的输入 token（input + cache）：模型开工前就已在上下文里的量，即启动输入的精确总量。 */
export function firstCallTokens(turns: MessageTurn[]): number | null {
  for (const turn of turns) {
    const tokens = contextTokens(turn)
    if (tokens != null) return tokens
  }
  return null
}

function emptyStats(): ExchangeStats {
  return {
    tools: {},
    toolTokens: {},
    skills: {},
    toolCalls: 0,
    errors: 0,
    thinking: 0,
    contextTokens: null,
    model: null,
    startedAt: null,
    endedAt: null,
  }
}

function collectStats(turns: MessageTurn[]): ExchangeStats {
  const stats = emptyStats()
  const toolNames = new Map<string, string>()
  for (const turn of turns) {
    stats.startedAt ??= turn.timestamp
    stats.endedAt = turn.completed_at ?? turn.timestamp
    stats.contextTokens = contextTokens(turn) ?? stats.contextTokens
    stats.model = turn.model ?? stats.model
    for (const block of turn.blocks) {
      if (block.type === "tool_use") {
        stats.tools[block.tool_name] = (stats.tools[block.tool_name] ?? 0) + 1
        stats.toolCalls += 1
        if (block.tool_use_id) toolNames.set(block.tool_use_id, block.tool_name)
        for (const skill of toolSkills(block)) {
          stats.skills[skill] = (stats.skills[skill] ?? 0) + 1
        }
      } else if (block.type === "tool_result") {
        if (block.is_error) stats.errors += 1
        const name = block.tool_use_id && toolNames.get(block.tool_use_id)
        if (name && block.output_tokens) {
          stats.toolTokens[name] =
            (stats.toolTokens[name] ?? 0) + block.output_tokens
        }
      } else if (block.type === "thinking" && block.text.trim() !== "") {
        stats.thinking += 1
      }
    }
  }
  return stats
}

/** 找本段最后一个 assistant 文本块的位置。 */
function findAnswer(body: MessageTurn[]): [number, number] | null {
  for (let t = body.length - 1; t >= 0; t--) {
    const turn = body[t]
    if (turn.role !== "assistant") continue
    for (let b = turn.blocks.length - 1; b >= 0; b--) {
      if (hasText(turn.blocks[b])) return [t, b]
    }
  }
  return null
}

function mergeProcess(body: MessageTurn[]): MessageTurn[] {
  const segments: MessageTurn[] = []
  let current: MessageTurn | null = null
  let calls = 0

  const flush = () => {
    if (current && current.blocks.length > 0) segments.push(current)
    current = null
    calls = 0
  }

  for (const turn of body) {
    if (turn.blocks.length === 0) continue
    const mergeable = turn.role === "assistant" || isToolResultOnly(turn)
    if (!mergeable) {
      flush()
      segments.push(turn)
      continue
    }
    const turnCalls = turn.blocks.filter(
      (block) => block.type === "tool_use"
    ).length
    if (current && turnCalls > 0 && calls >= MAX_TOOL_CALLS_PER_SEGMENT) {
      flush()
    }
    current ??= {
      id: `${turn.id}:process`,
      role: "assistant",
      blocks: [],
      timestamp: turn.timestamp,
    }
    current.blocks.push(...turn.blocks)
    calls += turnCalls
  }
  flush()
  return segments
}

function buildExchange(
  index: number,
  prompt: MessageTurn | null,
  body: MessageTurn[]
): SessionExchange {
  const stats = collectStats(prompt ? [prompt, ...body] : body)
  const position = findAnswer(body)
  let answer: MessageTurn | null = null
  let processBody = body
  if (position) {
    const [t, b] = position
    const source = body[t]
    answer = {
      id: `${source.id}:answer`,
      role: "assistant",
      blocks: [source.blocks[b]],
      timestamp: source.timestamp,
      model: source.model,
      completed_at: source.completed_at,
    }
    processBody = body.map((turn, i) =>
      i === t
        ? { ...turn, blocks: turn.blocks.filter((_, j) => j !== b) }
        : turn
    )
  }
  return {
    id: prompt?.id ?? body[0]?.id ?? `exchange-${index}`,
    index,
    prompt,
    process: mergeProcess(processBody),
    answer,
    stats,
  }
}

export function buildExchanges(turns: MessageTurn[]): SessionExchange[] {
  const exchanges: SessionExchange[] = []
  let prompt: MessageTurn | null = null
  let body: MessageTurn[] = []
  let prompts = 0

  const close = () => {
    if (!prompt && !body.some((turn) => turn.blocks.length > 0)) return
    exchanges.push(buildExchange(prompt ? prompts : 0, prompt, body))
  }

  for (const turn of turns) {
    if (isPromptTurn(turn)) {
      close()
      prompts += 1
      prompt = turn
      body = []
    } else {
      body.push(turn)
    }
  }
  close()
  return exchanges
}

export function isNarrowed(filter: Narrowing): boolean {
  return filter.toolName != null || filter.skill != null || filter.errorsOnly
}

/**
 * 按筛选条件裁剪过程。收窄（工具名 / 技能 / 只看出错）时只留命中的调用
 * 及其结果；否则按思考、工具开关整体显隐。
 */
export function filterProcess(
  process: MessageTurn[],
  filter: ProcessFilter
): MessageTurn[] {
  const narrowed = isNarrowed(filter)
  const errorIds = new Set<string>()
  for (const turn of process) {
    for (const block of turn.blocks) {
      if (block.type === "tool_result" && block.is_error && block.tool_use_id) {
        errorIds.add(block.tool_use_id)
      }
    }
  }
  const keptIds = new Set<string>()
  const keepUse = (block: ContentBlock & { type: "tool_use" }) =>
    filter.tools &&
    (filter.toolName == null || block.tool_name === filter.toolName) &&
    (filter.skill == null || toolSkills(block).includes(filter.skill)) &&
    (!filter.errorsOnly ||
      (block.tool_use_id != null && errorIds.has(block.tool_use_id)))

  const result: MessageTurn[] = []
  for (const turn of process) {
    const blocks = turn.blocks.filter((block) => {
      switch (block.type) {
        case "tool_use": {
          const keep = keepUse(block)
          if (keep && block.tool_use_id) keptIds.add(block.tool_use_id)
          return keep
        }
        case "tool_result":
          return (
            filter.tools &&
            (block.tool_use_id != null
              ? keptIds.has(block.tool_use_id)
              : !narrowed)
          )
        case "thinking":
          return filter.thinking && !narrowed
        default:
          return !narrowed
      }
    })
    if (blocks.length > 0) result.push({ ...turn, blocks })
  }
  return result
}

/** 段落是否命中筛选（工具名、技能、只看出错、关键词）。 */
export function matchesExchange(
  exchange: SessionExchange,
  filter: Narrowing,
  query: string
): boolean {
  if (filter.toolName && !exchange.stats.tools[filter.toolName]) return false
  if (filter.skill && !exchange.stats.skills[filter.skill]) return false
  if (filter.errorsOnly && exchange.stats.errors === 0) return false
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  const turns = [exchange.prompt, exchange.answer, ...exchange.process]
  return turns.some((turn) =>
    turn?.blocks.some((block) => {
      if (block.type === "text" || block.type === "thinking") {
        return block.text.toLowerCase().includes(needle)
      }
      if (block.type === "tool_use") {
        return (
          block.tool_name.toLowerCase().includes(needle) ||
          (block.input_preview ?? "").toLowerCase().includes(needle)
        )
      }
      return false
    })
  )
}

/** 提问首行摘要，用于目录。 */
export function promptSummary(exchange: SessionExchange): string {
  const text = exchange.prompt?.blocks.find(hasText)
  if (!text || text.type !== "text") return ""
  return text.text.trim().split("\n")[0].slice(0, 120)
}
