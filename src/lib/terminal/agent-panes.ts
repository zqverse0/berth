"use client"

import { useEffect } from "react"
import { create } from "zustand"
import { useShallow } from "zustand/react/shallow"
import { AGENT_CHANGED_EVENT } from "@/lib/api"
import { subscribe } from "@/lib/platform"
import { fetchTerminalInventory } from "@/lib/terminal/terminal-inventory-query"
import type { AgentProfileSummary } from "@/lib/transport/launchbar"
import type { TerminalDescriptor } from "@/lib/types"

/** 协作总览里一个 pane 的状态；`exited` 来自 pane 进程退出，优先于协议状态。 */
export type PaneAgentState = "working" | "idle" | "attention" | "exited"

export interface AgentPaneRow {
  descriptor: TerminalDescriptor
  state: PaneAgentState
  /** 当前状态开始的毫秒时间戳。 */
  since: number
}

export const DEFAULT_INTERRUPT_KEY = "Escape"
/** 兜底轮询：报 hook 的 Agent 由 `agent.changed` 即时唤醒，其余靠它。 */
const POLL_MS = 2_000

export function paneAgentState(descriptor: TerminalDescriptor): PaneAgentState {
  if (descriptor.status !== "running") return "exited"
  // 旧 daemon 不报告状态时按空闲展示。
  return descriptor.agentSignal?.state ?? "idle"
}

/** 打断键：tool.json 声明的 `interruptKey`，未声明或不是 Agent 终端时用 Escape。 */
export function interruptKeyFor(
  agentId: string | null | undefined,
  agents: AgentProfileSummary[]
): string {
  const declared = agentId
    ? agents.find((agent) => agent.id === agentId)?.interruptKey?.trim()
    : null
  return declared || DEFAULT_INTERRUPT_KEY
}

/** terminalId → 用户已看过的那一轮 attention 的 `since`。 */
export type SeenAttention = Readonly<Record<string, number>>

/**
 * 未读的「需要关注」Agent 数：用户看过该 pane 的这一轮即不计；下一轮 attention 的
 * `since` 不同，自动重新计入。普通终端（如 shell 的 BEL）不计，与项目列表状态点一致。
 * 只影响角标，termd 的 attention（门铃 / 收集器依赖）不动。
 */
export function countAttention(
  rows: AgentPaneRow[],
  seen: SeenAttention = {}
): number {
  return rows.filter(
    (row) => row.descriptor.agentId && paneDot(row, seen) === "attention"
  ).length
}

/**
 * 由本轮描述符与上一轮结果得出行。协议层 attention 用 termd 的变化时间；
 * 兜底层 working / idle 没有时间戳，取本端第一次观察到该状态的时刻。
 */
export function buildAgentPaneRows(
  descriptors: TerminalDescriptor[],
  previous: AgentPaneRow[],
  now: number
): AgentPaneRow[] {
  const before = new Map(
    previous.map((row) => [row.descriptor.terminalId, row])
  )
  // 每 2 秒轮询一次；行没变就复用旧对象、整表没变就复用旧数组，
  // 否则项目列表每一行的角标都会跟着重渲染。
  const rows = descriptors.map((descriptor) => {
    const state = paneAgentState(descriptor)
    const prior = before.get(descriptor.terminalId)
    const changedAt = descriptor.agentSignal?.stateChangedAt
    const since =
      state === "attention" && changedAt
        ? changedAt * 1000
        : prior?.state === state
          ? prior.since
          : now
    return prior &&
      prior.state === state &&
      prior.since === since &&
      JSON.stringify(prior.descriptor) === JSON.stringify(descriptor)
      ? prior
      : { descriptor, state, since }
  })
  return rows.length === previous.length &&
    rows.every((row, index) => row === previous[index])
    ? previous
    : rows
}

// 已读存本地：重新加载后看过的这一轮不再算未读（`since` 取自 termd，重载后不变）。
// ponytail: 关掉的终端不清理，每项只是 id → 时间戳；真变多再按清单修剪。
const SEEN_KEY = "berth.agentPanes.seen"

function loadSeen(): SeenAttention {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(SEEN_KEY) ?? "{}")
    return value && typeof value === "object" ? (value as SeenAttention) : {}
  } catch {
    return {}
  }
}

interface AgentPaneStore {
  /** 全部项目的 pane 行（termd 清单顺序）。 */
  rows: AgentPaneRow[]
  /** 本轮读取时刻；页面以它计算持续时长。 */
  polledAt: number
  seen: SeenAttention
}

/**
 * 项目列表、协作页与两个角标共用的唯一数据源。只在有消费者、窗口可见时每 2 秒
 * 读一次全部项目的终端清单（与共享 inventory 同一个合并请求），不写回 inventory，
 * 以免 agent 状态抖动触发标签页对账。
 */
export const useAgentPaneStore = create<AgentPaneStore>(() => ({
  rows: [],
  polledAt: 0,
  seen: loadSeen(),
}))

