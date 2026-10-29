"use client"

import { useEffect, useState } from "react"
import { FolderOpen, Sparkles } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "@/lib/notify"
import { revealItemInDir } from "@/lib/platform"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import {
  getClassifierSettings,
  saveClassifierConfig,
  type ClassifierConfig,
  type ClassifierSettings as Settings,
} from "@/knowledge/api/knowledge-client"

/**
 * 高级设置「会话分类」：总开关与每类开关，改完即存。
 * 问法、判定标准、阈值是交给 Jev 的题目本身，默认值来自实测，只在 `classifier.json` 里改。
 */
export function ClassifierSettings() {
  const t = useTranslations("ClassifierSettings")
  const [settings, setSettings] = useState<Settings | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)

  useEffect(() => {
    getClassifierSettings()
      .then(setSettings)
      .catch((cause) => setLoadError(String(cause)))
  }, [])

  if (loadError) return <p className="text-xs text-destructive">{loadError}</p>
  if (!settings) return null
  const config = settings.config

  const save = async (next: ClassifierConfig) => {
    try {
      const saved = await saveClassifierConfig(next)
      setSettings({ ...settings, config: saved })
    } catch (cause) {
      toast.error(cause instanceof Error ? cause.message : String(cause))
    }
  }
  const revealFile = () =>
    revealItemInDir(settings.path).catch((cause) =>
      toast.error(cause instanceof Error ? cause.message : String(cause))
    )

  return (
    <section className="space-y-4 rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("title")}</h2>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        {t("description")}
      </p>
      {settings.error || !config ? (
        <div className="rounded-md border border-destructive/30 px-3 py-2 text-xs text-destructive">
          {t("invalid", { error: settings.error ?? "" })}
        </div>
      ) : (
        <>
          <label className="flex items-center gap-2">
            <Switch
              checked={config.enabled}
              onCheckedChange={(enabled) => void save({ ...config, enabled })}
            />
            <span className="text-sm">{t("enable")}</span>
          </label>
          <p className="text-xs text-muted-foreground">{t("decisionModel")}</p>
          <div className="space-y-1">
            <p className="text-xs font-medium text-muted-foreground">
              {t("categories")}
            </p>
            {config.categories.map((category) => (
              <label
                key={category.id}
                className="flex items-center gap-2 rounded-md px-1 py-1 text-xs"
              >
                <Switch
                  aria-label={category.name}
                  checked={category.enabled}
                  onCheckedChange={(enabled) =>
                    void save({
                      ...config,
                      categories: config.categories.map((item) =>
                        item.id === category.id ? { ...item, enabled } : item
                      ),
                    })
                  }
                />
                <span className="w-12 shrink-0 font-medium">
                  {category.name}
                </span>
                <span className="text-muted-foreground">
                  {category.description}
                </span>
              </label>
            ))}
          </div>
        </>
      )}
      <div className="flex items-center gap-2 text-xs text-muted-foreground">
        <span className="flex-1">{t("fileHint")}</span>
        <Button size="sm" variant="outline" onClick={() => void revealFile()}>
          <FolderOpen className="size-3.5" />
          {t("revealFile")}
        </Button>
      </div>
    </section>
  )
}
