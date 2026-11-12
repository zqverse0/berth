"use client"

/**
 * 设备的共用部件：设备列表与在线状态、错误文案、添加设备 / 在设备上添加项目的对话框、开终端与配置密钥。
 * 状态栏设备段（`status-bar-devices.tsx`）、侧栏项目列表与设备页（`device-page.tsx`）共用。
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react"
import { useTranslations } from "next-intl"
import { CornerLeftUp, Folder, KeyRound, Loader2 } from "lucide-react"
import { toast } from "@/lib/notify"
import { toErrorMessage } from "@/lib/app-error"
import { getHomeDirectory } from "@/lib/api"
import { subscribe } from "@/lib/platform"
import { createAndOpenPrimaryTerminal } from "@/lib/terminal/create-and-open-primary-terminal"
import {
  addDevice,
  checkDevice,
  deviceCandidates,
  deviceNode,
  deviceRequest,
  ensureSshKey,
  listDevices,
  needsKeySetup,
  nodeOnline,
  type Device,
  type DeviceCheck,
  type NodeChannelStatus,
  type NodeReply,
} from "@/lib/devices"
import type { DeviceFeedState } from "@/components/conversations/sidebar/device-projects"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

export type DeviceStatus = "checking" | "online" | "offline"

/** 设备在线状态点的颜色（设备条、项目行、设备页共用）。 */
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

/** 设备列表；项目视图可见时读取，`reload` 重读。`loaded` 为读到过一次（据此清理工作区登记）。 */
export function useDeviceList(visible: boolean) {
  const t = useTranslations("Folder.sidebar.devices")
  const [devices, setDevices] = useState<Device[]>([])
  const [loaded, setLoaded] = useState(false)
  const [revision, setRevision] = useState(0)

  useEffect(() => {
    if (!visible) return
    let cancelled = false
    listDevices()
      .then((list) => {
        if (cancelled) return
        setDevices(list)
        setLoaded(true)
      })
      .catch((error) => {
        if (!cancelled)
          toast.error(t("loadFailed"), { description: toErrorMessage(error) })
      })
    return () => {
      cancelled = true
    }
  }, [visible, revision, t])

  const reload = useCallback(() => setRevision((n) => n + 1), [])
  useEffect(() => {
    window.addEventListener(DEVICES_CHANGED, reload)
    return () => window.removeEventListener(DEVICES_CHANGED, reload)
  }, [reload])
  return { devices, loaded, reload }
}

export interface DeviceState {
  state: DeviceStatus
  /** 连不上时 ssh 的错误或 `device.*` 错误码 */
  message: string | null
  keyMissing: boolean
}

/**
 * 各设备能否连上：设备列表读到时检测一次（不轮询），`recheck` 重新检测；节点设备在 ssh 测得通之后
 * 以节点连接的状态为准（后端推送）。检测时对方装没装 Berth 变了就重读列表。
 */
export function useDeviceStatus(devices: Device[], onChanged: () => void) {
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

type DeviceProblem = DeviceFeedState["problem"]

interface DevicesValue {
  devices: Device[]
  loaded: boolean
  reload: () => void
  statusOf: (device: Device) => DeviceState
  /** 节点设备的连线问题（侧栏的设备数据源上报，状态栏悬停说明用） */
  problems: Readonly<Record<number, DeviceProblem>>
  reportProblem: (deviceId: number, problem: DeviceProblem) => void
}

const DevicesContext = createContext<DevicesValue>({
  devices: [],
  loaded: false,
  reload: () => {},
  statusOf: () => ({ state: "checking", message: null, keyMissing: false }),
  problems: {},
  reportProblem: () => {},
})

/** 设备列表与在线状态的唯一来源：挂在窗口外壳，切换侧栏视图不卸载、不重复探测。 */
export function DevicesProvider({ children }: { children: ReactNode }) {
  const { devices, loaded, reload } = useDeviceList(true)
  const { statusOf } = useDeviceStatus(devices, reload)
  const [problems, setProblems] = useState<Record<number, DeviceProblem>>({})
  const reportProblem = useCallback(
    (deviceId: number, problem: DeviceProblem) =>
      setProblems((prev) =>
        (prev[deviceId] ?? null) === problem
          ? prev
          : { ...prev, [deviceId]: problem }
      ),
    []
  )
  const value = useMemo(
    () => ({ devices, loaded, reload, statusOf, problems, reportProblem }),
    [devices, loaded, reload, statusOf, problems, reportProblem]
  )
  return <DevicesContext value={value}>{children}</DevicesContext>
}

export function useDevices() {
  return useContext(DevicesContext)
}

/** 设备增删、装上 Berth 等变化：各处的设备列表据此重读。 */
const DEVICES_CHANGED = "berth:devices-changed"

export function notifyDevicesChanged() {
  window.dispatchEvent(new Event(DEVICES_CHANGED))
}

/** 从本机开一个到设备的 SSH 终端（没装 Berth 的设备只能这样用），起始目录是设备目录。 */
export async function openDeviceTerminal(device: Device) {
  return openHostTerminal(
    device.name,
    "ssh",
    ["--", device.target],
    device.localDir
  )
}

/** 配置免密登录：开终端跑 ssh-copy-id。 */
export function setupDeviceKey(device: Device) {
  return openKeySetupTerminal(device.name, device.target)
}

/**
 * 添加设备：填 SSH 目标与名称；保存前后端测一次连接，连不上不保存。
 * 因为要密码而连不上时，给出「配置免密登录」：开终端跑 ssh-copy-id，完成后再点添加。
 */
export function AddDeviceDialog({
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

/** 节点回复 → 结果；节点报错抛出它的说明。 */
async function nodeResult<T>(reply: Promise<NodeReply<T>>): Promise<T> {
  const settled = await reply
  if ("error" in settled) throw new Error(settled.error.message)
  return settled.result
}

/** 节点设备上的目录浏览（限对方家目录之内）。 */
const nodeDirs = (deviceId: number, path: string) =>
  nodeResult<{ path: string; dirs: string[] }>(
    deviceRequest(deviceId, { op: "dirs", path: path || null })
  )

/** 父目录；`/` 没有父目录。 */
function parentDir(path: string): string | null {
  if (path === "/") return null
  const cut = path.replace(/\/+$/, "").lastIndexOf("/")
  return cut <= 0 ? "/" : path.slice(0, cut)
}

/** 在节点设备上添加项目：浏览对方目录（限对方家目录之内），在对方 Berth 里登记，不挂载。 */
export function AddDeviceProjectDialog({
  device,
  onClose,
}: {
  device: Device | null
  onClose: () => void
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
  // 远程目录浏览：每进一层列一次子目录；只认最后一次请求的结果。
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
        const listed = await nodeDirs(device.id, path)
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
      const added = await nodeResult<{ name: string }>(
        deviceRequest(device.id, { op: "project_add", path: remotePath })
      )
      // 刷新设备概览，项目列表随 `device://node` 更新。
      void deviceNode(device.id).catch(() => {})
      toast.success(t("projectAdded", { name: added.name }))
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
              placeholder="/Users/me/Project/app"
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
                  {t("registering")}
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
