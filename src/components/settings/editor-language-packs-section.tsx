"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  Download,
  Languages,
  LoaderCircle,
  RefreshCw,
  Search,
  Trash2,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "@/lib/notify"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { toErrorMessage } from "@/lib/app-error"
import {
  editorLanguagePackOperation,
  type EditorLanguagePackEntry,
  type InstalledEditorLanguagePack,
} from "@/lib/api"

export function EditorLanguagePacksSection() {
  const t = useTranslations("AppearanceSettings.languagePacks")
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<EditorLanguagePackEntry[]>([])
  const [installed, setInstalled] = useState<InstalledEditorLanguagePack[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [searched, setSearched] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refreshInstalled = useCallback(async () => {
    const snapshot = await editorLanguagePackOperation("installed")
    setInstalled(snapshot.installed)
  }, [])

  useEffect(() => {
    void refreshInstalled().catch((cause) => setError(toErrorMessage(cause)))
  }, [refreshInstalled])

  const search = useCallback(async () => {
    setBusy("search")
    setError(null)
    setSearched(true)
    try {
      const snapshot = await editorLanguagePackOperation(
        "search-npm",
        undefined,
        { query: query.trim() }
      )
      setResults(snapshot.catalog)
      setInstalled(snapshot.installed)
    } catch (cause) {
      setError(toErrorMessage(cause))
    } finally {
      setBusy(null)
    }
  }, [query])

  const operate = useCallback(
    async (
      action: "install-npm" | "update-npm" | "uninstall" | "enable" | "disable",
      pack: EditorLanguagePackEntry | InstalledEditorLanguagePack
    ) => {
      setBusy(pack.id)
      setError(null)
      try {
        if (action === "install-npm" || action === "update-npm") {
          await editorLanguagePackOperation(action, pack.id, {
            packageName: pack.npmPackageName,
          })
        } else {
          await editorLanguagePackOperation(action, pack.id)
        }
        await refreshInstalled()
        window.dispatchEvent(new Event("berth:language-packs-changed"))
      } catch (cause) {
        setError(toErrorMessage(cause))
        toast.error(t("operationFailed"))
      } finally {
        setBusy(null)
      }
    },
    [refreshInstalled, t]
  )

  const installedById = useMemo(
    () => new Map(installed.map((pack) => [pack.id, pack])),
    [installed]
  )
  const available = results.filter((pack) => !installedById.has(pack.id))

  const packDetails = (pack: EditorLanguagePackEntry) => (
    <div className="min-w-0 flex-1">
      <div className="flex items-center gap-1 truncate text-xs font-medium">
        {pack.displayName}
        {busy === pack.id && <LoaderCircle className="h-3 w-3 animate-spin" />}
      </div>
      <div className="truncate text-[11px] text-muted-foreground">
        {pack.npmPackageName ?? pack.id} · {pack.extensions.join(", ")}
      </div>
    </div>
  )

  return (
    <section className="space-y-4 rounded-xl border bg-card p-4">
      <div className="flex items-center gap-2">
        <Languages className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("title")}</h2>
      </div>
      <p className="text-xs leading-5 text-muted-foreground">
        {t("description")}
      </p>

      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault()
          void search()
        }}
      >
        <Input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={t("searchPlaceholder")}
          aria-label={t("searchPlaceholder")}
        />
        <Button type="submit" disabled={busy !== null}>
          {busy === "search" ? (
            <LoaderCircle className="mr-1 h-4 w-4 animate-spin" />
          ) : (
            <Search className="mr-1 h-4 w-4" />
          )}
          {t("search")}
        </Button>
      </form>

      {error && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          <p>
            {error.includes("Unknown language pack operation")
              ? t("restartRequired")
              : t("npmUnavailable")}
          </p>
          <p className="mt-1 break-all font-mono text-[10px] opacity-80">
            {error}
          </p>
        </div>
      )}

      {available.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-medium">{t("available")}</h3>
          {available.map((pack) => (
            <div
              key={pack.id}
              className="flex items-center gap-3 rounded-md border px-3 py-2"
            >
              {packDetails(pack)}
              <Button
                size="sm"
                disabled={busy !== null || !pack.npmPackageName}
                onClick={() => void operate("install-npm", pack)}
              >
                <Download className="mr-1 h-3 w-3" /> {t("install")}
              </Button>
            </div>
          ))}
        </div>
      )}
      {searched && available.length === 0 && !error && (
        <p className="text-xs text-muted-foreground">{t("noSearchResults")}</p>
      )}

      {installed.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-xs font-medium">{t("installed")}</h3>
          {installed.map((pack) => {
            const result = results.find((candidate) => candidate.id === pack.id)
            const updating = result && result.version !== pack.version
            return (
              <div
                key={pack.id}
                className="flex items-center gap-3 rounded-md border px-3 py-2"
              >
                {packDetails(pack)}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() =>
                    void operate(pack.enabled ? "disable" : "enable", pack)
                  }
                >
                  {pack.enabled ? t("disable") : t("enable")}
                </Button>
                {updating && pack.npmPackageName && (
                  <Button
                    size="sm"
                    disabled={busy !== null}
                    onClick={() => void operate("update-npm", pack)}
                  >
                    <RefreshCw className="mr-1 h-3 w-3" /> {t("update")}
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="outline"
                  disabled={busy !== null}
                  onClick={() => void operate("uninstall", pack)}
                >
                  <Trash2 className="mr-1 h-3 w-3" /> {t("uninstall")}
                </Button>
              </div>
            )
          })}
        </div>
      )}
    </section>
  )
}
