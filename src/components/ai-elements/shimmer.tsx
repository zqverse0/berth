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

// 「进行中」文字：跟随全局 1 秒慢闪。原来的扫光是 CSS 无限动画，挂着时 WebKit 每秒出 60 帧，
// GTK3 下宿主主线程逐帧拷贝整窗（见 status-dot.tsx）。
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
