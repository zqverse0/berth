"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { Check, Circle, CircleDot, Pencil, Plus, Trash2 } from "lucide-react"
import { toast } from "@/lib/notify"
import { Button } from "@/components/ui/button"
import { Textarea } from "@/components/ui/textarea"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import {
  type BerthTaskPlanStep,
  type BerthTaskView,
  saveTask,
} from "@/lib/agent/berth-tasks"
import { cn } from "@/lib/utils"

/** 视图里的步骤 → frontmatter 的一步；只保留文件里记过的提交（`checked`）。 */
function planOf(view: BerthTaskView): BerthTaskPlanStep[] {
  return view.steps.map((step, index) => ({
    id: step.id ?? `S${index + 1}`,
    do: step.text,
    change: step.change ?? "",
    verify: step.verify ?? "",
    ...(step.checked && step.commit ? { commit: step.commit.hash } : {}),
  }))
}

function nextId(steps: BerthTaskPlanStep[]): string {
  const max = Math.max(0, ...steps.map((step) => Number(step.id.slice(1)) || 0))
  return `S${max + 1}`
}

/**
 * 任务页右栏：步骤是任务进度的唯一展示处。每步「做什么」，展开看改哪里、怎么验证、提交；
 * 单文件任务可随时编辑（写回 frontmatter 的 `steps`），旧任务只读。
 */
