"use client"

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { useTranslations } from "next-intl"
import { toast } from "@/lib/notify"
import {
  type AppUpdateState,
  getAppUpdateState,
  normalizeAppUpdateError,
  restartApp,
  startAppUpdate,
  subscribeAppUpdateState,
} from "@/lib/updater"

const IDLE_STATE: AppUpdateState = { seq: 0, status: "idle" }

const LIFECYCLES = new Set([
  "idle",
  "downloading",
  "installing",
  "ready_to_restart",
  "restarting",
  "error",
])

/** Reject payloads that aren't a well-formed AppUpdateState. Without this an
 * undefined `seq` would poison the monotonic guard. */
function isAppUpdateState(x: unknown): x is AppUpdateState {
  if (!x || typeof x !== "object") return false
  const c = x as Record<string, unknown>
  return typeof c.seq === "number" && LIFECYCLES.has(c.status as string)
}

export interface UpdateContextValue {
  /** Backend-owned lifecycle. The single source of truth, re-synced on mount
   * so it survives navigation and reloads. */
  state: AppUpdateState
  /** A download/install is actively in progress. */
  isUpdating: boolean
  /** A relaunch has been requested and is in progress. */
  isRestarting: boolean
  /** True once the first authoritative state has landed. Before this, `state`
   * is the default `idle` placeholder and must not be treated as a real
   * backend status. */
  hydrated: boolean
  /** Any action (update / restart) is in flight — for disabling
   * controls without each consumer re-deriving it. */
  isBusy: boolean
  /** Begin (or attach to) a background download+install of the available
   * update. Progress arrives via {@link state}. */
  startUpdate: () => Promise<void>
  /** Relaunch into the staged update. Call when `state.status` is
   * `ready_to_restart`. */
  restart: () => Promise<void>
}

const UpdateContext = createContext<UpdateContextValue | null>(null)

export function UpdateProvider({ children }: { children: React.ReactNode }) {
  const t = useTranslations("SystemSettings")
  const [state, setState] = useState<AppUpdateState>(IDLE_STATE)
  // True from the moment a relaunch is requested until it completes (or the app
  // is gone). Covers the window between the click and the backend's
  // `restarting` event — where status would not yet mark us busy — so a
  // second click can't re-trigger the relaunch.
  const [isRestarting, setIsRestarting] = useState(false)
  // False until the first authoritative state (snapshot or event) lands. Until
  // then `state` is the default `idle` placeholder, which consumers must not
  // treat as a real "idle" backend status.
  const [hydrated, setHydrated] = useState(false)

  // Highest sequence applied. Guards against a late snapshot clobbering a
  // fresher update event.
  const latestSeqRef = useRef(0)
  const applyState = useCallback((next: unknown) => {
    if (!isAppUpdateState(next)) return
    if (next.seq < latestSeqRef.current) return
    latestSeqRef.current = next.seq
    setState(next)
    setHydrated(true)
  }, [])

  // Arm the subscription BEFORE fetching the snapshot so no transition is
  // missed in the gap, then fetch the current snapshot.
  useEffect(() => {
    let cancelled = false
    let unsub: (() => void) | null = null

    const resync = async () => {
      try {
        const snap = await getAppUpdateState()
        if (cancelled) return
        applyState(snap)
      } catch (err) {
        console.error("[Update] snapshot failed:", err)
      }
    }

    const arm = async () => {
      try {
        const u = await subscribeAppUpdateState((s) => {
          if (!cancelled) applyState(s)
        })
        // If we unmounted while subscribing, the cleanup below already ran with
        // a null `unsub` — tear the subscription down here so it doesn't leak.
        if (cancelled) {
          u()
          return
        }
        unsub = u
      } catch (err) {
        // Not fatal: the snapshot below still seeds current state, and a later
        // reconnect re-arms. The login screen (no auth yet) lands here.
        console.error("[Update] subscribe failed:", err)
      }
      if (!cancelled) await resync()
    }

    void arm()

    return () => {
      cancelled = true
      unsub?.()
    }
  }, [applyState])

  // ─── Actions ────────────────────────────────────────────────────────────

  const startUpdate = useCallback(async () => {
    try {
      const snap = await startAppUpdate()
      applyState(snap)
    } catch (err) {
      // The detached backend task reports its own failures via the state
      // event; this only fires if the kickoff call itself failed.
      const { rawMessage } = normalizeAppUpdateError(err)
      toast.error(t("installFailed", { message: rawMessage }))
      console.error("[Update] start failed:", err)
    }
  }, [applyState, t])

  const restart = useCallback(async () => {
    setIsRestarting(true)
    try {
      await restartApp()
      // Success: the app is relaunching; stay busy until it does.
    } catch (err) {
      setIsRestarting(false)
      const { rawMessage } = normalizeAppUpdateError(err)
      toast.error(t("installFailed", { message: rawMessage }))
      console.error("[Update] restart failed:", err)
    }
  }, [t])

  const isUpdating =
    state.status === "downloading" || state.status === "installing"
  const isBusy = isUpdating || isRestarting || state.status === "restarting"

  const value = useMemo<UpdateContextValue>(
    () => ({
      state,
      isUpdating,
      isRestarting,
      hydrated,
      isBusy,
      startUpdate,
      restart,
    }),
    [state, isUpdating, isRestarting, hydrated, isBusy, startUpdate, restart]
  )

  return (
    <UpdateContext.Provider value={value}>{children}</UpdateContext.Provider>
  )
}

/** Access the app-update controller. Returns null outside a provider, so the
 * global indicator can render nothing rather than throw on surfaces (login,
 * aux windows) that don't mount it. */
export function useAppUpdate(): UpdateContextValue | null {
  return useContext(UpdateContext)
}
