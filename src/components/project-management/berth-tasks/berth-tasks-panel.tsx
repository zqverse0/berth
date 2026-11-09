"use client"

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  type BerthTaskList,
  type BerthTaskSummary,
  listBerthTaskViews,
  type BerthTaskView,
} from "@/lib/agent/berth-tasks"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { cn } from "@/lib/utils"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"
import { stepProgress, TASK_STATE_COLOR, taskRunState } from "./task-state"

/** 派生视图的刷新间隔：进度来自 git 与任务文件，没有事件推送，轮询。 */
const VIEW_POLL_MS = 5000

interface BerthTasksPanelProps {
  folderId: number
  data: BerthTaskList
}

/**
 * 任务列表：只列任务本身，按状态平铺（进行中 / 规划中），完成与放弃折进「已归档」。
 * 群组在侧栏「群组」视图里看。列哪些任务由后端按主项目记录决定（worktree 只列分到它的群的任务），
 * 派生视图只补进度，不决定成员。每行只有标题、状态和进度，步骤在任务页看和编辑。
 */
export function BerthTasksPanel({ folderId, data }: BerthTasksPanelProps) {
  const t = useTranslations("BerthTasks.tasks")
  const workspace = useWorkspaceRuntimeActions()
  const [views, setViews] = useState<Map<string, BerthTaskView>>(new Map())
  const [viewError, setViewError] = useState<string | null>(null)

  const load = useCallback(
    () =>
      listBerthTaskViews(folderId)
        .then((response) => {
          if (!response.ok) return setViewError(response.error.message)
          setViewError(null)
          setViews(
            new Map(
              response.result.tasks.map((view) => [view.taskDirName, view])
            )
          )
        })
        .catch(() => {}),
    [folderId]
  )

  useEffect(() => {
    void load()
    const timer = setInterval(() => void load(), VIEW_POLL_MS)
    return () => clearInterval(timer)
  }, [load])

  /** 中间工作区当前打开的本项目任务：高亮它那一行。 */
  const activeTask = useWorkspaceFileStore((state) => {
    const tab = state.fileTabs.find((item) => item.id === state.activeFileTabId)
    return tab?.kind === "task" && tab.folderId === folderId
      ? tab.taskDirName
      : null
  })

  /** 详情在中间工作区的任务 tab 里看。 */
  const openTask = (task: BerthTaskSummary) =>
    workspace.openTaskTab({
      folderId,
      taskDirName: task.id,
      title: task.title,
    })

  const stateOf = (task: BerthTaskSummary) =>
    taskRunState(task, views.get(task.id))
  const visible = data.tasks
  const closed = (task: BerthTaskSummary) =>
    task.archived || stateOf(task) === "completed"
  const running = visible.filter(
    (task) => !closed(task) && stateOf(task) !== "planning"
  )
  const planning = visible.filter(
    (task) => !closed(task) && stateOf(task) === "planning"
  )
  const archived = visible.filter(closed)

  const renderTaskList = (tasks: BerthTaskSummary[]) => (
    <ul className="space-y-px">
      {tasks.map((task) => {
        const state = stateOf(task)
        const view = views.get(task.id)
        const progress = view ? stepProgress(view) : null
        const abandoned = state === "completed" && Boolean(view?.abandoned)
        const stateLabel = abandoned ? t("abandoned") : t(`runState.${state}`)
        const active = task.id === activeTask
        const done = closed(task)
        const percent = progress
          ? Math.round((progress.done / progress.total) * 100)
          : 0
        return (
          <li key={`${task.archived ? "archive" : "active"}:${task.id}`}>
            <div
              data-active={active || undefined}
              className={cn(
                "group flex items-center rounded-md hover:bg-accent/60",
                active && "bg-accent hover:bg-accent"
              )}
            >
              <button
                type="button"
                data-task-state={state}
                data-abandoned={abandoned || undefined}
                aria-current={active ? "page" : undefined}
                className="flex min-h-8 min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left"
                title={`${task.id}\n${stateLabel}${progress ? ` · ${progress.done}/${progress.total}` : ""}`}
                onClick={() => openTask(task)}
              >
                <span
                  aria-hidden="true"
                  className={cn(
                    "size-2 shrink-0 rounded-full",
                    abandoned
                      ? "bg-muted-foreground/40"
                      : TASK_STATE_COLOR[state],
                    done && !abandoned && "opacity-60"
                  )}
                />
                <span
                  className={cn(
                    "min-w-0 flex-1 truncate text-xs",
                    active
                      ? "font-medium text-foreground"
                      : "text-foreground/90",
                    done && "text-muted-foreground",
                    abandoned && "line-through"
                  )}
                >
                  {task.title}
                </span>
                {progress && !done ? (
                  <span className="flex shrink-0 items-center gap-1.5">
                    <span className="h-1 w-8 overflow-hidden rounded-full bg-muted">
                      <span
                        className={cn("block h-full", TASK_STATE_COLOR[state])}
                        style={{ width: `${percent}%` }}
                      />
                    </span>
                    <span className="font-mono text-[10px] tabular-nums text-muted-foreground">
                      {progress.done}/{progress.total}
                    </span>
                  </span>
                ) : null}
              </button>
            </div>
          </li>
        )
      })}
    </ul>
  )

  const heading =
    "flex items-center gap-1.5 px-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
  const count = (tasks: BerthTaskSummary[]) => (
    <span className="rounded-full bg-muted px-1.5 font-mono text-[10px] tabular-nums">
      {tasks.length}
    </span>
  )
  const section = (title: string, tasks: BerthTaskSummary[]) =>
    tasks.length > 0 ? (
      <section className="space-y-1">
        <h3 className={heading}>
          {title}
          {count(tasks)}
        </h3>
        {renderTaskList(tasks)}
      </section>
    ) : null

  return (
    <section className="space-y-3 text-sm">
      {data.truncated ? (
        <p className="px-2 text-xs text-muted-foreground">{t("truncated")}</p>
      ) : null}
      {data.diagnostics.length > 0 ? (
        <details className="px-2 text-xs">
          <summary className="cursor-pointer text-destructive">
            {t("unreadable", { count: data.diagnostics.length })}
          </summary>
          {data.diagnostics.map((diagnostic) => (
            <p
              key={diagnostic.entry}
              className="mt-1 break-all text-muted-foreground"
            >
              {diagnostic.entry}: {diagnostic.message}
            </p>
          ))}
        </details>
      ) : null}

      {viewError ? (
        <p className="px-2 text-xs text-muted-foreground">{viewError}</p>
      ) : null}
      <>
        {running.length + planning.length === 0 ? (
          <p className="px-2 text-muted-foreground">{t("empty")}</p>
        ) : null}
        {section(t("runningTitle"), running)}
        {section(t("planningTitle"), planning)}
        {archived.length > 0 ? (
          <details className="space-y-1">
            <summary className={cn(heading, "cursor-pointer")}>
              {t("archivedTitle")}
              {count(archived)}
            </summary>
            {renderTaskList(archived)}
          </details>
        ) : null}
      </>
    </section>
  )
}
