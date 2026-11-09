"use client"

import { useTranslations } from "next-intl"
import { Plus } from "lucide-react"
import type { Device } from "@/lib/devices"
import { cn } from "@/lib/utils"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import {
  STATUS_DOT,
  useDeviceErrorText,
  type DeviceState,
} from "@/components/devices/devices"
import {
  DeviceTransfers,
  useOsFileDropToDevices,
  type DeviceFeedState,
} from "./device-projects"

/**
 * 侧栏底部的设备条：每台设备一个状态点 + 名称，点开设备页（状态、检查与全部操作都在那里）；
 * 末尾添加设备。传到设备的文件进度列在条下方。
 */
export function DeviceBar({
  devices,
  statusOf,
  feeds,
  onAdd,
}: {
  devices: Device[]
  statusOf: (device: Device) => DeviceState
  /** 节点设备的连线问题（悬停说明） */
  feeds: Readonly<Record<number, DeviceFeedState>>
  onAdd: () => void
}) {
  const t = useTranslations("Folder.sidebar.devices")
  const errorText = useDeviceErrorText()
  const { openDeviceTab } = useWorkspaceRuntimeActions()
  useOsFileDropToDevices()
  return (
    <div className="shrink-0 border-t border-border/50">
      <div
        role="toolbar"
        aria-label={t("section")}
        className="flex flex-wrap items-center gap-x-1 gap-y-0.5 px-2 py-1 text-xs"
      >
        <span className="mr-1 text-muted-foreground">{t("section")}</span>
        {devices.map((device) => {
          const { state, message, keyMissing } = statusOf(device)
          const problem = feeds[device.id]?.problem
          const status = keyMissing
            ? t("status.needsKey")
            : t(`status.${state}`)
          return (
            <button
              key={device.id}
              type="button"
              onClick={() =>
                openDeviceTab({ deviceId: device.id, title: device.name })
              }
              title={[
                `${device.name} · ${status}`,
                state === "offline" ? errorText(message) : null,
                problem ? t(problem) : null,
              ]
                .filter(Boolean)
                .join("\n")}
              className={cn(
                "flex h-6 min-w-0 max-w-[10rem] items-center gap-1 rounded px-1.5 hover:bg-accent",
                state === "offline" && "text-muted-foreground"
              )}
            >
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  STATUS_DOT[state]
                )}
              />
              <span className="truncate">{device.name}</span>
              <span className="sr-only">{status}</span>
            </button>
          )
        })}
        <button
          type="button"
          onClick={onAdd}
          title={t("addTitle")}
          aria-label={t("addTitle")}
          className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <Plus className="size-3.5" />
        </button>
      </div>
      {devices.map((device) => (
        <DeviceTransfers key={device.id} deviceId={device.id} />
      ))}
    </div>
  )
}
