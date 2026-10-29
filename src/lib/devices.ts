/**
 * 设备：可通过 SSH 连接的其他机器（runtime bridge `device.*`，后端 `src-tauri/src/devices.rs`）。
 */
import { runtimeBridgeOperation } from "@/lib/runtime-bridge"
import type { FolderDetail } from "@/lib/types"

export interface DeviceProject {
  folderId: number
  /** 设备上的目录（绝对路径，或相对登录目录）。 */
  remotePath: string
}

export interface Device {
  id: number
  name: string
  /** 传给 ssh 的目标：`user@host`、域名或 `~/.ssh/config` 的 Host 别名。 */
  target: string
  /** 设备在本机的目录：从设备打开的终端以它为起始目录，据此归到设备下。 */
  localDir: string
  projects: DeviceProject[]
}

export interface DeviceCheck {
  ok: boolean
  /** 连不上时 ssh 的最后一行错误，或 `device.*` 错误码。 */
  message: string | null
}

async function call<T>(method: string, params?: Record<string, unknown>) {
  const response = await runtimeBridgeOperation<T>({ method, params })
  if (!response.ok) throw new Error(response.error.message)
  return response.result
}

export const listDevices = () => call<Device[]>("device.list")
/** 测连接；带 `deviceId` 且连得上时，后端顺带把该设备的项目挂好。 */
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
/** 挂载设备上的目录并注册为项目。 */
export const addDeviceProject = (deviceId: number, remotePath: string) =>
  call<FolderDetail>("device.addProject", { deviceId, remotePath })

/** 设备上目录的绝对路径与子目录名（不含隐藏目录）；`path` 为空即登录目录。 */
export const listDeviceDirs = (deviceId: number, path: string) =>
  call<{ path: string; dirs: string[] }>("device.listDirs", { deviceId, path })

/** 连接失败是否因为还没配免密登录（服务器要密码）。 */
export function needsKeySetup(message: string | null | undefined): boolean {
  return /permission denied|publickey|password/i.test(message ?? "")
}
