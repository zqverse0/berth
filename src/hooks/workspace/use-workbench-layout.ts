"use client"

import { useCallback, useMemo, useSyncExternalStore } from "react"
import { WORKBENCH_LAYOUT } from "@/lib/workbench"
import type {
  ResolvedWorkbench,
  WorkbenchPageId,
  WorkbenchPanelId,
} from "@/lib/workbench"

type Selection = Partial<Record<WorkbenchPageId, WorkbenchPanelId>>

const listeners = new Set<() => void>()
let picked: Selection = {}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

function getPicked(): Selection {
  return picked
}

export type UseWorkbenchLayoutResult = {
  resolved: ResolvedWorkbench
  selected: Selection
  selectPanel: (pageId: WorkbenchPageId, panelId: WorkbenchPanelId) => void
}

function clampSelected(current: Selection): Selection {
  const next: Selection = {}
  for (const [pageId, list] of Object.entries(WORKBENCH_LAYOUT.pages) as [
    WorkbenchPageId,
    WorkbenchPanelId[],
  ][]) {
    const panelId = current[pageId]
    next[pageId] = panelId && list.includes(panelId) ? panelId : list[0]
  }
  return next
}

/** 各 page 当前选中的面板（进程内共享，不持久化）。 */
export function useWorkbenchLayout(): UseWorkbenchLayoutResult {
  const currentPicked = useSyncExternalStore(subscribe, getPicked, getPicked)
  const selected = useMemo(() => clampSelected(currentPicked), [currentPicked])

  const selectPanel = useCallback(
    (pageId: WorkbenchPageId, panelId: WorkbenchPanelId) => {
      picked = { ...picked, [pageId]: panelId }
      for (const listener of listeners) listener()
    },
    []
  )

  return { resolved: WORKBENCH_LAYOUT, selected, selectPanel }
}
