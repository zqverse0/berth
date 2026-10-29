import { create } from "zustand"
import { getFolderConversation } from "@/lib/api"
import { registerBackendScopedStoreReset } from "@/stores/backend-scoped-store-reset"
import type { DbConversationDetail, MessageTurn } from "@/lib/types"
import { toErrorMessage } from "@/lib/app-error"

/**
 * 会话 detail 的共享缓存：按会话 id 拉取 transcript 解析结果并给消息列表出时间线。
 * ACP 时代的 live / optimistic / streaming 状态机已删除（见 docs/REMOVED.md），
 * 现在会话内容只来自 transcript 文件。
 */
export interface ConversationTimelineTurn {
  key: string
  turn: MessageTurn
}

export interface ConversationRuntimeSession {
  conversationId: number
  detail: DbConversationDetail | null
  detailLoading: boolean
  detailError: string | null
}

interface ConversationRuntimeState {
  byConversationId: Map<number, ConversationRuntimeSession>
}

export interface RuntimeActions {
  /** 没加载过才拉取。 */
  fetchDetail: (conversationId: number) => void
  /** 强制重新拉取（显示加载态）。 */
  refetchDetail: (conversationId: number) => void
  /** 跨客户端 `conversation://changed` 提示后，静默轮询已打开会话直到回复落盘。 */
  syncViewerDetail: (conversationId: number) => void
}

interface ConversationRuntimeStore extends ConversationRuntimeState {
  actions: RuntimeActions
}

// 稳定空数组，避免按引用 memo 的消费方每次渲染都拿到新数组。
const EMPTY_TIMELINE: ConversationTimelineTurn[] = []

// 按 session 对象缓存时间线：只有被改动的会话换新对象，其他会话的数组引用保持不变。
let timelineCache = new WeakMap<
  ConversationRuntimeSession,
  ConversationTimelineTurn[]
>()

// 每个会话的拉取代数：过期请求的结果不提交，防止旧响应覆盖新响应。
const fetchGeneration = new Map<number, number>()

function bumpFetchGeneration(conversationId: number): number {
  const next = (fetchGeneration.get(conversationId) ?? 0) + 1
  fetchGeneration.set(conversationId, next)
  return next
}

function isLatestGeneration(
  conversationId: number,
  generation: number
): boolean {
  return fetchGeneration.get(conversationId) === generation
}

// 回合结束信号会和 Agent CLI 写 transcript 赛跑，单次拉取可能还没有回复，
// 所以按退避轮询，直到末尾不再是用户回合且后端不再标记进行中。
const VIEWER_DETAIL_SYNC_DELAYS_MS = [0, 300, 700, 1500, 2500] as const

// 每个会话最多一个轮询；新提示取代旧轮询。
const viewerDetailSyncCancels = new Map<number, () => void>()

function cancelViewerDetailSync(conversationId: number): void {
  viewerDetailSyncCancels.get(conversationId)?.()
}

function computeTimeline(
  state: ConversationRuntimeState,
  conversationId: number
): ConversationTimelineTurn[] {
  const session = state.byConversationId.get(conversationId)
  if (!session) return EMPTY_TIMELINE
  const cached = timelineCache.get(session)
  if (cached) return cached
  const timeline = (session.detail?.turns ?? []).map((turn, index) => ({
    key: `${conversationId}-${turn.id}-${index}`,
    turn,
  }))
  timelineCache.set(session, timeline)
  return timeline
}

