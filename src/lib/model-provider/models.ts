import type { ModelProviderInfo } from "@/lib/types"

/**
 * 模型接口(后端 `provider_injection::MODEL_APIS`):同一个 OpenAI 兼容地址背后
 * 有 Chat Completions 与 Responses 两种,模型可能只开通其中一种,所以按模型记录。
 */
export const MODEL_APIS = [
  "openai-chat",
  "openai-responses",
  "anthropic",
  "gemini",
] as const
export type ModelApi = (typeof MODEL_APIS)[number]

/** 一个模型条目:显示名称(角色/别名)+ 实际请求的模型 ID。 */
export interface ProviderModel {
  name: string
  id: string
  /** 可选 slot 标签(tool.json providerInjection.slots 声明的档位)。 */
  slot?: string
  /** 该模型支持的接口;缺省 = 用档案默认接口,也没有则按 Agent 首选接口自动选。 */
  apis?: ModelApi[]
  /** 上下文长度(token);缺省 = 交给 Agent 自己的默认值。 */
  contextWindow?: number
  /** 单次最长输出(token);缺省 = 交给 Agent 自己的默认值。 */
  maxOutput?: number
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined
}

/** 档案里的一个模型条目(裸 ID 字符串或对象)→ 模型;没有 ID 为 null。 */
export function parseModelEntry(item: unknown): ProviderModel | null {
  if (typeof item === "string") {
    const id = item.trim()
    return id ? { name: id, id } : null
  }
  if (!item || typeof item !== "object") return null
  const record = item as Record<string, unknown>
  const id = typeof record.id === "string" ? record.id.trim() : ""
  if (!id) return null
  const name = typeof record.name === "string" ? record.name.trim() : ""
  const slot = typeof record.slot === "string" ? record.slot.trim() : ""
  const apis = modelApis(record.apis)
  const contextWindow = positiveInt(record.contextWindow)
  const maxOutput = positiveInt(record.maxOutput)
  return {
    name: name || id,
    id,
    ...(slot ? { slot } : {}),
    ...(apis ? { apis } : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxOutput ? { maxOutput } : {}),
  }
}

/** token 数输入:`200000`、`200k`、`1m`(不分大小写);空或无法识别为 undefined。 */
export function parseTokens(text: string): number | undefined {
  const match = /^(\d+(?:\.\d+)?)\s*([km]?)$/i.exec(text.trim())
  if (!match) return undefined
  const unit = { "": 1, k: 1_000, m: 1_000_000 }[match[2].toLowerCase()] ?? 1
  return positiveInt(Math.round(Number(match[1]) * unit))
}

/** token 数 → 输入框文本(整千写成 `k`,整百万写成 `m`)。 */
export function formatTokens(value: number | undefined): string {
  if (!value) return ""
  if (value % 1_000_000 === 0) return `${value / 1_000_000}m`
  if (value % 1_000 === 0) return `${value / 1_000}k`
  return String(value)
}

/** 只留认识的接口名,去重;空数组视为未设置。 */
export function modelApis(value: unknown): ModelApi[] | undefined {
  if (!Array.isArray(value)) return undefined
  const apis = MODEL_APIS.filter((api) => value.includes(api))
  return apis.length > 0 ? apis : undefined
}

/**
 * Agent 能不能用这个模型(`apis` 为 Agent 的 providerInjection.apis)。
 * 未设置接口的模型照常可用(启动时按 Agent 第一偏好),Agent 未声明则不筛。
 */
export function modelUsableBy(
  model: ProviderModel,
  apis: readonly string[] | null | undefined
): boolean {
  if (!apis?.length || !model.apis?.length) return true
  return model.apis.some((api) => apis.includes(api))
}

/** 档案默认接口(`discovery_json.defaultApis`,后端同名字段):模型没单独设置时用它。 */
export function providerDefaultApis(
  provider?: Pick<ModelProviderInfo, "discovery_json"> | null
): ModelApi[] | undefined {
  if (!provider?.discovery_json) return undefined
  try {
    return modelApis(JSON.parse(provider.discovery_json)?.defaultApis)
  } catch {
    return undefined
  }
}

/** 官方登录档案:启动时不注入 url/key。 */
export function isOfficialProvider(
  provider: Pick<ModelProviderInfo, "kind">
): boolean {
  return provider.kind === "official"
}

/**
 * 档案 model 字段解析为模型条目并按 ID 去重。支持三种形态:
 * 对象数组(当前格式 `[{"name","id"}]`)、字符串数组(裸 ID,显示名=ID)、
 * 角色对象(cc-switch 旧数据 `{"main":"x"}`,键首字母大写作显示名)。
 */
export function archivedModels(provider: ModelProviderInfo): ProviderModel[] {
  const raw = provider.model?.trim()
  let items: ProviderModel[] = []
  try {
    const parsed = raw ? JSON.parse(raw) : null
    if (Array.isArray(parsed)) {
      items = parsed.flatMap((item) => parseModelEntry(item) ?? [])
    } else if (typeof parsed === "string" && parsed.trim() !== "") {
      items = [{ name: parsed.trim(), id: parsed.trim() }]
    } else if (parsed && typeof parsed === "object") {
      items = Object.entries(parsed as Record<string, unknown>)
        .filter(
          ([, value]) =>
            typeof value === "string" && (value as string).trim() !== ""
        )
        .map(([key, value]) => ({
          name: key.charAt(0).toUpperCase() + key.slice(1),
          id: (value as string).trim(),
        }))
    }
  } catch {
    items = raw ? [{ name: raw, id: raw }] : []
  }
  const seen = new Set<string>()
  return items.filter((item) => {
    if (seen.has(item.id)) return false
    seen.add(item.id)
    return true
  })
}

/** 重新获取模型列表：上游给的接口优先，其余已有设置（手动接口、上下文、档位）保留。 */
export function mergeFetchedModels(
  previous: ProviderModel[],
  fetched: { id: string; apis?: string[] }[]
): ProviderModel[] {
  const known = new Map(previous.map((model) => [model.id.trim(), model]))
  return fetched.map((model) => {
    const apis = modelApis(model.apis)
    const previousModel: ProviderModel = known.get(model.id) ?? {
      name: model.id,
      id: model.id,
    }
    const { apis: keptApis, ...kept } = previousModel
    const merged = apis ?? keptApis
    return { ...kept, ...(merged ? { apis: merged } : {}) }
  })
}
