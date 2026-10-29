import { getTransport } from "../transport"
import type {
  LogRecord,
  LogSettings,
  LogSettingsView,
} from "../domain-types/logging"

/** Live-tail channel: one event per appended log record. */
export const LOG_APPENDED_EVENT = "logs://appended"
/** Cross-window broadcast announcing a log-level change. */
export const LOG_SETTINGS_CHANGED_EVENT = "log-settings://changed"

export async function getLogSettings(): Promise<LogSettingsView> {
  return getTransport().call("get_log_settings")
}

export async function setLogSettings(
  settings: LogSettings
): Promise<LogSettings> {
  return getTransport().call("set_log_settings", { settings })
}

export async function getRecentLogs(params: {
  limit: number
  minLevel?: string
  search?: string
}): Promise<LogRecord[]> {
  return getTransport().call("get_recent_logs", {
    limit: params.limit,
    minLevel: params.minLevel,
    search: params.search,
  })
}

/** Ensure the logs dir exists and return its absolute path (desktop only). */
export async function openLogsDir(): Promise<string> {
  return getTransport().call("open_logs_dir")
}

export async function subscribeLogAppended(
  handler: (record: LogRecord) => void
): Promise<() => void> {
  return getTransport().subscribe<LogRecord>(LOG_APPENDED_EVENT, handler)
}

export async function subscribeLogSettingsChanged(
  handler: (settings: LogSettings) => void
): Promise<() => void> {
  return getTransport().subscribe<LogSettings>(
    LOG_SETTINGS_CHANGED_EVENT,
    handler
  )
}
