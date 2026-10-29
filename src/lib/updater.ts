import { toErrorMessage } from "./app-error"
import { getTransport } from "./transport"

// All updater imports are dynamic to avoid crashing outside the Tauri runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Update = any

export interface AppUpdateCheckResult {
  currentVersion: string
  update: Update | null
}

// ─── Backend-owned update lifecycle ────────────────────────────────────────
//
// The backend (tauri-plugin-updater) is the single source of truth for an
// in-flight/completed update. The UI subscribes to `app_update_state` and
// re-syncs from a snapshot on mount, so progress survives navigating between
// settings pages, closing the page, or a reload.
// Mirrors `src-tauri/src/update/state.rs` (camelCase over the wire).

export type AppUpdateLifecycle =
  | "idle"
  | "downloading"
  | "installing"
  | "ready_to_restart"
  | "restarting"
  | "error"

export interface AppUpdateState {
  /** Monotonic; keep only the highest-seq snapshot/event seen. */
  seq: number
  status: AppUpdateLifecycle
  /** Bytes downloaded so far (downloading only). */
  downloaded?: number
  /** Total bytes from Content-Length, if known. */
  total?: number | null
  /** Target version, once known. */
  version?: string
  /** Raw error message (error only); classify via {@link normalizeAppUpdateError}. */
  error?: string
}

/** Snapshot of the current update state. Call on mount to recover an
 * in-flight download the UI would otherwise have lost. */
export function getAppUpdateState(): Promise<AppUpdateState> {
  return getTransport().call<AppUpdateState>("app_update_state")
}

/** Subscribe to live update-state transitions (download progress, ready,
 * error, restarting). Arm this BEFORE the snapshot fetch so no event is
 * missed. */
export function subscribeAppUpdateState(
  handler: (state: AppUpdateState) => void
): Promise<() => void> {
  return getTransport().subscribe<AppUpdateState>("app_update_state", handler)
}

/** Begin (or attach to) the download+install. Returns immediately with the
 * current snapshot; progress arrives via {@link subscribeAppUpdateState}. The
 * download runs detached in the backend, so it is not bound to this call's
 * lifetime. */
export function startAppUpdate(): Promise<AppUpdateState> {
  return getTransport().call<AppUpdateState>("perform_app_update")
}

/** Relaunch into the freshly-installed bytes. */
export function restartApp(): Promise<void> {
  return getTransport().call("restart_app")
}

export type AppUpdateErrorKind =
  | "source_unreachable"
  | "network"
  | "download_failed"
  | "install_failed"
  | "unknown"

export interface AppUpdateErrorInfo {
  kind: AppUpdateErrorKind
  rawMessage: string
}

export async function getCurrentAppVersion(): Promise<string> {
  try {
    const { getVersion } = await import("@tauri-apps/api/app")
    return await getVersion()
  } catch {
    return "unknown"
  }
}

export async function checkAppUpdate(): Promise<AppUpdateCheckResult> {
  const { getVersion } = await import("@tauri-apps/api/app")
  const { check } = await import("@tauri-apps/plugin-updater")
  const [currentVersion, update] = await Promise.all([getVersion(), check()])
  return { currentVersion, update }
}

export async function relaunchApp(): Promise<void> {
  const { relaunch } = await import("@tauri-apps/plugin-process")
  await relaunch()
}

export async function closeAppUpdate(
  update: NonNullable<Update>
): Promise<void> {
  if (typeof update?.close !== "function") return
  await update.close()
}

export function normalizeAppUpdateError(error: unknown): AppUpdateErrorInfo {
  const rawMessage = toErrorMessage(error)
  const normalized = rawMessage.toLowerCase()

  if (
    normalized.includes("latest.json") ||
    normalized.includes("/releases/latest/download/") ||
    normalized.includes("could not fetch a valid release json")
  ) {
    return { kind: "source_unreachable", rawMessage }
  }

  if (
    normalized.includes("error sending request for url") ||
    normalized.includes("failed to send request") ||
    normalized.includes("network") ||
    normalized.includes("timed out") ||
    normalized.includes("dns") ||
    normalized.includes("connection refused")
  ) {
    return { kind: "network", rawMessage }
  }

  if (
    normalized.includes("download") ||
    normalized.includes("checksum") ||
    normalized.includes("content-length")
  ) {
    return { kind: "download_failed", rawMessage }
  }

  if (
    normalized.includes("install") ||
    normalized.includes("installer") ||
    normalized.includes("permission denied")
  ) {
    return { kind: "install_failed", rawMessage }
  }

  return { kind: "unknown", rawMessage }
}
