"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Archive,
  Ban,
  Ellipsis,
  Lightbulb,
  Play,
  RotateCcw,
} from "lucide-react"
import { toast } from "@/lib/notify"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { changeTaskState } from "@/lib/agent/berth-tasks"
import { assignTask, listGroups } from "@/lib/agent/berth-group"
import { listIdeas } from "@/knowledge/api/knowledge-client"
import { cn } from "@/lib/utils"
import { stepProgress, TASK_STATE_COLOR } from "./task-state"
import { useTaskView, useTaskViewStore } from "./task-view-store"

/**
 * 任务 tab 的工具栏（统一文件 Header 里）：状态、编号、来源想法、步骤进度，
 * 每个状态一个主操作；分配到群、放弃收进 ⋯ 菜单。
 */
export function TaskToolbar({
  folderId,
  task,
}: {
  folderId: number
  task: string
}) {
  const t = useTranslations("BerthTasks.group")
  const tTasks = useTranslations("BerthTasks.tasks")
  const tRoot = useTranslations("BerthTasks")
  const workspace = useWorkspaceRuntimeActions()
  const { view } = useTaskView(folderId, task)
  const load = useTaskViewStore((state) => state.load)
  const [busy, setBusy] = useState(false)
  /** 项目全部群组（内部键 → worktree 目录），分配任务用。 */
  const [groups, setGroups] = useState<Record<string, string>>({})

  useEffect(() => {
    let cancelled = false
    listGroups(folderId, true)
      .then((response) => {
        if (!cancelled && response.ok) setGroups(response.result.worktrees)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [folderId])

  if (!view) return null

  const state = view.state
  const progress = stepProgress(view)
  const percent = progress
    ? Math.round((progress.done / progress.total) * 100)
    : 0
  const abandoned = state === "completed" && Boolean(view.abandoned)
  const primary =
    state === "planning"
      ? "begin"
      : state === "completed"
        ? "reopen"
        : "complete"
  const PrimaryIcon =
    primary === "begin" ? Play : primary === "reopen" ? RotateCcw : Archive
  const groupNames = Object.keys(groups)

  const run = async (
    action: () => Promise<{ ok: boolean; error?: { message: string } }>
  ) => {
    setBusy(true)
    try {
      const response = await action()
      if (!response.ok) {
        toast.error(response.error?.message ?? "")
        return
      }
      await load(folderId, task)
    } catch (cause) {
      toast.error(String(cause))
    } finally {
      setBusy(false)
    }
  }
  const transition = (operation: "begin" | "complete" | "reopen" | "cancel") =>
    run(() => changeTaskState(folderId, task, operation))

  /** 来源想法：可能已进归档，按 id 查到实际路径再打开。 */
  const openIdea = async (id: string) => {
    const ideas = await listIdeas(folderId).catch(() => [])
    const idea = ideas.find((item) => item.id === id)
    const root = view.prd.split("/.berth/")[0]
    if (!idea || !root) {
      toast.error(t("ideaMissing", { id }))
      return
    }
    void workspace.openFilePreview(`${root}/${idea.path}`)
  }

  return (
    <div className="flex h-full min-w-0 items-center gap-3 px-3 text-xs text-muted-foreground">
      <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-muted px-2 py-0.5 text-foreground">
        <span
          aria-hidden="true"
          className={cn(
            "size-2 rounded-full",
            abandoned ? "bg-muted-foreground/40" : TASK_STATE_COLOR[state]
          )}
        />
        {abandoned ? tTasks("abandoned") : tTasks(`runState.${state}`)}
      </span>
      {progress ? (
        <span className="flex shrink-0 items-center gap-1.5">
          <span className="h-1.5 w-20 overflow-hidden rounded-full bg-muted">
            <span
              className={cn("block h-full", TASK_STATE_COLOR[state])}
              style={{ width: `${percent}%` }}
            />
          </span>
          <span className="tabular-nums">{t("stats.steps", progress)}</span>
        </span>
      ) : null}
      <span className="min-w-0 truncate font-mono">{view.taskDirName}</span>
      {view.idea ? (
        <button
          type="button"
          className="flex min-w-0 items-center gap-1 hover:text-foreground hover:underline"
          onClick={() => void openIdea(view.idea!)}
        >
          <Lightbulb aria-hidden="true" className="size-3.5 shrink-0" />
          <span className="truncate">{t("fromIdea", { id: view.idea })}</span>
        </button>
      ) : null}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5 px-2 text-xs"
          disabled={busy}
          onClick={() => void transition(primary)}
        >
          <PrimaryIcon aria-hidden="true" className="size-3.5" />
          {tRoot(`lifecycle.${primary}`)}
        </Button>
        {state !== "completed" ? (
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-1.5"
                aria-label={tTasks("more")}
                disabled={busy}
              >
                <Ellipsis aria-hidden="true" className="size-4" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {groupNames.length > 1 ? (
                <>
                  <DropdownMenuLabel>{tTasks("assignGroup")}</DropdownMenuLabel>
                  <DropdownMenuRadioGroup
                    value={view.group}
                    onValueChange={(group) =>
                      void run(() => assignTask(folderId, task, group))
                    }
                  >
                    {groupNames.map((name) => (
                      <DropdownMenuRadioItem key={name} value={name}>
                        {groups[name]
                          .split(/[\\/]/)
                          .filter(Boolean)
                          .slice(-1)[0] ?? name}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                  <DropdownMenuSeparator />
                </>
              ) : null}
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => void transition("cancel")}
              >
                <Ban aria-hidden="true" className="size-3.5" />
                {tRoot("lifecycle.cancel")}
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
    </div>
  )
}
