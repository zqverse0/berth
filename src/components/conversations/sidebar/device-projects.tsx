"use client"

import { useEffect, useSyncExternalStore, type DragEvent } from "react"
import { useTranslations } from "next-intl"
import { Copy, RefreshCw, X } from "lucide-react"
import { toast } from "@/lib/notify"
import { toErrorMessage } from "@/lib/app-error"
import {
  FILE_TREE_DROP_DEVICE_ATTR,
  hasFileTreeDragType,
  elementAtDropPosition,
  parseDeviceDropZone,
  readFileTreeDragPayload,
} from "@/lib/files/file-tree-dnd"
import { isDesktop } from "@/lib/transport"

import {
  cancelDeviceTransfer,
  startDeviceTransfer,
  transferInto,
  type DeviceTransfer,
  useDeviceOverview,
  type NodeOverview,
} from "@/lib/devices"
import { cn } from "@/lib/utils"
import {
  copyPathToClipboard,
  PasteMenuItem,
} from "@/components/layout/file-tree/file-tree-node"
import { usePasteFileTreeEntry } from "@/hooks/workspace/use-paste-file-tree-entry"
import { ContextMenuItem } from "@/components/ui/context-menu"
import { connectDevice } from "@/lib/transport"
import { refreshTerminalInventory } from "@/lib/terminal/terminal-inventory-query"
import { refreshAgentPanes } from "@/lib/terminal/agent-panes"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import {
  deviceFolderId,
  deviceLineState,
  devicePath,
  setDeviceRoots,
  watchDeviceLines,
} from "@/lib/transport/device"

function indent(depth: number) {
  return { paddingLeft: `${depth * 12 + 8}px` }
}

/**
 * 把本机文件树的条目拖进对方目录即传过去。桌面端的放下由文件树按 `data-tree-drop-device` 命中提交
 * （WebKit 收不到 DOM drop），这里的 `onDrop` 是网页端的路径。离线时不接收。
 */
/** 系统文件拖动中、放下即传到这一行：由 {@link useOsFileDropToDevices} 直接标在 DOM 上，不触发渲染。 */
const DROP_ACTIVE_ATTR = "data-drop-active"

export function useDeviceDrop(deviceId: number, live: boolean) {
  const t = useTranslations("Folder.fileTreeTab")
  return (dir: string) =>
    live
      ? {
          [FILE_TREE_DROP_DEVICE_ATTR]: `${deviceId}:${dir}`,
          className: "data-[drop-active]:bg-muted-foreground/20",
          onDragOver: (event: DragEvent) => {
            if (!hasFileTreeDragType(event.dataTransfer)) return
            event.preventDefault()
            event.dataTransfer.dropEffect = "copy"
          },
          onDrop: (event: DragEvent) => {
            const payload = readFileTreeDragPayload(event.dataTransfer)
            if (!payload) return
            event.preventDefault()
            if (payload.kind === "dir") {
              toast.error(t("toasts.transferDirUnsupported"))
              return
            }
            transferInto({ deviceId, dir }, payload.absPath).catch((error) =>
              toast.error(t("toasts.transferFailed"), {
                description: toErrorMessage(error),
              })
            )
          },
        }
      : {}
}

/**
 * 桌面端：从系统文件管理器拖进来的文件（Tauri 原生拖放带 `paths`）放到设备目录上即传过去。
 * 文件树自己的拖动不带 `paths`，仍由文件树提交；命中方式与它相同（按坐标找 `data-tree-drop-device`）。
 */
