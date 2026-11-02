"use client"

import { useCallback, useEffect, useState } from "react"
import { Copy, Loader2, Wifi, X } from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { getRemoteAccess, updateRemoteAccess } from "@/lib/api"
import { toErrorMessage } from "@/lib/app-error"
import { toast } from "@/lib/notify"
import type { RemoteAccessStatus } from "@/lib/types"
import { copyTextToClipboard } from "@/lib/utils"

/** Settings → 高级 → 远程访问：用户填写监听地址与访问密码，保存即重新监听。 */
export function RemoteAccessSettingsSection() {
  const t = useTranslations("SystemSettings.remote")
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null)
  // 末尾恒有一个空行，填了就是新地址。
  const [drafts, setDrafts] = useState<string[]>([""])
  const [password, setPassword] = useState("")
  const [saving, setSaving] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)

  const show = useCallback((next: RemoteAccessStatus) => {
    setStatus(next)
    setDrafts([...next.settings.addresses, ""])
  }, [])

  useEffect(() => {
    getRemoteAccess()
      .then(show)
      .catch((err) => setLoadError(toErrorMessage(err)))
  }, [show])

  const save = async (addresses: string[], nextPassword?: string) => {
    setSaving(true)
    try {
      show(await updateRemoteAccess({ addresses }, nextPassword))
      return true
    } catch (err) {
      toast.error(t("saveFailed", { message: toErrorMessage(err) }))
      return false
    } finally {
      setSaving(false)
    }
  }

  const filled = (list: string[]) =>
    list.map((a) => a.trim()).filter((a) => a !== "")

  const saveAddresses = (list: string[]) => {
    if (!status) return
    const next = filled(list)
    if (next.join("\n") !== status.settings.addresses.join("\n")) {
      void save(next)
    }
  }

  const savePassword = async (value: string) => {
    if (!status) return
    if (await save(filled(drafts), value)) setPassword("")
  }

  const copy = async (url: string) => {
    if (await copyTextToClipboard(url)) toast.success(t("copied"))
  }

  return (
    <section className="rounded-xl border bg-card p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Wifi className="h-4 w-4 text-muted-foreground" />
        <h2 className="text-sm font-semibold">{t("title")}</h2>
      </div>

      <p className="text-xs text-muted-foreground leading-5">
        {t("description")}
      </p>

      {loadError && (
        <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
          {loadError}
        </div>
      )}

      {!status && !loadError && (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
      )}

      {status && (
        <>
          <div className="space-y-2">
            <label
              htmlFor="remote-access-password"
              className="text-xs font-medium text-muted-foreground"
            >
              {t("password")}
            </label>
            <div className="flex items-center gap-2">
              <Input
                id="remote-access-password"
                type="password"
                autoComplete="new-password"
                className="max-w-64"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && password) void savePassword(password)
                }}
                placeholder={
                  status.hasPassword ? t("passwordSet") : t("passwordUnset")
                }
                disabled={saving}
              />
              <Button
                size="sm"
                onClick={() => void savePassword(password)}
                disabled={saving || !password}
              >
                {t("savePassword")}
              </Button>
              {status.hasPassword && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => void savePassword("")}
                  disabled={saving}
                >
                  {t("clearPassword")}
                </Button>
              )}
            </div>
          </div>

          <div className="space-y-2">
            <p className="text-xs font-medium text-muted-foreground">
              {t("addresses")}
            </p>
            {drafts.map((draft, index) => {
              const last = index === drafts.length - 1
              return (
                <div key={index} className="flex items-center gap-2">
                  <Input
                    className="max-w-64"
                    aria-label={t("addresses")}
                    value={draft}
                    onChange={(e) => {
                      const next = drafts.map((d, i) =>
                        i === index ? e.target.value : d
                      )
                      setDrafts(last && e.target.value ? [...next, ""] : next)
                    }}
                    onBlur={() => saveAddresses(drafts)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") e.currentTarget.blur()
                    }}
                    placeholder={
                      last
                        ? t("addressPlaceholder", { port: status.defaultPort })
                        : undefined
                    }
                    disabled={saving}
                  />
                  {!last && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      onClick={() =>
                        saveAddresses(drafts.filter((_, i) => i !== index))
                      }
                      disabled={saving}
                      aria-label={t("remove")}
                      title={t("remove")}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  )}
                </div>
              )
            })}
            <p className="text-[11px] text-muted-foreground">
              {t("addressHint", { port: status.defaultPort })}
            </p>
          </div>

          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">
              {t("urls")}
            </p>
            {!status.hasPassword ? (
              <p className="text-xs text-muted-foreground">
                {t("needPassword")}
              </p>
            ) : status.listening.length === 0 ? (
              <p className="text-xs text-muted-foreground">{t("off")}</p>
            ) : (
              status.listening.map((addr) => {
                const url = `http://${addr}/`
                return (
                  <div key={addr} className="flex items-center gap-2 text-sm">
                    <code className="rounded bg-muted px-1.5 py-0.5 text-xs">
                      {url}
                    </code>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="size-6"
                      onClick={() => void copy(url)}
                      aria-label={t("copy")}
                      title={t("copy")}
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )
              })
            )}
            {status.errors.map((error) => (
              <p key={error.address} className="text-[11px] text-destructive">
                {t("bindFailed", error)}
              </p>
            ))}
          </div>
        </>
      )}
    </section>
  )
}
