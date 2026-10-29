"use client"

import { useState } from "react"
import { useTranslations } from "next-intl"
import { ChevronDown, Plus, Scale, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  formatTokens,
  MODEL_APIS,
  parseTokens,
  type ModelApi,
  type ProviderModel,
} from "@/lib/model-provider"
import { cn } from "@/lib/utils"

/** 接口名是协议名，不翻译。 */
export const API_LABELS: Record<ModelApi, string> = {
  "openai-chat": "Chat",
  "openai-responses": "Responses",
  anthropic: "Anthropic",
  gemini: "Gemini",
}

/** 模型多于这个数时显示筛选框。 */
const FILTER_THRESHOLD = 8

/** 服务商档案的模型才有的逐模型设置。 */
export interface ModelDetailOptions {
  /** 各 Agent tool.json providerInjection.slots 声明的档位（并集）；空 = 不显示档位。 */
  slotOptions: string[]
  /** 档案默认接口：模型没单独设置时用它。 */
  defaultApis?: ModelApi[]
}

/**
 * 模型列表逐行编辑：每行一个模型 ID。给了 `details`（服务商档案）时，行尾摘要显示该模型的
 * 接口与上下文设置，点开可改接口、上下文长度、最长输出与档位；都不填就沿用档案默认 / Agent 默认。
 */
export function ModelMappingEditor({
  value,
  onChange,
  details,
  onDecide,
}: {
  value: ProviderModel[]
  onChange: (next: ProviderModel[]) => void
  details?: ModelDetailOptions
  /** 服务商声明了决策端点时给出：模型行出现「决策」入口。 */
  onDecide?: (model: ProviderModel) => void
}) {
  const t = useTranslations("ModelProviderSettings")
  const [filter, setFilter] = useState("")
  const [open, setOpen] = useState<number | null>(null)

  const update = (index: number, patch: Partial<ProviderModel>) => {
    onChange(
      value.map((item, i) => (i === index ? { ...item, ...patch } : item))
    )
  }

  const query = filter.trim().toLowerCase()
  const rows = value
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !query || item.id.toLowerCase().includes(query))

  return (
    <div className="space-y-1.5">
      {value.length > FILTER_THRESHOLD ? (
        <Input
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          placeholder={t("modelFilter")}
          aria-label={t("modelFilter")}
          className="h-7 text-xs"
        />
      ) : null}
      {rows.map(({ item, index }) => (
        <div key={index} className="space-y-1">
          <div className="flex items-center gap-1.5">
            <Input
              value={item.id}
              onChange={(event) => {
                const id = event.target.value
                update(index, { id, name: id })
              }}
              placeholder={t("modelId")}
              aria-label={t("modelId")}
              className="h-8 min-w-0 flex-1 font-mono text-xs"
            />
            {details ? (
              <button
                type="button"
                aria-expanded={open === index}
                aria-label={t("modelDetails", { model: item.id || "?" })}
                onClick={() => setOpen(open === index ? null : index)}
                className="flex h-8 max-w-[45%] shrink-0 items-center gap-1 rounded-md border px-2 text-[11px] text-muted-foreground hover:text-foreground"
              >
                <span className="truncate">
                  {modelSummary(item, details, {
                    default: t("modelApisDefault"),
                    unset: t("modelApisAuto"),
                  })}
                </span>
                <ChevronDown
                  className={cn(
                    "h-3 w-3 shrink-0 transition-transform",
                    open === index && "rotate-180"
                  )}
                  aria-hidden
                />
              </button>
            ) : null}
            {onDecide ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-8 w-6 shrink-0"
                aria-label={t("decision.open", { model: item.id })}
                title={t("decision.open", { model: item.id })}
                disabled={!item.id.trim()}
                onClick={() => onDecide(item)}
              >
                <Scale className="h-3.5 w-3.5" aria-hidden />
              </Button>
            ) : null}
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-8 w-6 shrink-0"
              aria-label={t("removeModel")}
              onClick={() => {
                setOpen(null)
                onChange(value.filter((_, i) => i !== index))
              }}
            >
              <X className="h-3.5 w-3.5" aria-hidden />
            </Button>
          </div>
          {details && open === index ? (
            <ModelDetails
              item={item}
              details={details}
              onChange={(patch) => update(index, patch)}
            />
          ) : null}
        </div>
      ))}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className="h-7 w-full text-xs"
        onClick={() => {
          setFilter("")
          onChange([...value, { name: "", id: "" }])
        }}
      >
        <Plus className="mr-1 h-3 w-3" aria-hidden />
        {t("addModel")}
      </Button>
    </div>
  )
}