useAgentPaneStore.subscribe((state, previous) => {
  if (state.seen === previous.seen) return
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify(state.seen))
  } catch {
    // 存不下只影响重载后的已读，忽略。
  }
})

let refCount = 0
let timer: number | null = null
let stopListening: (() => void) | null = null

/** Agent hook 报告变化时立即回调（`agent.changed` 唤醒）；返回同步的取消函数。 */
export function onAgentChanged(handler: () => void): () => void {
  let disposed = false
  let dispose: (() => void) | null = null
  void subscribe<unknown>(AGENT_CHANGED_EVENT, handler)
    .then((unsubscribe) => {
      if (disposed) unsubscribe()
      else dispose = unsubscribe
    })
    .catch(() => {
      // 订阅不上只剩轮询。
    })
  return () => {
    disposed = true
    dispose?.()
  }
}

function tick(): void {
  if (refCount === 0 || document.visibilityState !== "visible") return
  fetchTerminalInventory()
    .then((all) => {
      if (refCount === 0) return
      const polledAt = Date.now()
      useAgentPaneStore.setState((state) => ({
        polledAt,
        rows: buildAgentPaneRows(all, state.rows, polledAt),
      }))
    })
    .catch(() => {
      // 保留上一轮结果；下一轮重试。
    })
}

function onVisibility(): void {
  if (document.visibilityState === "visible") tick()
}

function acquire(): () => void {
  refCount += 1
  if (refCount === 1) {
    tick()
    timer = window.setInterval(tick, POLL_MS)
    stopListening = onAgentChanged(tick)
    document.addEventListener("visibilitychange", onVisibility)
  }
  return () => {
    refCount -= 1
    if (refCount !== 0) return
    if (timer != null) window.clearInterval(timer)
    timer = null
    stopListening?.()
    stopListening = null
    document.removeEventListener("visibilitychange", onVisibility)
  }
}

/** 立即再读一次（顶栏刷新、打断后）。 */
export function refreshAgentPanes(): void {
  tick()
}

/** 订阅全部 pane 行；挂载即参与共享轮询。 */
export function useAllAgentPanes(): AgentPaneRow[] {
  useEffect(acquire, [])
  return useAgentPaneStore((state) => state.rows)
}

/** 只订阅满足 `match` 的 pane 行：行对象跨轮询复用，无关 pane 变化不触发重渲染。 */
export function useAgentPanesWhere(
  match: (row: AgentPaneRow) => boolean
): AgentPaneRow[] {
  useEffect(acquire, [])
  return useAgentPaneStore(useShallow((state) => state.rows.filter(match)))
}

/** 全部项目未读「需要关注」的 pane 数；只在数字变化时触发渲染。 */
export function useAttentionCount(): number {
  useEffect(acquire, [])
  return useAgentPaneStore((state) => countAttention(state.rows, state.seen))
}

/** 项目列表状态点：未读的需要关注 > 工作中；其余不显示。 */
export type PaneDot = "attention" | "working" | null

export function paneDot(row: AgentPaneRow, seen: SeenAttention): PaneDot {
  if (row.state === "attention") {
    return seen[row.descriptor.terminalId] === row.since ? null : "attention"
  }
  return row.state === "working" ? "working" : null
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path
}

/**
 * pane 归到哪一行：前台进程当前目录（缺省启动目录）落在的最深已注册目录，
 * 所以开在 worktree 里的终端挂在该 worktree 行；都不包含时用会话归属的项目。
 * 只给项目终端换行显示，不按 cwd 给独立 / 归属未证明的终端补项目。
 */
export function paneFolderId(
  descriptor: TerminalDescriptor,
  folders: readonly { id: number; path: string }[]
): number | null {
  if (descriptor.folderId == null) return null
  const cwd = trimSlash(descriptor.cwd || descriptor.initialCwd)
  let best: { id: number; length: number } | null = null
  for (const folder of folders) {
    const root = trimSlash(folder.path)
    const inside =
      cwd === root || cwd.startsWith(root === "/" ? "/" : `${root}/`)
    if (inside && (best == null || root.length > best.length)) {
      best = { id: folder.id, length: root.length }
    }
  }
  return best?.id ?? descriptor.folderId
}

/**
 * 终端可见且窗口有焦点时，把该 pane 当前这一轮 attention 记为已读；
 * 窗口在后台时等重新获得焦点再记。
 */
export function useMarkAttentionSeen(
  terminalId: string,
  visible: boolean
): void {
  const since = useAgentPaneStore(
    (state) =>
      state.rows.find(
        (row) =>
          row.descriptor.terminalId === terminalId && row.state === "attention"
      )?.since ?? null
  )
  useEffect(() => {
    if (!visible || since == null) return
    const mark = () => {
      if (!document.hasFocus()) return
      useAgentPaneStore.setState((state) =>
        state.seen[terminalId] === since
          ? state
          : { seen: { ...state.seen, [terminalId]: since } }
      )
    }
    mark()
    window.addEventListener("focus", mark)
    return () => window.removeEventListener("focus", mark)
  }, [terminalId, visible, since])
}
