"use client"

import {
  useId,
  useLayoutEffect,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react"
import { cn } from "@/lib/utils"
import { useRequiredSplitViewContext } from "./split-view-context"
import {
  getSplitGridItemStyle,
  sanitizeSplitDomId,
} from "./split-view-dom-renderer"
import type { SplitHandleProps } from "./split-view-types"

const DEFAULT_HANDLE_CLASS = cn(
  "relative z-30 flex touch-none items-center justify-center overflow-visible select-none",
  "w-2.5 -mx-[4.5px] cursor-col-resize",
  "[--resize-handle-thickness:1px] hover:[--resize-handle-thickness:3px] data-[split-handle-state=drag]:[--resize-handle-thickness:3px]",
  "before:pointer-events-none before:absolute before:inset-y-0 before:left-1/2 before:h-full before:w-[var(--resize-handle-thickness)] before:-translate-x-1/2 before:bg-border before:transition-[width,height,background-color] before:duration-150 before:ease-out hover:before:bg-primary data-[split-handle-state=drag]:before:bg-primary",
  "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-offset-1",
  "data-[split-view-direction=vertical]:h-2.5 data-[split-view-direction=vertical]:-my-[4.5px] data-[split-view-direction=vertical]:w-full data-[split-view-direction=vertical]:mx-0 data-[split-view-direction=vertical]:cursor-row-resize",
  "data-[split-view-direction=vertical]:before:inset-x-0 data-[split-view-direction=vertical]:before:inset-y-auto data-[split-view-direction=vertical]:before:top-1/2 data-[split-view-direction=vertical]:before:h-[var(--resize-handle-thickness)] data-[split-view-direction=vertical]:before:w-full data-[split-view-direction=vertical]:before:-translate-y-1/2 data-[split-view-direction=vertical]:before:translate-x-0"
)

export const SplitHandle = function SplitHandle({
  id,
  disabled = false,
  onDragging,
  className,
  style,
  onPointerDown,
  onKeyDown,
  tabIndex,
  role,
  children,
  ...props
}: SplitHandleProps) {
  const context = useRequiredSplitViewContext("SplitHandle")
  const generatedId = useId()
  const handleId = id ?? `split-handle-${sanitizeSplitDomId(generatedId)}`
  const a11y = context.getHandleA11y(handleId)

  const { registerHandle, unregisterHandle } = context
  useLayoutEffect(() => {
    registerHandle({ id: handleId, disabled, onDragging })
    return () => unregisterHandle(handleId)
  }, [disabled, handleId, onDragging, registerHandle, unregisterHandle])

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    onPointerDown?.(event)
    if (event.defaultPrevented) return
    context.startPointerDrag(handleId, event.currentTarget, event.nativeEvent)
  }

  const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event)
    if (event.defaultPrevented) return
    context.handleKeyDown(handleId, event.nativeEvent)
  }

  const slot = context.getHandleSlot(handleId)
  const inactive = disabled ? "inactive" : undefined
  return (
    <div
      {...props}
      data-split-handle
      data-split-handle-id={handleId}
      data-split-view-direction={context.direction}
      data-split-handle-state={inactive}
      role={role ?? "separator"}
      tabIndex={tabIndex ?? (disabled ? -1 : 0)}
      aria-orientation={
        context.direction === "horizontal" ? "vertical" : "horizontal"
      }
      aria-valuenow={a11y?.valueNow ?? 0}
      aria-valuemin={a11y?.valueMin ?? 0}
      aria-valuemax={a11y?.valueMax ?? 100}
      aria-controls={a11y?.controls || undefined}
      aria-disabled={disabled || undefined}
      className={cn(DEFAULT_HANDLE_CLASS, className)}
      style={{
        ...getSplitGridItemStyle(context.direction, slot, "handle"),
        ...style,
      }}
      onPointerDown={handlePointerDown}
      onKeyDown={handleKeyDown}
    >
      {children}
    </div>
  )
}
