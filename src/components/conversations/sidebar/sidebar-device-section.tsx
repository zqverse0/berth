"use client"

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react"
import { useTranslations } from "next-intl"
import {
  ChevronDown,
  ChevronRight,
  CornerLeftUp,
  Folder,
  FolderPlus,
  KeyRound,
  Loader2,
  RefreshCw,
  Server,
  SquareTerminal,
  Trash2,
  type LucideIcon,
} from "lucide-react"
import { toast } from "@/lib/notify"
import { toErrorMessage } from "@/lib/app-error"
import { getHomeDirectory } from "@/lib/api"
import { createAndOpenPrimaryTerminal } from "@/lib/terminal/create-and-open-primary-terminal"
import {
  addDevice,
  addDeviceProject,
  checkDevice,
  deviceCandidates,
  ensureSshKey,
  listDeviceDirs,
  listDevices,
  needsKeySetup,
  removeDevice,
  type Device,
} from "@/lib/devices"
import type { FolderDetail } from "@/lib/types"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  DetachedTerminalStrip,
  type SessionStripEntry,
} from "./project-active-session-strip"

type DeviceStatus = "checking" | "online" | "offline"

const STATUS_DOT: Record<DeviceStatus, string> = {
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
  "device.hasProjects": "errors.hasProjects",
  "device.remotePathInvalid": "errors.remotePathInvalid",
  "device.sshfsMissing": "errors.sshfsMissing",
} as const

