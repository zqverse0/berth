"use client"

import type { ComponentProps } from "react"
import { WorkspaceTabStrip } from "@/components/tabs/workspace-tab-strip"

// Desktop conversation-column title strip. Mobile uses the conversation detail
// header + sidebar instead of a multi-tab strip.
export function TabBar(
  props: Omit<ComponentProps<typeof WorkspaceTabStrip>, "pane">
) {
  return <WorkspaceTabStrip pane="conversation" {...props} />
}
