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
