"use client"

import { useEffect, useState } from "react"
import { create } from "zustand"
import {
  getConversationContext,
  getConversationParts,
  getConversationRawTurns,
  getConversationSourceRevision,
  getConversationToc,
} from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import type {
  ContextSource,
  ConversationToc,
  PartTurn,
  RawTurn,
} from "@/lib/types"
import { formatConversationTitle } from "@/lib/agent/conversation-title"
import { buildTranscriptTabId } from "@/lib/files/file-workspace-tab"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"

/**
 * 阅读器的数据：打开时只取目录，看到哪一段才按轮取 Part，工具卡片展开时取原文。
 * 正在写的会话 2 秒比一次变化标记，有变化只取目录从最后一段起的变化；新写入的轮按需再取。
 */

interface TocStore {
  tocs: Record<number, ConversationToc>
  contexts: Record<number, ContextSource[]>
  errors: Record<number, string>
}

export const useTocStore = create<TocStore>(() => ({
  tocs: {},
  contexts: {},
  errors: {},
}))

const tocRequests = new Map<number, Promise<void>>()

function setToc(id: number, toc: ConversationToc) {
  useTocStore.setState((state) => {
    const errors = { ...state.errors }
    delete errors[id]
    return { tocs: { ...state.tocs, [id]: toc }, errors }
  })
  // 会话标签的标题打开时定下；读到更新后的会话标题（改名、自动标题回填）时跟上。
  const title = formatConversationTitle(toc.summary?.title)
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

/** 取目录；`refresh` 时只取最后一段起的变化（generation 对不上时宿主回整份）。 */
export function loadToc(id: number, refresh = false): Promise<void> {
  const pending = tocRequests.get(id)
  if (pending) return pending
  const current = useTocStore.getState().tocs[id]
  const known =
    refresh && current
      ? {
          generation: current.generation,
          from: Math.max(0, current.segments.length - 1),
        }
      : undefined
  const request = getConversationToc(id, known)
    .then(
      (next) => setToc(id, mergeToc(useTocStore.getState().tocs[id], next)),
      (reason) =>
        useTocStore.setState((state) => ({
          errors: { ...state.errors, [id]: toErrorMessage(reason) },
        }))
    )
    .finally(() => tocRequests.delete(id))
  tocRequests.set(id, request)
  return request
}

/** 同一 generation 时把第 `from` 段起的变化接到原目录上，否则用新目录。 */
export function mergeToc(
  current: ConversationToc | undefined,
  next: ConversationToc
): ConversationToc {
  if (!current || current.generation !== next.generation || next.from === 0) {
    return next
  }
  return {
    ...next,
    from: 0,
    segments: [...current.segments.slice(0, next.from), ...next.segments],
  }
}

export function useConversationToc(id: number) {
  const toc = useTocStore((state) => state.tocs[id] ?? null)
  const error = useTocStore((state) => state.errors[id] ?? null)
  useEffect(() => {
    if (!useTocStore.getState().tocs[id]) void loadToc(id)
  }, [id])
  return {
    toc,
    error,
    reload: () => {
      useTocStore.setState((state) => {
        const errors = { ...state.errors }
        delete errors[id]
        return { errors }
      })
      void loadToc(id)
    },
  }
}

/** 启动上下文全文，第一次用到时取。 */
export function useStartupContext(id: number): ContextSource[] | null {
  const context = useTocStore((state) => state.contexts[id] ?? null)
  useEffect(() => {
    if (useTocStore.getState().contexts[id]) return
    let cancelled = false
    getConversationContext(id).then(
      (items) => {
        if (!cancelled)
          useTocStore.setState((state) => ({
            contexts: { ...state.contexts, [id]: items },
          }))
      },
      () => {}
    )
    return () => {
      cancelled = true
    }
  }, [id])
  return context
}

// ---------------------------------------------------------------------------
// 按轮取 Part：轮是会话文件里的一行（或一条记录），generation 不变时内容不变，按轮缓存
// ---------------------------------------------------------------------------

// ponytail: 全局按轮 LRU，约 2 KB 一轮；需要按会话分配时再拆
const PART_CACHE_TURNS = 3000
const partCache = new Map<string, PartTurn>()
const partRequests = new Map<string, Promise<void>>()

const partKey = (id: number, generation: number, entry: number) =>
  `${id}:${generation}:${entry}`

function cachedPart(key: string): PartTurn | undefined {
  const turn = partCache.get(key)
  if (turn) {
    partCache.delete(key)
    partCache.set(key, turn)
  }
  return turn
}

function rememberPart(key: string, turn: PartTurn) {
  partCache.set(key, turn)
  while (partCache.size > PART_CACHE_TURNS) {
    partCache.delete(partCache.keys().next().value!)
  }
}

/** 已经取到的 Part（不发请求），搜索只在这些里找。 */
export function cachedParts(
  id: number,
  generation: number,
  entries: Iterable<number>
): PartTurn[] {
  const found: PartTurn[] = []
  for (const entry of entries) {
    const turn = partCache.get(partKey(id, generation, entry))
    if (turn) found.push(turn)
  }
  return found
}

function fetchParts(
  id: number,
  generation: number,
  entries: number[]
): Promise<void> {
  const missing = entries.filter(
    (entry) =>
      !partCache.has(partKey(id, generation, entry)) &&
      !partRequests.has(partKey(id, generation, entry))
  )
  const waiting = entries
    .map((entry) => partRequests.get(partKey(id, generation, entry)))
    .filter((request): request is Promise<void> => request != null)
  if (missing.length > 0) {
    const request = getConversationParts(id, generation, missing).then(
      (read) => {
        if (read.generation !== generation) {
          // 会话被整份重建（或索引被放掉后重建），轮序号可能变了：重取目录
          void loadToc(id)
          return
        }
        for (const turn of read.turns) {
          rememberPart(partKey(id, generation, turn.entry), turn)
        }
      }
    )
    const settled = request.finally(() => {
      for (const entry of missing)
        partRequests.delete(partKey(id, generation, entry))
    })
    for (const entry of missing)
      partRequests.set(partKey(id, generation, entry), settled)
    waiting.push(request)
  }
  return Promise.all(waiting).then(() => undefined)
}

/** 这几轮的 Part（轮序号 → Part），取到之前是 null。 */
export function useTurnParts(
  id: number,
  generation: number,
  entries: number[]
): { turns: Map<number, PartTurn> | null; error: string | null } {
  const key = `${generation}:${entries.join(",")}`
  const [, setLoaded] = useState(0)
  const [error, setError] = useState<{ key: string; message: string } | null>(
    null
  )
  let turns: Map<number, PartTurn> | null = new Map()
  for (const entry of entries) {
    const turn = cachedPart(partKey(id, generation, entry))
    if (!turn) {
      turns = null
      break
    }
    turns.set(entry, turn)
  }
  const ready = turns != null

  useEffect(() => {
    if (ready) return
    let cancelled = false
    const wanted = key.split(":")[1].split(",").filter(Boolean).map(Number)
    fetchParts(id, generation, wanted).then(
      () => {
        if (!cancelled) setLoaded((n) => n + 1)
      },
      (reason) => {
        if (!cancelled) setError({ key, message: toErrorMessage(reason) })
      }
    )
    return () => {
      cancelled = true
    }
  }, [id, generation, key, ready])

  return { turns, error: error?.key === key ? error.message : null }
}

/** 这几轮的原文；generation 对不上时为空数组（并重取目录）。 */
export async function loadRawTurns(
  id: number,
  generation: number,
  entries: number[]
): Promise<RawTurn[]> {
  const read = await getConversationRawTurns(id, generation, entries)
  if (read.generation !== generation) {
    void loadToc(id)
    return []
  }
  return read.turns
}

// ---------------------------------------------------------------------------
// 正在写的会话
// ---------------------------------------------------------------------------

// ponytail: 定时 stat 轮询；需要亚秒级延迟时改为后端文件 watcher 推事件
export const LIVE_POLL_MS = 2_000

const livePollers = new Map<number, { count: number; stop: () => void }>()

function startLivePoller(id: number): () => void {
  let stopped = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const tick = async () => {
    const current = useTocStore.getState().tocs[id]
    if (document.visibilityState === "visible" && current?.source_revision) {
      const revision = await getConversationSourceRevision(id).catch(() => null)
      if (!stopped && revision && revision !== current.source_revision) {
        await loadToc(id, true)
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

/** 会话源文件有新写入时续取目录；多个视图订阅同一会话只轮询一次。 */
export function useTocLiveSync(id: number, enabled = true) {
  useEffect(() => {
    if (!enabled) return
    const existing = livePollers.get(id)
    if (existing) existing.count += 1
    else livePollers.set(id, { count: 1, stop: startLivePoller(id) })
    return () => {
      const poller = livePollers.get(id)
      if (!poller) return
      poller.count -= 1
      if (poller.count === 0) {
        poller.stop()
        livePollers.delete(id)
      }
    }
  }, [id, enabled])
}
