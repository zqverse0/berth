// 对方设备上的项目在本机 Berth 里直接用：界面与状态都是本机的，只有属于对方项目的后端调用
// 经节点隧道发给对方 GUI，只传参数与结果。连接与协议是远程访问的同一份客户端（`./remote-line.js`）。
//
// 对方的东西在本机的身份：
// - 路径 `berth-device://<设备 id><对方绝对路径>`；
// - 终端 id `berth-device://<设备 id>#<对方终端 id>`；
// - 项目 id 取负：`-(设备 id × 1e6 + 对方 id)`，与本机 id 永不相同。
// 调用参数里出现这些身份就发给那台设备（换回对方的值），结果里对方的路径、终端与项目 id 换成本机身份。
//
// 每台设备一个会话、两条线：命令线 `/__berth/ws` 走节点隧道普通道，终端专线 `/__berth/term` 走交互道
// （终端输出、按键、改尺寸，不排在文件等大响应后面）。

import type { UnsubscribeFn } from "./types"
import { createRemoteSession, type RemoteSession } from "./remote-line"

const PREFIX = "berth-device://"
const ID_SPAN = 1_000_000

/** 设备路径的根前缀 `berth-device://<设备 id>`（其后是对方的绝对路径）；不是设备路径返回 `null`。 */
export function deviceRoot(path: string): string | null {
  return path.match(/^berth-device:\/\/\d+(?=\/)/)?.[0] ?? null
}

/** 对方项目 / 文件在本机的路径。 */
export function devicePath(deviceId: number, path: string): string {
  return `${PREFIX}${deviceId}${path}`
}

/** 对方终端在本机的 id。 */
export function deviceTerminalId(deviceId: number, terminalId: string): string {
  return `${PREFIX}${deviceId}#${terminalId}`
}

/** 对方项目在本机的 id。 */
export function deviceFolderId(deviceId: number, folderId: number): number {
  return -(deviceId * ID_SPAN + folderId)
}

/** 本机 id 是不是对方项目的；是则给出设备与对方 id。 */
export function parseDeviceFolderId(
  id: number
): { deviceId: number; folderId: number } | null {
  if (!(id < 0)) return null
  return { deviceId: Math.floor(-id / ID_SPAN), folderId: -id % ID_SPAN }
}

