"use client"

import { useLayoutEffect, type ReactNode } from "react"
import { createPortal } from "react-dom"
import type { LucideIcon } from "lucide-react"
import { create } from "zustand"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"

/**
 * Sidebar header contract. The shell (`Sidebar`) owns the header row; a view
 * body describes what belongs in it and stays the owner of its own state:
 *
 *   <SidebarHeaderTabs tabs={…} value={…} onChange={…} />   // replaces the title
 *   <SidebarHeaderActions><SidebarHeaderButton … /></SidebarHeaderActions>
 *
 * Both render through a portal into the header, so a view never lifts state
 * into a store just to show a control up there. Header content mounts and
 * unmounts with the view body; while a lazy body loads, the view title shows.
 */
const useHeaderSlots = create<{
  tabsEl: HTMLElement | null
  actionsEl: HTMLElement | null
  hasTabs: boolean
}>(() => ({ tabsEl: null, actionsEl: null, hasTabs: false }))

const setTabsEl = (tabsEl: HTMLElement | null) =>
  useHeaderSlots.setState({ tabsEl })
const setActionsEl = (actionsEl: HTMLElement | null) =>
  useHeaderSlots.setState({ actionsEl })

export function SidebarHeader({
  title,
  identity,
  reserve,
  mobile,
  trailing,
}: {
  /** Default heading; hidden while the view supplies tabs. */
  title: ReactNode
  /** Replaces the heading and the slots (e.g. the launch view's agent). */
  identity?: ReactNode
  /** Width of the window-chrome overlay to clear; 0/undefined = none. */
  reserve?: number
  mobile?: boolean
  trailing?: ReactNode
}) {
  const hasTabs = useHeaderSlots((s) => s.hasTabs)
  return (
    <div
      className={cn(
        "flex h-10 shrink-0 items-center gap-1.5 pr-2",
        mobile
          ? "border-b border-border pl-4"
          : "border-b border-border/50 ws-chrome-border pl-3"
      )}
    >
      {!mobile && (
        <div
          data-tauri-drag-region
          className="h-full shrink-0"
          style={{ width: reserve }}
        />
      )}
      {identity ?? (
        <>
          <div
            ref={setTabsEl}
            className={cn("flex min-w-0 flex-1", !hasTabs && "hidden")}
          />
          {hasTabs ? null : (
            <h2
              data-tauri-drag-region
              className="min-w-0 flex-1 truncate text-[0.8125rem] font-semibold text-sidebar-foreground"
            >
              {title}
            </h2>
          )}
          <div
            ref={setActionsEl}
            className="flex shrink-0 items-center gap-0.5"
          />
        </>
      )}
      {trailing}
    </div>
  )
}

export function SidebarHeaderTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: string }[]
  value: T
  onChange: (id: T) => void
}) {
  const el = useHeaderSlots((s) => s.tabsEl)
  useLayoutEffect(() => {
    useHeaderSlots.setState({ hasTabs: true })
    return () => useHeaderSlots.setState({ hasTabs: false })
  }, [])
  if (!el) return null
  return createPortal(
    <div
      role="tablist"
      className="no-scrollbar flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto"
    >
      {tabs.map((tab) => (
        <button
          key={tab.id}
          type="button"
          role="tab"
          aria-selected={value === tab.id}
          onClick={() => onChange(tab.id)}
          className={cn(
            "shrink-0 rounded-md px-2 py-1 text-xs transition-colors",
            value === tab.id
              ? "bg-muted font-medium text-foreground"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>,
    el
  )
}

export function SidebarHeaderActions({ children }: { children: ReactNode }) {
  const el = useHeaderSlots((s) => s.actionsEl)
  return el ? createPortal(children, el) : null
}

export function SidebarHeaderButton({
  icon: Icon,
  label,
  onClick,
  disabled,
  spinning,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
  disabled?: boolean
  /** 进行中：图标转圈 */
  spinning?: boolean
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-6 w-6 shrink-0 text-muted-foreground"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
    >
      <Icon
        aria-hidden="true"
        className={spinning ? "h-3.5 w-3.5 animate-spin" : "h-3.5 w-3.5"}
      />
    </Button>
  )
}
