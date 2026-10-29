"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { Loader2, Play, Plus, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  evaluateDecision,
  getDecisionSettings,
  saveDecisionSettings,
  type DecisionSettings,
  type DecisionAnswer,
  type DecisionQuestion,
  type DecisionResult,
} from "@/lib/model-provider"
import { cn } from "@/lib/utils"

type QuestionType = DecisionQuestion["type"]

/** 表单里的一行条件：choice 用 key（选项名）+ text；score 只用 text；noul 固定 true / false 两行。 */
interface CriterionRow {
  key: string
  text: string
}

interface QuestionDraft {
  id: number
  name: string
  type: QuestionType
  instructions: string
  rows: CriterionRow[]
}

const SCORE_LEVELS = { min: 2, max: 10 }

function defaultRows(type: QuestionType): CriterionRow[] {
  if (type === "noul") {
    return [
      { key: "true", text: "" },
      { key: "false", text: "" },
    ]
  }
  return [
    { key: "", text: "" },
    { key: "", text: "" },
  ]
}

function newQuestion(id: number, type: QuestionType = "choice"): QuestionDraft {
  return { id, name: "", type, instructions: "", rows: defaultRows(type) }
}

/** 表单 → 请求体；不完整返回 null（运行按钮随之禁用）。 */
function toRequest(
  drafts: QuestionDraft[]
): Record<string, DecisionQuestion> | null {
  const out: Record<string, DecisionQuestion> = {}
  for (const draft of drafts) {
    const name = draft.name.trim()
    const instructions = draft.instructions.trim()
    if (!name || !instructions || name in out) return null
    const texts = draft.rows.map((row) => row.text.trim())
    if (draft.type === "choice") {
      const keys = draft.rows.map((row) => row.key.trim())
      if (keys.length < 2 || keys.some((key) => !key)) return null
      if (new Set(keys).size !== keys.length) return null
      out[name] = {
        type: "choice",
        instructions,
        criteria: Object.fromEntries(keys.map((key, i) => [key, texts[i]])),
      }
    } else if (draft.type === "score") {
      if (texts.some((text) => !text)) return null
      if (texts.length < SCORE_LEVELS.min || texts.length > SCORE_LEVELS.max)
        return null
      out[name] = { type: "score", instructions, criteria: texts }
    } else {
      if (texts.some((text) => !text)) return null
      out[name] = {
        type: "noul",
        instructions,
        criteria: { true: texts[0], false: texts[1] },
      }
    }
  }
  return Object.keys(out).length > 0 ? out : null
}

