"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import { Check, Github, Globe, Loader2, Trash2, XCircle } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "@/lib/notify"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import {
  detectGit,
  getGitSettings,
  updateGitSettings,
  testGitPath,
  getGitHubAccounts,
  updateGitHubAccounts,
  validateGitHubToken,
  getAccountToken,
  deleteAccountToken,
} from "@/lib/api"
import type {
  GitDetectResult,
  GitHubAccount,
  GitHubAccountsSettings,
} from "@/lib/types"
import { toErrorMessage } from "@/lib/app-error"
import { AddGitHubAccountForm } from "./add-github-account-dialog"
import { AddGitAccountForm } from "./add-git-account-form"

type T = ReturnType<typeof useTranslations<"VersionControlSettings">>

function isGitHubAccount(account: GitHubAccount): boolean {
  const url = account.server_url.toLowerCase()
  return url.includes("github.com")
}

// ---------------------------------------------------------------------------
// Git program: detection + custom path (Berth's own git, not a plugin)
// ---------------------------------------------------------------------------

export function GitProgramStatus() {
  const t = useTranslations("VersionControlSettings")
  const [gitInfo, setGitInfo] = useState<GitDetectResult | null>(null)
  const [customPath, setCustomPath] = useState("")
  const [editingPath, setEditingPath] = useState(false)
  const [savingGit, setSavingGit] = useState(false)

  useEffect(() => {
    Promise.all([detectGit(), getGitSettings()])
      .then(([git, settings]) => {
        setGitInfo(git)
        setCustomPath(settings.custom_path ?? "")
      })
      .catch((err) =>
        toast.error(t("loadFailed", { message: toErrorMessage(err) }))
      )
  }, [t])

  const handleSaveGit = useCallback(async () => {
    const trimmed = customPath.trim()
    setSavingGit(true)
    try {
      // Test first if a custom path is provided
      if (trimmed) {
        const result = await testGitPath(trimmed)
        if (!result.installed) {
          toast.error(
            t("testFailed", { message: "not a valid git executable" })
          )
          return
        }
      }
      await updateGitSettings({ custom_path: trimmed || null })
      setGitInfo(await detectGit())
      setEditingPath(false)
      toast.success(t("saveSuccess"))
    } catch (err) {
      toast.error(t("saveFailed", { message: toErrorMessage(err) }))
    } finally {
      setSavingGit(false)
    }
  }, [customPath, t])

  const handleCancelEdit = useCallback(() => {
    setEditingPath(false)
    // Restore to the saved value
    getGitSettings()
      .then((s) => setCustomPath(s.custom_path ?? ""))
      .catch(() => {})
  }, [])

  if (!gitInfo) {
    return (
      <p className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("loading")}
      </p>
    )
  }

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        {gitInfo.installed ? (
          <Check className="h-4 w-4 shrink-0 text-emerald-600" />
        ) : (
          <XCircle className="h-4 w-4 shrink-0 text-red-500" />
        )}
        <span className={gitInfo.installed ? undefined : "text-red-500"}>
          {gitInfo.installed ? t("gitDetected") : t("gitNotFound")}
          {gitInfo.version ? ` ${gitInfo.version}` : null}
        </span>
        {!editingPath && (
          <Button
            size="xs"
            variant="ghost"
            className="text-xs"
            onClick={() => setEditingPath(true)}
          >
            {t("customGitPath")}
          </Button>
        )}
      </div>
      {gitInfo.path && (
        <p className="mt-1 truncate pl-6 text-xs text-muted-foreground">
          {gitInfo.path}
        </p>
      )}

      {editingPath && (
        <div className="mt-2 space-y-2 pl-6">
          <div className="flex gap-2">
            <Input
              value={customPath}
              onChange={(e) => setCustomPath(e.target.value)}
              placeholder={t("customGitPathPlaceholder")}
              className="flex-1"
              autoFocus
            />
            <Button
              size="sm"
              variant="outline"
              onClick={handleCancelEdit}
              disabled={savingGit}
            >
              {t("removeCancel")}
            </Button>
            <Button size="sm" onClick={handleSaveGit} disabled={savingGit}>
              {savingGit ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                t("save")
              )}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t("customGitPathHint")}
          </p>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------

