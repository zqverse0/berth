"use client"

import { useCallback, useEffect, useState } from "react"
import { Loader2, MonitorCog, RefreshCw, SquareTerminal } from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "@/lib/notify"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import {
  getAvailableTerminalShells,
  getSystemRenderingSettings,
  getSystemTerminalSettings,
  probeTerminalShellPath,
  updateSystemRenderingSettings,
  updateSystemTerminalSettings,
} from "@/lib/api"
import type { AvailableTerminalShells, TerminalShellOption } from "@/lib/types"
import { usePlatform } from "@/hooks/use-platform"
import { relaunchApp } from "@/lib/updater"
import { toErrorMessage } from "@/lib/app-error"

const TERMINAL_SHELL_OPTION_SYSTEM = "system"
const TERMINAL_SHELL_OPTION_CUSTOM = "custom"

/// Pick which dropdown row matches a stored `default_shell` value:
/// - null  → "system"
/// - matches a predefined option's `value` → that option's id
/// - anything else → "custom" (user-supplied path)
function resolveSelectedShellId(
  storedShell: string | null,
  options: TerminalShellOption[]
): string {
  if (!storedShell) return TERMINAL_SHELL_OPTION_SYSTEM
  const matched = options.find(
    (opt) => opt.value !== null && opt.value === storedShell
  )
  return matched?.id ?? TERMINAL_SHELL_OPTION_CUSTOM
}

// Captured the first time the rendering section loads: represents the value
// the running webview process was launched with. Survives Settings surface
// remounts so the "Restart now" banner doesn't vanish if the user navigates
// away and back without restarting.
let processStartDisableHwAccel: boolean | null = null

