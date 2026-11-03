import { assertTauriEnvironment, detectEnvironment } from "./detect"
import type { Transport } from "./types"
import { TauriTransport } from "./tauri-transport"
import { installPerfBridge, withPerf } from "@/lib/perf"
import {
  deviceCall,
  deviceSession,
  parseDeviceRef,
  routeArgs,
  subscribeDevice,
  subscribeDevices,
} from "./device"

export type { Transport, UnsubscribeFn, CallOptions } from "./types"
export { isRemoteBrowser } from "./detect"

let _shellTransport: Transport | null = null

function createTauriTransport(): Transport {
  assertTauriEnvironment()
  // Install the developer console bridge once (no-op in production / SSR).
  installPerfBridge()
  // Wrap with perf proxy when enabled; returns base unchanged when disabled.
  return withDeviceRouting(withPerf(new TauriTransport()))
}

/** 到这台设备 GUI 的会话（`./device`）：本机回环端口由 `device.connect` 给出。 */
function device(deviceId: number) {
  return deviceSession(deviceId, async () => {
    const { deviceConnect } = await import("@/lib/devices")
    return (await deviceConnect(deviceId)).port
  })
}

/** 连上这台设备的 GUI（对方未运行时在后台重试）；连上后它的终端进入本机终端清单。 */
export function connectDevice(deviceId: number): void {
  device(deviceId)
}

/** 指向对方的调用发给那台设备（见 `./device`），其余照旧走本机。 */
function withDeviceRouting(base: Transport): Transport {
  return {
    async call(command, args, options) {
      const routed = routeArgs(args)
      const target = options?.device ?? routed?.deviceId
      if (target == null) return base.call(command, args, options)
      if (routed && routed.deviceId !== target)
        throw new Error("a call cannot span two devices")
      return deviceCall(
        device(target),
        target,
        command,
        routed?.args ?? args ?? {}
      )
    },
    async callRaw(command, body, headers) {
      // 原始字节调用只有终端写入：按头里的终端 id 认设备。
      const ref = parseDeviceRef(
        decodeURIComponent(headers["x-berth-terminal-id"] ?? "")
      )
      if (!ref) return base.callRaw!(command, body, headers)
      return deviceCall(device(ref.deviceId), ref.deviceId, command, body, {
        ...headers,
        "x-berth-terminal-id": encodeURIComponent(ref.value),
      })
    },
    async subscribe<T>(event: string, handler: (payload: T) => void) {
      // 按对方终端 id 订阅的事件（如 `terminal://exit/<id>`）只在那台设备上订。
      const at = event.indexOf("berth-device://")
      const ref = at < 0 ? null : parseDeviceRef(event.slice(at))
      const handle = handler as (payload: unknown) => void
      if (ref)
        return subscribeDevice(
          device(ref.deviceId),
          event.slice(0, at) + ref.value,
          handle
        )
      const local = await base.subscribe(event, handler)
      const remote = subscribeDevices(event, handle)
      return () => {
        local()
        remote()
      }
    },
    isDesktop: () => base.isDesktop(),
  }
}

export function getTransport(): Transport {
  if (!_shellTransport) {
    _shellTransport = createTauriTransport()
  }
  return _shellTransport
}

export function isDesktop(): boolean {
  return detectEnvironment() === "tauri"
}
