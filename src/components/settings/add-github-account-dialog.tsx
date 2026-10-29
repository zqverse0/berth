"use client"

import { useCallback, useState } from "react"
import { ExternalLink, Eye, EyeOff, Loader2 } from "lucide-react"
import { openUrl } from "@/lib/platform"
import { useTranslations } from "next-intl"
import { randomUUID } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { validateGitHubToken, saveAccountToken } from "@/lib/api"
import type { GitHubAccount } from "@/lib/types"
import { toErrorMessage } from "@/lib/app-error"

interface AddGitHubAccountDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAccountAdded: (account: GitHubAccount) => void
  isFirstAccount: boolean
}

/** 发现页（star / 趋势）用的弹窗外壳；设置页直接内嵌 `AddGitHubAccountForm`。 */
export function AddGitHubAccountDialog({
  open,
  onOpenChange,
  onAccountAdded,
  isFirstAccount,
}: AddGitHubAccountDialogProps) {
  const t = useTranslations("VersionControlSettings")
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("addAccount")}</DialogTitle>
          <DialogDescription>{t("githubDescription")}</DialogDescription>
        </DialogHeader>
        {/* 关闭即卸载表单，下次打开是空白状态。 */}
        {open ? (
          <AddGitHubAccountForm
            isFirstAccount={isFirstAccount}
            onCancel={() => onOpenChange(false)}
            onAccountAdded={(account) => {
              onAccountAdded(account)
              onOpenChange(false)
            }}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  )
}

interface AddGitHubAccountFormProps {
  onAccountAdded: (account: GitHubAccount) => void
  onCancel: () => void
  isFirstAccount: boolean
}

/** GitHub 账号表单（校验 token 后保存）；收起即卸载，状态随之清空。 */
export function AddGitHubAccountForm({
  onAccountAdded,
  onCancel,
  isFirstAccount,
}: AddGitHubAccountFormProps) {
  const t = useTranslations("VersionControlSettings")

  const [serverUrl, setServerUrl] = useState("https://github.com")
  const [token, setToken] = useState("")
  const [showToken, setShowToken] = useState(false)
  const [validating, setValidating] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleGenerateToken = useCallback(async () => {
    const base = serverUrl.trim().replace(/\/+$/, "") || "https://github.com"
    const params = new URLSearchParams({
      description: "berth",
      scopes: "repo,read:org,workflow,gist,read:user,user:email",
    })
    const url = `${base}/settings/tokens/new?${params.toString()}`
    try {
      await openUrl(url)
    } catch {
      // fallback: ignore if opener fails
    }
  }, [serverUrl])

  const handleSubmit = useCallback(async () => {
    const trimmedToken = token.trim()
    if (!trimmedToken) {
      setError(t("addFailed", { message: "Token is required" }))
      return
    }

    setValidating(true)
    setError(null)

    try {
      const result = await validateGitHubToken(serverUrl.trim(), trimmedToken)

      if (!result.success) {
        setError(
          t("addFailed", { message: result.message ?? "Validation failed" })
        )
        return
      }

      const account: GitHubAccount = {
        id: randomUUID(),
        server_url: serverUrl.trim() || "https://github.com",
        username: result.username ?? "unknown",
        scopes: result.scopes,
        avatar_url: result.avatar_url,
        is_default: isFirstAccount,
        created_at: new Date().toISOString(),
      }

      await saveAccountToken(account.id, trimmedToken)
      onAccountAdded(account)
    } catch (err) {
      const message = toErrorMessage(err)
      setError(t("addFailed", { message }))
    } finally {
      setValidating(false)
    }
  }, [serverUrl, token, isFirstAccount, onAccountAdded, t])

  return (
    <div className="space-y-4">
      <div className="space-y-4">
        <div className="space-y-2">
          <label className="text-xs font-medium text-muted-foreground">
            {t("serverUrl")}
          </label>
          <Input
            value={serverUrl}
            onChange={(e) => setServerUrl(e.target.value)}
            placeholder={t("serverUrlPlaceholder")}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <label className="text-xs font-medium text-muted-foreground">
              {t("token")}
            </label>
            <Button
              type="button"
              variant="link"
              size="xs"
              className="h-auto p-0 text-xs"
              onClick={handleGenerateToken}
            >
              {t("generateToken")}
              <ExternalLink className="ml-1 h-3 w-3" />
            </Button>
          </div>
          <div className="relative">
            <Input
              type={showToken ? "text" : "password"}
              value={token}
              onChange={(e) => {
                setToken(e.target.value)
                setError(null)
              }}
              placeholder={t("tokenPlaceholder")}
              className="pr-9"
            />
            <Button
              type="button"
              variant="ghost"
              size="xs"
              className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 p-0"
              onClick={() => setShowToken(!showToken)}
              tabIndex={-1}
            >
              {showToken ? (
                <EyeOff className="h-3.5 w-3.5" />
              ) : (
                <Eye className="h-3.5 w-3.5" />
              )}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">{t("tokenHint")}</p>
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
        <Button
          size="sm"
          onClick={handleSubmit}
          disabled={validating || !token.trim()}
        >
          {validating ? (
            <>
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
              {t("validating")}
            </>
          ) : (
            t("validateAndAdd")
          )}
        </Button>
      </div>
    </div>
  )
}
