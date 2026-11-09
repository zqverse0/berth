"use client"

import { useEffect, useState, useSyncExternalStore } from "react"
import { useTranslations } from "next-intl"
import {
  CheckCircle2,
  Circle,
  FolderPlus,
  KeyRound,
  Loader2,
  MinusCircle,
  Plus,
  RefreshCw,
  SquareTerminal,
  Trash2,
  XCircle,
} from "lucide-react"
import { toast } from "@/lib/notify"
import { toErrorMessage } from "@/lib/app-error"
import {
  checkDevice,
  deviceChecklist,
  removeDevice,
  useDeviceOverview,
  type DeviceCheck,
  type DeviceCheckItem,
} from "@/lib/devices"
import { getCurrentAppVersion } from "@/lib/updater"
import {
  deviceLineState,
  parseDeviceRef,
  watchDeviceLines,
} from "@/lib/transport/device"
import { useTerminalInventorySnapshot } from "@/lib/terminal/terminal-inventory-query"
import { tabFromDescriptor } from "@/lib/terminal/create-and-open-primary-terminal"
import {
  useWorkspaceGroupsStore,
  workspaceGroupOf,
} from "@/lib/workspace-groups"
import { useTabActions, useTabStore } from "@/contexts/tab-context"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { useAppUiStore } from "@/stores/app-ui-store"
import { buildDeviceTabId } from "@/lib/files/file-workspace-tab"
import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { DeviceLaunchPanel } from "@/components/layout/sidebar/agent-launch"
import {
  AddDeviceProjectDialog,
  STATUS_DOT,
  notifyDevicesChanged,
  openDeviceTerminal,
  setupDeviceKey,
  useDeviceErrorText,
  useDeviceList,
} from "./devices"

const CHECK_ICON: Record<DeviceCheckItem["state"], typeof Circle> = {
  ok: CheckCircle2,
  fail: XCircle,
  pending: Loader2,
  skipped: MinusCircle,
}
const CHECK_COLOR: Record<DeviceCheckItem["state"], string> = {
  ok: "text-emerald-600 dark:text-emerald-400",
  fail: "text-destructive",
  pending: "animate-spin text-muted-foreground",
  skipped: "text-muted-foreground/60",
}