/** 本机身份的路径 / 终端 id → 设备与对方的值；不是对方的返回 `null`。 */
export function parseDeviceRef(
  value: string
): { deviceId: number; value: string } | null {
  if (!value.startsWith(PREFIX)) return null
  const rest = value.slice(PREFIX.length)
  const end = rest.search(/[/#]/)
  const deviceId = Number(rest.slice(0, end))
  if (end <= 0 || !(deviceId > 0)) return null
  // 路径保留开头的 `/`，终端 id 去掉 `#`。
  return {
    deviceId,
    value: rest[end] === "#" ? rest.slice(end + 1) : rest.slice(end),
  }
}

const FOLDER_ID_KEY =
  /^(folderId|folder_id|parent_id|parentId|folderIds|folder_ids)$/
const TERMINAL_ID_KEY = /^(terminalId|terminal_id)$/

/**
 * 深拷贝并替换：`onString(文本, 键)` / `onFolderId` 返回新值。字节数组与类实例（如 Tauri
 * `Channel`）原样保留。
 */
function mapValue(
  value: unknown,
  onString: (text: string, key: string) => string,
  onFolderId: (id: number) => number,
  key = ""
): unknown {
  if (typeof value === "string") return onString(value, key)
  if (typeof value === "number")
    return FOLDER_ID_KEY.test(key) ? onFolderId(value) : value
  if (Array.isArray(value))
    return value.map((item) => mapValue(item, onString, onFolderId, key))
  if (
    value === null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return value
  return Object.fromEntries(
    Object.entries(value).map(([k, v]) => [
      k,
      mapValue(v, onString, onFolderId, k),
    ])
  )
}

/**
 * 参数里指向对方的调用：返回设备 id 与换成对方值的参数；本机调用返回 `null`。
 * 一次调用只能指向一台设备。
 */
export function routeArgs(
  args: Record<string, unknown> | undefined
): { deviceId: number; args: Record<string, unknown> } | null {
  if (!args) return null
  let device: number | null = null
  const claim = (deviceId: number) => {
    if (device !== null && device !== deviceId)
      throw new Error("a call cannot span two devices")
    device = deviceId
  }
  const mapped = mapValue(
    args,
    (text) => {
      const parsed = parseDeviceRef(text)
      if (!parsed) return text
      claim(parsed.deviceId)
      return parsed.value
    },
    (id) => {
      const parsed = parseDeviceFolderId(id)
      if (!parsed) return id
      claim(parsed.deviceId)
      return parsed.folderId
    }
  ) as Record<string, unknown>
  return device === null ? null : { deviceId: device, args: mapped }
}

/** 各设备打开的项目根（对方绝对路径）：结果里据此认出对方路径。 */
const roots = new Map<number, string[]>()

/**
 * 对方的结果 / 事件载荷换成本机身份：项目根下的路径与终端 id 加前缀，项目 id 取负。
 * `touched` 表示载荷里有没有对方的路径、终端或项目 id。
 */
function localize(
  deviceId: number,
  value: unknown
): { value: unknown; touched: boolean } {
  const known = roots.get(deviceId) ?? []
  let touched = false
  // ponytail: 只认已知项目根下的字符串为路径；正文恰以项目根开头时也会被加前缀（极少见）。
  const mapped = mapValue(
    value,
    (text, key) => {
      if (TERMINAL_ID_KEY.test(key) && text && !text.startsWith(PREFIX)) {
        touched = true
        return deviceTerminalId(deviceId, text)
      }
      const hit = known.some(
        (root) =>
          text === root ||
          text.startsWith(root.endsWith("/") ? root : `${root}/`)
      )
      if (!hit) return text
      touched = true
      return devicePath(deviceId, text)
    },
    (id) => {
      if (!(id > 0)) return id
      touched = true
      return deviceFolderId(deviceId, id)
    }
  )
  return { value: mapped, touched }
}

/** 页面里 Tauri 的回调表：对方的终端输出交给本机 `Channel`（按包序号排序）。 */
interface TauriInternals {
  runCallback(id: number, data: unknown): void
  callbacks: Map<number, unknown>
}
const internals = () =>
  (window as unknown as { __TAURI_INTERNALS__: TauriInternals })
    .__TAURI_INTERNALS__

/**
 * 对方宿主自己的事件：它的窗口、设置、更新、它连的设备、它的标签页。与本机无关，不订——
 * 载荷里常有对方项目的路径（如它的设备概览），按路径判断会被误当成对方项目的数据灌进本机状态。
 */
const HOST_EVENT = /^(app:\/\/|app_|device:\/\/|primary-tabs:\/\/|backup:\/\/)/

type Handler = (payload: unknown) => void

/** 连线状态：`error` 是最近一次没连上的原因（`device.connect` 的错误或断线原因）。 */
export interface DeviceLineState {
  open: boolean
  error: unknown
}

interface Device {
  session: RemoteSession
  /** 事件名 → (回调 → 是否只要关于对方项目的)。 */
  listeners: Map<string, Map<Handler, boolean>>
  state: DeviceLineState
}

const devices = new Map<number, Device>()
/** 广播订阅（本机订的事件，各设备上关于对方项目的同名事件也要）：设备后连上时补订。 */
const broadcasts = new Map<string, Set<Handler>>()
const stateWatchers = new Set<() => void>()

function listen(
  device: Device,
  event: string,
  handler: Handler,
  scoped: boolean
) {
  let handlers = device.listeners.get(event)
  if (!handlers) {
    handlers = new Map()
    device.listeners.set(event, handlers)
    device.session.setEvents([...device.listeners.keys()])
  }
  handlers.set(handler, scoped)
  return () => {
    handlers.delete(handler)
    if (handlers.size > 0) return
    device.listeners.delete(event)
    device.session.setEvents([...device.listeners.keys()])
  }
}

/**
 * 这台设备的会话（没有就建）。`connect` 给出本机回环端口（`device.connect`，对方 GUI 未运行时失败）；
 * 连不上按断线退避重试，调用在会话里排队，连上即发。
 */
export function deviceSession(
  deviceId: number,
  connect: () => Promise<number>
): Device {
  const existing = devices.get(deviceId)
  if (existing) return existing
  // 端口取一次，两条线共用；取到之后一次也没连上就重新取（对方 GUI 没开、刚关），
  // 取的同时得到确切原因（`device.windowUnavailable` 等）。
  let port: Promise<number> | null = null
  let stale = false
  let opened = false
  const device: Device = {
    session: createRemoteSession({
      url(path) {
        if (!port || stale) {
          stale = false
          opened = false
          const fetching = connect()
          fetching.catch(() => {
            stale = true
          })
          port = fetching
        }
        return port.then((value) => `ws://localhost:${value}${path}`)
      },
      deliver: (channel, packet) => internals().runCallback(channel, packet),
      alive: (channel) => internals().callbacks.has(channel),
      onEvent(name, payload) {
        const handlers = device.listeners.get(name)
        if (!handlers) return
        // 广播的事件只转发关于对方项目的（带对方路径 / id 的）；按对方终端 id 订的全收。
        const local = localize(deviceId, payload)
        for (const [handler, scoped] of handlers)
          if (local.touched || !scoped) handler(local.value)
      },
      // 对方丢了这一页的状态：终端已各自重新 attach，排队的调用重发；本机状态不受影响。
      onReset() {},
      onState(open, error) {
        if (open) opened = true
        else if (!opened) stale = true
        device.state = { open, error: open ? null : error }
        for (const watcher of stateWatchers) watcher()
      },
      notice(text) {
        void import("@/lib/notify").then(({ toast }) => toast.warning(text))
      },
    }),
    listeners: new Map(),
    state: { open: false, error: null },
  }
  devices.set(deviceId, device)
  for (const [event, handlers] of broadcasts)
    for (const handler of handlers) listen(device, event, handler, true)
  return device
}

/** 发给这台设备的调用（参数已换成对方的值），结果换回本机身份。 */
export async function deviceCall<T>(
  device: Device,
  deviceId: number,
  command: string,
  payload: unknown,
  headers?: Record<string, string>
): Promise<T> {
  const value = await device.session.call<unknown>(command, payload, headers)
  return localize(deviceId, value).value as T
}

/** 按对方终端 id 订的事件（如 `terminal://exit/<id>`）：只在那台设备上订，全收。 */
export function subscribeDevice(
  device: Device,
  event: string,
  handler: Handler
): UnsubscribeFn {
  return listen(device, event, handler, false)
}

/** 各设备命令线上的同名事件（关于对方项目的）也交给 `handler`，之后连上的设备同样。 */
export function subscribeDevices(
  event: string,
  handler: Handler
): UnsubscribeFn {
  if (HOST_EVENT.test(event)) return () => {}
  let handlers = broadcasts.get(event)
  if (!handlers) {
    handlers = new Set()
    broadcasts.set(event, handlers)
  }
  handlers.add(handler)
  const offs = [...devices.values()].map((device) =>
    listen(device, event, handler, true)
  )
  return () => {
    handlers.delete(handler)
    if (handlers.size === 0) broadcasts.delete(event)
    for (const off of offs) off()
  }
}

/** 这台设备的连线状态；还没建会话时为 `null`。 */
export function deviceLineState(deviceId: number): DeviceLineState | null {
  return devices.get(deviceId)?.state ?? null
}

/** 任一设备连线状态变化时回调。 */
export function watchDeviceLines(watcher: () => void): UnsubscribeFn {
  stateWatchers.add(watcher)
  return () => stateWatchers.delete(watcher)
}

/** 记下这台设备打开的项目根，结果里据此把对方路径换成本机身份。 */
export function setDeviceRoots(deviceId: number, paths: string[]) {
  roots.set(deviceId, paths)
}

/** 对方终端清单等对方卡住时也不能挂住本机：超时按「没有」处理。 */
const LIST_TIMEOUT_MS = 5000

/**
 * 已连上的各设备 GUI 的终端（本机身份），与本机终端合成同一份清单
 * （`terminal-inventory-query.ts`）。没通着或超时的设备这一轮跳过，断线期间不积压。
 */
export async function listDeviceTerminals<T>(): Promise<T[]> {
  const lists = await Promise.all(
    [...devices]
      .filter(([, device]) => device.session.open)
      .map(([deviceId, device]) =>
        Promise.race([
          deviceCall<T[]>(device, deviceId, "terminal_list_sessions", {}),
          new Promise<T[]>((resolve) =>
            setTimeout(() => resolve([]), LIST_TIMEOUT_MS)
          ),
        ]).catch(() => [] as T[])
      )
  )
  return lists.flat()
}