export function TaskSteps({
  folderId,
  view,
  editable,
  onSaved,
}: {
  folderId: number
  view: BerthTaskView
  editable: boolean
  onSaved: () => unknown
}) {
  const t = useTranslations("BerthTasks.group")
  const workspace = useWorkspaceRuntimeActions()
  const [draft, setDraft] = useState<BerthTaskPlanStep[] | null>(null)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState<string | null>(null)

  const save = async () => {
    if (!draft) return
    setSaving(true)
    try {
      const response = await saveTask(folderId, view.taskDirName, {
        steps: draft.filter((step) => step.do.trim()),
      })
      if (!response.ok) {
        toast.error(response.error.message)
        return
      }
      setDraft(null)
      await onSaved()
    } catch (cause) {
      toast.error(String(cause))
    } finally {
      setSaving(false)
    }
  }

  if (draft) {
    const update = (index: number, patch: Partial<BerthTaskPlanStep>) =>
      setDraft(
        draft.map((step, at) => (at === index ? { ...step, ...patch } : step))
      )
    const field = (index: number, key: "do" | "change" | "verify") => (
      <Textarea
        value={draft[index][key]}
        placeholder={t(`steps.${key}`)}
        aria-label={`${draft[index].id} ${t(`steps.${key}`)}`}
        className={cn(
          "min-h-0 resize-y px-2 py-1 text-xs",
          key === "verify" && "font-mono"
        )}
        rows={key === "do" ? 2 : 1}
        onChange={(event) => update(index, { [key]: event.target.value })}
      />
    )
    return (
      <section className="space-y-2 py-1">
        <ol className="space-y-3">
          {draft.map((step, index) => (
            <li key={step.id} className="space-y-1">
              <div className="flex items-center gap-1 text-xs font-medium">
                <span className="min-w-0 flex-1 font-mono">{step.id}</span>
                {step.commit ? (
                  <span className="font-mono text-[10px] text-muted-foreground">
                    {step.commit.slice(0, 7)}
                  </span>
                ) : null}
                <button
                  type="button"
                  className="rounded p-0.5 text-muted-foreground hover:bg-accent hover:text-destructive"
                  aria-label={`${t("steps.remove")} ${step.id}`}
                  onClick={() =>
                    setDraft(draft.filter((_, at) => at !== index))
                  }
                >
                  <Trash2 aria-hidden="true" className="size-3.5" />
                </button>
              </div>
              {field(index, "do")}
              {field(index, "change")}
              {field(index, "verify")}
            </li>
          ))}
        </ol>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 w-full gap-1.5 text-xs"
          onClick={() =>
            setDraft([
              ...draft,
              { id: nextId(draft), do: "", change: "", verify: "" },
            ])
          }
        >
          <Plus aria-hidden="true" className="size-3.5" />
          {t("steps.add")}
        </Button>
        <div className="flex justify-end gap-1.5">
          <Button
            size="sm"
            variant="ghost"
            className="h-7 text-xs"
            onClick={() => setDraft(null)}
          >
            {t("steps.cancel")}
          </Button>
          <Button
            size="sm"
            className="h-7 text-xs"
            disabled={saving}
            onClick={() => void save()}
          >
            {t("steps.save")}
          </Button>
        </div>
      </section>
    )
  }

  return (
    <section className="space-y-0.5 py-0.5">
      <ol className="space-y-px">
        {view.steps.map((step) => {
          // 文件里记了提交（`berth task step`）但提交不在当前分支上，也算已提交。
          const shown =
            step.state === "todo" && step.checked ? "committed" : step.state
          const Icon =
            shown === "merged"
              ? Check
              : shown === "committed"
                ? CircleDot
                : Circle
          const hash = step.commit?.hash
          const current = step.id != null && step.id === view.currentStep
          const key = step.id ?? step.text
          const expanded = open === key || (open === null && current)
          const detail = step.change || step.verify
          return (
            <li
              key={key}
              data-step-state={shown}
              data-current={current || undefined}
              title={t(`steps.${shown}`)}
              className={cn(
                "rounded px-1 py-0.5 text-xs",
                current && "bg-accent"
              )}
            >
              <div className="flex gap-2">
                <Icon
                  aria-hidden="true"
                  className={cn(
                    "mt-0.5 size-3.5 shrink-0",
                    shown === "merged"
                      ? "text-chart-4"
                      : shown === "committed"
                        ? "text-primary"
                        : "text-muted-foreground/60"
                  )}
                />
                <button
                  type="button"
                  disabled={!detail}
                  aria-expanded={detail ? expanded : undefined}
                  className={cn(
                    "min-w-0 flex-1 text-left leading-snug",
                    shown === "todo" && !current
                      ? "text-muted-foreground"
                      : "text-foreground",
                    current && "font-medium"
                  )}
                  onClick={() => setOpen(expanded ? "" : key)}
                >
                  {/* 旧任务的步骤文本自带 `S<n>` 前缀 */}
                  {step.id && !step.text.startsWith(step.id) ? (
                    <span className="mr-1 font-mono">{step.id}</span>
                  ) : null}
                  {step.text}
                </button>
                {hash ? (
                  <button
                    type="button"
                    className="h-fit shrink-0 font-mono text-[10px] text-muted-foreground hover:text-foreground hover:underline"
                    title={step.commit?.subject || hash}
                    onClick={() =>
                      void workspace.openCommitDiff(
                        hash,
                        undefined,
                        step.commit?.subject
                      )
                    }
                  >
                    {hash.slice(0, 7)}
                  </button>
                ) : null}
              </div>
              {expanded && detail ? (
                <dl className="mt-1 space-y-1 pl-5.5 text-[11px] text-muted-foreground">
                  {step.change ? (
                    <div>
                      <dt className="inline font-medium">
                        {t("steps.change")}：
                      </dt>
                      <dd className="inline break-words">{step.change}</dd>
                    </div>
                  ) : null}
                  {step.verify ? (
                    <div>
                      <dt className="inline font-medium">
                        {t("steps.verify")}：
                      </dt>
                      <dd className="inline break-all font-mono">
                        {step.verify}
                      </dd>
                    </div>
                  ) : null}
                </dl>
              ) : null}
            </li>
          )
        })}
      </ol>
      {editable ? (
        <button
          type="button"
          className="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-[11px] text-muted-foreground hover:bg-accent/60 hover:text-foreground"
          onClick={() =>
            setDraft(
              view.steps.length
                ? planOf(view)
                : [{ id: "S1", do: "", change: "", verify: "" }]
            )
          }
        >
          {view.steps.length ? (
            <Pencil aria-hidden="true" className="size-3" />
          ) : (
            <Plus aria-hidden="true" className="size-3" />
          )}
          {view.steps.length ? t("steps.edit") : t("steps.add")}
        </button>
      ) : null}
    </section>
  )
}
