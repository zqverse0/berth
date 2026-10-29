"use client"

import { useCallback, useState } from "react"
import { Eye, EyeOff } from "lucide-react"
import { useTranslations } from "next-intl"
import { randomUUID } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { saveAccountToken } from "@/lib/api"
import type { GitHubAccount } from "@/lib/types"

interface AddGitAccountFormProps {
  onAccountAdded: (account: GitHubAccount) => void
  onCancel: () => void
  isFirstAccount: boolean
}

/** 页内展开的 Git 服务器账号表单；收起即卸载，状态随之清空。 */
export function AddGitAccountForm({
  onAccountAdded,
  onCancel,
  isFirstAccount,
}: AddGitAccountFormProps) {
  const t = useTranslations("VersionControlSettings")

  const [serverUrl, setServerUrl] = useState("")
  const [username, setUsername] = useState("")
  const [password, setPassword] = useState("")
  const [showPassword, setShowPassword] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleSubmit = useCallback(async () => {
    const trimmedUrl = serverUrl.trim()
    const trimmedUser = username.trim()
    const trimmedPass = password.trim()

    if (!trimmedUrl) {
      setError(t("gitAccount.serverRequired"))
      return
    }
    if (!trimmedUser) {
      setError(t("gitAccount.usernameRequired"))
      return
    }
    if (!trimmedPass) {
      setError(t("gitAccount.passwordRequired"))
      return
    }

    const account: GitHubAccount = {
      id: randomUUID(),
      server_url: trimmedUrl,
      username: trimmedUser,
      scopes: [],
      avatar_url: null,
      is_default: isFirstAccount,
      created_at: new Date().toISOString(),
    }

    try {
      await saveAccountToken(account.id, trimmedPass)
    } catch {
      setError(t("gitAccount.passwordRequired"))
      return
    }

    onAccountAdded(account)
  }, [serverUrl, username, password, isFirstAccount, onAccountAdded, t])

  const canSubmit =
    serverUrl.trim().length > 0 &&
    username.trim().length > 0 &&
    password.trim().length > 0

  return (
    <div className="space-y-4 rounded-md border bg-muted/10 p-3">
      <div className="space-y-1">
        <p className="text-sm font-medium">{t("gitAccount.addTitle")}</p>
        <p className="text-xs text-muted-foreground">
          {t("gitAccount.addDescription")}
        </p>
      </div>
      <div className="space-y-4">
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground">
            {t("gitAccount.serverUrl")}
          </label>
          <Input
            value={serverUrl}
            onChange={(e) => {
              setServerUrl(e.target.value)
              setError(null)
            }}
            placeholder={t("gitAccount.serverUrlPlaceholder")}
            autoFocus
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground">
            {t("gitAccount.username")}
          </label>
          <Input
            value={username}
            onChange={(e) => {
              setUsername(e.target.value)
              setError(null)
            }}
            placeholder={t("gitAccount.usernamePlaceholder")}
          />
        </div>

        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground">
            {t("gitAccount.password")}
          </label>
          <div className="relative">
            <Input
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => {
                setPassword(e.target.value)
                setError(null)
              }}
              placeholder={t("gitAccount.passwordPlaceholder")}
              className="pr-9"
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit) handleSubmit()
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 p-0"
              onClick={() => setShowPassword(!showPassword)}
              tabIndex={-1}
            >
              {showPassword ? (
                <EyeOff className="h-3.5 w-3.5" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t("gitAccount.passwordHint")}
          </p>
        </div>

        {error && (
          <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
            {error}
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2">
        <Button size="sm" variant="outline" onClick={onCancel}>
          {t("removeCancel")}
        </Button>
        <Button size="sm" onClick={handleSubmit} disabled={!canSubmit}>
          {t("gitAccount.add")}
        </Button>
      </div>
    </div>
  )
}
