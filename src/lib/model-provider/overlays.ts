import type { ModelProviderInfo } from "@/lib/types"
import { archivedModels, parseModelEntry, type ProviderModel } from "./models"

/** 启动栏与设置页共用：档案上的模型列表。 */
export function providerCatalogModels(
  provider: ModelProviderInfo,
  agentType?: string
): ProviderModel[] {
  const fromFile = archivedModels(provider)
  if (fromFile.length > 0) return fromFile

  // 若指定了 agentType，仅查找对应的 overlay，严禁混入其他 Agent 的模型
  if (agentType && Array.isArray(provider.overlays)) {
    const target = agentType.trim().toLowerCase()
    const matched = provider.overlays.find(
      (row) => row.agent_type.trim().toLowerCase() === target
    )
    if (matched) {
      const parsed = archivedModels({ ...provider, model: matched.models })
      if (parsed.length > 0) return parsed
    }
  }
  if (provider.discovery_json) {
    try {
      const parsed = JSON.parse(provider.discovery_json)
      const groups = parsed?.keyGroups || parsed?.groupKeys
      if (Array.isArray(groups)) {
        const result: ProviderModel[] = []
        const seen = new Set<string>()
        for (const g of groups) {
          if (Array.isArray(g.models)) {
            for (const m of g.models) {
              const model = parseModelEntry(m)
              if (model && !seen.has(model.id)) {
                seen.add(model.id)
                result.push(model)
              }
            }
          }
        }
        if (result.length > 0) return result
      }
    } catch {}
  }
  // 仅在未指定特定 agentType（如设置页回显）时，退回查找首个有效 overlay
  if (!agentType) {
    for (const row of provider.overlays ?? []) {
      const parsed = archivedModels({ ...provider, model: row.models })
      if (parsed.length > 0) return parsed
    }
  }
  return []
}

/** 档案 `model` 字段:显示名只在与 ID 不同时写(cc-switch 旧数据的角色名)。 */
export function serializeModels(models: ProviderModel[]): string {
  const valid = models.filter((item) => item.id.trim() !== "")
  if (valid.length === 0) return ""
  return JSON.stringify(valid.map(modelRecord))
}

export function modelRecord(item: ProviderModel): Record<string, unknown> {
  const id = item.id.trim()
  const name = item.name.trim()
  return {
    id,
    ...(name && name !== id ? { name } : {}),
    ...(item.slot?.trim() ? { slot: item.slot.trim() } : {}),
    ...(item.apis?.length ? { apis: item.apis } : {}),
    ...(item.contextWindow ? { contextWindow: item.contextWindow } : {}),
    ...(item.maxOutput ? { maxOutput: item.maxOutput } : {}),
  }
}

/** 启动栏模型值里模型 id 与分组 id 的分隔符（模型 id 里不会出现的控制字符）。 */
const GROUP_SEPARATOR = "\u001f"

export interface LaunchModelOption {
  value: string
  label: string
}

/**
 * 启动栏模型选项：同一模型在多个分组里时每个分组一项（「模型 · 分组名」），
 * 值带分组 id，启动时用 `splitLaunchModelValue` 拆回；其余模型一项一值。
 */
export function launchModelOptions(
  provider: ModelProviderInfo | null,
  models: ProviderModel[]
): LaunchModelOption[] {
  const groups = new Map<string, { id: string; name: string }[]>()
  try {
    const parsed = provider?.discovery_json
      ? JSON.parse(provider.discovery_json)
      : null
    const list = parsed?.keyGroups || parsed?.groupKeys
    if (Array.isArray(list)) {
      list.forEach((group, index) => {
        const id = String(group?.id ?? index + 1)
        const name = String(group?.name || id)
        for (const entry of Array.isArray(group?.models) ? group.models : []) {
          const model = parseModelEntry(entry)
          if (model)
            groups.set(model.id, [
              ...(groups.get(model.id) ?? []),
              { id, name },
            ])
        }
      })
    }
  } catch {}
  return models.flatMap((model) => {
    const owners = groups.get(model.id) ?? []
    if (owners.length < 2) return [{ value: model.id, label: model.id }]
    return owners.map((group) => ({
      value: `${model.id}${GROUP_SEPARATOR}${group.id}`,
      label: `${model.id} · ${group.name}`,
    }))
  })
}

/** 启动栏模型值 → 模型 id 与选中的分组 id（没带分组为 null）。 */
export function splitLaunchModelValue(value: string): {
  model: string
  group: string | null
} {
  const [model, group] = value.split(GROUP_SEPARATOR)
  return { model, group: group || null }
}
