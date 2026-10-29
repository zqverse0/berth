"use client"

import { useEffect } from "react"
import { create } from "zustand"
import { getConversationSourceRevision, getFolderConversation } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type { DbConversationDetail } from "@/lib/types"
import { formatConversationTitle } from "@/lib/agent/conversation-title"
import { buildTranscriptTabId } from "@/lib/files/file-workspace-tab"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"
import {
  buildExchanges,
  type ExchangeDetail,
  type ProcessFilter,
  type SessionExchange,
} from "@/sessions/exchanges"

/**
 * 会话阅读的共享状态：工具栏（FileWorkspaceHeader）、阅读区（TranscriptReader）
 * 与左侧“会话详情”面板不在同一棵组件树，按会话 id 在这里汇合。
 */

export interface TranscriptView {
  level: ExchangeDetail
  filter: ProcessFilter
  query: string
}

const DEFAULT_TRANSCRIPT_VIEW: TranscriptView = {
  level: "answers",
  filter: {
    thinking: true,
    tools: true,
    toolName: null,
    skill: null,
    errorsOnly: false,
  },
  query: "",
}

// 阅读模式记住上次选择，作为新打开会话的默认值。
const LEVEL_KEY = "berth.transcript.level"
const LEVELS: ExchangeDetail[] = ["prompts", "answers", "full"]

function loadDefaultView(): TranscriptView {
  try {
    const level = window.localStorage.getItem(LEVEL_KEY) as ExchangeDetail
    if (LEVELS.includes(level)) return { ...DEFAULT_TRANSCRIPT_VIEW, level }
  } catch {
    // 读不到就用内置默认。
  }
  return DEFAULT_TRANSCRIPT_VIEW
}

let defaultView =
  typeof window === "undefined" ? DEFAULT_TRANSCRIPT_VIEW : loadDefaultView()

function rememberLevel(level: ExchangeDetail): void {
  defaultView = { ...DEFAULT_TRANSCRIPT_VIEW, level }
  try {
    window.localStorage.setItem(LEVEL_KEY, level)
  } catch {
    // 持久化失败只影响下次默认值。
  }
}

interface JumpRequest {
  conversationId: number
  exchangeId: string
}

interface TranscriptViewStore {
  views: Record<number, TranscriptView>
  // ponytail: 详情按会话 id 常驻到窗口关闭；会话很多时再加 LRU
  details: Record<number, DbConversationDetail>
  errors: Record<number, string>
  jump: JumpRequest | null
  updateView: (
    conversationId: number,
    update: (view: TranscriptView) => TranscriptView
  ) => void
  requestJump: (conversationId: number, exchangeId: string) => void
  consumeJump: () => void
}

export const useTranscriptViewStore = create<TranscriptViewStore>((set) => ({
  views: {},
  details: {},
  errors: {},
  jump: null,
  updateView: (conversationId, update) =>
    set((state) => {
      const prev = state.views[conversationId] ?? defaultView
      const next = update(prev)
      if (next.level !== prev.level) rememberLevel(next.level)
      return { views: { ...state.views, [conversationId]: next } }
    }),
  requestJump: (conversationId, exchangeId) =>
    set({ jump: { conversationId, exchangeId } }),
  consumeJump: () => set({ jump: null }),
}))

export function useTranscriptView(conversationId: number): TranscriptView {
  return useTranscriptViewStore(
    (state) => state.views[conversationId] ?? defaultView
  )
}

const requests = new Map<number, Promise<void>>()
const exchangeCache = new WeakMap<object, SessionExchange[]>()

function setDetail(id: number, detail: DbConversationDetail) {
  useTranscriptViewStore.setState((state) => {
    const errors = { ...state.errors }
    delete errors[id]
    return { details: { ...state.details, [id]: detail }, errors }
  })
  // 会话标签的标题打开时定下；读到更新后的会话标题（改名、自动标题回填）时跟上。
  const title = formatConversationTitle(detail.summary?.title)
  const tabId = buildTranscriptTabId(id)
  if (title)
    useWorkspaceFileStore
      .getState()
      .setFileTabs((tabs) =>
        tabs.some((tab) => tab.id === tabId && tab.title !== title)
          ? tabs.map((tab) =>
              tab.id === tabId ? { ...tab, title, description: title } : tab
            )
          : tabs
      )
}

function setError(id: number, error: string) {
  useTranscriptViewStore.setState((state) => ({
    errors: { ...state.errors, [id]: error },
  }))
}

/** 加载详情；同一会话的并发请求合并。`force` 忽略已有缓存。 */
export function loadTranscript(id: number, force = false): Promise<void> {
  if (!force && useTranscriptViewStore.getState().details[id]) {
    return Promise.resolve()
  }
  const pending = requests.get(id)
  if (pending) return pending
  const request = getFolderConversation(id)
    .then(
      (detail) => setDetail(id, detail),
      (reason) => setError(id, toErrorMessage(reason))
    )
    .finally(() => requests.delete(id))
  requests.set(id, request)
  return request
}

/** 同一份详情只分段一次，阅读区与会话详情面板共用。 */
export function exchangesOf(
  detail: Pick<DbConversationDetail, "turns">
): SessionExchange[] {
  let exchanges = exchangeCache.get(detail)
  if (!exchanges) {
    exchanges = buildExchanges(detail.turns)
    exchangeCache.set(detail, exchanges)
  }
  return exchanges
}

export function useTranscriptDetail(conversationId: number) {
  const detail = useTranscriptViewStore(
    (state) => state.details[conversationId] ?? null
  )
  const error = useTranscriptViewStore(
    (state) => state.errors[conversationId] ?? null
  )

  useEffect(() => {
    void loadTranscript(conversationId)
  }, [conversationId])

  return {
    detail,
    error,
    reload: () => {
      useTranscriptViewStore.setState((state) => {
        const errors = { ...state.errors }
        delete errors[conversationId]
        return { errors }
      })
      void loadTranscript(conversationId, true)
    },
  }
}

// ponytail: 定时 stat 轮询；需要亚秒级延迟时改为后端文件 watcher 推事件
export const LIVE_POLL_MS = 2_000

const livePollers = new Map<number, { count: number; stop: () => void }>()

function startLivePoller(id: number): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async () => {
    const current = useTranscriptViewStore.getState().details[id]
    if (document.visibilityState === "visible" && current?.source_revision) {
      const revision = await getConversationSourceRevision(id).catch(() => null)
      if (!stopped && revision && revision !== current.source_revision) {
        await loadTranscript(id, true)
      }
    }
    if (!stopped) timer = setTimeout(tick, LIVE_POLL_MS)
  }
  timer = setTimeout(tick, LIVE_POLL_MS)
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}

/** 订阅会话源文件的新写入（自动重读），返回退订；多处订阅同一会话只轮询一次。 */
export function retainLiveTranscript(conversationId: number): () => void {
  const existing = livePollers.get(conversationId)
  if (existing) existing.count += 1
  else
    livePollers.set(conversationId, {
      count: 1,
      stop: startLivePoller(conversationId),
    })
  return () => {
    const poller = livePollers.get(conversationId)
    if (!poller) return
    poller.count -= 1
    if (poller.count === 0) {
      poller.stop()
      livePollers.delete(conversationId)
    }
  }
}

/** 会话源文件有新写入时自动重读；多个视图订阅同一会话只轮询一次。 */
export function useTranscriptLiveSync(conversationId: number, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    return retainLiveTranscript(conversationId)
  }, [conversationId, enabled])
}
