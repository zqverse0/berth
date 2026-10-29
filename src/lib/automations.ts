import { getTransport } from "@/lib/transport"

export type Automation = {
  id: number
  name: string
  enabled: boolean
  cron: string
  timezone: string
  nextRunAt: string | null
  lastRunAt: string | null
  lastRunStatus: string | null
  agentId: string
  folderId: number
  /** 任务定时的补充说明；指令是任务正文。 */
  prompt: string
  /** 挂在哪个任务上（任务名）；没有的是已停用的旧独立自动化。 */
  task: string | null
  missedRunGraceMinutes: number
}

export type AutomationDraft = Omit<
  Automation,
  "id" | "nextRunAt" | "lastRunAt" | "lastRunStatus"
>

export type AutomationRun = {
  id: number
  automationId: number
  status: "running" | "succeeded" | "failed" | "cancelled" | "skipped"
  trigger: string
  scheduledFor: string | null
  terminalId: string | null
  endedAt?: string | null
  error: string | null
  stopReason?: string | null
  summary?: string | null
  reviewedAt?: string | null
  resultPath?: string | null
  createdAt: string
}

type Response =
  | { type: "list"; automations: Automation[] }
  | { type: "automation"; automation: Automation }
  | { type: "runs"; runs: AutomationRun[] }
  | { type: "run"; run: AutomationRun }
  | { type: "ok" }

async function call(request: Record<string, unknown>): Promise<Response> {
  return getTransport().call<Response>("automations", { request })
}

export async function listAutomations(folderId: number) {
  const response = await call({ type: "list", folderId })
  return response.type === "list" ? response.automations : []
}

export async function saveAutomation(
  id: number | null,
  draft: AutomationDraft
) {
  const response = await call(
    id == null ? { type: "create", draft } : { type: "update", id, draft }
  )
  if (response.type !== "automation") throw new Error("Invalid response")
  return response.automation
}

export async function deleteAutomation(id: number) {
  await call({ type: "delete", id })
}

export async function runAutomation(id: number) {
  const response = await call({ type: "run_now", id })
  if (response.type !== "run") throw new Error("Invalid response")
  return response.run
}

export async function listAutomationRuns(automationId: number) {
  const response = await call({ type: "list_runs", automationId })
  return response.type === "runs" ? response.runs : []
}

/**
 * 记录一次运行的人工检查状态与结果文件关联。
 * `reviewed` 为期望状态;`resultPath` 为期望的结果文件路径,空/省略表示清除。
 */
export async function checkAutomationRun(
  runId: number,
  reviewed: boolean,
  resultPath?: string | null
) {
  const response = await call({
    type: "check_run",
    runId,
    reviewed,
    resultPath: resultPath ?? null,
  })
  if (response.type !== "run") throw new Error("Invalid response")
  return response.run
}

export function subscribeAutomationChanges(refresh: () => void) {
  return getTransport().subscribe("automation://changed", refresh)
}
