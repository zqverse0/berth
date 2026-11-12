"use client"

import { useState } from "react"
import { Plus } from "lucide-react"
import { useTranslations } from "next-intl"
import { DeviceTransfers } from "@/components/conversations/sidebar/device-projects"
import {
  AddDeviceDialog,
  notifyDevicesChanged,
  STATUS_DOT,
  useDeviceErrorText,
  useDevices,
} from "@/components/devices/devices"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { useDeviceTransfers } from "@/lib/devices"
import { toast } from "@/lib/notify"
import { cn } from "@/lib/utils"

/** 状态栏的设备段：在线数与传输进度，点开列出各设备（进设备页）与添加设备；没有设备时不显示。 */
export function StatusBarDevices() {
  const { devices } = useDevices()
  return devices.length > 0 ? <DeviceSegment /> : null
}

function DeviceSegment() {
  const t = useTranslations("Folder.sidebar.devices")
  const tGroups = useTranslations("WorkspaceGroups")
  const errorText = useDeviceErrorText()
  const { devices, statusOf, problems } = useDevices()
  const { openDeviceTab } = useWorkspaceRuntimeActions()
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  const { transfers, dismiss } = useDeviceTransfers(null, (dest) =>
    toast.success(
      t("remote.transferDone", { name: dest.split("/").pop() ?? dest })
    )
  )
  const online = devices.filter(
    (device) => statusOf(device).state === "online"
  ).length
  const running = transfers.filter((item) => item.state === "running")
  const total = running.reduce((sum, item) => sum + item.total, 0)
  const sent = running.reduce((sum, item) => sum + item.sent, 0)
  const failed = transfers.some((item) => item.state === "failed")

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <button
            type="button"
            className="flex h-full shrink-0 items-center gap-1.5 px-2 transition-colors hover:text-foreground"
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 rounded-full",
                STATUS_DOT[online > 0 ? "online" : "offline"]
              )}
            />
            {t("statusSummary", { online, total: devices.length })}
            {running.length > 0 ? (
              <span className="tabular-nums">
                {t("remote.transferring", {
                  percent: total > 0 ? Math.floor((sent / total) * 100) : 0,
                })}
              </span>
            ) : failed ? (
              <span className="text-destructive">
                {t("remote.transferFailed")}
              </span>
            ) : null}
          </button>
        </PopoverTrigger>
        <PopoverContent side="top" align="start" className="w-72 p-1">
          <div role="toolbar" aria-label={t("section")} className="text-xs">
            {devices.map((device) => {
              const { state, message, keyMissing } = statusOf(device)
              const problem = problems[device.id]
              const status = keyMissing
                ? t("status.needsKey")
                : t(`status.${state}`)
              return (
                <button
                  key={device.id}
                  type="button"
                  onClick={() => {
                    setOpen(false)
                    openDeviceTab({ deviceId: device.id, title: device.name })
                  }}
                  title={[
                    `${device.name} · ${status}`,
                    state === "offline" ? errorText(message) : null,
                    problem ? t(problem) : null,
                  ]
                    .filter(Boolean)
                    .join("\n")}
                  className={cn(
                    "flex h-7 w-full min-w-0 items-center gap-2 rounded px-2 text-left hover:bg-accent",
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
                  <span className="min-w-0 flex-1 truncate">{device.name}</span>
                  <span className="shrink-0 text-muted-foreground">
                    {state === "offline" ? tGroups("offlineReason") : status}
                  </span>
                </button>
              )
            })}
          </div>
          <DeviceTransfers transfers={transfers} dismiss={dismiss} />
          <div className="my-1 border-t border-border/50" />
          <button
            type="button"
            onClick={() => {
              setOpen(false)
              setAdding(true)
            }}
            className="flex h-7 w-full items-center gap-2 rounded px-2 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Plus className="size-3.5" />
            {t("addTitle")}
          </button>
        </PopoverContent>
      </Popover>
      <AddDeviceDialog
        // 每次打开重新挂载，表单从空白开始。
        key={adding ? "add-device-open" : "add-device-closed"}
        open={adding}
        onOpenChange={setAdding}
        onAdded={notifyDevicesChanged}
      />
    </>
  )
}
