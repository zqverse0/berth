/**
 * 设备：可通过 SSH 连接的其他机器（runtime bridge `device.*`，后端 `src-tauri/src/devices.rs`）。
 */
import { useCallback, useEffect, useRef, useState } from "react"
import { runtimeBridgeOperation } from "@/lib/runtime-bridge"
import { subscribe } from "@/lib/platform"
import type { FolderDetail } from "@/lib/types"

export interface Device {
  id: number
  name: string
  /** 传给 ssh 的目标：`user@host`、域名或 `~/.ssh/config` 的 Host 别名。 */
  target: string
  /** 设备在本机的目录：从设备打开的 SSH 终端以它为起始目录，据此归到设备下。 */
  localDir: string
  /** 节点设备（对方装了 berth）：经节点连接操作对方；没装为 `null`（只能开 SSH 终端）。 */
  node?: DeviceNode | null
}

/** 一条节点连接的状态（`berth_node::client::Status`）。 */
export type NodeChannelStatus =
  | { state: "connecting"; attempt: number }
  | { state: "online" }
  | { state: "offline"; error: string; attempt: number; retry_in_ms: number }
  | { state: "failed"; error: string }

export interface DeviceNode {
  /** 对方 berth 的路径。 */
  berth: string
  /** 节点连接的状态；还没建立连接时为 `null`。 */
  status: NodeChannelStatus | null
}

/** 对方打开的一个项目：与本机侧栏同一份 `FolderDetail`（层级、别名、分支、排序）。 */
export type NodeProject = FolderDetail

/** 设备概览（`berth node` 的 `device` 视图）。 */
export interface NodeOverview {
  host: string
  os: string
  projects: NodeProject[]
}

export interface DeviceCheck {
  ok: boolean
  /** 连不上时 ssh 的最后一行错误，或 `device.*` 错误码。 */
  message: string | null
  node?: DeviceNode | null
}

async function call<T>(method: string, params?: Record<string, unknown>) {
  const response = await runtimeBridgeOperation<T>({ method, params })
  if (!response.ok) throw new Error(response.error.message)
  return response.result
}

export const listDevices = () => call<Device[]>("device.list")
/** 测连接；带 `deviceId` 时顺带重新探测对方的 berth（`node` 非空即节点设备）。 */
export const checkDevice = (target: string, deviceId?: number) =>
  call<DeviceCheck>("device.check", { target, deviceId })
/** 先测连接，连得上才保存；失败抛出错误码或 ssh 错误。 */
export const addDevice = (name: string, target: string) =>
  call<Device>("device.add", { name, target })
export const removeDevice = (id: number) => call<null>("device.remove", { id })
/** `~/.ssh/config` 里尚未添加的 Host 别名。 */
export const deviceCandidates = () => call<string[]>("device.candidates")
/** 本机公钥路径；没有就生成一把。 */
export const ensureSshKey = () =>
  call<{ publicKey: string }>("device.ensureKey")
/** 节点设备的概览：先回磁盘缓存（可能为 `null`），最新的经 `device://node` 事件到达。 */
export const deviceNode = (deviceId: number) =>
  call<{ status: DeviceNode["status"]; overview: NodeOverview | null }>(
    "device.node",
    { deviceId }
  )
/** 到对方 GUI 的本机回环端口（`devices/workspace.rs`）；对方 GUI 未运行时失败。 */
export const deviceConnect = (deviceId: number) =>
  call<{ port: number }>("device.connect", { deviceId })
/** 节点协议的请求（`berth_node::api::Request`），只列前端用到的：浏览对方目录、在对方添加项目。 */
export type NodeRequest =
  | { op: "project_add"; path: string }
  | { op: "dirs"; path?: string | null }

/** 节点报的错：`kind` 为 `not_found` / `conflict` / `forbidden` / `invalid` / `unavailable` / `timeout` / `closed` 等。 */
export interface NodeError {
  kind: string
  message: string
}

/** 回复：`body` 是原始字节（base64），没有为 `null`。 */
export type NodeReply<T> =
  | { result: T; body: string | null }
  | { error: NodeError }

/**
 * 经数据通道转发一个节点请求；只读请求后端写磁盘缓存。
 * `cached: true` 只读缓存（0 次往返），没有缓存为 `null`。
 */
