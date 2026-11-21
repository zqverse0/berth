/**
 * 页面命名空间 `devices@1`（docs/plugin-architecture.md §3，权限 `devices`）：设备管理面板（官方 `devices`
 * 插件）经它管理设备。本机是 id 0 的设备：看概览、项目，添加项目，开终端。只做「消息 ↔ 宿主设备服务」转换：设备连接、对方项目与终端并入本机仍归宿主
 * （`lib/devices.ts`、`transport/device.ts`）。
 */
import { getHomeDirectory, openFolderInWorkspace } from "@/lib/api"
import { openFileDialog } from "@/lib/platform"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  addDevice,
  checkDevice,
  deviceCandidates,
  deviceNode,
  deviceRequest,
  ensureSshKey,
  removeDevice,
  showDeviceProject,
  notifyDevicesChanged,
  useDevicesPanelStore,
  useDeviceSnapshotStore,
  type Device,
  type DeviceCheck,
} from "@/lib/devices"
import { deviceLineState } from "@/lib/transport/device"
import { createAndOpenPrimaryTerminal } from "@/lib/terminal/create-and-open-primary-terminal"
import { getCurrentAppVersion } from "@/lib/updater"
import { toErrorMessage } from "@/lib/app-error"

/** 在本机开一个终端跑指定程序（不属于任何项目）；`cwd` 缺省为家目录。 */
async function openHostTerminal(
  title: string,
  executable: string,
  args: string[],
  cwd?: string
) {
  await createAndOpenPrimaryTerminal({
    cwd: cwd ?? (await getHomeDirectory()),
    title,
    executable,
    args,
    folderId: null,
  })
}

function deviceById(id: unknown): Device {
  const device = useDeviceSnapshotStore
    .getState()
    .devices.find((item) => item.id === Number(id))
  if (!device) throw new Error(`device ${String(id)} not found`)
  return device
}

/** 给页面的设备：在线状态取宿主的探测结果。 */
function deviceView(device: Device) {
  const status = useDeviceSnapshotStore.getState().statusOf(device)
  return {
    id: device.id,
    name: device.name,
    target: device.target,
    node: device.node != null,
    shown: device.shown,
    status: status.state,
    message: status.message,
    keyMissing: status.keyMissing,
  }
}

/** 本机，当作 id 0 的设备给页面。 */
function localView() {
  const local = useDeviceSnapshotStore.getState().local
  if (!local) return null
  return {
    id: 0,
    name: local.host || "localhost",
    target: "",
    node: true,
    shown: [],
    status: "online",
    message: null,
    keyMissing: false,
    local: true,
  }
}

async function inspectLocal() {
  const local = useDeviceSnapshotStore.getState().local
  const localVersion = await getCurrentAppVersion().catch(() => null)
  return {
    overview: {
      host: local?.host ?? "",
      os: local?.os ?? "",
      arch: local?.arch,
      version: localVersion ?? undefined,
      projects: useAppWorkspaceStore.getState().folders,
    },
    check: { ok: true, message: null },
    berth: null,
    localVersion,
    line: null,
  }
}

/** 节点回复里的错误转成异常。 */
function unwrap<T>(reply: { result: T } | { error: { message: string } }) {
  if ("error" in reply) throw new Error(reply.error.message)
  return reply.result
}

