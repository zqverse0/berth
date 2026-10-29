"use client"

import { ExternalLink, Languages, Loader2 } from "lucide-react"
import { useCallback, useEffect, useMemo, useState } from "react"
import { useTranslations } from "next-intl"
import { toast } from "@/lib/notify"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { toErrorMessage } from "@/lib/app-error"
import { openUrl } from "@/lib/platform"
import {
  TRANSLATE_COMMERCIAL_DEFAULT_URLS,
  TRANSLATE_COMMERCIAL_DOCS,
  TRANSLATE_COMMERCIAL_PROVIDERS,
  TRANSLATE_FREE_PROVIDERS,
  TRANSLATE_PROVIDER_AUTO,
  getTranslateSettings,
  isTranslateProviderId,
  updateTranslateSettings,
  type TranslateProviderId,
} from "@/lib/translate"
import type { TranslateProviderConfig, TranslateSettings } from "@/lib/types"

const EMPTY_CONFIG: TranslateProviderConfig = {
  baseUrl: "",
  region: "",
  model: "",
  hasKey: false,
}

function maskKey(hasKey: boolean): string {
  return hasKey ? "********" : ""
}

export function TranslateSettings() {
  const t = useTranslations("TranslateSettings")
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [settings, setSettings] = useState<TranslateSettings | null>(null)
  const [keyDrafts, setKeyDrafts] = useState<Record<string, string>>({})

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const next = await getTranslateSettings()
      setSettings(next)
      const drafts: Record<string, string> = {}
      for (const id of TRANSLATE_COMMERCIAL_PROVIDERS) {
        drafts[id] = maskKey(Boolean(next.providerConfigs[id]?.hasKey))
      }
      setKeyDrafts(drafts)
    } catch (error) {
      toast.error(toErrorMessage(error) || t("loadFailed"))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const persist = useCallback(
    async (next: TranslateSettings) => {
      setSaving(true)
      try {
        const saved = await updateTranslateSettings(next)
        setSettings(saved)
        const drafts: Record<string, string> = {}
        for (const id of TRANSLATE_COMMERCIAL_PROVIDERS) {
          drafts[id] = maskKey(Boolean(saved.providerConfigs[id]?.hasKey))
        }
        setKeyDrafts(drafts)
        toast.success(t("saved"))
      } catch (error) {
        toast.error(toErrorMessage(error) || t("saveFailed"))
      } finally {
        setSaving(false)
      }
    },
    [t]
  )

  const providerIds = useMemo(
    () =>
      [
        TRANSLATE_PROVIDER_AUTO,
        ...TRANSLATE_FREE_PROVIDERS,
        ...TRANSLATE_COMMERCIAL_PROVIDERS,
      ] as TranslateProviderId[],
    []
  )

  if (loading || !settings) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("loading")}
      </div>
    )
  }

  const provider = isTranslateProviderId(settings.provider)
    ? settings.provider
    : TRANSLATE_PROVIDER_AUTO

  return (
    <>
      <section className="space-y-1 pt-4">
        <h1 className="text-sm font-semibold">{t("title")}</h1>
        <p className="text-muted-foreground text-xs">{t("description")}</p>
      </section>

      <section className="space-y-4 rounded-xl border bg-card p-4">
        <div className="flex items-center gap-2">
          <Languages className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("defaultsTitle")}</h2>
        </div>
        <div className="space-y-2">
          <label className="text-muted-foreground text-xs font-medium">
            {t("providerLabel")}
          </label>
          <Select
            value={provider}
            disabled={saving}
            onValueChange={(value) => {
              if (!isTranslateProviderId(value)) return
              void persist({ ...settings, provider: value })
            }}
          >
            <SelectTrigger className="w-full sm:w-80">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              {providerIds.map((id) => (
                <SelectItem key={id} value={id}>
                  {t(`providers.${id}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-muted-foreground text-xs leading-5">
            {t("providerHint")}
          </p>
        </div>
        <div className="space-y-2">
          <label className="text-muted-foreground text-xs font-medium">
            {t("targetLangLabel")}
          </label>
          <Select
            value={settings.targetLang || "auto"}
            disabled={saving}
            onValueChange={(value) => {
              void persist({ ...settings, targetLang: value })
            }}
          >
            <SelectTrigger className="w-full sm:w-80">
              <SelectValue />
            </SelectTrigger>
            <SelectContent align="start">
              <SelectItem value="auto">{t("targetLang.auto")}</SelectItem>
              <SelectItem value="zh-CN">{t("targetLang.zhCN")}</SelectItem>
              <SelectItem value="en">{t("targetLang.en")}</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </section>

      <section className="space-y-4 rounded-xl border bg-card p-4">
        <h2 className="text-sm font-semibold">{t("apiTitle")}</h2>
        <p className="text-muted-foreground text-xs leading-5">
          {t("apiDescription")}
        </p>
        {TRANSLATE_COMMERCIAL_PROVIDERS.map((id) => {
          const config = settings.providerConfigs[id] ?? EMPTY_CONFIG
          return (
            <div key={id} className="space-y-3 rounded-lg border p-3">
              <div className="flex items-center justify-between gap-2">
                <p className="text-sm font-medium">{t(`providers.${id}`)}</p>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="gap-1"
                  onClick={() => void openUrl(TRANSLATE_COMMERCIAL_DOCS[id])}
                >
                  <ExternalLink className="size-3.5" />
                  {t("openDocs")}
                </Button>
              </div>
              <div className="space-y-2">
                <label className="text-muted-foreground text-xs">
                  {t("apiKey")}
                </label>
                <Input
                  type="password"
                  autoComplete="off"
                  value={keyDrafts[id] ?? ""}
                  placeholder={t("apiKeyPlaceholder")}
                  onChange={(event) =>
                    setKeyDrafts((prev) => ({
                      ...prev,
                      [id]: event.target.value,
                    }))
                  }
                />
              </div>
              <div className="space-y-2">
                <label className="text-muted-foreground text-xs">
                  {t("baseUrl")}
                </label>
                <Input
                  value={config.baseUrl}
                  placeholder={TRANSLATE_COMMERCIAL_DEFAULT_URLS[id]}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      providerConfigs: {
                        ...settings.providerConfigs,
                        [id]: { ...config, baseUrl: event.target.value },
                      },
                    })
                  }
                />
              </div>
              {id === "openaiCompatible" ? (
                <div className="space-y-2">
                  <label className="text-muted-foreground text-xs">
                    {t("model")}
                  </label>
                  <Input
                    value={config.model}
                    placeholder="gpt-4o-mini"
                    onChange={(event) =>
                      setSettings({
                        ...settings,
                        providerConfigs: {
                          ...settings.providerConfigs,
                          [id]: { ...config, model: event.target.value },
                        },
                      })
                    }
                  />
                </div>
              ) : null}
              <Button
                type="button"
                size="sm"
                disabled={saving}
                onClick={() => {
                  const draft = keyDrafts[id] ?? ""
                  void persist({
                    ...settings,
                    providerConfigs: {
                      ...settings.providerConfigs,
                      [id]: {
                        ...config,
                        apiKey: draft,
                      },
                    },
                  })
                }}
              >
                {t("saveProvider")}
              </Button>
            </div>
          )
        })}
      </section>
    </>
  )
}