export function SystemRuntimeSettings() {
  const t = useTranslations("SystemRuntimeSettings")
  // Backend-driven shell label keys are dynamic strings, so widen `t`
  // for that single call site rather than casting at every use.
  const tDynamic = t as unknown as (key: string) => string
  const { isWindows } = usePlatform()

  // 硬件加速开关只对 Windows WebView2 生效。
  const renderingSectionVisible = isWindows

  const [loadingTerminal, setLoadingTerminal] = useState(true)
  const [terminalLoadError, setTerminalLoadError] = useState<string | null>(
    null
  )
  const [loadingRendering, setLoadingRendering] = useState(
    renderingSectionVisible
  )
  const [renderingLoadError, setRenderingLoadError] = useState<string | null>(
    null
  )

  const [savingTerminal, setSavingTerminal] = useState(false)
  const [availableShells, setAvailableShells] =
    useState<AvailableTerminalShells | null>(null)
  const [selectedShellId, setSelectedShellId] = useState<string>(
    TERMINAL_SHELL_OPTION_SYSTEM
  )
  const [customShellPath, setCustomShellPath] = useState<string>("")
  const [customPathExists, setCustomPathExists] = useState<boolean | null>(null)

  const [disableHwAccel, setDisableHwAccel] = useState(false)
  const [savingRendering, setSavingRendering] = useState(false)
  const [persistedDisableHwAccel, setPersistedDisableHwAccel] = useState(false)
  const [processStartLoaded, setProcessStartLoaded] = useState(
    processStartDisableHwAccel !== null
  )
  const renderingDirty =
    processStartLoaded && persistedDisableHwAccel !== processStartDisableHwAccel

  const loadTerminalSettings = useCallback(async () => {
    setLoadingTerminal(true)
    setTerminalLoadError(null)

    try {
      const [terminalSettings, terminalShells] = await Promise.all([
        getSystemTerminalSettings(),
        getAvailableTerminalShells(),
      ])
      setAvailableShells(terminalShells)
      const initialId = resolveSelectedShellId(
        terminalSettings.default_shell,
        terminalShells.options
      )
      setSelectedShellId(initialId)
      if (initialId === TERMINAL_SHELL_OPTION_CUSTOM) {
        setCustomShellPath(terminalSettings.default_shell ?? "")
        setCustomPathExists(
          terminalSettings.default_shell
            ? await probeTerminalShellPath(terminalSettings.default_shell)
            : null
        )
      } else {
        setCustomShellPath("")
        setCustomPathExists(null)
      }
    } catch (err) {
      setTerminalLoadError(toErrorMessage(err))
      console.error("[Settings] load terminal settings failed:", err)
    } finally {
      setLoadingTerminal(false)
    }
  }, [])

  const loadRenderingSettings = useCallback(async () => {
    if (!renderingSectionVisible) return

    setLoadingRendering(true)
    setRenderingLoadError(null)
    try {
      const settings = await getSystemRenderingSettings()
      const value = settings.disable_hardware_acceleration
      setDisableHwAccel(value)
      setPersistedDisableHwAccel(value)
      if (processStartDisableHwAccel === null) {
        processStartDisableHwAccel = value
        setProcessStartLoaded(true)
      }
    } catch (err) {
      setRenderingLoadError(toErrorMessage(err))
      console.error("[Settings] load rendering settings failed:", err)
    } finally {
      setLoadingRendering(false)
    }
  }, [renderingSectionVisible])

  useEffect(() => {
    void loadTerminalSettings()
  }, [loadTerminalSettings])

  useEffect(() => {
    void loadRenderingSettings()
  }, [loadRenderingSettings])

  const persistTerminalShell = useCallback(
    async (defaultShell: string | null) => {
      setSavingTerminal(true)
      try {
        const result = await updateSystemTerminalSettings({
          default_shell: defaultShell,
        })
        // Re-fetch options to refresh `exists` flags (e.g. user just installed
        // pwsh, or backend filter dropped a cross-platform stale value).
        const refreshedShells = await getAvailableTerminalShells()
        setAvailableShells(refreshedShells)
        const nextSelectedId = resolveSelectedShellId(
          result.default_shell,
          refreshedShells.options
        )
        setSelectedShellId(nextSelectedId)
        if (nextSelectedId === TERMINAL_SHELL_OPTION_CUSTOM) {
          setCustomShellPath(result.default_shell ?? "")
          setCustomPathExists(
            result.default_shell
              ? await probeTerminalShellPath(result.default_shell)
              : null
          )
        } else {
          setCustomShellPath("")
          setCustomPathExists(null)
        }
      } catch (err) {
        const message = toErrorMessage(err)
        toast.error(t("terminalSaveFailed", { message }))
      } finally {
        setSavingTerminal(false)
      }
    },
    [t]
  )

  const onShellSelectChange = useCallback(
    (nextId: string) => {
      setSelectedShellId(nextId)
      if (nextId === TERMINAL_SHELL_OPTION_CUSTOM) {
        // Don't persist yet — wait for user to type a path and press Save.
        setCustomShellPath("")
        setCustomPathExists(null)
        return
      }
      const matched = availableShells?.options.find((opt) => opt.id === nextId)
      void persistTerminalShell(matched?.value ?? null)
    },
    [availableShells, persistTerminalShell]
  )

  const onCustomPathSave = useCallback(() => {
    const trimmed = customShellPath.trim()
    if (!trimmed) return
    void persistTerminalShell(trimmed)
  }, [customShellPath, persistTerminalShell])

  const saveRenderingSettings = useCallback(
    async (next: boolean, prev: boolean) => {
      setSavingRendering(true)
      try {
        const result = await updateSystemRenderingSettings({
          disable_hardware_acceleration: next,
        })
        setDisableHwAccel(result.disable_hardware_acceleration)
        setPersistedDisableHwAccel(result.disable_hardware_acceleration)
      } catch (err) {
        setDisableHwAccel(prev)
        const message = toErrorMessage(err)
        toast.error(t("renderingSaveFailed", { message }))
      } finally {
        setSavingRendering(false)
      }
    },
    [t]
  )

  const restartNow = useCallback(async () => {
    try {
      await relaunchApp()
    } catch (err) {
      const message = toErrorMessage(err)
      toast.error(t("restartFailed", { message }))
    }
  }, [t])

  const loadState = (
    loading: boolean,
    error: string | null,
    retry: () => void
  ) => {
    if (loading) {
      return (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
          {t("loading")}
        </div>
      )
    }
    if (!error) return null
    return (
      <div className="flex items-center justify-between gap-3 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400">
        <span>{t("loadFailed", { message: error })}</span>
        <Button size="sm" variant="outline" onClick={retry}>
          <RefreshCw className="h-3.5 w-3.5" />
          {t("retry")}
        </Button>
      </div>
    )
  }

  return (
    <>
      <section className="rounded-xl border bg-card p-4 space-y-4">
        <div className="flex items-center gap-2">
          <SquareTerminal className="h-4 w-4 text-muted-foreground" />
          <h2 className="text-sm font-semibold">{t("terminalTitle")}</h2>
        </div>

        <p className="text-xs text-muted-foreground leading-5">
          {t("terminalDescription")}
        </p>

        {loadState(loadingTerminal, terminalLoadError, () => {
          void loadTerminalSettings()
        })}

        {!loadingTerminal && !terminalLoadError && (
          <div className="space-y-2">
            <label className="text-xs font-medium text-muted-foreground">
              {t("defaultTerminalShell")}
            </label>
            <Select
              value={selectedShellId}
              onValueChange={onShellSelectChange}
              disabled={savingTerminal || !availableShells}
            >
              <SelectTrigger className="w-full sm:w-64">
                <SelectValue />
              </SelectTrigger>
              <SelectContent align="start">
                {availableShells?.options.map((opt) => (
                  <SelectItem key={opt.id} value={opt.id}>
                    <span className="flex items-center gap-2">
                      <span>{tDynamic(opt.label_key)}</span>
                      {!opt.exists && !opt.accepts_custom_path && (
                        <span className="text-[10px] text-muted-foreground">
                          ({t("terminalShellNotInstalled")})
                        </span>
                      )}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {availableShells && (
              <p className="text-[11px] text-muted-foreground">
                {t("terminalCurrentShell", {
                  path: availableShells.resolved_shell,
                })}
              </p>
            )}

            {selectedShellId === TERMINAL_SHELL_OPTION_CUSTOM && (
              <div className="space-y-2 pt-2">
                <label className="text-xs font-medium text-muted-foreground">
                  {t("terminalShellCustomPath")}
                </label>
                <div className="flex gap-2">
                  <Input
                    value={customShellPath}
                    onChange={(event) => {
                      setCustomShellPath(event.target.value)
                      setCustomPathExists(null)
                    }}
                    placeholder={t("terminalShellCustomPlaceholder")}
                    disabled={savingTerminal}
                    className="flex-1"
                  />
                  <Button
                    size="sm"
                    onClick={onCustomPathSave}
                    disabled={savingTerminal || !customShellPath.trim()}
                  >
                    {t("terminalShellCustomSave")}
                  </Button>
                </div>
                {customPathExists === false && customShellPath.trim() && (
                  <p className="text-[11px] text-amber-500">
                    {t("terminalShellNotFoundWarning")}
                  </p>
                )}
                <p className="text-[11px] text-muted-foreground">
                  {t("terminalShellCustomHint")}
                </p>
              </div>
            )}
          </div>
        )}
      </section>

      {renderingSectionVisible && (
        <section className="rounded-xl border bg-card p-4 space-y-4">
          <div className="flex items-center gap-2">
            <MonitorCog className="h-4 w-4 text-muted-foreground" />
            <h2 className="text-sm font-semibold">{t("renderingTitle")}</h2>
          </div>

          <p className="text-xs text-muted-foreground leading-5">
            {t("renderingDescription")}
          </p>

          {loadState(loadingRendering, renderingLoadError, () => {
            void loadRenderingSettings()
          })}

          {!loadingRendering && !renderingLoadError && (
            <label className="inline-flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={disableHwAccel}
                disabled={savingRendering}
                onChange={(event) => {
                  const next = event.target.checked
                  const prev = disableHwAccel
                  setDisableHwAccel(next)
                  saveRenderingSettings(next, prev)
                }}
              />
              {t("disableHardwareAcceleration")}
            </label>
          )}

          {!loadingRendering && !renderingLoadError && renderingDirty && (
            <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/20 px-3 py-2 text-xs">
              <span className="text-muted-foreground">
                {t("restartRequired")}
              </span>
              <Button size="sm" onClick={restartNow} disabled={savingRendering}>
                <RefreshCw className="h-3.5 w-3.5" />
                {t("restartNow")}
              </Button>
            </div>
          )}
        </section>
      )}
    </>
  )
}