export const useConversationRuntimeStore = create<ConversationRuntimeStore>()((
  set,
  get
) => {
  const patch = (
    conversationId: number,
    next: Partial<ConversationRuntimeSession>
  ): void => {
    set((state) => {
      const current = state.byConversationId.get(conversationId) ?? {
        conversationId,
        detail: null,
        detailLoading: false,
        detailError: null,
      }
      const byConversationId = new Map(state.byConversationId)
      byConversationId.set(conversationId, { ...current, ...next })
      return { byConversationId }
    })
  }

  const refetchDetail = (conversationId: number): void => {
    const generation = bumpFetchGeneration(conversationId)
    patch(conversationId, { detailLoading: true, detailError: null })
    getFolderConversation(conversationId)
      .then((detail) => {
        if (!isLatestGeneration(conversationId, generation)) return
        patch(conversationId, { detail, detailLoading: false })
      })
      .catch((error: unknown) => {
        if (!isLatestGeneration(conversationId, generation)) return
        patch(conversationId, {
          detailLoading: false,
          detailError: toErrorMessage(error),
        })
      })
  }

  const fetchDetail = (conversationId: number): void => {
    const session = get().byConversationId.get(conversationId)
    if (session?.detail || session?.detailLoading) return
    refetchDetail(conversationId)
  }

  // 不设 detailLoading：后台同步不能让正在读的内容闪加载态。
  const syncViewerDetail = (conversationId: number): void => {
    if (!get().byConversationId.has(conversationId)) return
    cancelViewerDetailSync(conversationId)

    let cancelled = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const cancel = (): void => {
      cancelled = true
      if (timer) clearTimeout(timer)
      if (viewerDetailSyncCancels.get(conversationId) === cancel) {
        viewerDetailSyncCancels.delete(conversationId)
      }
    }
    viewerDetailSyncCancels.set(conversationId, cancel)

    const retry = (n: number): boolean => {
      if (n + 1 >= VIEWER_DETAIL_SYNC_DELAYS_MS.length) return false
      timer = setTimeout(
        () => attempt(n + 1),
        VIEWER_DETAIL_SYNC_DELAYS_MS[n + 1]
      )
      return true
    }

    const attempt = (n: number): void => {
      if (cancelled) return
      if (!get().byConversationId.has(conversationId)) return cancel()
      const generation = bumpFetchGeneration(conversationId)
      getFolderConversation(conversationId)
        .then((detail) => {
          if (cancelled) return
          const prev = get().byConversationId.get(conversationId)
          if (!prev) return cancel()
          const lastTurn = detail.turns[detail.turns.length - 1]
          const replyPending =
            detail.in_flight_user_turn_id != null || lastTurn?.role === "user"
          // 内容没变就不提交，免得每次轮询都重渲染；回复刚落定时总是提交
          // （OpenCode/Gemini 原地增长最后一个回合，水位和回合数都不变）。
          const changed =
            !prev.detail ||
            (prev.detail.transcript_watermark ?? null) !==
              (detail.transcript_watermark ?? null) ||
            prev.detail.turns.length !== detail.turns.length
          if (
            isLatestGeneration(conversationId, generation) &&
            (changed || !replyPending)
          ) {
            patch(conversationId, { detail, detailError: null })
          }
          if (!(replyPending && retry(n))) cancel()
        })
        .catch(() => {
          // transcript 可能正在写：按同样节奏重试，不报错，保留当前内容。
          if (cancelled) return
          if (!retry(n)) cancel()
        })
    }

    attempt(0)
  }

  return {
    byConversationId: new Map<number, ConversationRuntimeSession>(),
    actions: { fetchDetail, refetchDetail, syncViewerDetail },
  }
})

/** 当前时间线（读即时状态，不订阅）。 */
export function getTimelineTurns(
  conversationId: number
): ConversationTimelineTurn[] {
  return computeTimeline(useConversationRuntimeStore.getState(), conversationId)
}

/** 给 `useConversationRuntimeStore(...)` 用的时间线 selector，按会话对象 memo。 */
export function selectTimelineTurns(
  state: ConversationRuntimeState,
  conversationId: number
): ConversationTimelineTurn[] {
  return computeTimeline(state, conversationId)
}

/** 稳定的 action 引用，订阅它不会触发重渲染。 */
export function useConversationRuntimeActions(): RuntimeActions {
  return useConversationRuntimeStore((s) => s.actions)
}

/** 清空状态与模块级缓存（测试与后端切换时用）。 */
export function resetConversationRuntimeStore(): void {
  fetchGeneration.clear()
  for (const cancel of viewerDetailSyncCancels.values()) cancel()
  viewerDetailSyncCancels.clear()
  timelineCache = new WeakMap()
  useConversationRuntimeStore.setState({ byConversationId: new Map() })
}

registerBackendScopedStoreReset(resetConversationRuntimeStore)