export function useOsFileDropToDevices() {
  const t = useTranslations("Folder.fileTreeTab")
  useEffect(() => {
    if (!isDesktop()) return
    let disposed = false
    const unlisteners: Array<() => void> = []
    // 这次拖动是不是系统文件（带路径）；高亮着的行（放下即传到它）。
    let osDrag = false
    let lit: Element | null = null
    const light = (row: Element | null) => {
      if (row === lit) return
      lit?.removeAttribute(DROP_ACTIVE_ATTR)
      row?.setAttribute(DROP_ACTIVE_ATTR, "")
      lit = row
    }
    const rowAt = (position: { x: number; y: number }) =>
      elementAtDropPosition(position)?.closest(
        `[${FILE_TREE_DROP_DEVICE_ATTR}]`
      ) ?? null
    void (async () => {
      const { getCurrentWebview } = await import("@tauri-apps/api/webview")
      const { TauriEvent } = await import("@tauri-apps/api/event")
      const webview = getCurrentWebview()
      type Position = { position: { x: number; y: number } }
      const offs = await Promise.all([
        webview.listen<{ paths: string[] }>(TauriEvent.DRAG_ENTER, (event) => {
          osDrag = event.payload.paths.length > 0
        }),
        webview.listen<Position>(TauriEvent.DRAG_OVER, (event) =>
          light(osDrag ? rowAt(event.payload.position) : null)
        ),
        webview.listen(TauriEvent.DRAG_LEAVE, () => light(null)),
        webview.listen<Position & { paths: string[] }>(
          TauriEvent.DRAG_DROP,
          ({ payload }) => {
            light(null)
            if (payload.paths.length === 0) return
            const zone = parseDeviceDropZone(
              rowAt(payload.position)?.getAttribute(
                FILE_TREE_DROP_DEVICE_ATTR
              ) ?? null
            )
            if (!zone) return
            for (const path of payload.paths) {
              transferInto(zone, path).catch((error) =>
                toast.error(t("toasts.transferFailed"), {
                  description: toErrorMessage(error),
                })
              )
            }
          }
        ),
      ])
      if (disposed) offs.forEach((off) => off())
      else unlisteners.push(...offs)
    })()
    return () => {
      disposed = true
      light(null)
      for (const off of unlisteners.splice(0)) off()
    }
  }, [t])
}

