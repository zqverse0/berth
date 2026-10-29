"use client"

import type { ReactNode } from "react"
import { useTranslations } from "next-intl"
import { cn } from "@/lib/utils"
import { useWorkspaceLayoutProjection } from "@/hooks/workspace/use-workspace-layout"
import type { WorkspacePane } from "@/lib/workspace/workspace-tab-placement"

/**
 * A tab group's content area as a tab drop target. While a tab is dragged
 * over it, the region it would land in is highlighted; with `splitZone`, the
 * right third proposes a new right split group (`paneAtPoint`).
 */
export function WorkspacePaneDropArea({
  pane,
  splitZone = false,
  className,
  children,
}: {
  pane: WorkspacePane
  splitZone?: boolean
  className?: string
  children: ReactNode
}) {
  const t = useTranslations("Folder.tabs")
  // A strip target (insert index set) shows its gap instead of this highlight.
  const dragOverPane = useWorkspaceLayoutProjection(
    ({ dragging, dragOverPane, dragInsertIndex }) =>
      dragging && dragInsertIndex === null ? dragOverPane : null
  )
  const feedback =
    dragOverPane === pane
      ? { label: t("moveTabHere"), half: false }
      : splitZone && dragOverPane === "files-split"
        ? { label: t("splitRight"), half: true }
        : null

  return (
    <div
      data-workspace-pane={pane}
      data-workspace-split-zone={splitZone ? "" : undefined}
      className={cn("relative", className)}
    >
      {children}
      {feedback && (
        <div
          data-workspace-drop-feedback
          aria-hidden
          className={cn(
            "pointer-events-none absolute inset-y-1 right-1 z-50 flex items-center justify-center rounded-lg border-2 border-primary bg-primary/10",
            feedback.half ? "left-1/2" : "left-1"
          )}
        >
          <span className="rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground shadow-sm">
            {feedback.label}
          </span>
        </div>
      )}
    </div>
  )
}
