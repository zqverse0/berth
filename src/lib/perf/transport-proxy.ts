/**
 * Transport decorator for automatic IPC measurement.
 *
 * - Disabled → returns the base Transport unchanged (identity preserved).
 * - Enabled  → returns a Proxy that intercepts only `call`, records
 *              timing and outcome, and forwards everything else via Reflect.
 *
 * The Proxy preserves:
 * - Generic call signature (no type widening)
 * - resolve/reject value identity
 * - Optional method existence (callRaw, destroy, etc.)
 * - `this` binding for ALL callable methods (not just `call`), so that
 *   class private fields and internal state work correctly.
 *
 * When enabled, marks the transport as "active" via `setTransportActive(true)`.
 * When disabled, returns `base` with no side effects.
 */

import type { Transport } from "@/lib/transport/types"
import { perfEnabled, setTransportActive } from "./enabled"
import { getCollector, nowMs } from "./collector"

/** runtime bridge 是一个 command 承载多个方法：按方法分开计量，否则看不出是谁慢。 */
function metricName(command: string, args?: Record<string, unknown>): string {
  if (command !== "runtime_bridge_operation") return command
  const method = (args?.args as { method?: unknown } | undefined)?.method
  return typeof method === "string" ? `${command}:${method}` : command
}

/**
 * Wrap a Transport with perf instrumentation.
 * Returns `base` unchanged when disabled.
 */
export function withPerf<T extends Transport>(base: T): T {
  if (!perfEnabled()) return base

  // Mark that the current singleton is actually wrapped.
  setTransportActive(true)

  const handler: ProxyHandler<T> = {
    get(target, prop, receiver) {
      if (prop === "call") {
        // Bind to the original target to preserve class private fields / this.
        const original = Reflect.get(target, prop, target) as Transport["call"]
        const invoke = original.bind(target) as Transport["call"]
        return function perfCall<R>(
          command: string,
          args?: Record<string, unknown>,
          options?: Parameters<Transport["call"]>[2]
        ): Promise<R> {
          const collector = getCollector()
          const start = nowMs()
          const name = metricName(command, args)
          return invoke<R>(command, args, options).then(
            (value) => {
              collector.record("ipc", name, start, nowMs() - start, true)
              return value
            },
            (err) => {
              collector.record("ipc", name, start, nowMs() - start, false)
              throw err
            }
          )
        }
      }

      const value = Reflect.get(target, prop, receiver)

      // Bind all other callable properties to the original target so that
      // class private fields and internal `this` references work correctly.
      // This covers optional methods like subscribe, callRaw and destroy.
      if (typeof value === "function" && typeof prop === "string") {
        return value.bind(target)
      }

      return value
    },
  }

  return new Proxy(base, handler) as T
}
