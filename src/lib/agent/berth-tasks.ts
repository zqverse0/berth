/**
 * 项目任务：摘要、派生视图、状态变更（与 `berth task` 同一实现，进程内）。
 */
import {
  runtimeBridgeOperation,
  type RuntimeBridgeResponse,
} from "@/lib/runtime-bridge"

export interface BerthTaskSummary {
  id: string
  title: string
  status: string
  etag: string
  archived: boolean
  /** 所属群（主项目记录）；worktree 里后端只返回分到它的任务。 */
  group?: string
}

export interface BerthTaskDiagnostic {
  entry: string
  message: string
}

export interface BerthTaskList {
  tasks: BerthTaskSummary[]
  diagnostics: BerthTaskDiagnostic[]
  truncated: boolean
}

export type BerthTaskRunState = "planning" | "running" | "merged" | "completed"

export interface BerthTaskChecklistItem {
  text: string
  checked: boolean
}

export interface BerthTaskStepView extends BerthTaskChecklistItem {
  id?: string
  state: "todo" | "committed" | "merged"
  commit: { hash: string; subject: string } | null
  /** 单文件任务：改哪里、怎么验证。 */
  change?: string
  verify?: string
}

/** 单文件任务 frontmatter 里的一步（`task.save` 写回）。 */
export interface BerthTaskPlanStep {
  id: string
  do: string
  change: string
  verify: string
  commit?: string
}

/** `berth task views` 的派生视图：状态、步骤、提交都从 git 和 prd 算出。 */
export interface BerthTaskView {
  taskDirName: string
  title: string
  /** 来源想法 id（单文件任务 frontmatter 的 `idea`）。 */
  idea?: string
  state: BerthTaskRunState
  /** 未合并就放弃收尾的已完成任务。 */
  abandoned?: boolean
  prd: string
  prdText: string
  branch: string | null
  baseBranch: string | null
  worktree: string | null
  /** 所属群组（`main` 或 worktree 群组）。 */
  group?: string
  dirtyFiles: number
  /** base 上有、分支还没有的提交数。 */
  behind?: number
  acceptance: { done: number; total: number; items: BerthTaskChecklistItem[] }
  steps: BerthTaskStepView[]
  currentStep: string | null
  commits: { hash: string; subject: string; step: string | null }[]
  unlinkedCommits: number
  diffstat: string
  history: { hash: string; date: string; subject: string }[]
}

function call<T>(
  folderId: number,
  method: string,
  params: Record<string, unknown> = {}
): Promise<RuntimeBridgeResponse<T>> {
  return runtimeBridgeOperation<T>({ method, folderId, params })
}

/** 任务摘要（含归档），与 `berth task list --archived` 同一实现。 */
export function listBerthTasks(folderId: number) {
  return call<BerthTaskList>(folderId, "task.list")
}

const inflightViews = new Map<
  number,
  Promise<RuntimeBridgeResponse<{ tasks: BerthTaskView[] }>>
>()

/**
 * 全部任务的派生视图（状态、步骤、提交从 git 与 prd 算出）。后端要跑一串 git，
 * 首页和任务侧栏常同时要：同一项目在途的请求共用一个，结束即失效，不缓存结果。
 */
export function listBerthTaskViews(folderId: number) {
  const pending = inflightViews.get(folderId)
  if (pending) return pending
  const request = call<{ tasks: BerthTaskView[] }>(folderId, "task.views")
  inflightViews.set(folderId, request)
  void request.finally(() => inflightViews.delete(folderId)).catch(() => {})
  return request
}

/** 单个任务的派生视图（不跑全量 views）。 */
export function getTaskView(folderId: number, task: string) {
  return call<BerthTaskView>(folderId, "task.view", { task })
}

/** 显式改变任务状态，不清理群组环境、不关闭成员终端。 */
export function changeTaskState(
  folderId: number,
  task: string,
  operation: "begin" | "complete" | "cancel" | "reopen",
  reason?: string
) {
  return call<{ taskDirName: string; state: string }>(
    folderId,
    operation === "begin" ? "task.start" : "task.finish",
    { task, operation, reason }
  )
}

/** 任务页保存：步骤和 / 或正文；正文带加载时的内容，磁盘上已被改过时返回 conflict。 */
export function saveTask(
  folderId: number,
  task: string,
  edit: { steps?: BerthTaskPlanStep[]; body?: string; baseBody?: string }
) {
  return call<{ taskDirName: string; etag: string }>(folderId, "task.save", {
    task,
    ...edit,
  })
}
