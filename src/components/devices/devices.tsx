"use client"

/**
 * 设备的共用部件：设备列表与在线状态、错误文案、打开设备面板（官方 `devices` 插件）。
 * 侧栏项目列表按设备分组显示；设备管理在插件面板里。
 */
import { useCallback, useEffect, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import { toast } from "@/lib/notify"
import { toErrorMessage } from "@/lib/app-error"
import { subscribe } from "@/lib/platform"
import {
  checkDevice,
  listDevices,
  localDevice,
  needsKeySetup,
  nodeOnline,
  useDeviceSnapshotStore,
  useDevicesPanelStore,
  type Device,
  type DeviceCheck,
  type DeviceState,
  type NodeChannelStatus,
} from "@/lib/devices"
import {
  pluginSidebarViewId,
  usePluginViewsStore,
  type PluginView,
} from "@/lib/plugins/plugin-views"
import { useSidebarViewStore } from "@/components/layout/sidebar/views"

export type DeviceStatus = DeviceState["state"]

/** 设备在线状态点的颜色。 */
export const STATUS_DOT: Record<DeviceStatus, string> = {
  checking: "bg-muted-foreground/40 animate-pulse",
  online: "bg-emerald-500",
  offline: "bg-muted-foreground/40",
}

/** 后端 `device.*` 错误码 → i18n 键；其他消息（ssh 原文）原样显示。 */
const ERROR_KEYS = {
  "device.nameRequired": "errors.nameRequired",
  "device.nameTaken": "errors.nameTaken",
  "device.targetInvalid": "errors.targetInvalid",
  "device.timeout": "errors.timeout",
} as const

export function useDeviceErrorText() {
  const t = useTranslations("Folder.sidebar.devices")
  return useCallback(
    (message: string | null | undefined) => {
      const key = message
        ? ERROR_KEYS[message as keyof typeof ERROR_KEYS]
        : undefined
      return key ? t(key) : (message ?? "")
    },
    [t]
  )
}

/** 设备列表，`reload` 重读。 */
function useDeviceList() {
  const t = useTranslations("Folder.sidebar.devices")
  const [devices, setDevices] = useState<Device[]>([])
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    let cancelled = false
    listDevices()
      .then((list) => {
        if (!cancelled) setDevices(list)
      })
      .catch((error) => {
        if (!cancelled)
          toast.error(t("loadFailed"), { description: toErrorMessage(error) })
      })
    return () => {
      cancelled = true
    }
  }, [revision, t])

  const reload = useCallback(() => setRevision((n) => n + 1), [])
  return { devices, reload }
}

/**
 * 各设备能否连上：设备列表读到时检测一次（不轮询），`recheck` 重新检测；节点设备在 ssh 测得通之后
 * 以节点连接的状态为准（后端推送）。检测时对方装没装 Berth 变了就重读列表。
 */
function useDeviceStatus(devices: Device[], onChanged: () => void) {
  const [status, setStatus] = useState<
    Record<number, { state: DeviceStatus; message: string | null }>
  >({})
  const [nodeStatus, setNodeStatus] = useState<
    Record<number, NodeChannelStatus>
  >({})
  useEffect(() => {
    let disposed = false
    let unsubscribe: (() => void) | null = null
    void subscribe<{
      deviceId: number
      status: NodeChannelStatus
    }>("device://node-status", (payload) => {
      if (disposed) return
      setNodeStatus((prev) => ({ ...prev, [payload.deviceId]: payload.status }))
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
  }, [])

  // 没有记录即「检测中」；只在 await 之后写状态。
  const probe = useCallback(
    async (device: Device) => {
      const result: DeviceCheck = await checkDevice(
        device.target,
        device.id
      ).catch((error) => ({ ok: false, message: toErrorMessage(error) }))
      // 对方刚装上 / 卸掉 Berth：重读列表，设备换成对应的样子。
      if (result.ok && Boolean(result.node) !== Boolean(device.node))
        onChanged()
      setStatus((prev) => ({
        ...prev,
        [device.id]: {
          state: result.ok ? "online" : "offline",
          message: result.message,
        },
      }))
    },
    [onChanged]
  )

  useEffect(() => {
    devices.forEach((device) => void probe(device))
  }, [devices, probe])

  const recheck = useCallback(
    (device: Device) => {
      setStatus((prev) => {
        const next = { ...prev }
        delete next[device.id]
        return next
      })
      void probe(device)
    },
    [probe]
  )

  const statusOf = useCallback(
    (device: Device): DeviceState => {
      const checked = status[device.id]
      const node = nodeStatus[device.id] ?? device.node?.status
      const current =
        device.node && node && checked?.state !== "offline"
          ? {
              state: nodeOnline(node),
              message: "error" in node ? node.error : null,
            }
          : checked
      const state = current?.state ?? "checking"
      return {
        state,
        message: current?.message ?? null,
        keyMissing: state === "offline" && needsKeySetup(current?.message),
      }
    },
    [nodeStatus, status]
  )
  return { statusOf, recheck }
}

/** 探测设备并写入 `useDeviceSnapshotStore`：挂在窗口外壳，切换侧栏视图不卸载、不重复探测。 */
export function DevicesProvider({ children }: { children: ReactNode }) {
  const { devices, reload } = useDeviceList()
  const { statusOf, recheck } = useDeviceStatus(devices, reload)
  useEffect(() => {
    useDeviceSnapshotStore.setState({ devices, statusOf, recheck, reload })
  }, [devices, statusOf, recheck, reload])
  useEffect(() => {
    void localDevice()
      .then((local) => useDeviceSnapshotStore.setState({ local }))
      .catch(() => {})
  }, [])
  return children
}

export function useDevices() {
  return useDeviceSnapshotStore()
}

/** 设备面板（有 `devices` 权限的侧栏页面视图，官方为 `devices` 插件）；没有时为 null，入口随之隐藏。 */
export function useDevicesPanelView() {
  return usePluginViewsStore(
    (state) => state.views.find(isDevicesPanel) ?? null
  )
}

/** 打开设备面板并选中 `deviceId`；没有面板时什么也不做。 */
export function openDevicesPanel(deviceId?: number) {
  const view = usePluginViewsStore.getState().views.find(isDevicesPanel)
  if (!view) return
  if (deviceId != null) {
    // 先清再设：同一台设备再点一次也通知面板
    useDevicesPanelStore.setState({ selected: null })
    useDevicesPanelStore.setState({ selected: deviceId })
  }
  useSidebarViewStore.getState().setView(pluginSidebarViewId(view))
}

/** 设备面板按契约认：有 `devices` 权限的侧栏页面视图，不认插件 id。 */
export const isDevicesPanel = (view: PluginView) =>
  view.location === "sidebar" &&
  view.page != null &&
  view.permissions.includes("devices")
