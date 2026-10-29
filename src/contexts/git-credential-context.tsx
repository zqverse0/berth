"use client"

import type { ReactNode } from "react"
import {
  ExternalLink,
  Eye,
  EyeOff,
  Github,
  KeyRound,
  Loader2,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  useGitCredentialStore,
  useGitCredential,
  useOptionalGitCredential,
  type GitRemoteHint,
} from "@/stores/git/git-credential-store"

/**
 * Compat shim over `@/stores/git-credential-store`. The dialog is the store's
 * only subscriber, so `GitCredentialProvider` no longer holds state — it just
 * mounts the dialog alongside children. `useGitCredential()` /
 * `useOptionalGitCredential()` return a stable module-level action bundle.
 */
export { useGitCredential, useOptionalGitCredential }
export type { GitRemoteHint }

export function GitCredentialProvider({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <GitCredentialDialog />
    </>
  )
}

function GitCredentialDialog() {
  const t = useTranslations("GitCredentialDialog")
  const s = useGitCredentialStore()

  const canSubmitGitHub = s.token.trim().length > 0
  const canSubmitGeneric =
    s.username.trim().length > 0 && s.password.trim().length > 0
  const canSubmit = s.mode === "github" ? canSubmitGitHub : canSubmitGeneric

  const errorMessage =
    s.error &&
    ("message" in s.error ? s.error.message : t("invalidCredentials"))

  return (
    <Dialog open={s.open} onOpenChange={(v) => !v && s.cancel()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {s.mode === "github" ? (
              <Github className="h-4 w-4" />
            ) : (
              <KeyRound className="h-4 w-4" />
            )}
            {s.mode === "github" ? t("githubTitle") : t("title")}
          </DialogTitle>
          <DialogDescription>
            {s.mode === "github" ? t("githubDescription") : t("description")}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {s.mode === "github" ? (
            /* ---- GitHub Token Mode ---- */
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-xs font-medium text-muted-foreground">
                  {t("githubToken")}
                </label>
                <Button
                  type="button"
                  variant="link"
                  size="xs"
                  className="h-auto p-0 text-xs"
                  onClick={() => void s.generateToken()}
                  disabled={s.submitting}
                >
                  {t("generateToken")}
                  <ExternalLink className="ml-1 h-3 w-3" />
                </Button>
              </div>
              <div className="relative">
                <Input
                  type={s.showToken ? "text" : "password"}
                  value={s.token}
                  onChange={(e) => s.setToken(e.target.value)}
                  placeholder={t("githubTokenPlaceholder")}
                  disabled={s.submitting}
                  className="pr-9"
                  autoFocus
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && canSubmitGitHub) s.submit()
                  }}
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 p-0"
                  onClick={s.toggleShowToken}
                  tabIndex={-1}
                >
                  {s.showToken ? (
                    <EyeOff className="h-3.5 w-3.5" />
                  ) : (
                    <Eye className="h-3.5 w-3.5" />
                  )}
                </Button>
              </div>
              <p className="text-[11px] text-muted-foreground">
                {t("githubTokenHint")}
              </p>
            </div>
          ) : (
            /* ---- Generic Mode ---- */
            <>
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground">
                  {t("username")}
                </label>
                <Input
                  value={s.username}
                  onChange={(e) => s.setUsername(e.target.value)}
                  placeholder={t("usernamePlaceholder")}
                  disabled={s.submitting}
                  autoFocus
                />
              </div>
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground">
                  {t("password")}
                </label>
                <div className="relative">
                  <Input
                    type={s.showPassword ? "text" : "password"}
                    value={s.password}
                    onChange={(e) => s.setPassword(e.target.value)}
                    placeholder={t("passwordPlaceholder")}
                    disabled={s.submitting}
                    className="pr-9"
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && canSubmitGeneric) s.submit()
                    }}
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="xs"
                    className="absolute right-1 top-1/2 -translate-y-1/2 h-6 w-6 p-0"
                    onClick={s.toggleShowPassword}
                    tabIndex={-1}
                  >
                    {s.showPassword ? (
                      <EyeOff className="h-3.5 w-3.5" />
                    ) : (
                      <Eye className="h-3.5 w-3.5" />
                    )}
                  </Button>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {t("passwordHint")}
                </p>
              </div>
              <label className="inline-flex items-center gap-2 text-xs cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={s.saveCredentials}
                  onChange={(e) => s.setSaveCredentials(e.target.checked)}
                  disabled={s.submitting}
                />
                {t("saveCredentials")}
              </label>
            </>
          )}

          {errorMessage && (
            <div className="rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
              {errorMessage}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={s.cancel} disabled={s.submitting}>
            {t("cancel")}
          </Button>
          <Button onClick={s.submit} disabled={s.submitting || !canSubmit}>
            {s.submitting ? (
              <>
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("authenticating")}
              </>
            ) : s.mode === "github" ? (
              t("githubAuthenticate")
            ) : (
              t("authenticate")
            )}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
