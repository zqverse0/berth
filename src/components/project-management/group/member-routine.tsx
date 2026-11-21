"use client"

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
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
import { cronOf, parseCron, type Frequency } from "@/lib/automation-cron"

const RECENT_RUNS = 5

function errorText(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 例行发群（成员行菜单「定时发给它」）：到点往空间群发一条给该成员的消息，结局按它这一轮推出；
 * 成员正忙跳过，失败自动重试一次。一个成员一条，复用 automation 表与调度器。
 */
export function MemberRoutineDialog({
  folderId,
  member,
  label,
  onClose,
}: {
  folderId: number
  member: string
  label: string
  onClose: () => void
}) {
  const t = useTranslations("BerthTasks.automations")
  const tr = useTranslations("BerthTasks.group.routine")
  const [routine, setRoutine] = useState<Automation | null>(null)
  const [runs, setRuns] = useState<AutomationRun[]>([])
  const [form, setForm] = useState({
    frequency: "daily" as Frequency,
    time: "09:00",
    cron: "",
    prompt: "",
  })

  const load = useCallback(
    async (fill = false) => {
      try {
        const found =
          (await listAutomations(folderId)).find(
            (item) => item.member === member
          ) ?? null
        setRoutine(found)
        setRuns(
          found
            ? (await listAutomationRuns(found.id)).slice(0, RECENT_RUNS)
            : []
        )
        if (fill && found) {
          const parsed = parseCron(found.cron)
          setForm({
            frequency: parsed.frequency,
            time: parsed.time,
            cron: found.cron,
            prompt: found.prompt,
          })
        }
      } catch (error) {
        toast.error(errorText(error))
      }
    },
    [folderId, member]
  )

  useEffect(() => {
    let unsubscribe: (() => void) | undefined
    let disposed = false
    const timeout = window.setTimeout(() => void load(true), 0)
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

  const draft = (patch?: Partial<AutomationDraft>): AutomationDraft => ({
    name: tr("name", { name: label }),
    enabled: routine?.enabled ?? true,
    cron: cronOf(form.frequency, form.time, form.cron),
    timezone:
      routine?.timezone ??
      (Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"),
    agentId: "",
    folderId,
    prompt: form.prompt,
    task: null,
    member,
    missedRunGraceMinutes: routine?.missedRunGraceMinutes ?? 60,
    ...patch,
  })

  const act = (action: () => Promise<unknown>) =>
    void action()
      .then(() => load())
      .catch((error) => toast.error(errorText(error)))

  const runLabel = (run: AutomationRun) =>
    run.stopReason === "answered"
      ? t("runStatus.answered")
      : run.stopReason === "timeout"
        ? tr("timeout")
        : t(`runStatus.${run.status}`)

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-w-lg" data-member-routine={member}>
        <DialogHeader>
          <DialogTitle>{tr("title", { name: label })}</DialogTitle>
        </DialogHeader>
        <div className="grid gap-3 text-sm">
          <p className="text-xs text-muted-foreground">{tr("hint")}</p>
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
                placeholder="0 9 * * *"
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
            aria-label={tr("text")}
            placeholder={tr("text")}
            value={form.prompt}
            onChange={(e) => setForm({ ...form, prompt: e.target.value })}
          />
          {routine ? (
            <div className="flex items-center gap-2 text-xs">
              <Switch
                aria-label={t("enabled")}
                checked={routine.enabled}
                onCheckedChange={(enabled) =>
                  act(() => saveAutomation(routine.id, draft({ enabled })))
                }
              />
              <span className="min-w-0 flex-1 truncate text-muted-foreground">
                {t("nextRun")}{" "}
                {routine.nextRunAt
                  ? new Date(routine.nextRunAt).toLocaleString()
                  : t("disabled")}
                {routine.failures
                  ? ` · ${tr("failures", { count: routine.failures })}`
                  : ""}
              </span>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => act(() => runAutomation(routine.id))}
              >
                {t("runNow")}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                className="text-destructive"
                onClick={() =>
                  act(async () => {
                    await deleteAutomation(routine.id)
                    onClose()
                  })
                }
              >
                {t("delete")}
              </Button>
            </div>
          ) : null}
          {runs.length > 0 ? (
            <ul className="space-y-0.5 text-xs" aria-label={t("history")}>
              {runs.map((run) => (
                <li
                  key={run.id}
                  data-routine-run={run.id}
                  className="truncate"
                  title={run.summary ?? run.error ?? undefined}
                >
                  {new Date(run.createdAt).toLocaleString()} · {runLabel(run)}
                  {run.trigger === "retry" ? ` · ${tr("retry")}` : ""}
                  {run.error ? (
                    <span className="text-muted-foreground">
                      {" "}
                      · {run.error}
                    </span>
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
        <DialogFooter>
          <Button
            data-routine-save
            disabled={
              !form.prompt.trim() ||
              !cronOf(form.frequency, form.time, form.cron)
            }
            onClick={() =>
              act(() => saveAutomation(routine?.id ?? null, draft()))
            }
          >
            {t("save")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