/** 行尾摘要：接口（未设 = 档案默认 / 自动）+ 已设的上下文 / 输出。 */
function modelSummary(
  item: ProviderModel,
  details: ModelDetailOptions,
  labels: { default: string; unset: string }
): string {
  const apis = item.apis?.length
    ? item.apis.map((api) => API_LABELS[api]).join("/")
    : details.defaultApis?.length
      ? labels.default
      : labels.unset
  const limits = [item.contextWindow, item.maxOutput]
    .map((value) => formatTokens(value))
    .filter(Boolean)
  return [apis, ...limits, item.slot].filter(Boolean).join(" · ")
}

function ModelDetails({
  item,
  details,
  onChange,
}: {
  item: ProviderModel
  details: ModelDetailOptions
  onChange: (patch: Partial<ProviderModel>) => void
}) {
  const t = useTranslations("ModelProviderSettings")
  return (
    <div className="space-y-2 rounded-md border bg-muted/20 p-2">
      <div className="space-y-1">
        <span className="text-[11px] font-medium text-muted-foreground">
          {t("modelApis")}
        </span>
        <ApiToggles
          value={item.apis}
          label={(api) =>
            t("modelApiToggle", { model: item.id || "?", api: API_LABELS[api] })
          }
          onChange={(apis) => onChange({ apis })}
        />
        <p className="text-[10px] text-muted-foreground">
          {item.apis?.length
            ? null
            : details.defaultApis?.length
              ? t("modelApisFollowDefault", {
                  apis: details.defaultApis
                    .map((api) => API_LABELS[api])
                    .join(" / "),
                })
              : t("modelApisAutoHint")}
        </p>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <TokenInput
          label={t("contextWindow")}
          value={item.contextWindow}
          onChange={(contextWindow) => onChange({ contextWindow })}
        />
        <TokenInput
          label={t("maxOutput")}
          value={item.maxOutput}
          onChange={(maxOutput) => onChange({ maxOutput })}
        />
      </div>
      <p className="text-[10px] text-muted-foreground">{t("tokenHint")}</p>
      {details.slotOptions.length > 0 ? (
        <label className="flex items-center gap-2 text-[11px] text-muted-foreground">
          {t("modelSlot")}
          <Select
            value={item.slot || "__none__"}
            onValueChange={(next) =>
              onChange({ slot: next === "__none__" ? undefined : next })
            }
          >
            <SelectTrigger className="h-7 w-32 font-mono text-xs">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="__none__">{t("modelSlotNone")}</SelectItem>
              {details.slotOptions.map((slot) => (
                <SelectItem key={slot} value={slot}>
                  {slot}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </label>
      ) : null}
    </div>
  )
}

/** 接口多选（按规范顺序）；全不选 = `undefined`。档案默认接口与单个模型共用。 */
export function ApiToggles({
  value,
  label,
  onChange,
}: {
  value?: ModelApi[]
  label: (api: ModelApi) => string
  onChange: (next: ModelApi[] | undefined) => void
}) {
  const current = value ?? []
  return (
    <div className="flex flex-wrap items-center gap-1" role="group">
      {MODEL_APIS.map((api) => {
        const on = current.includes(api)
        return (
          <button
            key={api}
            type="button"
            aria-pressed={on}
            aria-label={label(api)}
            onClick={() => {
              const next = MODEL_APIS.filter((item) =>
                item === api ? !on : current.includes(item)
              )
              onChange(next.length > 0 ? next : undefined)
            }}
            className={cn(
              "rounded border px-1.5 py-px text-[10px] leading-4",
              on
                ? "border-primary/50 bg-primary/10 text-foreground"
                : "border-border text-muted-foreground hover:text-foreground"
            )}
          >
            {API_LABELS[api]}
          </button>
        )
      })}
    </div>
  )
}

/** token 数输入：接受 `200k` / `1m`，失焦时规范显示；清空 = 用 Agent 默认值。 */
function TokenInput({
  label,
  value,
  onChange,
}: {
  label: string
  value?: number
  onChange: (next: number | undefined) => void
}) {
  const t = useTranslations("ModelProviderSettings")
  const [text, setText] = useState(formatTokens(value))
  const invalid = text.trim() !== "" && parseTokens(text) === undefined
  return (
    <label className="space-y-0.5 text-[11px] text-muted-foreground">
      {label}
      <Input
        value={text}
        onChange={(event) => {
          setText(event.target.value)
          const parsed = parseTokens(event.target.value)
          if (parsed !== undefined || !event.target.value.trim()) {
            onChange(parsed)
          }
        }}
        onBlur={() => !invalid && setText(formatTokens(value))}
        placeholder={t("tokenDefault")}
        aria-invalid={invalid}
        className={cn("h-7 font-mono text-xs", invalid && "border-destructive")}
      />
    </label>
  )
}
