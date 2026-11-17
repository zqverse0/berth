"use client"

import { useId, useLayoutEffect, useMemo, type CSSProperties } from "react"
import { cn } from "@/lib/utils"
import { useRequiredSplitViewContext } from "./split-view-context"
import {
  getSplitGridItemStyle,
  sanitizeSplitDomId,
} from "./split-view-dom-renderer"
import type { SplitPaneProps } from "./split-view-types"

export const SplitPane = function SplitPane({
  id,
  defaultSize,
  weight,
  order,
  minSize,
  maxSize,
  minSizePx,
  maxSizePx,
  collapsed,
  visible,
  collapsible,
  collapsedSizePx,
  className,
  style,
  children,
  ...props
}: SplitPaneProps) {
  const context = useRequiredSplitViewContext("SplitPane")
  const generatedId = useId()
  const paneId = id ?? `split-pane-${sanitizeSplitDomId(generatedId)}`
  const spec = useMemo(
    () => ({
      id: paneId,
      order,
      defaultSize,
      weight,
      minSize,
      maxSize,
      minSizePx,
      maxSizePx,
      collapsed,
      visible,
      collapsible,
      collapsedSizePx,
    }),
    [
      collapsed,
      collapsedSizePx,
      defaultSize,
      maxSize,
      maxSizePx,
      minSize,
      minSizePx,
      paneId,
      visible,
      weight,
      collapsible,
      order,
    ]
  )

  const { registerPane, unregisterPane } = context
  // 注册与注销分开：spec 变化只走更新、保留序号（同 SplitHandle）
  useLayoutEffect(() => {
    registerPane({ id: paneId, spec })
  }, [paneId, registerPane, spec])
  useLayoutEffect(() => () => unregisterPane(paneId), [paneId, unregisterPane])

  return (
    <div
      {...props}
      id={paneId}
      data-split-pane
      data-split-pane-id={paneId}
      data-split-pane-visible={visible === false ? "false" : "true"}
      aria-hidden={visible === false || undefined}
      inert={visible === false || undefined}
      className={cn("min-h-0 min-w-0 overflow-hidden", className)}
      style={
        {
          ...getSplitGridItemStyle(
            context.direction,
            context.getPaneSlot(paneId),
            "pane"
          ),
          ...style,
        } as CSSProperties
      }
    >
      {children}
    </div>
  )
}