function useDeviceErrorText() {
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

/** 在本机打开一个终端跑指定程序（不属于任何项目）；`cwd` 缺省为家目录。 */
async function openHostTerminal(
  title: string,
  executable: string,
  args: string[],
  cwd?: string
) {
  return createAndOpenPrimaryTerminal({
    cwd: cwd ?? (await getHomeDirectory()),
    title,
    executable,
    args,
    folderId: null,
  })
}

/**
 * 配置免密登录：本机没有密钥就生成一把，再开终端跑 `ssh-copy-id`。
 * 主机指纹与密码由用户在终端里确认 / 输入，Berth 不经手密码。
 */
async function openKeySetupTerminal(name: string, target: string) {
  const { publicKey } = await ensureSshKey()
  return openHostTerminal(name, "ssh-copy-id", ["-i", publicKey, target])
}

/** 一级分组标题（本机、各设备）：点击折叠；右侧悬停出现动作按钮。 */
export function SidebarGroupHeader({
  icon,
  label,
  trailing,
  title,
  collapsed,
  onToggle,
  actions = [],
  muted = false,
}: {
  icon: ReactNode
  label: string
  trailing?: ReactNode
  title?: string
  collapsed: boolean
  onToggle: () => void
  actions?: { icon: LucideIcon; label: string; onClick: () => void }[]
  muted?: boolean
}) {
  const Chevron = collapsed ? ChevronRight : ChevronDown
  return (
    <div className="group/header flex h-7 items-center rounded-md pr-1 hover:bg-accent/60">
      <button
        type="button"
        title={title}
        aria-expanded={!collapsed}
        onClick={onToggle}
        className="flex h-full min-w-0 flex-1 items-center gap-1.5 px-1.5 text-left text-xs font-medium"
      >
        <Chevron
          aria-hidden
          className="size-3 shrink-0 text-muted-foreground"
        />
        <span className="relative flex size-4 shrink-0 items-center justify-center text-muted-foreground">
          {icon}
        </span>
        <span
          className={cn("min-w-0 truncate", muted && "text-muted-foreground")}
        >
          {label}
        </span>
        {trailing ? (
          <span className="ml-auto shrink-0 pl-2 text-[11px] font-normal text-muted-foreground group-hover/header:hidden">
            {trailing}
          </span>
        ) : null}
      </button>
      {actions.length > 0 ? (
        <div className="hidden shrink-0 items-center group-hover/header:flex">
          {actions.map((action) => (
            <button
              key={action.label}
              type="button"
              title={action.label}
              aria-label={action.label}
              onClick={action.onClick}
              className="flex size-6 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              <action.icon className="size-3.5" />
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** 设备列表；项目视图可见时、以及 `refreshKey`（项目集合）变化时重读。 */
export function useDeviceList(visible: boolean, refreshKey: string) {
  const t = useTranslations("Folder.sidebar.devices")
  const [devices, setDevices] = useState<Device[]>([])
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (!visible) return
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
  }, [visible, revision, refreshKey, t])

  const reload = useCallback(() => setRevision((n) => n + 1), [])
  return { devices, reload }
}

/**
 * 项目列表下方的「设备」分节：每台设备一行（能否连上、点击开 SSH 终端），其下是它的远程项目。
 * 在线状态只在设备列表读到时检测一次（不轮询），右键可重新检测；连得上时后端顺带挂好项目。
 */
export function SidebarDeviceSection({
  devices,
  onChanged,
  renderProject,
  terminals,
  collapsed,
  onToggle,
  onProjectAdded,
  addOpen,
  onAddOpenChange,
}: {
  devices: Device[]
  onChanged: () => void
  /** 从各设备打开、仍在运行的终端（按设备 id）。 */
  terminals: ReadonlyMap<number, readonly SessionStripEntry[]>
  /** 折叠状态，键 `device:<id>`。 */
  collapsed: Readonly<Record<string, boolean>>
  onToggle: (key: string) => void
  /** 远程项目行：与本机项目同一个行组件；项目已关闭时返回 null。 */
  renderProject: (folderId: number) => ReactNode
  onProjectAdded: (folder: FolderDetail) => void
  addOpen: boolean
  onAddOpenChange: (open: boolean) => void
}) {
  const t = useTranslations("Folder.sidebar.devices")
  const errorText = useDeviceErrorText()
  const [status, setStatus] = useState<
    Record<number, { state: DeviceStatus; message: string | null }>
  >({})
  const [projectTarget, setProjectTarget] = useState<Device | null>(null)

  // 没有记录即「检测中」；只在 await 之后写状态。
  const probe = useCallback(async (device: Device) => {
    const result = await checkDevice(device.target, device.id).catch(
      (error) => ({ ok: false, message: toErrorMessage(error) })
    )
    setStatus((prev) => ({
      ...prev,
      [device.id]: {
        state: result.ok ? "online" : "offline",
        message: result.message,
      },
    }))
  }, [])

  useEffect(() => {
    devices.forEach((device) => void probe(device))
  }, [devices, probe])

  const recheck = (device: Device) => {
    setStatus((prev) => {
      const next = { ...prev }
      delete next[device.id]
      return next
    })
    void probe(device)
  }

  const openTerminal = async (device: Device) => {
    try {
      const id = await openHostTerminal(
        device.name,
        "ssh",
        ["--", device.target],
        device.localDir
      )
      if (!id) toast.error(t("openFailed"))
    } catch (error) {
      toast.error(t("openFailed"), { description: toErrorMessage(error) })
    }
  }

  const setupKey = async (device: Device) => {
    try {
      await openKeySetupTerminal(device.name, device.target)
      toast.info(t("keySetupStarted"))
    } catch (error) {
      toast.error(t("keySetupFailed"), { description: toErrorMessage(error) })
    }
  }

  const handleRemove = async (device: Device) => {
    try {
      await removeDevice(device.id)
      onChanged()
    } catch (error) {
      toast.error(t("removeFailed"), {
        description: errorText(toErrorMessage(error)),
      })
    }
  }

  return (
    <>
      {devices.map((device) => {
        const current = status[device.id]
        const state = current?.state ?? "checking"
        const keyMissing =
          state === "offline" && needsKeySetup(current?.message)
        const key = `device:${device.id}`
        const deviceTerminals = terminals.get(device.id) ?? []
        return (
          <div key={device.id} className="flex flex-col pt-1">
            <ContextMenu>
              <ContextMenuTrigger asChild>
                <div>
                  <SidebarGroupHeader
                    icon={
                      <>
                        <Server aria-hidden className="size-3.5" />
                        <span
                          aria-hidden
                          className={cn(
                            "absolute -bottom-0.5 -right-0.5 size-1.5 rounded-full",
                            STATUS_DOT[state]
                          )}
                        />
                      </>
                    }
                    label={device.name}
                    muted={state === "offline"}
                    trailing={
                      keyMissing ? t("status.needsKey") : t(`status.${state}`)
                    }
                    title={
                      state === "offline"
                        ? `${device.target}\n${errorText(current?.message)}`
                        : device.target
                    }
                    collapsed={collapsed[key] === true}
                    onToggle={() => onToggle(key)}
                    actions={[
                      {
                        icon: SquareTerminal,
                        label: t("openTerminal"),
                        onClick: () => void openTerminal(device),
                      },
                      {
                        icon: FolderPlus,
                        label: t("addProject"),
                        onClick: () => setProjectTarget(device),
                      },
                    ]}
                  />
                </div>
              </ContextMenuTrigger>
              <ContextMenuContent>
                <ContextMenuItem onSelect={() => void openTerminal(device)}>
                  <SquareTerminal className="mr-2 h-3.5 w-3.5" />
                  {t("openTerminal")}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => setProjectTarget(device)}>
                  <FolderPlus className="mr-2 h-3.5 w-3.5" />
                  {t("addProject")}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => recheck(device)}>
                  <RefreshCw className="mr-2 h-3.5 w-3.5" />
                  {t("recheck")}
                </ContextMenuItem>
                <ContextMenuItem onSelect={() => void setupKey(device)}>
                  <KeyRound className="mr-2 h-3.5 w-3.5" />
                  {t("setupKey")}
                </ContextMenuItem>
                <ContextMenuSeparator />
                <ContextMenuItem onSelect={() => void handleRemove(device)}>
                  <Trash2 className="mr-2 h-3.5 w-3.5" />
                  {t("remove")}
                </ContextMenuItem>
              </ContextMenuContent>
            </ContextMenu>
            {collapsed[key] ? null : (
              <>
                {device.projects.map((project) => (
                  <div key={project.folderId}>
                    {renderProject(project.folderId)}
                  </div>
                ))}
                {device.projects.length === 0 &&
                deviceTerminals.length === 0 ? (
                  <button
                    type="button"
                    onClick={() => setProjectTarget(device)}
                    className="h-7 px-8 text-left text-xs text-muted-foreground hover:text-foreground"
                  >
                    {t("emptyDevice")}
                  </button>
                ) : null}
                <DetachedTerminalStrip
                  entries={deviceTerminals}
                  ariaLabel={t("deviceTerminals", { name: device.name })}
                />
              </>
            )}
          </div>
        )
      })}

      <AddDeviceDialog
        // 每次打开重新挂载，表单从空白开始。
        key={addOpen ? "add-device-open" : "add-device-closed"}
        open={addOpen}
        onOpenChange={onAddOpenChange}
        onAdded={onChanged}
      />
      <AddDeviceProjectDialog
        key={
          projectTarget
            ? `add-project-${projectTarget.id}`
            : "add-project-closed"
        }
        device={projectTarget}
        onClose={() => setProjectTarget(null)}
        onAdded={(folder) => {
          onChanged()
          onProjectAdded(folder)
        }}
      />
    </>
  )
}

/**
 * 添加设备：填 SSH 目标与名称；保存前后端测一次连接，连不上不保存。
 * 因为要密码而连不上时，给出「配置免密登录」：开终端跑 ssh-copy-id，完成后再点添加。
 */
function AddDeviceDialog({
  open,
  onOpenChange,
  onAdded,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onAdded: () => void
}) {
  const t = useTranslations("Folder.sidebar.devices")
  const tCommon = useTranslations("Folder.common")
  const errorText = useDeviceErrorText()
  const [form, setForm] = useState({
    name: "",
    target: "",
    saving: false,
    error: null as string | null,
    keySetupOpened: false,
  })
  const [candidates, setCandidates] = useState<string[]>([])

  useEffect(() => {
    if (!open) return
    deviceCandidates()
      .then(setCandidates)
      .catch(() => setCandidates([]))
  }, [open])

  const target = form.target.trim()

  const handleSave = async () => {
    if (!target || form.saving) return
    setForm((prev) => ({ ...prev, saving: true, error: null }))
    try {
      const device = await addDevice(form.name.trim() || target, target)
      onAdded()
      toast.success(t("added", { name: device.name }))
      onOpenChange(false)
    } catch (error) {
      setForm((prev) => ({
        ...prev,
        saving: false,
        error: toErrorMessage(error),
      }))
    }
  }

  const handleKeySetup = async () => {
    try {
      await openKeySetupTerminal(form.name.trim() || target, target)
      setForm((prev) => ({ ...prev, keySetupOpened: true }))
    } catch (error) {
      toast.error(t("keySetupFailed"), { description: toErrorMessage(error) })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t("addTitle")}</DialogTitle>
          <DialogDescription>{t("addDescription")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4 py-2"
          onSubmit={(event) => {
            event.preventDefault()
            void handleSave()
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="add-device-target">{t("targetLabel")}</Label>
            <Input
              id="add-device-target"
              list="add-device-candidates"
              autoFocus
              placeholder="user@100.64.0.6"
              value={form.target}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, target: e.target.value }))
              }
            />
            <datalist id="add-device-candidates">
              {candidates.map((host) => (
                <option key={host} value={host} />
              ))}
            </datalist>
            <p className="text-xs text-muted-foreground">{t("targetHint")}</p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="add-device-name">{t("nameLabel")}</Label>
            <Input
              id="add-device-name"
              placeholder={target || t("namePlaceholder")}
              value={form.name}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, name: e.target.value }))
              }
            />
          </div>
          {form.error ? (
            <div className="space-y-2">
              <p className="break-words text-xs text-destructive">
                {errorText(form.error)}
              </p>
              {needsKeySetup(form.error) ? (
                <div className="space-y-1.5 rounded-md bg-muted/40 p-2 text-xs text-muted-foreground">
                  <p>
                    {form.keySetupOpened
                      ? t("keySetupThenAdd")
                      : t("keySetupExplain")}
                  </p>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => void handleKeySetup()}
                  >
                    <KeyRound className="mr-1.5 h-3.5 w-3.5" />
                    {t("setupKey")}
                  </Button>
                </div>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => onOpenChange(false)}
            >
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={!target || form.saving}>
              {form.saving ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  {t("testing")}
                </>
              ) : (
                t("add")
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

/** 父目录；`/` 没有父目录。 */
function parentDir(path: string): string | null {
  if (path === "/") return null
  const cut = path.replace(/\/+$/, "").lastIndexOf("/")
  return cut <= 0 ? "/" : path.slice(0, cut)
}

/** 在设备上添加项目：浏览或填设备上的目录，后端用 sshfs 挂到本机并注册为项目。 */
function AddDeviceProjectDialog({
  device,
  onClose,
  onAdded,
}: {
  device: Device | null
  onClose: () => void
  onAdded: (folder: FolderDetail) => void
}) {
  const t = useTranslations("Folder.sidebar.devices")
  const tCommon = useTranslations("Folder.common")
  const errorText = useDeviceErrorText()
  const [form, setForm] = useState({
    remotePath: "",
    saving: false,
    error: null as string | null,
  })
  const remotePath = form.remotePath.trim()
  // 远程目录浏览：每进一层 ssh 列一次子目录；只认最后一次请求的结果。
  const [browse, setBrowse] = useState({
    path: null as string | null,
    dirs: [] as string[],
    loading: false,
    error: null as string | null,
  })
  const browseSeq = useRef(0)
  const openDir = useCallback(
    async (path: string) => {
      if (!device) return
      const seq = ++browseSeq.current
      setBrowse((prev) => ({ ...prev, loading: true, error: null }))
      try {
        const listed = await listDeviceDirs(device.id, path)
        if (seq !== browseSeq.current) return
        setBrowse({ ...listed, loading: false, error: null })
        setForm((prev) => ({ ...prev, remotePath: listed.path }))
      } catch (error) {
        if (seq !== browseSeq.current) return
        setBrowse((prev) => ({
          ...prev,
          loading: false,
          error: toErrorMessage(error),
        }))
      }
    },
    [device]
  )
  useEffect(() => {
    void openDir("")
  }, [openDir])
  const browseParent = browse.path ? parentDir(browse.path) : null

  const handleSave = async () => {
    if (!device || !remotePath || form.saving) return
    setForm((prev) => ({ ...prev, saving: true, error: null }))
    try {
      const folder = await addDeviceProject(device.id, remotePath)
      toast.success(t("projectAdded", { name: folder.name }))
      onAdded(folder)
      onClose()
    } catch (error) {
      setForm((prev) => ({
        ...prev,
        saving: false,
        error: toErrorMessage(error),
      }))
    }
  }

  return (
    <Dialog open={device !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {t("addProjectTitle", { name: device?.name ?? "" })}
          </DialogTitle>
          <DialogDescription>{t("addProjectDescription")}</DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4 py-2"
          onSubmit={(event) => {
            event.preventDefault()
            void handleSave()
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="add-device-project-path">
              {t("remotePathLabel")}
            </Label>
            <Input
              id="add-device-project-path"
              autoFocus
              placeholder="~/Project/app"
              value={form.remotePath}
              onChange={(e) =>
                setForm((prev) => ({ ...prev, remotePath: e.target.value }))
              }
            />
            <div
              role="group"
              aria-label={t("browseLabel")}
              aria-busy={browse.loading}
              className="h-48 overflow-y-auto rounded-md border text-xs"
            >
              {browseParent ? (
                <button
                  type="button"
                  className="flex h-7 w-full items-center gap-1.5 px-2 text-left text-muted-foreground hover:bg-accent"
                  onClick={() => void openDir(browseParent)}
                >
                  <CornerLeftUp className="size-3.5 shrink-0" aria-hidden />
                  ..
                </button>
              ) : null}
              {browse.dirs.map((name) => (
                <button
                  key={name}
                  type="button"
                  className="flex h-7 w-full items-center gap-1.5 px-2 text-left hover:bg-accent"
                  onClick={() =>
                    void openDir(
                      `${browse.path === "/" ? "" : browse.path}/${name}`
                    )
                  }
                >
                  <Folder
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-hidden
                  />
                  <span className="truncate">{name}</span>
                </button>
              ))}
              {browse.loading ? (
                <div className="flex h-7 items-center gap-1.5 px-2 text-muted-foreground">
                  <Loader2 className="size-3.5 animate-spin" aria-hidden />
                  {t("browseLoading")}
                </div>
              ) : browse.error ? (
                <p className="break-words px-2 py-1.5 text-destructive">
                  {errorText(browse.error)}
                </p>
              ) : browse.dirs.length === 0 ? (
                <p className="px-2 py-1.5 text-muted-foreground">
                  {t("browseEmpty")}
                </p>
              ) : null}
            </div>
          </div>
          {form.error ? (
            <p className="break-words text-xs text-destructive">
              {errorText(form.error)}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              {tCommon("cancel")}
            </Button>
            <Button type="submit" disabled={!remotePath || form.saving}>
              {form.saving ? (
                <>
                  <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                  {t("mounting")}
                </>
              ) : (
                t("add")
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
