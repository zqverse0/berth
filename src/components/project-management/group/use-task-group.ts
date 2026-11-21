"use client"

import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react"
import {
  builtinMember,
  mergeGroupEvents,
  type GroupEvent,
  ensureGroupWatch,
  readTaskGroup,
  type DeliveryState,
  type GroupMember,
  type GroupRead,
} from "@/lib/agent/berth-group"
import { onAgentChanged } from "@/lib/terminal/agent-panes"

const POLL_MS = 2_000
/** 有成员正在回答（Berth / ACP 成员的过程在流式更新）时读得勤一些。 */
const LIVE_POLL_MS = 400
/** 后台进程空闲 10 分钟会退出；视图开着时隔一会儿确认一次。 */
const WATCH_MS = 60_000

export interface TaskGroupState {
  env: NonNullable<GroupRead["env"]> | null
  name: string | null
  events: GroupEvent[]
  members: GroupMember[]
  delivery: Record<string, DeliveryState>
  /** 负责人；没设为 null。 */
  lead: string | null
  /** 时间线之前还有更早的事件。 */
  more: boolean
  error: string | null
  loaded: boolean
  /** 立即再读一次（发送、开工之后）。 */
  refresh: () => void
  /** 往上翻：读最早一条之前的一页。 */
  loadOlder: () => void
}

type GroupData = Omit<TaskGroupState, "refresh" | "loadOlder">

const EMPTY: GroupData = {
  env: null,
  name: null,
  events: [],
  members: [],
  delivery: {},
  lead: null,
  more: false,
  error: null,
  loaded: false,
}

/** 往上翻一页的条数。 */
const PAGE = 200

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
  loading: Promise<void> | null
  again: boolean
  /** 往上翻在途。 */
  older: boolean
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
      loading: null,
      again: false,
      older: false,
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
    update(feed, {
      loaded: true,
      error: response.error.message,
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
  // 群组页是项目主页、常开；轮询多数时候什么都没变，内容相同就不更新，
  // 否则每 2 秒都会把整条时间线重画一遍。
  const members = result.builtin
    ? [builtinMember(result.builtin), ...result.members]
    : result.members
  const snapshot = JSON.stringify([
    result.name,
    result.env ?? null,
    members,
    result.delivery,
    result.lead ?? null,
  ])
  if (feed.snapshot !== snapshot) {
    feed.snapshot = snapshot
    patch.name = result.name
    patch.env = result.env ?? null
    patch.members = members
    patch.delivery = result.delivery
    patch.lead = result.lead ?? null
  }
  if (after === 0) patch.more = result.more ?? false
  if (switched) patch.events = []
  else if (after === 0) patch.events = result.events
  else if (result.events.length > 0)
    patch.events = mergeGroupEvents(feed.data.events, result.events)
  if (Object.keys(patch).length > 0) update(feed, patch)
  feed.cursor = switched ? 0 : Math.max(after, result.nextAfter)
  if (result.name && result.name !== previous && feed.holders > 0) {
    ensureWatch(feed)
  }
}

/** 往上翻：最早一条之前的一页并进时间线。 */
async function loadOlder(feed: GroupFeed) {
  const first = feed.data.events[0]?.seq
  if (!feed.data.more || first == null || feed.older) return
  feed.older = true
  try {
    const response = await readTaskGroup(feed.folderId, 0, {
      before: first,
      limit: PAGE,
    })
    if (response.ok)
      update(feed, {
        events: mergeGroupEvents(feed.data.events, response.result.events),
        more: response.result.more ?? false,
      })
  } finally {
    feed.older = false
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
  let last = 0
  // 每 LIVE_POLL_MS 看一眼：有人在答就读，否则满 POLL_MS 才读。
  const poll = window.setInterval(() => {
    const live = feed.data.members.some((member) => member.busy)
    if (!live && Date.now() - last < POLL_MS) return
    last = Date.now()
    tick()
  }, LIVE_POLL_MS)
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
  const older = useCallback(() => void loadOlder(feed), [feed])
  return useMemo(
    () => ({ ...data, refresh, loadOlder: older }),
    [data, refresh, older]
  )
}
