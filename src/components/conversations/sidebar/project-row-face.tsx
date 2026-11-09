"use client"

import type { ComponentProps, ReactNode } from "react"
import { FolderGit2, FolderOpen, Pin } from "lucide-react"
import { cn } from "@/lib/utils"
import { FolderAliasLabel } from "./folder-alias-label"

/** 行图标中心所在的轴线；嵌套 worktree 右移一级，连接线画在顶层轴线上。 */
export const RAIL_AXIS = "0.875rem"
export const NESTED_STEP = "1.25rem"
/** 会话行的左缩进：根项目下与项目名对齐，嵌套 worktree 下再右移一级。 */
export function sessionIndent(nested: boolean) {
  return nested
    ? `calc(${RAIL_AXIS} + ${NESTED_STEP} * 2 + 0.875rem)`
    : `calc(${RAIL_AXIS} + ${NESTED_STEP} + 0.875rem)`
}

/** 项目行的底色：悬停、选中。 */
export function projectBlockClass(selected: boolean) {
  return cn(
    "group cursor-pointer rounded-xl transition-colors duration-150",
    selected
      ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground ring-1 ring-inset ring-sidebar-border"
      : "hover:bg-[color-mix(in_oklab,var(--sidebar-accent),var(--sidebar-foreground)_2%)]"
  )
}

/**
 * 项目行的按钮本体：连接线、图标、图钉、名称。本机项目与设备项目共用，两边长得一样。
 */
export function ProjectRowButton({
  name,
  alias,
  path,
  pinned,
  selected,
  worktree,
  nested,
  branch,
  icon,
  badge,
  dim = false,
  className,
  ...button
}: {
  name: string
  alias: string | null
  path: string
  pinned: boolean
  selected: boolean
  /** git worktree 行：FolderGit2 图标 + 分支名。 */
  worktree: boolean
  /** 挂在 root 下：右移一级并画连接线。 */
  nested: boolean
  branch: string | null
  /** 替换默认图标（如加载中）。 */
  icon?: ReactNode
  /** 名称后的标记（设备名 + 在线点） */
  badge?: ReactNode
  /** 空闲（没有会话）：名称淡色 */
  dim?: boolean
} & Omit<ComponentProps<"button">, "children" | "title">) {
  const axis = nested ? `calc(${RAIL_AXIS} + ${NESTED_STEP})` : RAIL_AXIS
  return (
    <button
      type="button"
      title={path}
      aria-current={selected ? "location" : undefined}
      className={cn(
        "relative flex h-full min-w-0 flex-1 cursor-pointer items-center pr-[0.5rem] outline-none",
        "rounded-full text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset",
        className
      )}
      style={{ paddingLeft: `calc(${axis} + 0.875rem)` }}
      {...button}
    >
      {/* 连接线：嵌套行在顶层轴线上画一段竖线，相邻行首尾相接成一条线。 */}
      {nested ? (
        <span
          aria-hidden
          data-project-rail
          className="pointer-events-none absolute z-0 bg-sidebar-border"
          style={{
            top: "-0.0625rem",
            bottom: "-0.0625rem",
            left: RAIL_AXIS,
            width: "0.125rem",
            transform: "translateX(-50%)",
          }}
        />
      ) : null}
      <span
        aria-hidden
        className="pointer-events-none absolute flex items-center justify-center"
        style={{
          top: "50%",
          left: axis,
          width: "0.875rem",
          height: "0.875rem",
          transform: "translate(-50%, -50%)",
        }}
      >
        {icon ??
          (worktree ? (
            <FolderGit2 className="h-3.5 w-3.5 text-orange-600 dark:text-orange-400" />
          ) : (
            <FolderOpen className="h-3.5 w-3.5 text-chart-3" />
          ))}
      </span>
      <div className="flex min-w-0 flex-1 items-center gap-[0.5rem]">
        {pinned ? (
          <Pin aria-hidden className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : null}
        <span
          className={cn(
            "min-w-0 flex-shrink truncate text-left text-[0.875rem] font-medium text-sidebar-foreground",
            !selected && "text-sidebar-foreground/85",
            dim && !selected && "text-muted-foreground"
          )}
        >
          {worktree && !alias?.trim() ? (
            (branch ?? name)
          ) : (
            <FolderAliasLabel
              name={name}
              alias={alias}
              bracketClassName="text-sidebar-foreground"
            />
          )}
        </span>
        {badge}
      </div>
    </button>
  )
}