export function deviceRequest<T>(
  deviceId: number,
  request: NodeRequest,
  options: { body?: string; cached: true }
): Promise<NodeReply<T> | null>
export function deviceRequest<T>(
  deviceId: number,
  request: NodeRequest,
  options?: { body?: string; cached?: false }
): Promise<NodeReply<T>>
export function deviceRequest<T>(
  deviceId: number,
  request: NodeRequest,
  options: { body?: string; cached?: boolean } = {}
) {
  return call<NodeReply<T> | null>("device.request", {
    deviceId,
    request,
    ...options,
  })
}

/** 设备概览：先出缓存，后端取到最新的经 `device://node` 推来。 */
export function useDeviceOverview(deviceId: number) {
  const [overview, setOverview] = useState<NodeOverview | null>(null)
  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | null = null
    void subscribe<{ deviceId: number; overview?: NodeOverview }>(
      "device://node",
      (payload) => {
        if (!disposed && payload.deviceId === deviceId && payload.overview)
          setOverview(payload.overview)
      }
    )
      .then((off) => {
        if (disposed) off()
        else unsubscribe = off
      })
      .catch(() => {})
    void deviceNode(deviceId)
      .then((node) => {
        if (!disposed && node.overview)
          setOverview((prev) => prev ?? node.overview)
      })
      .catch(() => {})
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [deviceId])
  return overview
}

/** 一次跨设备传输的进度（`device://transfer`）。 */
export interface DeviceTransfer {
  id: number
  deviceId: number
  /** 本机文件。 */
  source: string
  /** 对方的目标路径。 */
  dest: string
  sent: number
  total: number
  state: "running" | "done" | "failed" | "cancelled"
  error: string | null
}

/** 把本机文件传到对方 `dest`（绝对路径）；同一文件再传一次即从断点续上。 */
export const startDeviceTransfer = (
  deviceId: number,
  source: string,
  dest: string
) => call<{ id: number }>("device.transfer", { deviceId, source, dest })
/** 把本机文件传进对方目录 `dir`，文件名不变。 */
export const transferInto = (
  zone: { deviceId: number; dir: string },
  source: string
) =>
  startDeviceTransfer(
    zone.deviceId,
    source,
    `${zone.dir.replace(/\/+$/, "")}/${source.split(/[\\/]/).pop()}`
  )
/** 取消传输（对方保留已收到的部分）。 */
export const cancelDeviceTransfer = (id: number) =>
  call<null>("device.cancelTransfer", { id })

/** 传到这台设备的传输：进行中、失败、取消的留着（可重试 / 移除），完成的自动消失。 */
export function useDeviceTransfers(
  deviceId: number,
  onDone?: (dest: string) => void
) {
  const [transfers, setTransfers] = useState<DeviceTransfer[]>([])
  // 完成即从列表消失，小文件一闪而过：由调用方给个完成提示。
  const onDoneRef = useRef(onDone)
  useEffect(() => {
    onDoneRef.current = onDone
  })
  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | null = null
    void subscribe<DeviceTransfer>("device://transfer", (event) => {
      if (disposed || event.deviceId !== deviceId) return
      if (event.state === "done") onDoneRef.current?.(event.dest)
      setTransfers((prev) => {
        // 重试是新的 id：同一源与目标只留最新一条。
        const rest = prev.filter(
          (item) =>
            item.id !== event.id &&
            !(item.source === event.source && item.dest === event.dest)
        )
        return event.state === "done" ? rest : [...rest, event]
      })
    })
      .then((off) => {
        if (disposed) off()
        else unsubscribe = off
      })
      .catch(() => {})
    return () => {
      disposed = true
      unsubscribe?.()
    }
  }, [deviceId])
  const dismiss = useCallback(
    (id: number) =>
      setTransfers((prev) => prev.filter((item) => item.id !== id)),
    []
  )
  return { transfers, dismiss }
}

/** 节点连接状态 → 侧栏的在线状态；`null` 表示还没建立连接。 */
export function nodeOnline(
  status: NodeChannelStatus | null | undefined
): "checking" | "online" | "offline" {
  if (!status || status.state === "connecting") return "checking"
  return status.state === "online" ? "online" : "offline"
}

/** 连接失败是否因为还没配免密登录（服务器要密码）。 */
export function needsKeySetup(message: string | null | undefined): boolean {
  return /permission denied|publickey|password/i.test(message ?? "")
}
