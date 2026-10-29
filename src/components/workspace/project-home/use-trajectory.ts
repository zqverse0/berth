import { useEffect, useMemo, useState } from "react"
import { useShallow } from "zustand/react/shallow"
import { deriveToolTitle } from "@/components/message/thread/tool-call-parsing"
import { agentTypeForTool, useAgentProfiles } from "@/hooks/use-agent-profiles"
import {
  classifyToolKind,
  type ToolKindLabel,
} from "@/lib/adapters/tool-kind-classifier"
import { extractFilePaths } from "@/lib/agent/session-files"
import { normalizeToolName } from "@/lib/agent/tool-call-normalization"
import {
  listProjectSessionOverview,
  resolveProjectAgentSession,
} from "@/lib/api"
import type {
  DbConversationDetail,
  MessageTurn,
  ProjectSessionOverviewItem,
} from "@/lib/types"
import {
  exchangesOf,
  loadTranscript,
  retainLiveTranscript,
  useTranscriptViewStore,
} from "@/sessions/transcript-view-store"

const LANE_LIMIT = 6
const TURN_LIMIT = 24
/** 最后活动在这之内的会话算「进行中」（外部启动的会话没有群成员绑定，只能看活动时间）。 */
const LIVE_MS = 5 * 60_000

export interface TrajectoryCall {
  kind: ToolKindLabel
  title: string
  /** 改到的文件，相对会话所在目录（在目录外的保持原样） */
  files: string[]
}

export interface TrajectoryTurn {
  key: string
  index: number
  prompt: string
  startedAt: string | null
  calls: TrajectoryCall[]
  answer: string | null
}

export interface TrajectoryLane {
  key: string
  item: ProjectSessionOverviewItem
  folderId: number
  live: boolean
  /** null = 转录还没加载到 */
  turns: TrajectoryTurn[] | null
}

const trimSlash = (path: string) => path.replace(/[\\/]+$/, "")

const startOfToday = () => {
  const day = new Date()
  day.setHours(0, 0, 0, 0)
  return day.getTime()
}

function text(turn: MessageTurn | null): string {
  if (!turn) return ""
  return turn.blocks
    .flatMap((block) => (block.type === "text" ? [block.text] : []))
    .join("\n")
    .trim()
}

const summaries = new WeakMap<DbConversationDetail, TrajectoryTurn[]>()

/** 今天的每一问：提问、工具调用（类型、一行标题、改到的文件）、回答开头。按转录对象缓存。 */
function summarize(
  detail: DbConversationDetail,
  root: string
): TrajectoryTurn[] {
  const cached = summaries.get(detail)
  if (cached) return cached
  const since = startOfToday()
  const prefix = `${trimSlash(root)}/`
  const turns = exchangesOf(detail)
    .filter(
      (exchange) =>
        exchange.index > 0 &&
        Date.parse(
          exchange.stats.startedAt ?? exchange.prompt?.timestamp ?? ""
        ) >= since
    )
    .slice(-TURN_LIMIT)
    .map((exchange) => {
      const calls: TrajectoryCall[] = []
      for (const turn of exchange.process)
        for (const block of turn.blocks) {
          if (block.type !== "tool_use") continue
          const name = normalizeToolName(block.tool_name)
          const kind = classifyToolKind(name)
          calls.push({
            kind,
            title:
              deriveToolTitle(name, block.input_preview) ?? block.tool_name,
            files:
              kind === "edit"
                ? extractFilePaths(block.input_preview).map((path) =>
                    path.startsWith(prefix) ? path.slice(prefix.length) : path
                  )
                : [],
          })
        }
      const answer = text(exchange.answer)
      return {
        key: exchange.id,
        index: exchange.index,
        prompt: text(exchange.prompt).slice(0, 400),
        startedAt:
          exchange.stats.startedAt ?? exchange.prompt?.timestamp ?? null,
        calls,
        answer: answer ? answer.slice(0, 400) : null,
      }
    })
  summaries.set(detail, turns)
  return turns
}

