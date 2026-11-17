import { create } from "zustand"
import { getFolderConversation } from "@/lib/api"
import { registerBackendScopedStoreReset } from "@/stores/backend-scoped-store-reset"
import type { DbConversationDetail, MessageTurn } from "@/lib/types"
import { toErrorMessage } from "@/lib/app-error"

/**
 * 会话 detail 的共享缓存：按会话 id 拉取 transcript 解析结果并给消息列表出时间线。
 * 会话 tab、会话阅读器、项目首页轨迹共用这一份（阅读器经 transcript-view-store 写入）。
 * ACP 时代的 live / optimistic / streaming 状态机已删除（见 docs/REMOVED.md），
 * 现在会话内容只来自 transcript 文件。
 *
 * 一个会话的 detail 可达十几 MB：正在显示的经 `retainConversationDetail` 登记，常驻；
 * 没人显示的只留最近 IDLE_DETAILS 个（切回秒开），更早的删掉，再打开时重拉。
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
  /** 写入别处已拉到的 detail（不显示加载态）。 */
  storeDetail: (conversationId: number, detail: DbConversationDetail) => void
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

/** 没人显示时仍保留 detail 的会话数。 */
const IDLE_DETAILS = 3

// 正在显示的会话 → 登记次数；没人显示、仍留着 detail 的会话按最近使用排列（旧的在前）。
const holds = new Map<number, number>()
let idle: number[] = []

function markIdle(conversationId: number): void {
  idle = idle.filter((id) => id !== conversationId)
  idle.push(conversationId)
  const evicted = idle.slice(0, Math.max(0, idle.length - IDLE_DETAILS))
  if (evicted.length === 0) return
  idle = idle.slice(evicted.length)
  for (const id of evicted) {
    fetchGeneration.delete(id)
    cancelViewerDetailSync(id)
  }
  useConversationRuntimeStore.setState((state) => {
    const byConversationId = new Map(state.byConversationId)
    for (const id of evicted) byConversationId.delete(id)
    return { byConversationId }
  })
}

/** 登记「正在显示这个会话」，返回注销；全部注销后进入最近使用队列，超出 IDLE_DETAILS 就删。 */
export function retainConversationDetail(conversationId: number): () => void {
  holds.set(conversationId, (holds.get(conversationId) ?? 0) + 1)
  idle = idle.filter((id) => id !== conversationId)
  let released = false
  return () => {
    if (released) return
    released = true
    const count = (holds.get(conversationId) ?? 1) - 1
    if (count > 0) {
      holds.set(conversationId, count)
      return
    }
    holds.delete(conversationId)
    markIdle(conversationId)
  }
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
    // 没人登记就写进来的（如后台预取）也算闲置，免得绕过上限
    if (next.detail && !holds.has(conversationId)) markIdle(conversationId)
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

  // 外部已拉到的 detail（会话阅读器的静默重读）：作废进行中的请求，免得旧响应盖掉它
  const storeDetail = (
    conversationId: number,
    detail: DbConversationDetail
  ): void => {
    bumpFetchGeneration(conversationId)
    patch(conversationId, { detail, detailLoading: false, detailError: null })
  }

  return {
    byConversationId: new Map<number, ConversationRuntimeSession>(),
    actions: { fetchDetail, refetchDetail, syncViewerDetail, storeDetail },
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
  // 登记由挂着的组件持有，注销时自己减；只清闲置队列
  idle = []
  for (const cancel of viewerDetailSyncCancels.values()) cancel()
  viewerDetailSyncCancels.clear()
  timelineCache = new WeakMap()
  useConversationRuntimeStore.setState({ byConversationId: new Map() })
}

registerBackendScopedStoreReset(resetConversationRuntimeStore)
