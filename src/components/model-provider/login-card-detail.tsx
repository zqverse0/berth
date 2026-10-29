"use client"

import { useCallback, useEffect, useState } from "react"
import { useTranslations } from "next-intl"
import { ExternalLink, Loader2, RefreshCw } from "lucide-react"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { ModelMappingEditor } from "@/components/model-provider/model-mapping-editor"
import {
  fetchLoginModels,
  saveLoginPresets,
  type LoginEntry,
  type LoginModel,
  type ProviderModel,
} from "@/lib/model-provider"
import { openPath } from "@/lib/platform"
import {
  fetchOfficialAccountUsage,
  type UsageState,
} from "@/lib/transport/usage"
import {
  formatUsageWindowLine,
  type UsageTranslator,
} from "@/lib/agent/usage-window"
import { toErrorMessage } from "@/lib/app-error"

/** 一张登录凭证卡：同 loginId 的各 Agent 声明并排展示，全部只读。 */
export function LoginCardDetail({
  entries,
  checkedAt,
  onRecheck,
}: {
  entries: LoginEntry[]
  checkedAt: Date | null
  onRecheck: () => void
}) {
  const t = useTranslations("ModelProviderSettings")
  const first = entries[0]
  if (!first) return null
  // 与 API 服务商详情同一骨架；名称 / 官网来自声明，只读。
  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border">
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <label className="text-xs font-medium">{t("providerName")}</label>
              <Input value={first.label} readOnly disabled />
            </div>
            <div className="space-y-1.5">
              <label className="text-xs font-medium">{t("website")}</label>
              <div className="flex items-center gap-1.5">
                <Input value={first.website ?? ""} readOnly disabled />
                {first.website ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    aria-label={t("website")}
                    onClick={() => void openPath(first.website as string)}
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                ) : null}
              </div>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t("loginSourceNote")}
          </p>
          {entries.map((entry) => (
            <LoginAgentSection key={entry.agentId} entry={entry} />
          ))}
        </div>
      </ScrollArea>
      <div className="flex shrink-0 items-center justify-end gap-2 border-t p-3 text-[11px] text-muted-foreground">
        {checkedAt
          ? t("loginCheckedAt", { time: checkedAt.toLocaleTimeString() })
          : null}
        <Button
          variant="outline"
          size="sm"
          className="h-7 text-xs"
          onClick={onRecheck}
        >
          <RefreshCw className="mr-1 h-3 w-3" />
          {t("loginRecheck")}
        </Button>
      </div>
    </div>
  )
}

