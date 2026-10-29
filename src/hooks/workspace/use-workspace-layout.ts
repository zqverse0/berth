"use client"

import { useRef, useSyncExternalStore } from "react"
import { shallow } from "zustand/shallow"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useTabStore } from "@/stores/tab-store"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"
import {
  projectWorkspaceLayout,
  type WorkspaceLayoutProjection,
} from "@/lib/workspace/workspace-layout-projection"
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store"

// One projection per distinct input snapshot, shared by every consumer.
let cached: {
  inputs: readonly unknown[]
  projection: WorkspaceLayoutProjection
} | null = null

/** Reads the current projection without subscribing — for event handlers. */
export function readWorkspaceLayoutProjection(): WorkspaceLayoutProjection {
  const layoutState = useWorkspaceLayoutStore.getState()
  const { tabs, rawTabs } = useTabStore.getState()
  const { fileTabs } = useWorkspaceFileStore.getState()
  const { activeFolderId, allFolders } = useAppWorkspaceStore.getState()
  const inputs = [
    layoutState,
    tabs,
    rawTabs,
    fileTabs,
    activeFolderId,
    allFolders,
  ]
  if (!cached || inputs.some((input, i) => input !== cached!.inputs[i])) {
    cached = {
      inputs,
      projection: projectWorkspaceLayout(layoutState, {
        primaryTabs: tabs,
        rawPrimaryTabs: rawTabs,
        fileTabs,
        activeFolderId,
        allFolders,
      }),
    }
  }
  return cached.projection
}

function subscribe(onChange: () => void): () => void {
  const unsubscribers = [
    useWorkspaceLayoutStore.subscribe(onChange),
    useTabStore.subscribe(onChange),
    useWorkspaceFileStore.subscribe(onChange),
    useAppWorkspaceStore.subscribe(onChange),
  ]
  return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
}

const wholeProjection = (projection: WorkspaceLayoutProjection) => projection

/**
 * Projects canonical layout state against the current primary/file snapshots.
 * The store owns layout decisions; this hook only joins independent owners for
 * rendering and never writes back through an effect.
 *
 * Pass `select` to re-render only when the selected slice changes (compared
 * shallowly) — without it every tab, folder or layout change re-renders the
 * caller. Prefer selecting primitives.
 */
export function useWorkspaceLayoutProjection<T = WorkspaceLayoutProjection>(
  select: (projection: WorkspaceLayoutProjection) => T = wholeProjection as (
    projection: WorkspaceLayoutProjection
  ) => T
): T {
  const selected = useRef<{ value: T } | null>(null)
  const getSnapshot = () => {
    const next = select(readWorkspaceLayoutProjection())
    if (selected.current && shallow(selected.current.value, next)) {
      return selected.current.value
    }
    selected.current = { value: next }
    return next
  }
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
