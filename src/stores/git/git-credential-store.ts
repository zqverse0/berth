import { create } from "zustand"
import { randomUUID } from "@/lib/utils"
import { openUrl } from "@/lib/platform"
import { extractAppCommandError, toErrorMessage } from "@/lib/app-error"
import type { GitCredentials } from "@/lib/types"
import {
  gitListRemotes,
  validateGitHubToken,
  getGitHubAccounts,
  updateGitHubAccounts,
  saveAccountToken,
} from "@/lib/api"

/**
 * Git credential dialog state machine as a Zustand store — migrated from a
 * React context whose ~10 useState flips re-rendered every
 * `GitCredentialProvider` child on each keystroke. The dialog is the only
 * subscriber; `withCredentialRetry` reads fresh state via `getState()` so the
 * old ref-syncing useEffects are gone. Actions are reference-stable, and
 * translated strings stay out of the store — validation errors use the
 * `{ invalid: true }` sentinel and the dialog renders it as
 * `t("invalidCredentials")`.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Hint for identifying the remote when credentials are needed.
 * - `folderPath`: detect remote from an existing repo's origin URL.
 * - `remoteUrl`: use this URL directly (e.g. for clone operations).
 */
export type GitRemoteHint = { folderPath: string } | { remoteUrl: string }

export type DialogMode = "github" | "generic"

/**
 * Dialog error: a raw message, or the sentinel for the localized
 * "invalid credentials" copy (the store must not depend on next-intl).
 */
export type GitCredentialError = { message: string } | { invalid: true }

/** Resolve callback of the operation currently waiting on the dialog. */
let pendingResolve: ((credentials: GitCredentials | null) => void) | null = null

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isAuthError(error: unknown): boolean {
  const appError = extractAppCommandError(error)
  if (appError?.code === "authentication_failed") return true

  const msg = appError?.detail ?? appError?.message ?? String(error)
  const lower = msg.toLowerCase()
  return (
    lower.includes("authentication failed") ||
    lower.includes("could not read username") ||
    lower.includes("could not read password") ||
    lower.includes("logon failed")
  )
}

function extractHost(url: string): string | null {
  const trimmed = url.trim()
  // https://github.com/...
  const httpsMatch = trimmed.match(/^https?:\/\/(?:[^@]+@)?([^/:]+)/)
  if (httpsMatch) return httpsMatch[1].toLowerCase()
  // git@github.com:...
  const sshMatch = trimmed.match(/@([^/:]+)[:/]/)
  if (sshMatch) return sshMatch[1].toLowerCase()
  return null
}

function isGitHubHost(host: string | null): boolean {
  return host === "github.com"
}

async function resolveRemoteHost(hint: GitRemoteHint): Promise<string | null> {
  if ("remoteUrl" in hint) {
    return extractHost(hint.remoteUrl)
  }
  try {
    const remotes = await gitListRemotes(hint.folderPath)
    const origin = remotes.find((r) => r.name === "origin") ?? remotes[0]
    if (!origin) return null
    return extractHost(origin.url)
  } catch {
    return null
  }
}

