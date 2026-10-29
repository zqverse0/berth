// --- Logging ---

export type LogLevel = "off" | "error" | "warn" | "info" | "debug" | "trace"

/** A per-target level override, e.g. `berth_lib::acp` at `debug` while the
 * global level stays `info`. `target` is a tracing target (a Rust module path). */
export interface TargetDirective {
  target: string
  level: LogLevel
}

export interface LogSettings {
  level: LogLevel
  /** Omitted by the backend when empty; treat `undefined` as `[]`. */
  targets?: TargetDirective[]
}

/** What the Logs settings UI reads: the persisted level + per-target overrides,
 * plus whether an env var (BERTH_LOG/RUST_LOG) currently locks the controls
 * (env owns the live level). */
export interface LogSettingsView {
  level: LogLevel
  targets: TargetDirective[]
  env_locked: boolean
}

/** One enclosing span in an event's scope: its name + recorded fields. Ordered
 * root→leaf in `LogRecord.spans`. */
export interface SpanInfo {
  name: string
  fields: Record<string, string>
}

/** One captured log event. `level` is tracing's uppercase string
 * ("ERROR".."TRACE"); `target` is the emitting module path. `fields` holds
 * the event's own key-value fields and `spans` the enclosing span chain; both
 * are empty for plain-message logs. */
export interface LogRecord {
  seq: number
  timestamp_ms: number
  level: string
  target: string
  message: string
  fields: Record<string, string>
  spans: SpanInfo[]
}
