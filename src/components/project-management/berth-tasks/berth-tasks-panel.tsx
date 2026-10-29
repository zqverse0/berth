"use client"

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronRight } from "lucide-react"
import {
  type BerthTaskList,
  type BerthTaskSummary,
  listBerthTaskViews,
  type BerthTaskView,
} from "@/lib/agent/berth-tasks"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { cn } from "@/lib/utils"
import { useWorkspaceFileStore } from "@/stores/workspace-file-store"
import { TaskSteps } from "./task-steps"
import {
  isFileTask,
  stepProgress,
  TASK_STATE_COLOR,
  taskRunState,
} from "./task-state"

/** 派生视图的刷新间隔：进度来自 git 与任务文件，没有事件推送，轮询。 */
const VIEW_POLL_MS = 5000

interface BerthTasksPanelProps {
  folderId: number
  data: BerthTaskList
}

/**
 * 任务列表：只列任务本身，按状态平铺（进行中 / 规划中），完成与放弃折进「已归档」。
 * 群组在侧栏「群组」视图里看。列哪些任务由后端按主项目记录决定（worktree 只列分到它的群的任务），
 * 派生视图只补进度，不决定成员。
 * 任务行可展开看步骤（中间打开着的任务默认展开），步骤也在这里编辑。
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

  /** 中间工作区当前打开的本项目任务：它的步骤默认展开。 */
  const activeTask = useWorkspaceFileStore((state) => {
    const tab = state.fileTabs.find((item) => item.id === state.activeFileTabId)
    return tab?.kind === "task" && tab.folderId === folderId
      ? tab.taskDirName
      : null
  })
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

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
        // 有步骤才能展开；单文件任务没步骤时展开给「添加步骤」。
        const expandable = Boolean(
          view && (view.steps.length > 0 || isFileTask(view))
        )
        const open = expandable && (expanded[task.id] ?? active)
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
                className="flex min-h-8 min-w-0 flex-1 items-center gap-2 py-1 pl-2 text-left"
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
              {/* 箭头固定在右侧，展开与否不影响左侧色点对齐 */}
              <span className="flex w-6 shrink-0 justify-center">
                {expandable ? (
                  <button
                    type="button"
                    className={cn(
                      "rounded p-0.5 text-muted-foreground hover:bg-background/60 hover:text-foreground",
                      !open &&
                        !active &&
                        "opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    )}
                    aria-label={t("toggleSteps", { title: task.title })}
                    aria-expanded={open}
                    onClick={() =>
                      setExpanded({ ...expanded, [task.id]: !open })
                    }
                  >
                    <ChevronRight
                      aria-hidden="true"
                      className={cn(
                        "size-3.5 transition-transform",
                        open && "rotate-90"
                      )}
                    />
                  </button>
                ) : null}
              </span>
            </div>
            {open && view ? (
              <div className="mb-1 ml-[11px] mt-0.5 border-l border-border pl-2.5 pr-1">
                <TaskSteps
                  folderId={folderId}
                  view={view}
                  editable={isFileTask(view)}
                  onSaved={load}
                />
              </div>
            ) : null}
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