function LoginAgentSection({ entry }: { entry: LoginEntry }) {
  const t = useTranslations("ModelProviderSettings")
  const [models, setModels] = useState<LoginModel[]>([])
  const [presets, setPresets] = useState<ProviderModel[]>([])
  const [presetsDirty, setPresetsDirty] = useState(false)
  const [savingPresets, setSavingPresets] = useState(false)
  const [modelError, setModelError] = useState<string | null>(null)
  const [loadingModels, setLoadingModels] = useState(false)
  const [usage, setUsage] = useState<UsageState | null>(null)
  const [usageError, setUsageError] = useState(false)
  const [loadingUsage, setLoadingUsage] = useState(false)

  const readModels = useCallback(async () => {
    setLoadingModels(true)
    setModelError(null)
    try {
      const result = await fetchLoginModels(entry.agentId, entry.loginId)
      setModels(result.models.filter((model) => !model.preset))
      setPresets(
        result.models
          .filter((model) => model.preset)
          .map(({ id, name }) => ({ id, name }))
      )
      setPresetsDirty(false)
      setModelError(result.error ?? null)
    } catch (error) {
      setModelError(toErrorMessage(error))
    } finally {
      setLoadingModels(false)
    }
  }, [entry.agentId, entry.loginId])

  useEffect(() => {
    void readModels()
  }, [readModels])

  // 预选项整份覆盖保存（空行丢弃），保存后重读，与启动栏同源。
  const savePresets = async () => {
    setSavingPresets(true)
    try {
      await saveLoginPresets(
        entry.agentId,
        entry.loginId,
        presets.filter((model) => model.id.trim())
      )
      await readModels()
    } catch (error) {
      setModelError(toErrorMessage(error))
    } finally {
      setSavingPresets(false)
    }
  }

  const queryUsage = async () => {
    if (!entry.agentType) return
    setLoadingUsage(true)
    setUsageError(false)
    try {
      setUsage(
        await fetchOfficialAccountUsage({
          agentType: entry.agentType,
          rawCredential: null,
        })
      )
    } catch {
      setUsageError(true)
    } finally {
      setLoadingUsage(false)
    }
  }

  return (
    <section className="space-y-3 rounded-lg border bg-muted/15 p-3">
      <div className="flex items-center justify-between gap-2 border-b pb-2">
        <span className="text-xs font-semibold text-foreground/80">
          {entry.agentName}
        </span>
        <Badge variant="outline">
          {entry.credentialPresent === true
            ? t("loginPresent")
            : entry.credentialPresent === false
              ? t("loginMissing")
              : t("loginUnknown")}
        </Badge>
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-foreground/90">
            {t("loginFetchedModels")} ·{" "}
            {t("modelsCount", { count: models.length })}
          </label>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            disabled={loadingModels || !entry.hasModels}
            onClick={() => void readModels()}
          >
            {loadingModels ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : (
              <RefreshCw className="mr-1 h-3 w-3" />
            )}
            {t("loginModels")}
          </Button>
        </div>
        {modelError ? (
          <p className="text-[11px] text-red-400">
            {t("loginModelsError", { reason: modelError })}
          </p>
        ) : !entry.hasModels ? (
          <p className="text-[11px] text-muted-foreground">
            {t("loginModelsUndeclared")}
          </p>
        ) : !loadingModels && models.length === 0 ? (
          <p className="text-[11px] text-muted-foreground">
            {t("loginModelsEmpty")}
          </p>
        ) : null}
        {models.length > 0 ? (
          <div className="space-y-1">
            {models.map((model) => (
              <Input
                key={model.id}
                value={model.id}
                title={model.name}
                readOnly
                className="h-8 font-mono text-xs"
              />
            ))}
          </div>
        ) : null}
      </div>

      <div className="space-y-1.5">
        <div className="flex items-center justify-between">
          <label className="text-xs font-medium text-foreground/90">
            {t("loginPresets")}
          </label>
          <Button
            type="button"
            size="sm"
            className="h-6 px-2 text-[11px]"
            disabled={!presetsDirty || savingPresets}
            onClick={() => void savePresets()}
          >
            {savingPresets ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : null}
            {t("loginPresetSave")}
          </Button>
        </div>
        <ModelMappingEditor
          value={presets}
          onChange={(next) => {
            setPresets(next)
            setPresetsDirty(true)
          }}
        />
        <p className="text-[11px] text-muted-foreground">
          {t("loginPresetHint")}
        </p>
      </div>

      {entry.hasUsage && entry.agentType ? (
        <div className="space-y-1">
          <Button
            variant="ghost"
            size="sm"
            className="h-6 px-2 text-[11px]"
            disabled={loadingUsage}
            onClick={() => void queryUsage()}
          >
            {loadingUsage ? (
              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
            ) : null}
            {t("loginQueryUsage")}
          </Button>
          {usageError ? (
            <p className="text-xs text-red-400">{t("loginUsageError")}</p>
          ) : usage ? (
            <p aria-live="polite" className="text-xs">
              {usage.status === "ready"
                ? usage.windows
                    .map((window) =>
                      formatUsageWindowLine(
                        window,
                        t as unknown as UsageTranslator
                      )
                    )
                    .join(" · ") || t("loginUsageUnavailable")
                : t("loginUsageStatus", {
                    status: usage.status,
                    reason: usage.diagnostics
                      .map((item) => item.message)
                      .join(" "),
                  })}
            </p>
          ) : null}
        </div>
      ) : null}
    </section>
  )
}
