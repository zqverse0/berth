"use client"

import { forwardRef, useImperativeHandle, useRef } from "react"
import { cn } from "@/lib/utils"
import { useSplitLayoutTransaction } from "@/lib/workspace/split-layout-transaction-context"
import { SplitViewContext } from "./split-view-context"
import { getSplitViewRootStyle } from "./split-view-dom-renderer"
import { useSplitViewLayoutState } from "./split-view-layout-state"
import type { SplitViewHandle, SplitViewProps } from "./split-view-types"

export const SplitView = forwardRef<SplitViewHandle, SplitViewProps>(
  function SplitView(
    {
      direction = "horizontal",
      onLayout,
      onGeometry,
      transaction = null,
      className,
      style,
      children,
      ...props
    },
    forwardedRef
  ) {
    const inheritedTransaction = useSplitLayoutTransaction()
    const effectiveTransaction = transaction ?? inheritedTransaction
    const rootRef = useRef<HTMLDivElement | null>(null)
    const layoutState = useSplitViewLayoutState({
      direction,
      rootRef,
      onLayout,
      onGeometry,
      transaction: effectiveTransaction,
    })

    // 不传依赖数组：HMR 或方法换身份时不能改变 useImperativeHandle 的依赖长度。
    useImperativeHandle(forwardedRef, () => ({
      setLayout: layoutState.setLayout,
      getLayout: layoutState.getLayout,
    }))

    return (
      <SplitViewContext.Provider value={layoutState.context}>
        <div
          {...props}
          ref={rootRef}
          data-split-view
          data-split-view-direction={direction}
          className={cn(
            "relative grid h-full min-h-0 min-w-0 w-full overflow-clip",
            className
          )}
          style={getSplitViewRootStyle(direction, style)}
        >
          {children}
        </div>
      </SplitViewContext.Provider>
    )
  }
)

SplitView.displayName = "SplitView"
