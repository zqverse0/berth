"use client"

import { useEffect, useSyncExternalStore, type DragEvent } from "react"
import { useTranslations } from "next-intl"
import { Copy, Loader2, RefreshCw, X } from "lucide-react"
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
  useDeviceTransfers,
  useDeviceOverview,
  type Device,
  type NodeOverview,
} from "@/lib/devices"
import { cn } from "@/lib/utils"
import { copyPathToClipboard } from "@/components/layout/file-tree/file-tree-node"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import { ProjectActiveSessionStrip } from "./project-active-session-strip"
import { connectDevice } from "@/lib/transport"
import { refreshTerminalInventory } from "@/lib/terminal/terminal-inventory-query"
import { refreshAgentPanes } from "@/lib/terminal/agent-panes"
import { projectRowOrder } from "./project-list-order"
import { useAppWorkspaceStore } from "@/stores/app-workspace-store"
import { useAppUiStore } from "@/stores/app-ui-store"
import { useTabStore } from "@/contexts/tab-context"
import {
  deviceFolderId,
  deviceLineState,
  devicePath,
  parseDeviceFolderId,
  setDeviceRoots,
  watchDeviceLines,
} from "@/lib/transport/device"
import {
  ProjectRowButton,
  RAIL_AXIS,
  SESSION_STRIP_INDENT,
  projectBlockClass,
} from "./project-row-face"

function indent(depth: number) {
  return { paddingLeft: `${depth * 12 + 8}px` }
}

/**
 * 把本机文件树的条目拖进对方目录即传过去。桌面端的放下由文件树按 `data-tree-drop-device` 命中提交
 * （WebKit 收不到 DOM drop），这里的 `onDrop` 是网页端的路径。离线时不接收。
 */
/** 系统文件拖动中、放下即传到这一行：由 {@link useOsFileDropToDevices} 直接标在 DOM 上，不触发渲染。 */
const DROP_ACTIVE_ATTR = "data-drop-active"

function useDeviceDrop(deviceId: number, live: boolean) {
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
function DeviceTransfers({ deviceId }: { deviceId: number }) {
  const t = useTranslations("Folder.sidebar.devices")
  const { transfers, dismiss } = useDeviceTransfers(deviceId, (dest) =>
    toast.success(
      t("remote.transferDone", { name: dest.split("/").pop() ?? dest })
    )
  )
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
                      deviceId,
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

/**
 * 节点设备下的项目：对方侧栏里打开的项目，排法、外观与本机项目行一致（worktree 挂在根项目下），
 * 每个项目下是它在对方的终端。点项目或终端就选中它：主窗口内容区切到这个对方项目。
 */
export function DeviceProjects({
  device,
  live,
  onAddProject,
}: {
  device: Pick<Device, "id" | "name">
  /** 数据通道在线；否则只用缓存。 */
  live: boolean
  onAddProject: () => void
}) {
  const t = useTranslations("Folder.sidebar.devices")
  const tFileTree = useTranslations("Folder.fileTreeTab")
  const overview = useDeviceOverview(device.id)
  const drop = useDeviceDrop(device.id, live)
  const line = useDeviceWorkspace(device.id, overview, live)
  const problem = live && line && !line.open ? lineProblem(line.error) : null

  const activeFolderId = useAppWorkspaceStore((state) => state.activeFolderId)
  const selected =
    activeFolderId == null ? null : parseDeviceFolderId(activeFolderId)
  const selectedId = selected?.deviceId === device.id ? selected.folderId : null

  // 与本机项目一样：选中即进这个项目，群组是项目主页。没连上时调用在会话里排队，连上即出。
  const open = (project: number) => {
    if (!live) return
    useTabStore
      .getState()
      .activateFolderWorkspace(deviceFolderId(device.id, project))
    useAppUiStore.setState({ auxView: "group" })
  }

  const projects = overview?.projects ?? []
  const byId = new Map(projects.map((project) => [project.id, project]))
  const rows = projectRowOrder(projects)

  return (
    <div
      className={cn(!live && "opacity-60")}
      title={live ? undefined : t("remote.offline")}
    >
      {problem ? (
        <p className="flex min-h-7 items-center px-8 text-xs text-muted-foreground">
          {t(problem)}
        </p>
      ) : null}
      {!overview ? (
        <p className="flex h-7 items-center gap-1.5 px-8 text-xs text-muted-foreground">
          {live ? (
            <>
              <Loader2 aria-hidden className="size-3 animate-spin" />
              {t("remote.loading")}
            </>
          ) : (
            t("remote.noCache")
          )}
        </p>
      ) : rows.length === 0 ? (
        <button
          type="button"
          onClick={onAddProject}
          className="h-7 px-8 text-left text-xs text-muted-foreground hover:text-foreground"
        >
          {t("emptyDevice")}
        </button>
      ) : (
        rows.map((row, index) => {
          const project = byId.get(row.folderId)!
          const railBelow = rows[index + 1]?.nested === true
          return (
            <div
              key={project.id}
              className={projectBlockClass(selectedId === project.id)}
            >
              <ContextMenu>
                <ContextMenuTrigger asChild>
                  <div className="flex h-[2rem] items-center">
                    <ProjectRowButton
                      name={project.name}
                      alias={project.alias}
                      path={project.path}
                      pinned={project.pinned_at != null}
                      selected={selectedId === project.id}
                      worktree={row.worktree}
                      nested={row.nested}
                      branch={project.git_branch}
                      disabled={!live}
                      onClick={() => open(project.id)}
                      {...drop(project.path)}
                    />
                  </div>
                </ContextMenuTrigger>
                <ContextMenuContent>
                  <ContextMenuItem
                    onSelect={() =>
                      void copyPathToClipboard(
                        project.path,
                        tFileTree("toasts.copyPathFailed")
                      )
                    }
                  >
                    <Copy className="h-4 w-4" />
                    {tFileTree("copyPath")}
                  </ContextMenuItem>
                </ContextMenuContent>
              </ContextMenu>
              <ProjectActiveSessionStrip
                folderId={deviceFolderId(device.id, project.id)}
                indent={SESSION_STRIP_INDENT}
                railAxis={row.nested || railBelow ? RAIL_AXIS : undefined}
              />
            </div>
          )
        })
      )}
      <DeviceTransfers deviceId={device.id} />
    </div>
  )
}
