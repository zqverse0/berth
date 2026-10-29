"use client"

import { useId } from "react"
import { cn } from "@/lib/utils"

/**
 * 现代精致彩色终端图标
 * 与各 Agent 品牌图标（Claude 橙红、Codex 蓝紫渐变、Gemini 彩虹渐变、Kimi 黑底蓝点）保持同一设计语言：
 * - 采用相同规格的 Squircle 饱满圆角底座（rx="5.3"），具备同等视觉体量；
 * - 顶部点缀经典 macOS 终端红黄绿窗口控制灯；
 * - 内部呈现极客翠绿渐变命令行提示符（>）与霓虹天蓝活跃光标（_）；
 * - 搭配细腻微光边框，在深色与浅色模式下均极具质感且和谐统一。
 */
export function ColorTerminalIcon({
  className,
  size = "1em",
}: {
  className?: string
  size?: string | number
}) {
  const id = useId()
  const bgGradId = `${id}-term-bg`
  const promptGradId = `${id}-term-prompt`

  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className={cn("size-6 shrink-0", className)}
      style={{ flex: "none", lineHeight: 1 }}
      aria-hidden="true"
    >
      <title>Terminal</title>
      <defs>
        {/* 深曜石微光渐变背景 */}
        <linearGradient
          id={bgGradId}
          x1="0"
          y1="0"
          x2="24"
          y2="24"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#1C1E26" />
          <stop offset="1" stopColor="#0B0C10" />
        </linearGradient>

        {/* 命令行提示符翠绿霓虹渐变 */}
        <linearGradient
          id={promptGradId}
          x1="6.5"
          y1="11"
          x2="10.5"
          y2="16.5"
          gradientUnits="userSpaceOnUse"
        >
          <stop stopColor="#34D399" />
          <stop offset="1" stopColor="#10B981" />
        </linearGradient>
      </defs>

      {/* Squircle 饱满圆角底座 */}
      <rect width="24" height="24" rx="5.3" fill={`url(#${bgGradId})`} />
      <rect
        width="23"
        height="23"
        x="0.5"
        y="0.5"
        rx="4.8"
        stroke="rgba(255,255,255,0.14)"
        strokeWidth="0.75"
      />

      {/* 顶部经典三色窗口微点 */}
      <circle cx="5.6" cy="5.8" r="1.15" fill="#FF5F56" />
      <circle cx="9" cy="5.8" r="1.15" fill="#FFBD2E" />
      <circle cx="12.4" cy="5.8" r="1.15" fill="#27C93F" />

      {/* 命令行提示符 > */}
      <path
        d="M6.5 11L10.5 13.8L6.5 16.6"
        stroke={`url(#${promptGradId})`}
        strokeWidth="2.1"
        strokeLinecap="round"
        strokeLinejoin="round"
      />

      {/* 活跃电光天蓝光标 _ */}
      <rect x="12" y="15.5" width="5.4" height="1.9" rx="0.95" fill="#38BDF8" />
    </svg>
  )
}
