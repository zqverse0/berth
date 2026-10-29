"use client"

import { createContext, useContext } from "react"
import type { SplitViewContextValue } from "./split-view-types"

export const SplitViewContext = createContext<SplitViewContextValue | null>(
  null
)

export function useRequiredSplitViewContext(
  componentName: "SplitPane" | "SplitHandle"
): SplitViewContextValue {
  const context = useContext(SplitViewContext)
  if (!context) {
    throw new Error(`${componentName} must be rendered inside SplitView`)
  }
  return context
}