function Section({
  title,
  action,
  children,
}: {
  title: string
  action?: React.ReactNode
  children: React.ReactNode
}) {
  return (
    <section aria-label={title} className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-medium">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  )
}

/**
 * 设备页（中间区的设备 tab）：概览、检查清单、项目、终端与操作。打开时检测一次，「重新检测」再测；
 * 原侧栏设备右键菜单的操作都在这里完成。
 */
export function DevicePage({ deviceId }: { deviceId: number }) {
  const t = useTranslations("DevicePage")
  const tDevices = useTranslations("Folder.sidebar.devices")
  const errorText = useDeviceErrorText()
  const { devices, loaded } = useDeviceList(true)
  const device = devices.find((item) => item.id === deviceId) ?? null
  const overview = useDeviceOverview(deviceId)
  const line = useSyncExternalStore(watchDeviceLines, () =>
    deviceLineState(deviceId)
  )
  const groups = useWorkspaceGroupsStore((s) => s.state)
  const inventory = useTerminalInventorySnapshot(true)
  const tabs = useTabStore((s) => s.tabs)
  const { openTerminalTab, switchTab } = useTabActions()
  const { closeFileTab } = useWorkspaceRuntimeActions()

  const [localVersion, setLocalVersion] = useState<string | null>(null)
  useEffect(() => {
    void getCurrentAppVersion().then(setLocalVersion)
  }, [])

  // 检测：打开时一次，「重新检测」再一轮；只认本轮的结果。对方装没装 Berth 变了就让各处重读设备列表
  const [round, setRound] = useState(0)
  const [result, setResult] = useState<{
    round: number
    check: DeviceCheck
  } | null>(null)
  const target = device?.target
  const hadNode = device?.node != null
  useEffect(() => {
    if (!target) return
    let stale = false
    void checkDevice(target, deviceId)
      .catch((error) => ({ ok: false, message: toErrorMessage(error) }))
      .then((check: DeviceCheck) => {
        if (stale) return
        setResult({ round, check })
        if (check.ok && Boolean(check.node) !== hadNode) notifyDevicesChanged()
      })
    return () => {
      stale = true
    }
  }, [deviceId, hadNode, round, target])
  const check = result?.round === round ? result.check : null
  const runCheck = () => setRound((n) => n + 1)

  const [dialog, setDialog] = useState<"launch" | "project" | "remove" | null>(
    null
  )

  if (!device) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {loaded ? t("gone") : <Loader2 className="size-4 animate-spin" />}
      </div>
    )
  }

  const berth = check?.node?.berth ?? device.node?.berth ?? null
  const items = deviceChecklist({
    check,
    berth,
    overview,
    localVersion,
    line: line
      ? {
          open: line.open,
          error:
            line.error == null ? null : errorText(toErrorMessage(line.error)),
        }
      : null,
  })
  const state = !check ? "checking" : check.ok ? "online" : "offline"

  const terminals = inventory.filter(
    (descriptor) =>
      descriptor.status === "running" &&
      (parseDeviceRef(descriptor.terminalId)?.deviceId === deviceId ||
        descriptor.initialCwd === device.localDir)
  )
  const openTerminal = (terminalId: string) => {
    const tab = tabs.find(
      (item) => item.kind === "terminal" && item.terminalId === terminalId
    )
    const descriptor = terminals.find((item) => item.terminalId === terminalId)
    if (tab) switchTab(tab.id)
    else if (descriptor)
      openTerminalTab(
        descriptor.folderId == null
          ? tabFromDescriptor(descriptor, {
              folderId: null,
              detachedFolderPath: descriptor.initialCwd,
            })
          : tabFromDescriptor(descriptor),
        true
      )
    useAppUiStore.getState().showAuxView("terminals")
  }

  const run = (action: () => Promise<unknown>, failed: string) =>
    void action().catch((error) =>
      toast.error(failed, { description: toErrorMessage(error) })
    )

  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto max-w-2xl space-y-6 px-6 py-6">
        <header className="flex items-center gap-2">
          <span
            aria-hidden
            className={cn("size-2 rounded-full", STATUS_DOT[state])}
          />
          <h1 className="min-w-0 flex-1 truncate text-lg font-semibold">
            {device.name}
          </h1>
          <span className="text-xs text-muted-foreground">
            {tDevices(`status.${state}`)}
          </span>
        </header>

        <Section title={t("overview")}>
          <dl className="grid grid-cols-[8rem_1fr] gap-x-4 gap-y-1 text-sm">
            <dt className="text-muted-foreground">{t("target")}</dt>
            <dd className="truncate font-mono text-xs leading-5">
              {device.target}
            </dd>
            <dt className="text-muted-foreground">{t("system")}</dt>
            <dd className="truncate">
              {overview
                ? [overview.host, overview.os, overview.arch]
                    .filter(Boolean)
                    .join(" · ")
                : "—"}
            </dd>
            <dt className="text-muted-foreground">{t("berthPath")}</dt>
            <dd className="truncate font-mono text-xs leading-5">
              {berth ?? "—"}
            </dd>
            <dt className="text-muted-foreground">{t("version")}</dt>
            <dd className="truncate">
              {t("versions", {
                local: localVersion ?? "—",
                remote: overview?.version ?? "—",
              })}
            </dd>
          </dl>
        </Section>

        <Section
          title={t("checklist")}
          action={
            <Button size="sm" variant="outline" onClick={runCheck}>
              <RefreshCw className="mr-1.5 size-3.5" />
              {tDevices("recheck")}
            </Button>
          }
        >
          <ol className="space-y-1">
            {items.map((item) => {
              const Icon = CHECK_ICON[item.state]
              const detail = item.reason
                ? t(`checks.${item.reason.key}`, item.reason.values)
                : item.raw
                  ? errorText(item.raw)
                  : null
              return (
                <li
                  key={item.id}
                  className="flex items-start gap-2 text-sm"
                  data-check={item.id}
                  data-state={item.state}
                >
                  <Icon
                    aria-hidden
                    className={cn(
                      "mt-0.5 size-4 shrink-0",
                      CHECK_COLOR[item.state]
                    )}
                  />
                  <span className="w-28 shrink-0">{t(`steps.${item.id}`)}</span>
                  <span className="sr-only">{t(`states.${item.state}`)}</span>
                  {detail ? (
                    <span
                      className={cn(
                        "min-w-0 break-words text-xs leading-5",
                        item.state === "fail"
                          ? "text-destructive"
                          : "text-muted-foreground"
                      )}
                    >
                      {detail}
                    </span>
                  ) : null}
                </li>
              )
            })}
          </ol>
        </Section>

        {device.node ? (
          <Section
            title={t("projects")}
            action={
              <Button
                size="sm"
                variant="outline"
                onClick={() => setDialog("project")}
              >
                <FolderPlus className="mr-1.5 size-3.5" />
                {tDevices("addProject")}
              </Button>
            }
          >
            {overview?.projects.length ? (
              <ul className="divide-y rounded-md border text-sm">
                {overview.projects
                  .filter(
                    (project) =>
                      project.parent_id == null ||
                      !overview.projects.some((p) => p.id === project.parent_id)
                  )
                  .map((project) => {
                    const groupId = groups
                      ? workspaceGroupOf(groups, deviceId, project.path)
                      : null
                    const group = groups?.groups.find((g) => g.id === groupId)
                    return (
                      <li
                        key={project.id}
                        className="flex items-center gap-2 px-3 py-1.5"
                        title={project.path}
                      >
                        <span className="min-w-0 flex-1 truncate">
                          {project.alias || project.name}
                        </span>
                        {group ? (
                          <span className="shrink-0 text-xs text-muted-foreground">
                            {group.emoji ? `${group.emoji} ` : ""}
                            {group.name}
                          </span>
                        ) : null}
                      </li>
                    )
                  })}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                {overview
                  ? tDevices("emptyDevice")
                  : tDevices("remote.noCache")}
              </p>
            )}
          </Section>
        ) : null}

        <Section
          title={t("terminals")}
          action={
            <div className="flex gap-2">
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  run(() => openDeviceTerminal(device), tDevices("openFailed"))
                }
              >
                <SquareTerminal className="mr-1.5 size-3.5" />
                {tDevices("openTerminal")}
              </Button>
              {device.node ? (
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setDialog("launch")}
                >
                  <Plus className="mr-1.5 size-3.5" />
                  {tDevices("launchRemote")}
                </Button>
              ) : null}
            </div>
          }
        >
          {terminals.length > 0 ? (
            <ul className="divide-y rounded-md border text-sm">
              {terminals.map((descriptor) => (
                <li key={descriptor.terminalId}>
                  <button
                    type="button"
                    onClick={() => openTerminal(descriptor.terminalId)}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left hover:bg-accent"
                  >
                    <span className="min-w-0 flex-1 truncate">
                      {descriptor.title || descriptor.terminalId}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-muted-foreground">{t("noTerminals")}</p>
          )}
        </Section>

        <Section title={t("actions")}>
          <div className="flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              onClick={() =>
                run(async () => {
                  await setupDeviceKey(device)
                  toast.info(tDevices("keySetupStarted"))
                }, tDevices("keySetupFailed"))
              }
            >
              <KeyRound className="mr-1.5 size-3.5" />
              {tDevices("setupKey")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="text-destructive"
              onClick={() => setDialog("remove")}
            >
              <Trash2 className="mr-1.5 size-3.5" />
              {tDevices("remove")}
            </Button>
          </div>
        </Section>
      </div>

      <Dialog
        open={dialog === "launch"}
        onOpenChange={(open) => !open && setDialog(null)}
      >
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{tDevices("launchRemote")}</DialogTitle>
            <DialogDescription className="sr-only">
              {tDevices("runsOn", { name: device.name })}
            </DialogDescription>
          </DialogHeader>
          {dialog === "launch" ? (
            <DeviceLaunchPanel
              device={device}
              onClose={() => setDialog(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>
      <AddDeviceProjectDialog
        key={dialog === "project" ? "open" : "closed"}
        device={dialog === "project" ? device : null}
        onClose={() => setDialog(null)}
      />
      <AlertDialog
        open={dialog === "remove"}
        onOpenChange={(open) => !open && setDialog(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("removeTitle", { name: device.name })}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {t("removeDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() =>
                run(async () => {
                  await removeDevice(deviceId)
                  notifyDevicesChanged()
                  await closeFileTab(buildDeviceTabId(deviceId))
                }, tDevices("removeFailed"))
              }
            >
              {tDevices("remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