/** 会话（工具 id + 会话 id）→ 本地 conversation id；跨挂载复用，null = 解析不到。 */
const resolved = new Map<string, number | null>()

/**
 * 首页轨迹：项目（含各 worktree）今天活动过的会话，每个会话今天的每一问。
 * 转录走会话阅读的共享 store（加载合并、按源文件变化自动重读），只订阅在跑的会话。
 * `refreshKey` 变了（Agent 起停、换状态）就重读会话列表。
 */
export function useTrajectory(
  folderId: number,
  family: { id: number; path: string }[],
  refreshKey: string
): TrajectoryLane[] {
  useAgentProfiles()
  const [items, setItems] = useState<ProjectSessionOverviewItem[]>([])
  const [ids, setIds] = useState<Record<string, number | null>>({})

  useEffect(() => {
    let disposed = false
    listProjectSessionOverview(folderId, 30)
      .then((overview) => {
        if (disposed) return
        const since = startOfToday()
        setItems(
          overview.items
            .filter((item) => item.sessionId && item.updatedAt >= since)
            .slice(0, LANE_LIMIT)
        )
      })
      .catch(() => {})
    return () => {
      disposed = true
    }
  }, [folderId, refreshKey])

  // 只认已打开的目录：解析别的目录会顺手打开 worktree，首页只读不该有这种副作用
  const folderOf = (item: ProjectSessionOverviewItem) =>
    family.find((folder) => trimSlash(folder.path) === trimSlash(item.cwd))
  const familyKey = family.map((folder) => folder.path).join("\n")

  useEffect(() => {
    let disposed = false
    for (const item of items) {
      const key = `${item.agent}:${item.sessionId}`
      const known = resolved.get(key)
      if (known !== undefined) {
        setIds((prev) => (key in prev ? prev : { ...prev, [key]: known }))
        continue
      }
      const folder = folderOf(item)
      const agentType = agentTypeForTool(item.agent)
      if (!folder || !agentType || !item.sessionId) continue
      resolveProjectAgentSession({
        folderId: folder.id,
        agentType,
        externalId: item.sessionId,
      })
        .then((result) => {
          const id =
            result.deleted || !result.sourceAvailable
              ? null
              : (result.conversation?.id ?? null)
          resolved.set(key, id)
          if (!disposed) setIds((prev) => ({ ...prev, [key]: id }))
        })
        .catch(() => {})
    }
    return () => {
      disposed = true
    }
    // folderOf 只依赖 family 的路径
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items, familyKey])

  const now = Date.now()
  const lanes = items.flatMap((item) => {
    const folder = folderOf(item)
    if (!folder) return []
    const key = `${item.agent}:${item.sessionId}`
    return [
      {
        key,
        item,
        folderId: folder.id,
        root: folder.path,
        live: item.liveMember != null || now - item.updatedAt < LIVE_MS,
        conversationId: ids[key] ?? null,
      },
    ]
  })

  const conversationIds = lanes.map((lane) => lane.conversationId)
  const liveKey = lanes
    .map((lane) => (lane.live ? lane.conversationId : null))
    .join(",")
  useEffect(() => {
    const stops: (() => void)[] = []
    for (const lane of lanes) {
      if (lane.conversationId == null) continue
      // 在跑的会话第一次也强制重读：缓存里可能是之前打开时的旧内容
      void loadTranscript(lane.conversationId, lane.live)
      if (lane.live) stops.push(retainLiveTranscript(lane.conversationId))
    }
    return () => stops.forEach((stop) => stop())
    // 只在会话集合或在跑状态变时重订
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationIds.join(","), liveKey])

  const details = useTranscriptViewStore(
    useShallow((state) =>
      conversationIds.map((id) =>
        id == null ? null : (state.details[id] ?? null)
      )
    )
  )

  return useMemo(
    () =>
      lanes.map((lane, index) => ({
        key: lane.key,
        item: lane.item,
        folderId: lane.folderId,
        live: lane.live,
        turns: details[index] ? summarize(details[index], lane.root) : null,
      })),
    // lanes 每次渲染新建；内容由 items / ids / details 决定
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [items, ids, details, familyKey]
  )
}
