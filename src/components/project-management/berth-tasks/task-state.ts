import {
  type BerthTaskView,
  type BerthTaskSummary,
} from "@/lib/agent/berth-tasks"

/** 主项目所在的群（与 `berth-project-core` 的 `MAIN_GROUP` 一致）。 */
export const MAIN_GROUP = "main"

export type TaskRunState = BerthTaskView["state"]

/** 状态色：列表色点、进度线与详情头部共用。 */
export const TASK_STATE_COLOR: Record<TaskRunState, string> = {
  planning: "bg-muted-foreground/50",
  running: "bg-sky-500",
  merged: "bg-violet-500",
  completed: "bg-emerald-500",
}

/** 步骤进度：勾过或已有提交的算完成；没有步骤时为 null。 */
export function stepProgress(
  view: Pick<BerthTaskView, "steps">
): { done: number; total: number } | null {
  const total = view.steps.length
  if (total === 0) return null
  const done = view.steps.filter(
    (step) => step.checked || step.state !== "todo"
  ).length
  return { done, total }
}

/** 有派生视图用它；还没读到时按 task.json 的状态近似。 */
export function taskRunState(
  task: Pick<BerthTaskSummary, "status">,
  view: BerthTaskView | undefined
): TaskRunState {
  if (view) return view.state
  if (task.status === "completed") return "completed"
  return task.status === "in_progress" ? "running" : "planning"
}

function trimSlash(path: string): string {
  return path.length > 1 ? path.replace(/\/+$/, "") : path
}

export function samePath(a: string, b: string): boolean {
  return trimSlash(a) === trimSlash(b)
}

/** 单文件任务（`.berth/tasks/<name>.md`）可在任务页编辑；旧任务的 prd.md 只读。 */
export function isFileTask(view: Pick<BerthTaskView, "prd">): boolean {
  return /\.md$/.test(view.prd) && !/[\\/]prd\.md$/.test(view.prd)
}
