"use client"

import type { ReactNode } from "react"
import { createPortal } from "react-dom"
import { create } from "zustand"
import { useIsMobile } from "@/hooks/use-mobile"
import { cn } from "@/lib/utils"

/** 侧栏「设置」视图里放列表的位置；没有（手机抽屉收起 / 侧栏是别的视图）时为 null。 */
const useListSlot = create<{ el: HTMLElement | null }>(() => ({ el: null }))
const setListEl = (el: HTMLElement | null) => useListSlot.setState({ el })

/** 侧栏设置视图的正文：当前设置页的列表经 portal 渲染进来。 */
export function SettingsListTarget() {
  return (
    <div
      ref={setListEl}
      data-settings-list
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    />
  )
}

/**
 * 设置页的「列表 + 详情」：桌面端列表进侧栏、页内只剩详情；
 * 侧栏里没有设置视图时，列表留在页内左侧。手机没有并排的位置：列表只在侧栏抽屉里，
 * 抽屉收起时页内只放详情。页面状态仍归页面自己。
 */
export function SettingsSplit({
  list,
  children,
  listClassName,
  className,
}: {
  list: ReactNode
  children: ReactNode
  /** 列表留在页内时的外框。 */
  listClassName?: string
  className?: string
}) {
  const el = useListSlot((s) => s.el)
  const isMobile = useIsMobile()
  if (el || isMobile)
    return (
      <>
        {el ? createPortal(list, el) : null}
        <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
          {children}
        </div>
      </>
    )
  return (
    <div className="flex min-h-0 flex-1">
      <aside
        className={cn(
          "flex min-h-0 w-64 shrink-0 flex-col overflow-hidden border-r",
          listClassName
        )}
      >
        {list}
      </aside>
      <div className={cn("flex min-h-0 min-w-0 flex-1 flex-col", className)}>
        {children}
      </div>
    </div>
  )
}
