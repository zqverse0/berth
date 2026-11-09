"use client"

import { useEffect } from "react"
import { useTranslations } from "next-intl"
import { MessageResponse } from "@/components/ai-elements/message"
import type { TaskWorkspaceTab } from "@/lib/files/file-workspace-tab"
import { isFileTask, taskGoal } from "./task-state"
import { TaskBodyEditor } from "./task-body-editor"
import { TaskSchedule } from "./task-schedule"
import { TaskSessions } from "./task-sessions"
import { TaskSteps } from "./task-steps"
import { useTaskView, useTaskViewStore } from "./task-view-store"

/** 单任务派生视图要跑几条 git：比群时间线慢一档。 */
const VIEW_POLL_MS = 5000

/**
 * 任务页，从上到下：标题、目标摘要（只读）、步骤、关联会话、可编辑的完整正文。
 * 状态与操作在上方工具栏（TaskToolbar）；这里负责轮询，工具栏读同一份视图。
 */
export function TaskDetail({ tab }: { tab: TaskWorkspaceTab }) {
  const t = useTranslations("BerthTasks.group")
  const tRoot = useTranslations("BerthTasks")
  const { view, error } = useTaskView(tab.folderId, tab.taskDirName)
  const load = useTaskViewStore((state) => state.load)

  useEffect(() => {
    void load(tab.folderId, tab.taskDirName)
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible")
        void load(tab.folderId, tab.taskDirName)
    }, VIEW_POLL_MS)
    return () => window.clearInterval(timer)
  }, [load, tab.folderId, tab.taskDirName])

  if (!view) {
    return (
      <p
        className={
          error
            ? "p-6 text-sm text-destructive"
            : "p-6 text-sm text-muted-foreground"
        }
      >
        {error ?? tRoot("loading")}
      </p>
    )
  }

  const fileTask = isFileTask(view)
  const goal = taskGoal(view.prdText)

  return (
    <div className="flex h-full min-h-0 flex-col bg-background ws-transparent-bg text-sm">
      <h1 className="shrink-0 truncate px-6 pb-1 pt-5 text-xl font-semibold">
        {view.title}
      </h1>
      {goal ? (
        <p className="shrink-0 whitespace-pre-wrap px-6 pb-1 text-muted-foreground">
          {goal}
        </p>
      ) : null}
      <TaskSchedule folderId={tab.folderId} task={view.taskDirName} />
      {view.steps.length > 0 || fileTask || view.sessions?.length ? (
        <div className="max-h-[40%] shrink-0 overflow-y-auto border-b px-5 pb-2 pt-1">
          <TaskSteps
            folderId={tab.folderId}
            view={view}
            editable={fileTask}
            onSaved={() => load(tab.folderId, tab.taskDirName)}
          />
          <TaskSessions folderId={tab.folderId} view={view} />
        </div>
      ) : null}
      <main className="flex min-h-0 flex-1 flex-col">
        {fileTask ? (
          <TaskBodyEditor
            folderId={tab.folderId}
            task={view.taskDirName}
            path={view.prd}
            body={view.prdText}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
            {view.prdText ? (
              <MessageResponse>{view.prdText}</MessageResponse>
            ) : (
              <p className="text-muted-foreground">{t("noPrd")}</p>
            )}
          </div>
        )}
      </main>
    </div>
  )
}
