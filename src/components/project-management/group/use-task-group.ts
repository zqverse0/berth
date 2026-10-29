"use client"

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react"
import {
  mergeGroupEvents,
  type GroupEvent,
  ensureGroupWatch,
  readTaskGroup,
  type DeliveryState,
  type GroupMember,
  type GroupRead,
} from "@/lib/agent/berth-group"
import { getBerthStatus } from "@/lib/agent/berth-project"
import { refreshGroupUnread } from "@/lib/agent/group-unread"
import { onAgentChanged } from "@/lib/terminal/agent-panes"

const POLL_MS = 2_000
/** 后台进程空闲 10 分钟会退出；视图开着时隔一会儿确认一次。 */
const WATCH_MS = 60_000

export interface TaskGroupState {
  env: NonNullable<GroupRead["env"]> | null
  name: string | null
  events: GroupEvent[]
  members: GroupMember[]
  delivery: Record<string, DeliveryState>
  error: string | null
  /** 项目还没启用 Berth（`.berth/`）：视图给启用入口，不当错误显示。 */
  uninitialized: boolean
  loaded: boolean
  /** 立即再读一次（发送、开工之后）。 */
  refresh: () => void
}

type GroupData = Omit<TaskGroupState, "refresh">

const EMPTY: GroupData = {
  env: null,
  name: null,
  events: [],
  members: [],
  delivery: {},
  error: null,
  uninitialized: false,
  loaded: false,
}

/**
 * 一个项目（checkout）的群数据。`group.read` 只认当前 checkout 的群，同一项目的群页、成员栏、
 * 交接面板读的是同一份：共用一个轮询，而不是各开一个 2 秒定时器重复读。
 */
interface GroupFeed {
  folderId: number
  data: GroupData
  listeners: Set<() => void>
  /** 视图激活中的持有者数；为 0 时停止轮询，数据保留供下次立即显示。 */
  holders: number
  cursor: number
  snapshot: string
  marked: string | null
  loading: Promise<void> | null
  again: boolean
  stop: (() => void) | null
  subscribe: (listener: () => void) => () => void
}

const feeds = new Map<number, GroupFeed>()

function feedOf(folderId: number): GroupFeed {
  let feed = feeds.get(folderId)
  if (!feed) {
    const listeners = new Set<() => void>()
    feed = {
      folderId,
      data: EMPTY,
      listeners,
      holders: 0,
      cursor: 0,
      snapshot: "",
      marked: null,
      loading: null,
      again: false,
      stop: null,
      subscribe: (listener) => {
        listeners.add(listener)
        return () => listeners.delete(listener)
      },
    }
    feeds.set(folderId, feed)
  }
  return feed
}

function update(feed: GroupFeed, patch: Partial<GroupData>) {
  feed.data = { ...feed.data, ...patch }
  for (const listener of feed.listeners) listener()
}

async function readOnce(feed: GroupFeed) {
  const after = feed.cursor
  const response = await readTaskGroup(feed.folderId, after).catch(
    (cause: unknown) => ({
      ok: false as const,
      error: { message: String(cause) },
    })
  )
  if (!response.ok) {
    // 错误只带文案不带 code：读失败时再问一次是否启用，未启用交给启用入口。
    const status = await getBerthStatus(feed.folderId).catch(() => null)
    const uninitialized = status?.ok === true && !status.result.enabled
    update(feed, {
      loaded: true,
      uninitialized,
      error: uninitialized ? null : response.error.message,
    })
    return
  }
  const result = response.result
  const previous = feed.data.name
  // 群组换了（开工新建）：这批是新群 `after` 之后的，丢掉，下一轮从头读。
  const switched = result.name !== previous && after !== 0
  const patch: Partial<GroupData> = {}
  if (!feed.data.loaded) patch.loaded = true
  if (feed.data.error !== null) patch.error = null
  if (feed.data.uninitialized) patch.uninitialized = false
  // 群组页是项目主页、常开；轮询多数时候什么都没变，内容相同就不更新，
  // 否则每 2 秒都会把整条时间线重画一遍。
  const snapshot = JSON.stringify([
    result.name,
    result.env ?? null,
    result.members,
    result.delivery,
  ])
  if (feed.snapshot !== snapshot) {
    feed.snapshot = snapshot
    patch.name = result.name
    patch.env = result.env ?? null
    patch.members = result.members
    patch.delivery = result.delivery
  }
  if (switched) patch.events = []
  else if (after === 0) patch.events = result.events
  else if (result.events.length > 0)
    patch.events = mergeGroupEvents(feed.data.events, result.events)
  if (Object.keys(patch).length > 0) update(feed, patch)
  feed.cursor = switched ? 0 : Math.max(after, result.nextAfter)
  if (result.name && result.name !== previous && feed.holders > 0) {
    ensureWatch(feed)
  }
  // 只在视图激活且窗口可见时读，读到即算看过：项目行未读数清零。
  const mark = `${result.name}:${result.nextAfter}`
  if (result.name && feed.marked !== mark) {
    feed.marked = mark
    void refreshGroupUnread(feed.folderId, {
      group: result.name,
      seq: result.nextAfter,
    })
  }
}

/** 同一时刻只有一个读在途；在途时再要求读（刚发完消息），读完再补一次。 */
function load(feed: GroupFeed): Promise<void> {
  if (feed.loading) {
    feed.again = true
    return feed.loading
  }
  feed.loading = (async () => {
    do {
      feed.again = false
      await readOnce(feed)
    } while (feed.again)
  })().finally(() => {
    feed.loading = null
  })
  return feed.loading
}

function ensureWatch(feed: GroupFeed) {
  void ensureGroupWatch(feed.folderId).catch(() => {})
}

function start(feed: GroupFeed): () => void {
  const tick = () => {
    if (document.visibilityState === "visible") void load(feed)
  }
  tick()
  const poll = window.setInterval(tick, POLL_MS)
  // hook 贴回回答、送达后立即重读，不等下一轮轮询。
  const stopListening = onAgentChanged(tick)
  const watch = window.setInterval(() => {
    if (feed.data.name) ensureWatch(feed)
  }, WATCH_MS)
  if (feed.data.name) ensureWatch(feed)
  document.addEventListener("visibilitychange", tick)
  return () => {
    window.clearInterval(poll)
    window.clearInterval(watch)
    stopListening()
    document.removeEventListener("visibilitychange", tick)
  }
}

function hold(feed: GroupFeed): () => void {
  feed.holders += 1
  if (feed.holders === 1) feed.stop = start(feed)
  return () => {
    feed.holders -= 1
    if (feed.holders === 0) {
      feed.stop?.()
      feed.stop = null
    }
  }
}

/** 项目群组的时间线、成员与送达状态：有激活视图且窗口可见时每 2 秒增量读一次。 */
export function useTaskGroup(
  folderId: number,
  active: boolean
): TaskGroupState {
  const feed = feedOf(folderId)
  const data = useSyncExternalStore(
    feed.subscribe,
    () => feed.data,
    () => feed.data
  )
  useEffect(() => (active ? hold(feed) : undefined), [active, feed])
  const refresh = useCallback(() => void load(feed), [feed])
  return useMemo(() => ({ ...data, refresh }), [data, refresh])
}
