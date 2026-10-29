"use client"

import { useEffect } from "react"
import { create } from "zustand"
import { readGroupUnread } from "@/lib/agent/berth-group"
import { isRemoteBrowser } from "@/lib/transport"

const POLL_MS = 5_000
/** 远程浏览器每个请求都要过中继：轮询放缓，把连接让给用户的操作。 */
const REMOTE_POLL_MS = 30_000
/** 没有群的项目每隔几轮才复查（12 × 5 秒 = 1 分钟）。 */
const IDLE_EVERY = 12

/** 群主未读条数，键是去掉尾部斜杠的 checkout 路径。 */
export const useGroupUnreadStore = create<{ byPath: Record<string, number> }>(
  () => ({ byPath: {} })
)

export function unreadPathKey(path: string): string {
  return path.length > 1 ? path.replace(/[\\/]+$/, "") : path
}

/** 读一次本项目各群的未读数；`seen` 同时把该群标为已读到 `seq`。返回读到的 checkout 路径（无群为空）。 */
export async function refreshGroupUnread(
  folderId: number,
  seen?: { group: string; seq: number }
): Promise<string[]> {
  const response = await readGroupUnread(folderId, seen).catch(() => null)
  if (!response?.ok) return []
  const next = Object.fromEntries(
    Object.entries(response.result.worktrees).map(([path, count]) => [
      unreadPathKey(path),
      count,
    ])
  )
  useGroupUnreadStore.setState((state) => ({
    byPath: { ...state.byPath, ...next },
  }))
  return Object.keys(next)
}

/**
 * 项目列表可见且窗口可见时，每 5 秒（远程浏览器 30 秒）刷新这些主项目（含其 worktree 群）的未读数。
 * 逐个串行请求：几十个项目同时发会在后端同时起上百个 git 进程，正好撞上切换项目、打开文件。
 * 一个主项目一次返回它全部 worktree 的未读数，同一仓库的其他根项目本轮就不再读；
 * 没有群的项目（多数未启用 Berth）每分钟才复查一次。
 */
// ponytail: 每轮每个主项目整读一遍群账本；项目很多或账本很大时改为按文件 mtime 跳过。
export function useGroupUnreadPolling(
  roots: readonly { id: number; path: string }[],
  enabled: boolean
): void {
  const key = enabled
    ? roots.map((root) => `${root.id}=${unreadPathKey(root.path)}`).join("\n")
    : ""
  useEffect(() => {
    if (!key) return
    const list = key.split("\n").map((line) => {
      const at = line.indexOf("=")
      return { id: Number(line.slice(0, at)), path: line.slice(at + 1) }
    })
    const idle = new Set<number>()
    let round = 0
    let running = false
    let disposed = false
    const tick = async () => {
      if (running || document.visibilityState !== "visible") return
      running = true
      const recheck = round++ % IDLE_EVERY === 0
      const covered = new Set<string>()
      for (const { id, path } of list) {
        if (disposed) break
        if (covered.has(path) || (idle.has(id) && !recheck)) continue
        const paths = await refreshGroupUnread(id)
        for (const item of paths) covered.add(item)
        if (paths.length > 0) idle.delete(id)
        else idle.add(id)
      }
      running = false
    }
    const onVisibility = () => void tick()
    void tick()
    const timer = window.setInterval(
      onVisibility,
      isRemoteBrowser() ? REMOTE_POLL_MS : POLL_MS
    )
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      disposed = true
      window.clearInterval(timer)
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [key])
}
