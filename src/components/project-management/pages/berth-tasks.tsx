"use client"

import { BerthTasksConsole } from "@/components/project-management/berth-tasks/berth-tasks-console"
import type { ProjectPageProps } from "./types"

/** 任务视图。定时执行挂在各任务上（任务详情里），不另开入口。 */
export function BerthTasksPage({
  folderId,
  selectedAgent,
  visible,
  active,
}: ProjectPageProps) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <BerthTasksConsole
        folderId={folderId}
        selectedAgent={selectedAgent}
        className="h-full min-h-0"
        surfaceActive={visible && active}
      />
    </div>
  )
}
export default BerthTasksPage
