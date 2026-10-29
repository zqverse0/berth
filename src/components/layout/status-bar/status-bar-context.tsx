"use client"

import {
  ActivePathStatus,
  type ActivePathPart,
} from "@/components/layout/status-bar/active-path-status"

/**
 * Status-bar left edge. Path/source resolution lives in ActivePathStatus so
 * file, terminal, project and ACP surfaces share one projection.
 */
export function StatusBarContext({ part }: { part?: ActivePathPart }) {
  return <ActivePathStatus part={part} />
}