/** `devices.*` 的一次调用。 */
export async function handleDevicesCall(
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  switch (method) {
    case "devices.list":
      return {
        devices: [
          localView(),
          ...useDeviceSnapshotStore.getState().devices.map(deviceView),
        ].filter((device) => device != null),
        selected: useDevicesPanelStore.getState().selected,
      }
    case "devices.candidates":
      return deviceCandidates()
    case "devices.add": {
      const device = await addDevice(
        String(params.name ?? ""),
        String(params.target ?? "")
      )
      notifyDevicesChanged()
      return { id: device.id }
    }
    case "devices.remove":
      await removeDevice(deviceById(params.id).id)
      notifyDevicesChanged()
      return null
    case "devices.inspect": {
      if (params.id === 0) return inspectLocal()
      const device = deviceById(params.id)
      const [check, cached, localVersion] = await Promise.all([
        checkDevice(device.target, device.id).catch(
          (error): DeviceCheck => ({
            ok: false,
            message: toErrorMessage(error),
          })
        ),
        device.node ? deviceNode(device.id).catch(() => null) : null,
        getCurrentAppVersion().catch(() => null),
      ])
      if (check.ok && Boolean(check.node) !== Boolean(device.node))
        notifyDevicesChanged()
      useDeviceSnapshotStore.getState().recheck(device)
      const overview = cached?.overview ?? null
      const berth = check.node?.berth ?? device.node?.berth ?? null
      const line = deviceLineState(device.id)
      // 原始结果：检查清单的步骤与判断归插件
      return {
        check: { ok: check.ok, message: check.message },
        overview,
        berth,
        localVersion,
        line: line
          ? {
              open: line.open,
              error: line.error == null ? null : toErrorMessage(line.error),
            }
          : null,
      }
    }
    case "devices.show": {
      const device = deviceById(params.id)
      const shown = await showDeviceProject(
        device.id,
        String(params.path ?? ""),
        params.shown === true
      )
      notifyDevicesChanged()
      return shown
    }
    case "devices.dirs":
      return unwrap(
        await deviceRequest<{ path: string; dirs: string[] }>(
          deviceById(params.id).id,
          {
            op: "dirs",
            path: typeof params.path === "string" ? params.path : null,
          }
        )
      )
    case "devices.addProject": {
      // 本机：系统目录选择框选一个目录打开成项目
      if (params.id === 0) {
        const picked = await openFileDialog({
          directory: true,
          multiple: false,
        })
        const path = Array.isArray(picked) ? picked[0] : picked
        if (!path) return null
        await openFolderInWorkspace(path)
        return { name: path.split(/[\\/]/).pop() ?? path }
      }
      const result = unwrap(
        await deviceRequest<unknown>(deviceById(params.id).id, {
          op: "project_add",
          path: String(params.path ?? ""),
        })
      )
      // 对方的项目列表经概览刷新到达
      void deviceNode(deviceById(params.id).id).catch(() => null)
      return result
    }
    case "devices.openTerminal": {
      if (params.id === 0) {
        await createAndOpenPrimaryTerminal({
          cwd: await getHomeDirectory(),
          title: localView()?.name,
          folderId: null,
        })
        return null
      }
      const device = deviceById(params.id)
      await openHostTerminal(
        device.name,
        "ssh",
        ["--", device.target],
        device.localDir
      )
      return null
    }
    case "devices.setupKey": {
      // 本机没有密钥就生成一把，再开终端跑 ssh-copy-id；指纹与密码由用户在终端里确认，Berth 不经手。
      // 添加设备时还没保存，按 `target` 配；已添加的按 `id`。
      const device =
        typeof params.target === "string"
          ? { name: params.target, target: params.target }
          : deviceById(params.id)
      const { publicKey } = await ensureSshKey()
      await openHostTerminal(device.name, "ssh-copy-id", [
        "-i",
        publicKey,
        device.target,
      ])
      return null
    }
  }
  return undefined
}

/**
 * 有 `devices` 权限的页面：设备列表或状态变化时发 `devices.changed`，宿主要选中某台设备时发
 * `devices.select`。返回取消订阅。
 */
export function watchDevicesForPage(
  send: (method: string, params: Record<string, unknown>) => void
) {
  const offDevices = useDeviceSnapshotStore.subscribe(() =>
    send("devices.changed", {})
  )
  const offSelect = useDevicesPanelStore.subscribe(({ selected }) => {
    if (selected != null) send("devices.select", { id: selected })
  })
  return () => {
    offDevices()
    offSelect()
  }
}
