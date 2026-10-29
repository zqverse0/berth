"use client"

import { memo, useEffect, useState, type ReactNode } from "react"
import { Bot } from "lucide-react"
import { launchbar } from "@/lib/transport/launchbar"
import { cn } from "@/lib/utils"

/** agent 目录内图标（icon.svg/icon.png）的模块级缓存。 */
const iconCache = new Map<string, string | null>()
/** 进行中的请求：同一 agent 的图标同时挂载多处时只发一次 IPC。 */
const pendingIcons = new Map<string, Promise<string | null>>()

/** 测试用：清空图标缓存。 */
export function clearAgentIconCache(): void {
  iconCache.clear()
  pendingIcons.clear()
}

export function fetchAgentIcon(agentId: string): Promise<string | null> {
  if (iconCache.has(agentId)) {
    return Promise.resolve(iconCache.get(agentId) ?? null)
  }
  let pending = pendingIcons.get(agentId)
  if (!pending) {
    pending = (async () => {
      try {
        const response = await launchbar({ type: "load_icon", agent: agentId })
        const dataUrl = response.type === "icon" ? response.dataUrl : null
        iconCache.set(agentId, dataUrl)
        return dataUrl
      } catch {
        return null
      }
    })().finally(() => pendingIcons.delete(agentId))
    pendingIcons.set(agentId, pending)
  }
  return pending
}

/**
 * agent 目录文件图标：`tools/<command>/icon.svg|icon.png` 经 Rust 侧
 * 转 data URL，img 渲染（SVG 不经 innerHTML，不执行脚本）。目录里没有
 * 图标文件时渲染 `fallback`（缺省为通用徽标）。**目录文件是 agent 图标
 * 的唯一真相源**——前端不维护品牌图标清单。
 */
export const AgentProfileIcon = memo(function AgentProfileIcon({
  agentId,
  name,
  className,
  fallback,
}: {
  agentId: string
  name: string
  className?: string
  /** 无图标文件时的回退（如 AgentIcon 传内置品牌表）。 */
  fallback?: ReactNode
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(
    iconCache.get(agentId) ?? null
  )

  useEffect(() => {
    let cancelled = false
    void fetchAgentIcon(agentId).then((url) => {
      if (!cancelled) setDataUrl(url)
    })
    return () => {
      cancelled = true
    }
  }, [agentId])

  if (dataUrl) {
    return (
      // data URL 本地图标，next/image 不适用（同仓库其他 img 先例）。
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={dataUrl}
        alt=""
        aria-hidden
        title={name}
        className={cn("object-contain", className)}
      />
    )
  }

  if (fallback) return <>{fallback}</>

  return (
    <span
      className={cn(
        "inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-muted text-xs font-semibold text-muted-foreground",
        className
      )}
      title={name}
      aria-hidden
    >
      <Bot className="h-4 w-4" />
    </span>
  )
})