function AccountRow({
  account,
  testingId,
  confirmingRemove,
  onTest,
  onSetDefault,
  onRemove,
  onConfirmRemove,
  onCancelRemove,
  t,
}: {
  account: GitHubAccount
  testingId: string | null
  confirmingRemove: boolean
  onTest: (account: GitHubAccount) => void
  onSetDefault: (id: string) => void
  onRemove: (account: GitHubAccount) => void
  onConfirmRemove: () => void
  onCancelRemove: () => void
  t: T
}) {
  return (
    <div className="flex items-center gap-3 rounded-lg border bg-muted/10 px-3 py-2.5">
      {account.avatar_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={account.avatar_url}
          alt={account.username}
          className="h-8 w-8 rounded-full"
        />
      ) : (
        <div className="h-8 w-8 rounded-full bg-muted flex items-center justify-center text-xs font-medium">
          {account.username[0]?.toUpperCase()}
        </div>
      )}

      <div className="flex-1 min-w-0 space-y-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium truncate">
            {account.username}
          </span>
          {account.is_default && (
            <Badge variant="secondary" className="text-[10px] px-1.5 py-0">
              {t("defaultLabel")}
            </Badge>
          )}
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="truncate">{account.server_url}</span>
          {account.scopes.length > 0 && (
            <>
              <span>·</span>
              <span className="truncate">{account.scopes.join(", ")}</span>
            </>
          )}
        </div>
      </div>

      {confirmingRemove ? (
        <div className="flex items-center gap-1 shrink-0">
          <span className="text-xs text-muted-foreground">
            {t("removeConfirmMessage", { username: account.username })}
          </span>
          <Button size="xs" variant="ghost" onClick={onCancelRemove}>
            {t("removeCancel")}
          </Button>
          <Button size="xs" variant="destructive" onClick={onConfirmRemove}>
            {t("removeConfirm")}
          </Button>
        </div>
      ) : (
        <div className="flex items-center gap-1 shrink-0">
          <Button
            size="xs"
            variant="ghost"
            onClick={() => onTest(account)}
            disabled={testingId === account.id}
          >
            {testingId === account.id ? (
              <Loader2 className="h-3 w-3 animate-spin" />
            ) : (
              t("testConnection")
            )}
          </Button>
          {!account.is_default && (
            <Button
              size="xs"
              variant="ghost"
              onClick={() => onSetDefault(account.id)}
            >
              {t("setDefault")}
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            className="text-destructive hover:text-destructive"
            aria-label={t("removeConfirmTitle")}
            onClick={() => onRemove(account)}
          >
            <Trash2 className="h-3 w-3" />
          </Button>
        </div>
      )}
    </div>
  )
}

/** GitHub 与其他 Git 服务器账号：Berth 的 git 凭据助手与发现页使用。 */
export function GitAccountsSettings() {
  const t = useTranslations("VersionControlSettings")

  const [loading, setLoading] = useState(true)
  const [accounts, setAccounts] = useState<GitHubAccountsSettings>({
    accounts: [],
  })
  const [adding, setAdding] = useState<"github" | "git" | null>(null)
  const [testingAccountId, setTestingAccountId] = useState<string | null>(null)
  const [removeTargetId, setRemoveTargetId] = useState<string | null>(null)

  // Split accounts into GitHub vs other
  const githubAccounts = useMemo(
    () => accounts.accounts.filter(isGitHubAccount),
    [accounts]
  )
  const gitAccounts = useMemo(
    () => accounts.accounts.filter((a) => !isGitHubAccount(a)),
    [accounts]
  )

  useEffect(() => {
    getGitHubAccounts()
      .then(setAccounts)
      .catch((err) =>
        toast.error(t("loadFailed", { message: toErrorMessage(err) }))
      )
      .finally(() => setLoading(false))
  }, [t])

  const handleAccountAdded = useCallback(
    async (account: GitHubAccount) => {
      const updated: GitHubAccountsSettings = {
        accounts: [
          ...accounts.accounts.map((a) =>
            account.is_default ? { ...a, is_default: false } : a
          ),
          account,
        ],
      }
      try {
        const saved = await updateGitHubAccounts(updated)
        setAccounts(saved)
        setAdding(null)
        toast.success(t("addSuccess", { username: account.username }))
      } catch (err) {
        toast.error(t("addFailed", { message: toErrorMessage(err) }))
      }
    },
    [accounts, t]
  )

  const handleTestConnection = useCallback(
    async (account: GitHubAccount) => {
      setTestingAccountId(account.id)
      try {
        const token = await getAccountToken(account.id)
        if (!token) {
          toast.error(t("connectionFailed", { message: "Token not found" }))
          return
        }
        if (isGitHubAccount(account)) {
          const result = await validateGitHubToken(account.server_url, token)
          if (result.success) {
            toast.success(t("connectionSuccess"))
          } else {
            toast.error(
              t("connectionFailed", {
                message: result.message ?? "Unknown error",
              })
            )
          }
        } else {
          // For non-GitHub accounts we can't validate via API,
          // just confirm the token exists in keyring.
          toast.success(t("connectionSuccess"))
        }
      } catch (err) {
        toast.error(t("connectionFailed", { message: toErrorMessage(err) }))
      } finally {
        setTestingAccountId(null)
      }
    },
    [t]
  )

  const handleSetDefault = useCallback(
    async (accountId: string) => {
      const updated: GitHubAccountsSettings = {
        accounts: accounts.accounts.map((a) => ({
          ...a,
          is_default: a.id === accountId,
        })),
      }
      try {
        const saved = await updateGitHubAccounts(updated)
        setAccounts(saved)
        toast.success(t("defaultSet"))
      } catch (err) {
        toast.error(toErrorMessage(err))
      }
    },
    [accounts, t]
  )

  const handleRemoveAccount = useCallback(async () => {
    if (!removeTargetId) return
    const updated: GitHubAccountsSettings = {
      accounts: accounts.accounts.filter((a) => a.id !== removeTargetId),
    }
    try {
      await deleteAccountToken(removeTargetId)
      const saved = await updateGitHubAccounts(updated)
      setAccounts(saved)
      toast.success(t("removeSuccess"))
    } catch (err) {
      toast.error(toErrorMessage(err))
    } finally {
      setRemoveTargetId(null)
    }
  }, [accounts, removeTargetId, t])

  if (loading) {
    return (
      <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("loading")}
      </div>
    )
  }

  const renderRows = (list: GitHubAccount[]) => (
    <div className="space-y-2">
      {list.map((account) => (
        <AccountRow
          key={account.id}
          account={account}
          testingId={testingAccountId}
          confirmingRemove={removeTargetId === account.id}
          onTest={handleTestConnection}
          onSetDefault={handleSetDefault}
          onRemove={(target) => setRemoveTargetId(target.id)}
          onConfirmRemove={handleRemoveAccount}
          onCancelRemove={() => setRemoveTargetId(null)}
          t={t}
        />
      ))}
    </div>
  )
  const isFirstAccount = accounts.accounts.length === 0

  return (
    <div className="w-full space-y-4">
      {/* ---- GitHub Accounts ---- */}
      <section className="rounded-xl border bg-card p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Github className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("githubTitle")}</h2>
        </div>
        <p className="text-xs text-muted-foreground leading-5">
          {t("githubDescription")}
        </p>

        {githubAccounts.length === 0 && adding !== "github" ? (
          <div className="rounded-md border border-dashed bg-muted/10 px-4 py-6 text-center text-xs text-muted-foreground">
            {t("noAccounts")}
          </div>
        ) : (
          renderRows(githubAccounts)
        )}

        {adding === "github" ? (
          <AddGitHubAccountForm
            isFirstAccount={isFirstAccount}
            onCancel={() => setAdding(null)}
            onAccountAdded={handleAccountAdded}
          />
        ) : (
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setAdding("github")}>
              {t("addAccount")}
            </Button>
          </div>
        )}
      </section>

      {/* ---- Git Accounts (non-GitHub) ---- */}
      <section className="rounded-xl border bg-card p-4 space-y-4">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">
            {t("gitAccount.sectionTitle")}
          </h2>
        </div>
        <p className="text-xs text-muted-foreground leading-5">
          {t("gitAccount.sectionDescription")}
        </p>

        {gitAccounts.length === 0 && adding !== "git" ? (
          <div className="rounded-md border border-dashed bg-muted/10 px-4 py-6 text-center text-xs text-muted-foreground">
            {t("gitAccount.noAccounts")}
          </div>
        ) : (
          renderRows(gitAccounts)
        )}

        {adding === "git" ? (
          <AddGitAccountForm
            isFirstAccount={isFirstAccount}
            onCancel={() => setAdding(null)}
            onAccountAdded={handleAccountAdded}
          />
        ) : (
          <div className="flex justify-end">
            <Button size="sm" onClick={() => setAdding("git")}>
              {t("gitAccount.addAccount")}
            </Button>
          </div>
        )}
      </section>
    </div>
  )
}
