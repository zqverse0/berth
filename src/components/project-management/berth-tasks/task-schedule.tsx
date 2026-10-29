"use client"

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  AlarmClock,
  CheckCircle2,
  Circle,
  FileText,
  Pencil,
  Play,
  SquareTerminal,
  Trash2,
  type LucideIcon,
} from "lucide-react"
import { toast } from "@/lib/notify"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  checkAutomationRun,
  deleteAutomation,
  listAutomationRuns,
  listAutomations,
  runAutomation,
  saveAutomation,
  subscribeAutomationChanges,
  type Automation,
  type AutomationDraft,
  type AutomationRun,
} from "@/lib/automations"
import { getTerminalSession } from "@/lib/api"
import { useAgentProfiles } from "@/hooks/use-agent-profiles"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { tabFromDescriptor } from "@/lib/terminal/create-and-open-primary-terminal"
import { useTabActions } from "@/stores/tab-store"
import { cn } from "@/lib/utils"

/** 运行记录只看最近几次；更早的结果在 `.berth/runs/<任务>/` 里。 */
const RECENT_RUNS = 10

type Frequency = "daily" | "weekdays" | "weekly" | "custom"
const FREQUENCY_DOW: Record<Exclude<Frequency, "custom">, string> = {
  daily: "*",
  weekdays: "1-5",
  weekly: "1",
}

/** 「每天 / 工作日 / 每周一 + 时刻」↔ cron；其余写法按自定义 cron。 */
export function cronOf(frequency: Frequency, time: string, custom: string) {
  if (frequency === "custom") return custom.trim()
  const [hour, minute] = time.split(":").map(Number)
  return `${minute || 0} ${hour || 0} * * ${FREQUENCY_DOW[frequency]}`
}

export function parseCron(cron: string): {
  frequency: Frequency
  time: string
} {
  const match = /^(\d{1,2}) (\d{1,2}) \* \* (\*|1-5|1)$/.exec(cron.trim())
  if (!match) return { frequency: "custom", time: "08:00" }
  const frequency = (
    Object.keys(FREQUENCY_DOW) as Exclude<Frequency, "custom">[]
  ).find((key) => FREQUENCY_DOW[key] === match[3])!
  const pad = (value: string) => value.padStart(2, "0")
  return { frequency, time: `${pad(match[2])}:${pad(match[1])}` }
}

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

function IconAction({
  icon: Icon,
  label,
  onClick,
  disabled,
}: {
  icon: LucideIcon
  label: string
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      className="size-6 shrink-0 text-muted-foreground"
      title={label}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon aria-hidden="true" className="size-3.5" />
    </Button>
  )
}

/**
 * 任务的定时执行：到点无人值守地跑这个任务，结果累积在下面；任务归档后不再触发（后端判断）。
 * 一个任务一条定时。
 */
