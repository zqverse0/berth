"use client"

import type { ElementType } from "react"

import { useSlowBlink } from "@/components/ui/status-dot"
import { cn } from "@/lib/utils"
import { memo } from "react"

export interface TextShimmerProps {
  children: string
  as?: ElementType
  className?: string
}

// 「进行中」文字：跟随全局 1 秒慢闪。早期为规避 WebKitGTK / GTK3 下 CSS 无限扫光每帧
// 触发宿主主线程整窗拷贝而做的取舍（见 status-dot.tsx）；切 CEF 后待重测基线再决定是否恢复。
const ShimmerComponent = ({
  children,
  as: Component = "p",
  className,
}: TextShimmerProps) => {
  useSlowBlink(true)
  return (
    <Component
      className={cn("berth-slow-blink text-muted-foreground", className)}
    >
      {children}
    </Component>
  )
}

export const Shimmer = memo(ShimmerComponent)
