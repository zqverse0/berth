"use client"

import { useState } from "react"
import { Languages } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "@/lib/notify"
import { useAppI18n } from "@/components/i18n-provider"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { updateSystemLanguageSettings } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { APP_LOCALES } from "@/lib/i18n"
import type { AppLocale } from "@/lib/types"

type LanguageSelectValue = "system" | AppLocale

function isAppLocale(value: string): value is AppLocale {
  return APP_LOCALES.includes(value as AppLocale)
}

export function LanguageSection() {
  const t = useTranslations("SystemSettings")
  const tLanguage = useTranslations("Language")
  const { languageSettings, languageSettingsLoaded, setLanguageSettings } =
    useAppI18n()
  const [saving, setSaving] = useState(false)

  const value: LanguageSelectValue =
    languageSettings.mode === "system" ? "system" : languageSettings.language

  const save = async (lang: LanguageSelectValue) => {
    setSaving(true)
    try {
      const next = await updateSystemLanguageSettings({
        mode: lang === "system" ? "system" : "manual",
        language: lang === "system" ? languageSettings.language : lang,
      })
      setLanguageSettings(next)
    } catch (err) {
      toast.error(t("languageSaveFailed", { message: toErrorMessage(err) }))
    } finally {
      setSaving(false)
    }
  }

  return (
    <section className="rounded-xl border bg-card p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Languages className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("languageTitle")}</h2>
      </div>

      <p className="text-xs text-muted-foreground leading-5">
        {t("languageDescription")}
      </p>

      <div className="space-y-2">
        <label className="text-xs font-medium text-muted-foreground">
          {t("appLanguage")}
        </label>
        <Select
          value={value}
          onValueChange={(next) => {
            if (next === "system" || isAppLocale(next)) void save(next)
          }}
          disabled={saving || !languageSettingsLoaded}
        >
          <SelectTrigger className="w-full sm:w-56">
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="start">
            <SelectItem value="system">{tLanguage("followSystem")}</SelectItem>
            <SelectItem value="en">{tLanguage("english")}</SelectItem>
            <SelectItem value="zh_cn">
              {tLanguage("simplifiedChinese")}
            </SelectItem>
          </SelectContent>
        </Select>
      </div>
    </section>
  )
}
