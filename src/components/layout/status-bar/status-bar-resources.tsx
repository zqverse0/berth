"use client"

import { useCallback, useEffect, useState } from "react"
import { Cpu } from "lucide-react"
import { useTranslations } from "next-intl"
import {
  MiniBar,
  usageTextColorClass,
} from "@/components/layout/status-bar/status-bar-usage"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { runtimeBridgeOperation } from "@/lib/runtime-bridge"
import { cn } from "@/lib/utils"

/** `system.resources` 的返回（`src-tauri/src/system_resources.rs`）；CPU% 都按整机口径。 */
export interface ResourceSnapshot {
  machine: {
    cpuPercent: number
    cpuCount: number
    memoryUsed: number
    memoryTotal: number
    swapUsed: number
    swapTotal: number
    disks: { mount: string; used: number; total: number }[]
  }
  berth: {
    kind: "ui" | "termd" | "agents" | "background"
    cpuPercent: number
    memory: number
    processes: {
      pid: number
      name: string
      cpuPercent: number
      memory: number
    }[]
  }[]
}

// 收起时只看整机两个数，10 秒一读够用；展开时要看进程变化，2 秒一读。
// 资源变化没有事件可订阅，只能轮询；窗口不可见时不读。
const IDLE_MS = 10_000
const OPEN_MS = 2_000
// 每组最多列几个进程，其余只计入合计
const TOP_PROCESSES = 5

const percent = (used: number, total: number) =>
  total > 0 ? Math.round((used / total) * 100) : 0

function formatBytes(bytes: number): string {
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(1)} GB`
  return `${Math.round(bytes / 1024 ** 2)} MB`
}

/** 状态栏「资源」段：整机 CPU / 内存，点开看磁盘与 Berth 各进程的占用。 */
export function StatusBarResources({ className }: { className?: string }) {
  const t = useTranslations("Folder.statusBar.resources")
  const [snapshot, setSnapshot] = useState<ResourceSnapshot | null>(null)
  const [open, setOpen] = useState(false)

  const load = useCallback(async () => {
    if (document.visibilityState !== "visible") return
    const response = await runtimeBridgeOperation<ResourceSnapshot>({
      method: "system.resources",
    })
    // 失败保留旧值，下一轮再试
    if (response.ok) setSnapshot(response.result)
  }, [])

  useEffect(() => {
    const timeout = window.setTimeout(() => void load(), 0)
    const interval = window.setInterval(
      () => void load(),
      open ? OPEN_MS : IDLE_MS
    )
    document.addEventListener("visibilitychange", load)
    return () => {
      window.clearTimeout(timeout)
      window.clearInterval(interval)
      document.removeEventListener("visibilitychange", load)
    }
  }, [open, load])

  if (!snapshot) return null
  const { machine, berth } = snapshot
  const cpu = Math.round(machine.cpuPercent)
  const memory = percent(machine.memoryUsed, machine.memoryTotal)
  const berthCpu = berth.reduce((sum, group) => sum + group.cpuPercent, 0)
  const berthMemory = berth.reduce((sum, group) => sum + group.memory, 0)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          className={cn(
            "flex shrink-0 items-center gap-1.5 tabular-nums transition-colors hover:text-foreground max-md:hidden",
            className
          )}
          title={t("title")}
          aria-label={t("title")}
          data-berth-status-resources-trigger
        >
          <Cpu className="size-3.5 shrink-0" />
          <span className={usageTextColorClass(cpu)}>{cpu}%</span>
          <span className="text-muted-foreground/60">·</span>
          <span className={usageTextColorClass(memory)}>
            {t("memoryShort")} {memory}%
          </span>
        </button>
      </PopoverTrigger>
      <PopoverContent side="top" align="end" className="w-96 p-3">
        <div className="mb-2 text-xs font-semibold text-foreground">
          {t("machine")}
        </div>
        <div className="space-y-1.5 text-[11px]">
          <MeterRow
            label={t("cpu")}
            value={cpu}
            detail={t("cores", { count: machine.cpuCount })}
          />
          <MeterRow
            label={t("memory")}
            value={memory}
            detail={`${formatBytes(machine.memoryUsed)} / ${formatBytes(machine.memoryTotal)}`}
          />
          {machine.swapTotal > 0 && (
            <MeterRow
              label={t("swap")}
              value={percent(machine.swapUsed, machine.swapTotal)}
              detail={`${formatBytes(machine.swapUsed)} / ${formatBytes(machine.swapTotal)}`}
            />
          )}
          {machine.disks.map((disk) => (
            <MeterRow
              key={disk.mount}
              label={disk.mount}
              value={percent(disk.used, disk.total)}
              detail={`${formatBytes(disk.used)} / ${formatBytes(disk.total)}`}
            />
          ))}
        </div>

        <div className="mb-2 mt-3 flex items-baseline gap-2 border-t border-border pt-3 text-xs font-semibold text-foreground">
          {t("berth")}
          <span className="ml-auto font-normal tabular-nums text-muted-foreground">
            CPU {berthCpu.toFixed(1)}% · {formatBytes(berthMemory)}
          </span>
        </div>
        <div className="max-h-72 space-y-2.5 overflow-y-auto text-[11px]">
          {berth.map((group) => (
            <div key={group.kind}>
              <div className="flex items-baseline gap-2 font-medium">
                {t(`groups.${group.kind}`)}
                <span className="ml-auto tabular-nums text-muted-foreground">
                  {group.cpuPercent.toFixed(1)}% · {formatBytes(group.memory)}
                </span>
              </div>
              {group.processes.length === 0 ? (
                <div className="pl-3 text-muted-foreground">{t("none")}</div>
              ) : (
                group.processes.slice(0, TOP_PROCESSES).map((process) => (
                  <div
                    key={process.pid}
                    className="flex items-baseline gap-2 pl-3 text-muted-foreground"
                  >
                    <span className="min-w-0 truncate">{process.name}</span>
                    <span className="shrink-0 text-[10px] text-muted-foreground/60">
                      {process.pid}
                    </span>
                    <span className="ml-auto shrink-0 tabular-nums">
                      {process.cpuPercent.toFixed(1)}% ·{" "}
                      {formatBytes(process.memory)}
                    </span>
                  </div>
                ))
              )}
              {group.processes.length > TOP_PROCESSES && (
                <div className="pl-3 text-muted-foreground/60">
                  {t("more", {
                    count: group.processes.length - TOP_PROCESSES,
                  })}
                </div>
              )}
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  )
}

function MeterRow({
  label,
  value,
  detail,
}: {
  label: string
  value: number
  detail: string
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-20 shrink-0 truncate text-muted-foreground">
        {label}
      </span>
      <MiniBar percent={value} />
      <span
        className={cn("w-9 shrink-0 tabular-nums", usageTextColorClass(value))}
      >
        {value}%
      </span>
      <span className="ml-auto shrink-0 tabular-nums text-muted-foreground">
        {detail}
      </span>
    </div>
  )
}
