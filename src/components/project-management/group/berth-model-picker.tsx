"use client"

import { useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { listModelProviders } from "@/lib/api"
import {
  type BerthModel,
  loadBerthModel,
  saveBerthModel,
} from "@/lib/agent/berth-group"
import { providerCatalogModels } from "@/lib/model-provider"
import type { ModelProviderInfo } from "@/lib/types"

/** 服务商档案按这个 Agent 类型取模型清单（与宿主一致）。 */
const AGENT_TYPE = "berth"

/**
 * 和 Berth 对话用的服务商 / 模型：来自「模型服务商」里填了 Key 的档案（官方登录 Berth 用不了），
 * 选过记住；`onChange` 报告当前是否已选好（没选好不能发）。
 */
export function BerthModelPicker({
  onChange,
}: {
  onChange: (model: BerthModel | null) => void
}) {
  const t = useTranslations("BerthTasks.group.composer")
  const [providers, setProviders] = useState<ModelProviderInfo[] | null>(null)
  const [model, setModel] = useState<BerthModel | null>(() => loadBerthModel())

  useEffect(() => {
    let active = true
    void listModelProviders(false)
      .then((rows) => {
        if (active) setProviders(rows.filter((row) => row.kind !== "official"))
      })
      .catch(() => {
        if (active) setProviders([])
      })
    return () => {
      active = false
    }
  }, [])

  const provider = providers?.find((row) => row.id === model?.providerId)
  const models = provider ? providerCatalogModels(provider, AGENT_TYPE) : []
  // 记住的档案或模型已被删掉：当作没选。
  const valid =
    model && provider && models.some((row) => row.id === model.modelId)
      ? model
      : null
  useEffect(() => {
    if (providers) onChange(valid)
  }, [providers, valid?.providerId, valid?.modelId]) // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (next: BerthModel) => {
    setModel(next)
    saveBerthModel(next)
  }

  if (providers && providers.length === 0) {
    return (
      <span className="truncate text-[11px] text-muted-foreground">
        {t("berthNoProvider")}
      </span>
    )
  }
  return (
    <div className="flex min-w-0 items-center gap-1" data-berth-model>
      <Select
        value={provider ? String(provider.id) : ""}
        onValueChange={(id) => {
          const next = providers?.find((row) => String(row.id) === id)
          const first = next ? providerCatalogModels(next, AGENT_TYPE)[0] : null
          if (next) choose({ providerId: next.id, modelId: first?.id ?? "" })
        }}
      >
        <SelectTrigger
          size="sm"
          className="h-7 max-w-36 rounded-md px-2 text-xs"
          aria-label={t("berthProvider")}
        >
          <SelectValue placeholder={t("berthProvider")} />
        </SelectTrigger>
        <SelectContent>
          {(providers ?? []).map((row) => (
            <SelectItem key={row.id} value={String(row.id)}>
              {row.name}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Select
        value={valid?.modelId ?? ""}
        disabled={!provider}
        onValueChange={(modelId) =>
          provider && choose({ providerId: provider.id, modelId })
        }
      >
        <SelectTrigger
          size="sm"
          className="h-7 max-w-44 rounded-md px-2 text-xs"
          aria-label={t("berthModel")}
        >
          <SelectValue placeholder={t("berthModel")} />
        </SelectTrigger>
        <SelectContent>
          {models.map((row) => (
            <SelectItem key={row.id} value={row.id}>
              {row.name || row.id}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}