/** 粘贴的是 JSON 对象 / 数组就按结构发送，其余按文本。 */
function parseState(raw: string): unknown {
  const text = raw.trim()
  if (text.startsWith("{") || text.startsWith("[")) {
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
  return text
}

const percent = (value: number) => `${Math.round(value * 100)}%`

function ProbabilityBar({
  label,
  value,
  highlight,
}: {
  label: string
  value: number
  highlight?: boolean
}) {
  return (
    <div className="grid grid-cols-[minmax(0,8rem)_1fr_3rem] items-center gap-2 text-xs">
      <span
        className={cn("truncate", highlight && "font-semibold text-foreground")}
        title={label}
      >
        {label}
      </span>
      <div className="h-1.5 overflow-hidden rounded bg-muted">
        <div
          className={cn(
            "h-full rounded",
            highlight ? "bg-primary" : "bg-muted-foreground/40"
          )}
          style={{ width: percent(value) }}
        />
      </div>
      <span className="text-right font-mono tabular-nums">
        {percent(value)}
      </span>
    </div>
  )
}

function AnswerView({ answer }: { answer: DecisionAnswer }) {
  const t = useTranslations("ModelProviderSettings.decision")
  if (answer.type === "noul") {
    return <ProbabilityBar label={t("yes")} value={answer.noul} highlight />
  }
  if (answer.type === "choice") {
    return (
      <div className="space-y-1">
        {Object.entries(answer.probabilities)
          .sort(([, a], [, b]) => b - a)
          .map(([option, value]) => (
            <ProbabilityBar
              key={option}
              label={option}
              value={value}
              highlight={option === answer.choice}
            />
          ))}
        <p className="text-[11px] text-muted-foreground">
          {t("confidence", { value: percent(answer.confidence) })}
        </p>
      </div>
    )
  }
  const nearest = String(Math.round(answer.score))
  return (
    <div className="space-y-1">
      <p className="text-xs">
        {t("scoreValue", {
          score: answer.score.toFixed(2),
          level: answer.legend[nearest] ?? nearest,
        })}
      </p>
      {Object.entries(answer.legend).map(([index, level]) => (
        <ProbabilityBar
          key={index}
          label={level}
          value={answer.probabilities[index] ?? 0}
          highlight={index === nearest}
        />
      ))}
      <p className="text-[11px] text-muted-foreground">
        {t("confidence", { value: percent(answer.confidence) })}
      </p>
    </div>
  )
}

/** 决策面板：在服务商的模型行打开，填写内容与问题，交给该模型评估。 */
export function DecisionPanel({
  providerId,
  providerName,
  model,
  open,
  onOpenChange,
}: {
  providerId: number
  /** 档案名：「设为 Berth 决策模型」按名字记 */
  providerName: string
  model: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations("ModelProviderSettings.decision")
  const [state, setState] = useState("")
  const [questions, setQuestions] = useState<QuestionDraft[]>(() => [
    newQuestion(1),
  ])
  const [run, setRun] = useState<{
    busy: boolean
    result: DecisionResult | null
    error: string | null
  }>({ busy: false, result: null, error: null })

  /** Berth 全局决策模型；文件写错时为 null，不显示设置按钮。 */
  const [berthModel, setBerthModel] = useState<DecisionSettings | null>(null)
  useEffect(() => {
    if (!open) return
    getDecisionSettings()
      .then((response) => setBerthModel(response.settings))
      .catch(() => {})
  }, [open])
  const isBerthModel =
    berthModel?.provider === providerName && berthModel.model === model

  const request = toRequest(questions)
  const canRun = Boolean(state.trim()) && request !== null && !run.busy

  const updateQuestion = (id: number, patch: Partial<QuestionDraft>) =>
    setQuestions((prev) =>
      prev.map((q) => (q.id === id ? { ...q, ...patch } : q))
    )
  const updateRow = (id: number, index: number, patch: Partial<CriterionRow>) =>
    setQuestions((prev) =>
      prev.map((q) =>
        q.id === id
          ? {
              ...q,
              rows: q.rows.map((row, i) =>
                i === index ? { ...row, ...patch } : row
              ),
            }
          : q
      )
    )

  const handleRun = async () => {
    if (!request) return
    setRun({ busy: true, result: null, error: null })
    try {
      const result = await evaluateDecision({
        providerId,
        model,
        state: parseState(state),
        questions: request,
      })
      setRun({ busy: false, result, error: null })
    } catch (err: unknown) {
      setRun({
        busy: false,
        result: null,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("title", { model })}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
          {berthModel ? (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span>{t(isBerthModel ? "isBerthModel" : "berthModelHint")}</span>
              {isBerthModel ? null : (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() =>
                    void saveDecisionSettings({
                      provider: providerName,
                      model,
                    }).then(setBerthModel)
                  }
                >
                  {t("setBerthModel")}
                </Button>
              )}
            </div>
          ) : null}
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <label htmlFor="decision-state" className="text-xs font-medium">
              {t("state")}
            </label>
            <Textarea
              id="decision-state"
              value={state}
              onChange={(e) => setState(e.target.value)}
              placeholder={t("statePlaceholder")}
              className="min-h-24 text-xs"
            />
          </div>

          <div className="space-y-3">
            {questions.map((q, qIndex) => {
              const answer = run.result?.answers[q.name.trim()]
              return (
                <div
                  key={q.id}
                  className="space-y-2 rounded-lg border bg-muted/15 p-3"
                >
                  <div className="flex items-center gap-2">
                    <Input
                      value={q.name}
                      onChange={(e) =>
                        updateQuestion(q.id, { name: e.target.value })
                      }
                      placeholder={t("questionName")}
                      aria-label={t("questionName")}
                      className="h-7 w-40 font-mono text-xs"
                    />
                    <Select
                      value={q.type}
                      onValueChange={(type) =>
                        updateQuestion(q.id, {
                          type: type as QuestionType,
                          rows: defaultRows(type as QuestionType),
                        })
                      }
                    >
                      <SelectTrigger
                        className="h-7 w-32 text-xs"
                        aria-label={t("questionType")}
                      >
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value="choice">
                          {t("type.choice")}
                        </SelectItem>
                        <SelectItem value="score">{t("type.score")}</SelectItem>
                        <SelectItem value="noul">{t("type.noul")}</SelectItem>
                      </SelectContent>
                    </Select>
                    <span className="flex-1" />
                    {questions.length > 1 ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon"
                        className="h-7 w-7"
                        aria-label={t("removeQuestion", { index: qIndex + 1 })}
                        onClick={() =>
                          setQuestions((prev) =>
                            prev.filter((item) => item.id !== q.id)
                          )
                        }
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden />
                      </Button>
                    ) : null}
                  </div>

                  <Input
                    value={q.instructions}
                    onChange={(e) =>
                      updateQuestion(q.id, { instructions: e.target.value })
                    }
                    placeholder={t("instructions")}
                    aria-label={t("instructions")}
                    className="h-8 text-xs"
                  />

                  <div className="space-y-1.5">
                    {q.rows.map((row, index) => (
                      <div key={index} className="flex items-center gap-1.5">
                        {q.type === "choice" ? (
                          <Input
                            value={row.key}
                            onChange={(e) =>
                              updateRow(q.id, index, { key: e.target.value })
                            }
                            placeholder={t("option")}
                            aria-label={t("option")}
                            className="h-7 w-36 font-mono text-xs"
                          />
                        ) : (
                          <span className="w-16 shrink-0 text-[11px] text-muted-foreground">
                            {q.type === "noul"
                              ? t(index === 0 ? "yes" : "no")
                              : t("level", { index })}
                          </span>
                        )}
                        <Input
                          value={row.text}
                          onChange={(e) =>
                            updateRow(q.id, index, { text: e.target.value })
                          }
                          placeholder={t(
                            q.type === "score"
                              ? "levelPlaceholder"
                              : "whenPlaceholder"
                          )}
                          aria-label={t("criterion")}
                          className="h-7 flex-1 text-xs"
                        />
                        {q.type !== "noul" && q.rows.length > 2 ? (
                          <Button
                            type="button"
                            variant="ghost"
                            size="icon"
                            className="h-7 w-6 shrink-0"
                            aria-label={t("removeRow")}
                            onClick={() =>
                              updateQuestion(q.id, {
                                rows: q.rows.filter((_, i) => i !== index),
                              })
                            }
                          >
                            <X className="h-3.5 w-3.5" aria-hidden />
                          </Button>
                        ) : null}
                      </div>
                    ))}
                    {q.type !== "noul" &&
                    !(
                      q.type === "score" && q.rows.length >= SCORE_LEVELS.max
                    ) ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-6 px-2 text-[11px]"
                        onClick={() =>
                          updateQuestion(q.id, {
                            rows: [...q.rows, { key: "", text: "" }],
                          })
                        }
                      >
                        <Plus className="mr-1 h-3 w-3" aria-hidden />
                        {t(q.type === "score" ? "addLevel" : "addOption")}
                      </Button>
                    ) : null}
                  </div>

                  {answer ? (
                    <div className="border-t pt-2">
                      <AnswerView answer={answer} />
                    </div>
                  ) : null}
                </div>
              )
            })}
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 w-full gap-1 border-dashed text-xs"
              onClick={() =>
                setQuestions((prev) => [
                  ...prev,
                  newQuestion(Math.max(0, ...prev.map((q) => q.id)) + 1),
                ])
              }
            >
              <Plus className="h-3.5 w-3.5" aria-hidden />
              {t("addQuestion")}
            </Button>
          </div>

          {run.error ? (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
              {run.error}
            </div>
          ) : null}

          {run.result ? (
            <details className="text-[11px] text-muted-foreground">
              <summary className="cursor-pointer">
                {t("raw", { model: run.result.model ?? model })}
              </summary>
              <pre className="mt-1 max-h-60 overflow-auto rounded bg-muted p-2 font-mono">
                {JSON.stringify(run.result, null, 2)}
              </pre>
            </details>
          ) : null}

          <div className="flex items-center justify-end gap-2">
            {!request ? (
              <span className="text-[11px] text-muted-foreground">
                {t("incomplete")}
              </span>
            ) : null}
            <Button
              size="sm"
              disabled={!canRun}
              onClick={() => void handleRun()}
            >
              {run.busy ? (
                <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />
              ) : (
                <Play className="mr-1 h-3.5 w-3.5" />
              )}
              {t("run")}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}
