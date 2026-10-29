"use client"

import { Profiler, type ProfilerOnRenderCallback, type ReactNode } from "react"
import { getCollector } from "./collector"
import { perfEnabled } from "./enabled"

/**
 * Records every React commit of a workspace region as span `render:<id>`, so a
 * scene dump shows how many times each region re-rendered for one operation.
 *
 * Always mounts `<Profiler>` to keep the tree shape stable across the perf
 * switch; production React never calls `onRender`, so it costs nothing there.
 */
const onRender: ProfilerOnRenderCallback = (
  id,
  _phase,
  actualDuration,
  _base,
  startTime
) => {
  if (!perfEnabled()) return
  getCollector().record("span", `render:${id}`, startTime, actualDuration, true)
}

export function PerfProfiler({
  id,
  children,
}: {
  id: string
  children: ReactNode
}) {
  return (
    <Profiler id={id} onRender={onRender}>
      {children}
    </Profiler>
  )
}