export function TaskSchedule({
  folderId,
  task,
  defaultAgent,
}: {
  folderId: number
  task: string
  defaultAgent?: string
}) {
  const t = useTranslations("BerthTasks.automations")
  const { agents } = useAgentProfiles()
  const { openTerminalTab } = useTabActions()
  const workspace = useWorkspaceRuntimeActions()
  const [schedule, setSchedule] = useState<Automation | null>(null)
  const [runs, setRuns] = useState<AutomationRun[]>([])
  const [editing, setEditing] = useState(false)
  const [form, setForm] = useState({
    agentId: "",
    frequency: "daily" as Frequency,
    time: "08:00",
    cron: "",
    prompt: "",
  })

  const load = useCallback(async () => {
    try {
      const found =
        (await listAutomations(folderId)).find((item) => item.task === task) ??
        null
      setSchedule(found)
      setRuns(
        found ? (await listAutomationRuns(found.id)).slice(0, RECENT_RUNS) : []
      )
    } catch (error) {
      toast.error(errorText(error))
    }
  }, [folderId, task])

  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    let disposed = false
    const timeout = window.setTimeout(() => void load(), 0)
    void subscribeAutomationChanges(() => void load())
      .then((off) => {
        if (disposed) off()
        else unsubscribe = off
      })
      .catch(() => {})
    return () => {
      disposed = true
      window.clearTimeout(timeout)
      unsubscribe?.()
    }
  }, [load])

  const openEditor = () => {
    const parsed = parseCron(schedule?.cron ?? "0 8 * * *")
    setForm({
      agentId: schedule?.agentId ?? defaultAgent ?? agents[0]?.id ?? "",
      frequency: parsed.frequency,
      time: parsed.time,
      cron: schedule?.cron ?? "",
      prompt: schedule?.prompt ?? "",
    })
    setEditing(true)
  }

  const save = async (patch?: Partial<AutomationDraft>) => {
    const draft: AutomationDraft = {
      name: task,
      enabled: schedule?.enabled ?? true,
      cron: cronOf(form.frequency, form.time, form.cron),
      timezone:
        schedule?.timezone ??
        (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"),
      agentId: form.agentId,
      folderId,
      prompt: form.prompt,
      task,
      missedRunGraceMinutes: schedule?.missedRunGraceMinutes ?? 720,
      ...patch,
    }
    try {
      await saveAutomation(schedule?.id ?? null, draft)
      setEditing(false)
      await load()
    } catch (error) {
      toast.error(errorText(error))
    }
  }

  const toggle = (enabled: boolean) => {
    if (!schedule) return
    void saveAutomation(schedule.id, {
      name: schedule.name,
      enabled,
      cron: schedule.cron,
      timezone: schedule.timezone,
      agentId: schedule.agentId,
      folderId,
      prompt: schedule.prompt,
      task,
      missedRunGraceMinutes: schedule.missedRunGraceMinutes,
    })
      .then(load)
      .catch((error) => toast.error(errorText(error)))
  }

  const act = (action: () => Promise<unknown>) =>
    void action()
      .then(load)
      .catch((error) => toast.error(errorText(error)))

  const openRun = (run: AutomationRun) =>
    run.terminalId &&
    act(async () =>
      openTerminalTab(
        tabFromDescriptor(await getTerminalSession(run.terminalId!)),
        true
      )
    )

  const runLabel = (run: AutomationRun) =>
    run.stopReason === "needs_attention" || run.stopReason === "timeout"
      ? t(`runStatus.${run.stopReason === "timeout" ? "timeout" : "attention"}`)
      : run.stopReason === "result_submitted"
        ? t("runStatus.submitted")
        : t(`runStatus.${run.status}`)

  const agentName = (id: string) =>
    agents.find((agent) => agent.id === id)?.name ?? id

  return (
    <section className="shrink-0 border-b border-border/60 px-6 py-2 text-xs">
      {schedule ? (
        <div className="flex items-center gap-2">
          <AlarmClock
            aria-hidden="true"
            className="size-3.5 shrink-0 text-muted-foreground"
          />
          <span className="min-w-0 truncate">
            {agentName(schedule.agentId)} · {schedule.cron} ·{" "}
            <span className="text-muted-foreground">
              {t("nextRun")}{" "}
              {schedule.nextRunAt
                ? new Date(schedule.nextRunAt).toLocaleString()
                : t("disabled")}
            </span>
          </span>
          <span className="flex-1" />
          <Switch
            aria-label={t("enabled")}
            checked={schedule.enabled}
            onCheckedChange={toggle}
          />
          <IconAction
            icon={Play}
            label={t("runNow")}
            onClick={() => act(() => runAutomation(schedule.id))}
          />
          <IconAction icon={Pencil} label={t("edit")} onClick={openEditor} />
          <IconAction
            icon={Trash2}
            label={t("delete")}
            onClick={() => act(() => deleteAutomation(schedule.id))}
          />
        </div>
      ) : (
        <button
          type="button"
          className="flex items-center gap-1.5 text-muted-foreground hover:text-foreground"
          onClick={openEditor}
        >
          <AlarmClock aria-hidden="true" className="size-3.5" />
          {t("new")}
        </button>
      )}
      {runs.length > 0 ? (
        <ul className="mt-1.5 space-y-0.5">
          {runs.map((run) => {
            const reviewed = run.reviewedAt != null
            return (
              <li
                key={run.id}
                data-testid={`run-row-${run.id}`}
                className="flex items-center gap-2"
              >
                <span
                  className={cn(
                    "min-w-0 truncate",
                    reviewed && "text-muted-foreground"
                  )}
                  title={run.error ?? undefined}
                >
                  {new Date(run.createdAt).toLocaleString()} · {runLabel(run)}
                </span>
                <span className="flex-1" />
                <IconAction
                  icon={FileText}
                  label={t("openResult")}
                  disabled={!run.resultPath}
                  onClick={() =>
                    run.resultPath &&
                    void workspace.openFilePreview(run.resultPath)
                  }
                />
                <IconAction
                  icon={SquareTerminal}
                  label={t("open")}
                  disabled={!run.terminalId}
                  onClick={() => openRun(run)}
                />
                <IconAction
                  icon={reviewed ? CheckCircle2 : Circle}
                  label={reviewed ? t("markUnreviewed") : t("markReviewed")}
                  onClick={() =>
                    act(() =>
                      checkAutomationRun(run.id, !reviewed, run.resultPath)
                    )
                  }
                />
              </li>
            )
          })}
        </ul>
      ) : null}
      <Dialog open={editing} onOpenChange={setEditing}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>{schedule ? t("edit") : t("new")}</DialogTitle>
          </DialogHeader>
          <div className="grid gap-3 text-sm">
            <p className="text-xs text-muted-foreground">{t("hint")}</p>
            <select
              aria-label={t("agent")}
              className="h-9 rounded-md border bg-background px-3"
              value={form.agentId}
              onChange={(e) => setForm({ ...form, agentId: e.target.value })}
            >
              {!agents.some((agent) => agent.id === form.agentId) && (
                <option value={form.agentId}>{form.agentId}</option>
              )}
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
            <div className="grid grid-cols-2 gap-3">
              <select
                aria-label={t("preset")}
                className="h-9 rounded-md border bg-background px-3"
                value={form.frequency}
                onChange={(e) =>
                  setForm({ ...form, frequency: e.target.value as Frequency })
                }
              >
                <option value="daily">{t("daily")}</option>
                <option value="weekdays">{t("weekdays")}</option>
                <option value="weekly">{t("weekly")}</option>
                <option value="custom">{t("custom")}</option>
              </select>
              {form.frequency === "custom" ? (
                <Input
                  aria-label={t("cron")}
                  placeholder="0 8 * * *"
                  value={form.cron}
                  onChange={(e) => setForm({ ...form, cron: e.target.value })}
                />
              ) : (
                <Input
                  aria-label={t("time")}
                  type="time"
                  value={form.time}
                  onChange={(e) => setForm({ ...form, time: e.target.value })}
                />
              )}
            </div>
            <Textarea
              aria-label={t("prompt")}
              placeholder={t("prompt")}
              value={form.prompt}
              onChange={(e) => setForm({ ...form, prompt: e.target.value })}
            />
          </div>
          <DialogFooter>
            <Button
              onClick={() => void save()}
              disabled={
                !form.agentId || !cronOf(form.frequency, form.time, form.cron)
              }
            >
              {t("save")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </section>
  )
}