/** 传到这台设备的文件：进度、取消；失败或取消后可重试（从断点续上）或移除。 */
export function DeviceTransfers({
  transfers,
  dismiss,
}: {
  transfers: readonly DeviceTransfer[]
  dismiss: (id: number) => void
}) {
  const t = useTranslations("Folder.sidebar.devices")
  if (transfers.length === 0) return null
  const action = (label: string, Icon: typeof X, onClick: () => void) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      onClick={onClick}
      className="flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
    >
      <Icon className="size-3" />
    </button>
  )
  return (
    <ul aria-label={t("remote.transfers")}>
      {transfers.map((item) => {
        const name = item.dest.split("/").pop()
        const percent =
          item.total > 0 ? Math.floor((item.sent / item.total) * 100) : 0
        return (
          <li
            key={item.id}
            className="flex h-7 items-center gap-1.5 pr-2 text-xs"
            style={indent(1)}
            title={item.error ?? `${item.source} → ${item.dest}`}
          >
            <span className="min-w-0 flex-1 truncate">{name}</span>
            {item.state === "running" ? (
              <>
                <span className="shrink-0 tabular-nums text-muted-foreground">
                  {percent}%
                </span>
                {action(
                  t("remote.transferCancel"),
                  X,
                  () => void cancelDeviceTransfer(item.id).catch(() => {})
                )}
              </>
            ) : (
              <>
                <span
                  className={cn(
                    "shrink-0",
                    item.state === "failed"
                      ? "text-destructive"
                      : "text-muted-foreground"
                  )}
                >
                  {t(
                    item.state === "failed"
                      ? "remote.transferFailed"
                      : "remote.transferCancelled"
                  )}
                </span>
                {action(
                  t("remote.transferRetry"),
                  RefreshCw,
                  () =>
                    void startDeviceTransfer(
                      item.deviceId,
                      item.source,
                      item.dest
                    ).catch((error) =>
                      toast.error(t("remote.transferFailed"), {
                        description: toErrorMessage(error),
                      })
                    )
                )}
                {action(t("remote.transferDismiss"), X, () => dismiss(item.id))}
              </>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * 设备概览到达且在线：对方打开的项目以本机身份进工作区（`transport/device.ts`），并连上对方 GUI，
 * 它的终端从此并入本机终端清单——项目下的终端、Agent 状态、点开终端都与本机项目同一套。
 * 对方 GUI 没开时在后台重试，打开后自动连上。返回连线状态。
 */
function useDeviceWorkspace(
  deviceId: number,
  overview: NodeOverview | null,
  live: boolean
) {
  useEffect(() => {
    if (!overview || !live) return
    setDeviceRoots(
      deviceId,
      overview.projects.map((item) => item.path)
    )
    useAppWorkspaceStore.getState().syncDeviceFolders(
      deviceId,
      overview.projects.map((item) => ({
        ...item,
        id: deviceFolderId(deviceId, item.id),
        path: devicePath(deviceId, item.path),
        parent_id:
          item.parent_id == null
            ? null
            : deviceFolderId(deviceId, item.parent_id),
      }))
    )
    connectDevice(deviceId)
  }, [deviceId, overview, live])
  const state = useSyncExternalStore(watchDeviceLines, () =>
    deviceLineState(deviceId)
  )
  // 连上（含重连）后立即读一次终端，不等下一轮轮询。
  const open = state?.open === true
  useEffect(() => {
    if (!open) return
    void refreshTerminalInventory().catch(() => {})
    refreshAgentPanes()
  }, [open])
  return state
}

/** 没连上时的一句说明：对方版本过旧 / 没在运行 / 断线重连中；首次连接中不提示。 */
function lineProblem(
  error: unknown
):
  | "remote.berthOutdated"
  | "remote.windowUnavailable"
  | "remote.reconnecting"
  | null {
  if (error == null) return null
  const text = toErrorMessage(error)
  if (text.includes("device.berthOutdated")) return "remote.berthOutdated"
  if (text.includes("device.windowUnavailable"))
    return "remote.windowUnavailable"
  return "remote.reconnecting"
}

/** 一台节点设备的概览与连线问题，由 {@link DeviceFeed} 上报给项目列表。 */
export interface DeviceFeedState {
  overview: NodeOverview | null
  problem: ReturnType<typeof lineProblem>
}

/**
 * 节点设备的数据源（不渲染）：读概览（离线时用缓存）、在线时把对方项目并入本机工作区并连上对方 GUI，
 * 结果上报给项目列表，对方项目与本机项目在同一张列表里按工作区显示。
 */
export function DeviceFeed({
  deviceId,
  live,
  onUpdate,
}: {
  deviceId: number
  /** 数据通道在线；否则只用缓存。 */
  live: boolean
  onUpdate: (deviceId: number, feed: DeviceFeedState) => void
}) {
  const overview = useDeviceOverview(deviceId)
  const line = useDeviceWorkspace(deviceId, overview, live)
  const problem = live && line && !line.open ? lineProblem(line.error) : null
  useEffect(() => {
    onUpdate(deviceId, { overview, problem })
  }, [deviceId, overview, problem, onUpdate])
  return null
}

/** 对方项目行右键菜单里的对方专属项：复制路径、粘贴到对方。 */
export function DeviceProjectMenuItems({
  deviceId,
  path,
}: {
  deviceId: number
  path: string
}) {
  const tFileTree = useTranslations("Folder.fileTreeTab")
  const paste = usePasteFileTreeEntry()
  return (
    <>
      <ContextMenuItem
        onSelect={() =>
          void copyPathToClipboard(path, tFileTree("toasts.copyPathFailed"))
        }
      >
        <Copy className="h-4 w-4" />
        {tFileTree("copyPath")}
      </ContextMenuItem>
      <PasteMenuItem
        onPaste={() => void paste(devicePath(deviceId, path), "")}
      />
    </>
  )
}