/** Save generic credentials as a git account for future operations. */
async function saveGenericAccount(
  host: string | null,
  creds: GitCredentials
): Promise<void> {
  const serverUrl = host ? `https://${host}` : "https://unknown"
  try {
    const existing = await getGitHubAccounts()
    const isDuplicate = existing.accounts.some(
      (a) => a.username === creds.username && extractHost(a.server_url) === host
    )
    if (!isDuplicate) {
      const newId = randomUUID()
      await saveAccountToken(newId, creds.password)
      await updateGitHubAccounts({
        accounts: [
          ...existing.accounts,
          {
            id: newId,
            server_url: serverUrl,
            username: creds.username,
            scopes: [],
            avatar_url: null,
            is_default: existing.accounts.length === 0,
            created_at: new Date().toISOString(),
          },
        ],
      })
    }
  } catch {
    // Non-critical — just skip saving
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

interface GitCredentialState {
  open: boolean
  mode: DialogMode
  remoteHost: string | null
  /** Generic mode fields */
  username: string
  password: string
  showPassword: boolean
  /** GitHub mode field */
  token: string
  showToken: boolean
  /** Save credentials checkbox (generic mode) */
  saveCredentials: boolean
  submitting: boolean
  error: GitCredentialError | null

  /** Text inputs clear the error on change (same as the old onChange). */
  setUsername: (value: string) => void
  setPassword: (value: string) => void
  setToken: (value: string) => void
  toggleShowPassword: () => void
  toggleShowToken: () => void
  setSaveCredentials: (checked: boolean) => void

  /** Open the "generate token" page on the remote host. */
  generateToken: () => Promise<void>
  /** Dismiss the dialog — resolves the pending operation with null. */
  cancel: () => void
  /** Submit the current mode's form (fire-and-forget; errors land in state). */
  submit: () => void
}

export const useGitCredentialStore = create<GitCredentialState>()(
  (set, get) => ({
    open: false,
    mode: "generic",
    remoteHost: null,
    username: "",
    password: "",
    showPassword: false,
    token: "",
    showToken: false,
    saveCredentials: true,
    submitting: false,
    error: null,

    setUsername: (value) => set({ username: value, error: null }),
    setPassword: (value) => set({ password: value, error: null }),
    setToken: (value) => set({ token: value, error: null }),
    toggleShowPassword: () => set((s) => ({ showPassword: !s.showPassword })),
    toggleShowToken: () => set((s) => ({ showToken: !s.showToken })),
    setSaveCredentials: (checked) => set({ saveCredentials: checked }),

    generateToken: async () => {
      const host = get().remoteHost || "github.com"
      const base = `https://${host}`
      const params = new URLSearchParams({
        description: "berth",
        scopes: "repo,read:org,workflow,gist,read:user,user:email",
      })
      try {
        await openUrl(`${base}/settings/tokens/new?${params.toString()}`)
      } catch {
        // ignore
      }
    },

    cancel: () => {
      set({ open: false })
      pendingResolve?.(null)
      pendingResolve = null
    },

    submit: () => {
      const s = get()
      if (s.mode === "github") {
        void submitGitHub(set, get)
      } else {
        submitGeneric(set, get)
      }
    },
  })
)

async function submitGitHub(
  set: (partial: Partial<GitCredentialState>) => void,
  get: () => GitCredentialState
): Promise<void> {
  const trimmedToken = get().token.trim()
  if (!trimmedToken) return

  set({ submitting: true, error: null })

  try {
    const { remoteHost } = get()
    const serverUrl = remoteHost
      ? `https://${remoteHost}`
      : "https://github.com"

    const result = await validateGitHubToken(serverUrl, trimmedToken)
    if (!result.success) {
      set({
        error: result.message ? { message: result.message } : { invalid: true },
        submitting: false,
      })
      return
    }

    // Save as GitHub account
    try {
      const existing = await getGitHubAccounts()
      const isDuplicate = existing.accounts.some(
        (a) =>
          a.username === result.username &&
          extractHost(a.server_url) === remoteHost
      )
      if (!isDuplicate) {
        const newAccount = {
          id: randomUUID(),
          server_url: serverUrl,
          username: result.username ?? "unknown",
          scopes: result.scopes,
          avatar_url: result.avatar_url,
          is_default: existing.accounts.length === 0,
          created_at: new Date().toISOString(),
        }
        await saveAccountToken(newAccount.id, trimmedToken)
        await updateGitHubAccounts({
          accounts: [...existing.accounts, newAccount],
        })
      }
    } catch {
      // Saving account failed — not critical, continue with auth
    }

    const creds: GitCredentials = {
      username: result.username ?? "unknown",
      password: trimmedToken,
    }
    pendingResolve?.(creds)
    pendingResolve = null
  } catch (err) {
    set({ error: { message: toErrorMessage(err) }, submitting: false })
  }
}

function submitGeneric(
  set: (partial: Partial<GitCredentialState>) => void,
  get: () => GitCredentialState
): void {
  const { username, password } = get()
  if (!username.trim() || !password.trim()) return
  const creds: GitCredentials = {
    username: username.trim(),
    password: password.trim(),
  }
  set({ submitting: true })
  pendingResolve?.(creds)
  pendingResolve = null
}

/** Reset form fields and open the dialog in the given mode. */
function requestCredentials(
  dialogMode: DialogMode,
  host: string | null
): Promise<GitCredentials | null> {
  return new Promise((resolve) => {
    pendingResolve = resolve
    useGitCredentialStore.setState({
      username: "",
      password: "",
      showPassword: false,
      token: "",
      showToken: false,
      saveCredentials: true,
      error: null,
      submitting: false,
      mode: dialogMode,
      remoteHost: host,
      open: true,
    })
  })
}

/** Auth failed again after a retry — arm a new pending promise. */
function setRetryPending(): void {
  useGitCredentialStore.setState({
    submitting: false,
    error: { invalid: true },
  })
}

/** Close the dialog without touching the pending callback (already consumed). */
function closeDialog(): void {
  useGitCredentialStore.setState({ open: false })
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Stable bundle — reference never changes, consumers re-render zero times. */
const gitCredentialApi = {
  withCredentialRetry,
}

export function useGitCredential(): typeof gitCredentialApi {
  return gitCredentialApi
}

export function useOptionalGitCredential(): typeof gitCredentialApi {
  return gitCredentialApi
}

/**
 * Wrap an async git operation with automatic credential retry.
 *
 * - For GitHub remotes: shows a token dialog, validates via API,
 *   saves as a GitHub account, then retries the operation.
 * - For other remotes: shows a generic username/password dialog.
 */
export async function withCredentialRetry<T>(
  operation: (credentials?: GitCredentials) => Promise<T>,
  hint: GitRemoteHint
): Promise<T> {
  // First attempt — no explicit credentials
  try {
    return await operation()
  } catch (firstError) {
    if (!isAuthError(firstError)) throw firstError

    // Detect remote host to decide dialog mode
    const host = await resolveRemoteHost(hint)
    const dialogMode: DialogMode = isGitHubHost(host) ? "github" : "generic"

    // Helper: save credentials after successful operation
    const maybeSave = async (c: GitCredentials) => {
      const s = useGitCredentialStore.getState()
      if (s.mode === "generic" && s.saveCredentials) {
        await saveGenericAccount(s.remoteHost, c)
      }
      // GitHub mode saves during submit, no extra work needed
    }

    // Show credential dialog for the first time
    let creds = await requestCredentials(dialogMode, host)
    if (!creds) {
      closeDialog()
      throw firstError
    }

    // Retry loop — keep trying until success or user cancels
    let lastError: unknown = firstError

    while (true) {
      try {
        const result = await operation(creds)
        await maybeSave(creds)
        closeDialog()
        return result
      } catch (retryError) {
        lastError = retryError
        if (!isAuthError(retryError)) {
          // Non-auth error — stop retrying
          closeDialog()
          throw retryError
        }
        // Auth error — show error and let user try again
        setRetryPending()
        const retryCreds = await new Promise<GitCredentials | null>(
          (resolve) => {
            pendingResolve = resolve
          }
        )
        if (!retryCreds) {
          closeDialog()
          throw lastError
        }
        creds = retryCreds
      }
    }
  }
}

/** Reset store state to a clean slate. Used by tests. */
export function resetGitCredentialStore(): void {
  pendingResolve = null
  useGitCredentialStore.setState({
    open: false,
    mode: "generic",
    remoteHost: null,
    username: "",
    password: "",
    showPassword: false,
    token: "",
    showToken: false,
    saveCredentials: true,
    submitting: false,
    error: null,
  })
}
