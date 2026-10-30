"use client"

import { useCallback, useEffect, useState, type ReactNode } from "react"
import {
  AlertTriangle,
  Check,
  ChevronRight,
  Download,
  FileJson,
  FolderOpen,
  Loader2,
  Package,
  RefreshCw,
  Rocket,
  Store,
  Trash2,
  Wrench,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { MessageResponse } from "@/components/ai-elements/message"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
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
import { AgentProfileIcon } from "@/components/agents/profile/agent-profile-icon"
import { Switch } from "@/components/ui/switch"
import { toErrorMessage } from "@/lib/app-error"
import { toast } from "@/lib/notify"
import { openPath, revealItemInDir, saveFileDialog } from "@/lib/platform"
import {
  toolAssets,
  type ToolAssetDetail,
  type ToolAssetSummary,
  type ToolCatalogEntry,
} from "@/lib/transport/tool-assets"
import { cn } from "@/lib/utils"
import { SettingsSplit } from "@/components/settings/settings-split"
import { useStatusBarLaunchStore } from "@/stores/agent-launch-store"
import {
  programReady,
  useToolsSettingsStore,
} from "@/stores/tools-settings-store"
import { AgentLaunchShelfContent } from "@/components/layout/sidebar/agent-launch"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { useOpenWorkbenchPanel } from "@/hooks/workspace/use-open-workbench-panel"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import type { SettingsPageId } from "@/lib/workspace/settings-tab"

/** 卡片里逐条列出的接入点 → 文案 key。 */
const POINT_LABEL_KEYS = {
  "agent.sessions": "agentSessions",
  "agent.usage": "agentUsage",
  "agent.providerInjection": "agentProviderInjection",
  "agent.logins": "agentLogins",
  "agent.capabilityStores": "agentCapabilityStores",
  "agent.promptInput": "agentPromptInput",
  "agent.interruptKey": "agentInterruptKey",
  preview: "preview",
  extract: "extract",
} as const

const AGENT_FEATURES = [
  "agent.sessions",
  "agent.usage",
  "agent.providerInjection",
  "agent.logins",
  "agent.capabilityStores",
  "agent.promptInput",
  "agent.interruptKey",
] as const
const FILE_POINTS = ["preview", "extract"] as const

/** 文件类接入点声明的后缀，如 `.docx / .xlsx`。 */
function fileExtensions(raw: Record<string, unknown>, point: string): string {
  const decl = asRecord(asRecord(raw.extensions)[`org.berth.${point}`])
  const exts = Array.isArray(decl.extensions) ? decl.extensions : []
  return exts.map((ext) => `.${String(ext)}`).join(" / ")
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
}

/** 设置页的一张卡片：标题行可带操作按钮。 */
function Card({
  title,
  action,
  children,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="rounded-lg border p-4 text-sm">
      <div className="mb-2 flex items-center gap-2">
        <h4 className="font-semibold">{title}</h4>
        {action ? <div className="ml-auto">{action}</div> : null}
      </div>
      {children}
    </section>
  )
}

/** 插件声明的程序：装没装、能不能跑、有没有新版本；没装可运行包内安装脚本。`extra` 是同一卡片里的其他程序行。 */
function InstallStatus({
  toolId,
  extra,
}: {
  toolId: string
  extra?: ReactNode
}) {
  const t = useTranslations("ToolsSettings")
  const program = useToolsSettingsStore((state) => state.programs[toolId])
  const loadProgram = useToolsSettingsStore((state) => state.loadProgram)
  const updateCheck = useToolsSettingsStore(
    (state) => state.updateChecks[toolId]
  )
  const checkUpdate = useToolsSettingsStore((state) => state.checkUpdate)
  const run = useToolsSettingsStore((state) => state.installs[toolId])
  const runInstall = useToolsSettingsStore((state) => state.runInstall)
  const installing = !!run?.running
  const info = program && !("error" in program) ? program : null
  const installed = programReady(program)

  useEffect(() => {
    if (program === undefined) void loadProgram(toolId)
  }, [loadProgram, program, toolId])

  // 已装且本次运行还没查过时，按插件声明的 latest 来源查一次最新版本。
  useEffect(() => {
    if (installed && updateCheck === undefined) void checkUpdate(toolId)
  }, [checkUpdate, installed, toolId, updateCheck])

  const updateButton = (
    <Button
      size="sm"
      variant="outline"
      className="h-6 px-2 text-xs"
      onClick={() => void runInstall(toolId, true)}
      disabled={installing}
    >
      {installing ? (
        <Loader2 className="mr-1 h-3 w-3 animate-spin" />
      ) : (
        <Download className="mr-1 h-3 w-3" />
      )}
      {installing ? t("programUpdating") : t("programUpdate")}
    </Button>
  )
  let updateLine: ReactNode = null
  if (installed) {
    if (updateCheck === undefined) {
      updateLine = <span>{t("updateChecking")}</span>
    } else if (updateCheck && "error" in updateCheck) {
      updateLine = (
        <span className="break-all">
          {t("updateCheckFailed", { error: updateCheck.error })}
        </span>
      )
    } else if (updateCheck?.updateAvailable) {
      updateLine = (
        <>
          <span className="text-amber-600 dark:text-amber-500">
            {t("updateAvailable", { version: updateCheck.latest })}
          </span>
          {info?.canUpdate ? updateButton : null}
        </>
      )
    } else if (updateCheck) {
      updateLine = <span>{t("upToDate")}</span>
    } else if (info?.canUpdate) {
      updateLine = updateButton
    }
  }

  let status: ReactNode
  if (program === undefined) {
    status = (
      <p className="flex items-center gap-2 text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        {t("programChecking")}
      </p>
    )
  } else if (!info) {
    status = (
      <p className="break-all text-destructive">
        {program && "error" in program ? program.error : null}
      </p>
    )
  } else if (installed) {
    status = (
      <>
        <p className="flex items-center gap-2">
          <Check className="h-4 w-4 shrink-0 text-emerald-600" />
          {info.version
            ? t("programInstalledVersion", { version: info.version })
            : t("programInstalled")}
        </p>
        {info.path ? (
          <p className="mt-1 truncate pl-6 text-xs text-muted-foreground">
            {info.path}
          </p>
        ) : null}
        {updateLine ? (
          <div className="mt-1 flex flex-wrap items-center gap-2 pl-6 text-xs text-muted-foreground">
            {updateLine}
          </div>
        ) : null}
      </>
    )
  } else if (info.installed) {
    status = (
      <p className="flex items-start gap-2 text-amber-600 dark:text-amber-500">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
        <span className="break-all">
          {t("programBroken", { error: info.runtimeError ?? "" })}
        </span>
      </p>
    )
  } else {
    status = (
      <div className="flex flex-wrap items-center gap-3">
        <p className="text-muted-foreground">
          {info.installScript ? t("programMissing") : t("programMissingManual")}
        </p>
        {info.installScript ? (
          <Button
            size="sm"
            onClick={() => void runInstall(toolId, false)}
            disabled={installing}
          >
            {installing ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="mr-1.5 h-3.5 w-3.5" />
            )}
            {installing ? t("programInstalling") : t("programInstall")}
          </Button>
        ) : null}
      </div>
    )
  }

  return (
    <Card title={t("programTitle")}>
      {status}
      {extra ? <div className="mt-3">{extra}</div> : null}
      {installing && installed ? (
        <p className="mt-2 text-xs text-muted-foreground">
          {t("updateRestartHint")}
        </p>
      ) : null}
      {installing && run?.log ? (
        <p className="mt-2 truncate text-xs text-muted-foreground">{run.log}</p>
      ) : null}
      {run?.error ? (
        <p className="mt-2 break-all text-xs text-destructive">{run.error}</p>
      ) : null}
    </Card>
  )
}

/** 左栏每行的第二行：有程序声明时显示程序状态，否则显示能力数。 */
function ToolStatusLine({ tool }: { tool: ToolAssetSummary }) {
  const t = useTranslations("ToolsSettings")
  const program = useToolsSettingsStore((state) => state.programs[tool.id])
  const updateCheck = useToolsSettingsStore(
    (state) => state.updateChecks[tool.id]
  )
  if (!tool.contributes.includes("install")) {
    return (
      <>
        {tool.contributes.length > 0
          ? t("capabilityCount", { count: tool.contributes.length })
          : t("noContributions")}
      </>
    )
  }
  if (program === undefined) return <>…</>
  if (!program || "error" in program || !programReady(program)) {
    return (
      <span className="text-amber-600 dark:text-amber-500">
        {!program || "error" in program || !program.installed
          ? t("statusMissing")
          : t("statusBroken")}
      </span>
    )
  }
  if (updateCheck && "updateAvailable" in updateCheck) {
    if (updateCheck.updateAvailable) {
      return (
        <span className="text-amber-600 dark:text-amber-500">
          {t("statusUpdate", { version: updateCheck.latest })}
        </span>
      )
    }
  }
  return (
    <>
      {program.version?.match(/\d+(?:\.\d+)+/)?.[0] ??
        program.version ??
        t("statusInstalled")}
    </>
  )
}

export function ToolsSettingsPage() {
  const t = useTranslations("ToolsSettings")
  const [tools, setTools] = useState<ToolAssetSummary[]>([])
  const [root, setRoot] = useState("")
  const selectedId = useToolsSettingsStore((state) => state.selectedToolId)
  const setSelectedId = useToolsSettingsStore((state) => state.selectTool)
  const [detail, setDetail] = useState<ToolAssetDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [detailLoading, setDetailLoading] = useState(false)
  const [checkingUpdates, setCheckingUpdates] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // 右侧显示插件仓库还是选中插件的详情；没装任何插件时默认进仓库。
  const [showCatalog, setShowCatalog] = useState(false)
  const [removing, setRemoving] = useState<ToolAssetSummary | null>(null)

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await toolAssets({ type: "list" })
      if (response.type !== "list") throw new Error(t("unexpectedResponse"))
      setTools(response.tools)
      setRoot(response.directory)
      if (response.tools.length === 0) setShowCatalog(true)
      const store = useToolsSettingsStore.getState()
      for (const tool of response.tools) {
        if (!tool.contributes.includes("install")) continue
        // 本次运行首次打开时顺带查最新版本，结果缓存；「检查更新」强制重查。
        void store.loadProgram(tool.id).then(() => {
          const { programs, updateChecks, checkUpdate } =
            useToolsSettingsStore.getState()
          if (programReady(programs[tool.id]) && !(tool.id in updateChecks))
            void checkUpdate(tool.id)
        })
      }
      const current = store.selectedToolId
      setSelectedId(
        current && response.tools.some((tool) => tool.id === current)
          ? current
          : (response.tools[0]?.id ?? null)
      )
    } catch (cause) {
      setError(toErrorMessage(cause))
    } finally {
      setLoading(false)
    }
  }, [setSelectedId, t])

  useEffect(() => {
    void reload()
  }, [reload])

  // 重查所有已装程序的最新版本（会联网，只在用户点按钮时做）。
  const checkAllUpdates = useCallback(async () => {
    setCheckingUpdates(true)
    const store = useToolsSettingsStore.getState()
    await Promise.all(
      tools
        .filter((tool) => programReady(store.programs[tool.id]))
        .map((tool) => store.checkUpdate(tool.id))
    )
    setCheckingUpdates(false)
  }, [tools])

  const setEnabled = useCallback(
    async (id: string, enabled: boolean) => {
      setError(null)
      try {
        const response = await toolAssets({ type: "set_enabled", id, enabled })
        if (response.type !== "list") throw new Error(t("unexpectedResponse"))
        setTools(response.tools)
      } catch (cause) {
        setError(toErrorMessage(cause))
      }
    },
    [t]
  )
  // 打包成 `<id>/…` 的 zip：别人解压进插件目录、刷新即可使用。
  const pack = useCallback(
    async (summary: ToolAssetSummary) => {
      const name = `${summary.id}${summary.version ? `-${summary.version}` : ""}.zip`
      const path = await saveFileDialog({
        title: t("packTitle"),
        defaultPath: name,
        filters: [{ name: "zip", extensions: ["zip"] }],
      })
      if (!path) return
      setError(null)
      try {
        await toolAssets({ type: "pack", id: summary.id, path })
        toast.success(t("packed", { name: summary.name }), {
          description: path,
          action: {
            label: t("revealPacked"),
            onClick: () => void revealItemInDir(path),
          },
        })
      } catch (cause) {
        setError(toErrorMessage(cause))
      }
    },
    [t]
  )
  const remove = useCallback(
    async (summary: ToolAssetSummary) => {
      setError(null)
      try {
        const response = await toolAssets({ type: "remove", id: summary.id })
        if (response.type !== "list") throw new Error(t("unexpectedResponse"))
        setTools(response.tools)
        setSelectedId(response.tools[0]?.id ?? null)
        if (response.tools.length === 0) setShowCatalog(true)
        toast.success(t("removed", { name: summary.name }))
      } catch (cause) {
        setError(toErrorMessage(cause))
      }
    },
    [setSelectedId, t]
  )
  // 仓库里装好一个插件：刷新列表并选中它，留在仓库页继续装。
  const installed = useCallback(
    (next: ToolAssetSummary[]) => {
      setTools(next)
      if (!selectedId) setSelectedId(next[0]?.id ?? null)
    },
    [selectedId, setSelectedId]
  )
  const openTool = useCallback(
    (id: string) => {
      setShowCatalog(false)
      setSelectedId(id)
    },
    [setSelectedId]
  )
  const selectedEnabled =
    tools.find((tool) => tool.id === selectedId)?.enabled ?? true

  useEffect(() => {
    if (!selectedId) {
      setDetail(null)
      return
    }
    let active = true
    setDetailLoading(true)
    setError(null)
    void toolAssets({ type: "load", id: selectedId })
      .then(
        (response) => {
          if (!active) return
          if (response.type !== "detail") {
            setError(t("unexpectedResponse"))
            return
          }
          setDetail(response.detail)
        },
        (cause) => {
          if (active) setError(toErrorMessage(cause))
        }
      )
      .finally(() => {
        if (active) setDetailLoading(false)
      })
    return () => {
      active = false
    }
  }, [selectedId, t])

  const groups = [
    {
      label: t("groupAgents"),
      items: tools.filter((tool) => tool.contributes.includes("agent")),
    },
    {
      label: t("groupTools"),
      items: tools.filter((tool) => !tool.contributes.includes("agent")),
    },
  ].filter((group) => group.items.length > 0)

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="flex shrink-0 items-center gap-3 border-b px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Wrench className="h-4 w-4" />
            {t("title")}
          </h2>
          <p className="truncate text-xs text-muted-foreground" title={root}>
            {root || t("description")}
          </p>
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          title={t("openDir")}
          aria-label={t("openDir")}
          onClick={() => void openPath(root)}
          disabled={!root}
        >
          <FolderOpen className="h-4 w-4" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          title={t("checkUpdates")}
          aria-label={t("checkUpdates")}
          onClick={() => void checkAllUpdates()}
          disabled={loading || checkingUpdates}
        >
          {checkingUpdates ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Download className="h-4 w-4" />
          )}
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          title={t("refresh")}
          aria-label={t("refresh")}
          onClick={() => void reload()}
          disabled={loading}
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
      </header>

      {error ? (
        <div className="flex items-center gap-2 border-b bg-destructive/5 px-4 py-2 text-xs text-destructive">
          <AlertTriangle className="h-3.5 w-3.5 shrink-0" />
          {error}
        </div>
      ) : null}

      <SettingsSplit
        list={
          <div className="min-h-0 flex-1 overflow-auto p-2">
            <button
              type="button"
              onClick={() => setShowCatalog(true)}
              className={cn(
                "mb-2 flex w-full items-center gap-3 rounded-md px-3 py-2 text-left text-sm font-medium hover:bg-muted",
                showCatalog && "bg-muted"
              )}
            >
              <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
                <Store className="h-4 w-4" />
              </span>
              {t("catalog")}
            </button>
            {loading && tools.length === 0 ? (
              <p className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("loading")}
              </p>
            ) : null}
            {!loading && tools.length === 0 ? (
              <p className="p-3 text-xs text-muted-foreground">{t("empty")}</p>
            ) : null}
            {groups.map((group) => (
              <div key={group.label} className="mb-2">
                <p className="px-3 pb-1 pt-2 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {group.label}
                </p>
                {group.items.map((tool) => (
                  <button
                    key={tool.id}
                    type="button"
                    onClick={() => openTool(tool.id)}
                    className={cn(
                      "mb-0.5 flex w-full items-center gap-3 rounded-md px-3 py-2 text-left hover:bg-muted",
                      !showCatalog && selectedId === tool.id && "bg-muted",
                      !tool.enabled && "opacity-60"
                    )}
                  >
                    <PluginIcon id={tool.id} name={tool.name} />
                    <span className="min-w-0 flex-1">
                      <span className="flex items-center gap-2 text-sm font-medium">
                        <span className="min-w-0 flex-1 truncate">
                          {tool.name}
                        </span>
                        {!tool.enabled ? (
                          <Badge
                            variant="outline"
                            className="shrink-0 text-[10px]"
                          >
                            {t("disabledBadge")}
                          </Badge>
                        ) : null}
                        {tool.diagnostics.length > 0 ? (
                          <AlertTriangle className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                        ) : null}
                      </span>
                      <span className="mt-0.5 block truncate text-xs text-muted-foreground">
                        <ToolStatusLine tool={tool} />
                        {tool.diagnostics.length > 0 ? (
                          <span className="text-amber-600 dark:text-amber-500">
                            {" · "}
                            {t("issueCount", {
                              count: tool.diagnostics.length,
                            })}
                          </span>
                        ) : null}
                      </span>
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        }
      >
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {showCatalog ? (
            <CatalogView onInstalled={installed} onOpen={openTool} />
          ) : null}
          {!showCatalog && detailLoading ? (
            <div className="flex flex-1 items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : null}
          {!showCatalog && !detailLoading && detail ? (
            <>
              <div className="shrink-0 border-b px-4 py-4">
                <div className="flex items-start gap-3">
                  <PluginIcon
                    id={detail.summary.id}
                    name={detail.summary.name}
                    large
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <h3 className="text-base font-semibold">
                        {detail.summary.name}
                      </h3>
                      <Badge variant="outline" className="font-mono">
                        {detail.summary.id}
                      </Badge>
                      {detail.summary.version ? (
                        <Badge variant="secondary">
                          v{detail.summary.version}
                        </Badge>
                      ) : null}
                    </div>
                    {detail.summary.description ? (
                      <p className="mt-1 text-sm text-muted-foreground">
                        {detail.summary.description}
                      </p>
                    ) : null}
                  </div>
                  <label className="flex shrink-0 items-center gap-2 text-xs text-muted-foreground">
                    {t("enabled")}
                    <Switch
                      checked={selectedEnabled}
                      onCheckedChange={(checked) =>
                        void setEnabled(detail.summary.id, checked)
                      }
                    />
                  </label>
                </div>
              </div>

              <PluginDetailTabs
                detail={detail}
                enabled={selectedEnabled}
                onPack={() => void pack(detail.summary)}
                onRemove={() => setRemoving(detail.summary)}
              />
            </>
          ) : null}
          {!showCatalog && !detailLoading && !detail && !loading ? (
            <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
              {t("selectTool")}
            </div>
          ) : null}
        </main>
      </SettingsSplit>

      <AlertDialog
        open={removing !== null}
        onOpenChange={(open) => !open && setRemoving(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t("removeTitle", { name: removing?.name ?? "" })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t("removeBody")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-white hover:bg-destructive/90"
              onClick={() => removing && void remove(removing)}
            >
              {t("remove")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

/** 插件图标：包内 icon.svg|png，没有时用通用包图标。`src` 给未安装的仓库条目直接传 data URL。 */
function PluginIcon({
  id,
  name,
  src,
  large,
}: {
  id: string
  name: string
  src?: string | null
  large?: boolean
}) {
  const box = cn(
    "flex shrink-0 items-center justify-center rounded-md bg-muted",
    large ? "h-10 w-10" : "h-7 w-7"
  )
  const img = large ? "h-7 w-7" : "h-5 w-5"
  const fallback = (
    <span className={box} aria-hidden>
      <Package
        className={cn("text-muted-foreground", large ? "h-5 w-5" : "h-4 w-4")}
      />
    </span>
  )
  if (src !== undefined) {
    return src ? (
      <span className={box}>
        {/* eslint-disable-next-line @next/next/no-img-element -- data URL 本地图标 */}
        <img
          src={src}
          alt=""
          aria-hidden
          className={cn("object-contain", img)}
        />
      </span>
    ) : (
      fallback
    )
  }
  return (
    <span className={box}>
      <AgentProfileIcon
        agentId={id}
        name={name}
        className={img}
        fallback={
          <Package
            className={cn(
              "text-muted-foreground",
              large ? "h-5 w-5" : "h-4 w-4"
            )}
          />
        }
      />
    </span>
  )
}

/** 插件仓库：打开时拉取官方插件仓库的清单（会联网克隆），点「安装」即装。 */
function CatalogView({
  onInstalled,
  onOpen,
}: {
  onInstalled: (tools: ToolAssetSummary[]) => void
  onOpen: (id: string) => void
}) {
  const t = useTranslations("ToolsSettings")
  const [catalog, setCatalog] = useState<{
    repository: string
    plugins: ToolCatalogEntry[]
  } | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await toolAssets({ type: "catalog" })
      if (response.type !== "catalog") throw new Error(t("unexpectedResponse"))
      setCatalog({ repository: response.repository, plugins: response.plugins })
    } catch (cause) {
      setError(toErrorMessage(cause))
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    void load()
  }, [load])

  const install = useCallback(
    async (entry: ToolCatalogEntry) => {
      setInstalling(entry.id)
      setError(null)
      try {
        const response = await toolAssets({
          type: "install",
          source: entry.source,
        })
        if (response.type !== "list") throw new Error(t("unexpectedResponse"))
        onInstalled(response.tools)
        setCatalog(
          (current) =>
            current && {
              ...current,
              plugins: current.plugins.map((item) =>
                item.id === entry.id ? { ...item, installed: true } : item
              ),
            }
        )
        toast.success(t("catalogInstalled", { name: entry.name }))
      } catch (cause) {
        setError(toErrorMessage(cause))
      } finally {
        setInstalling(null)
      }
    },
    [onInstalled, t]
  )

  return (
    <>
      <div className="flex shrink-0 items-start gap-3 border-b px-4 py-4">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-primary/10 text-primary">
          <Store className="h-5 w-5" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold">{t("catalog")}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {t("catalogDescription")}
          </p>
          {catalog ? (
            <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
              {catalog.repository}
            </p>
          ) : null}
        </div>
        <Button
          size="icon"
          variant="ghost"
          className="h-8 w-8"
          title={t("refresh")}
          aria-label={t("refresh")}
          onClick={() => void load()}
          disabled={loading}
        >
          <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-4">
        {error ? (
          <div className="mb-3 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <span className="break-all">{error}</span>
          </div>
        ) : null}
        {loading && !catalog ? (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            {t("catalogLoading")}
          </p>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          {catalog?.plugins.map((entry) => (
            <section
              key={entry.id}
              className="flex flex-col rounded-lg border p-4 transition-colors hover:border-foreground/20"
            >
              <div className="flex items-start gap-3">
                <PluginIcon
                  id={entry.id}
                  name={entry.name}
                  src={entry.icon ?? null}
                  large
                />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold">{entry.name}</p>
                  <p className="truncate font-mono text-xs text-muted-foreground">
                    {entry.id}
                    {entry.version ? ` · v${entry.version}` : ""}
                  </p>
                </div>
              </div>
              <p className="mt-3 line-clamp-2 flex-1 text-xs text-muted-foreground">
                {entry.description ?? ""}
              </p>
              <div className="mt-3 flex justify-end">
                {entry.installed ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7"
                    onClick={() => onOpen(entry.id)}
                  >
                    <Check className="mr-1.5 h-3.5 w-3.5 text-emerald-600" />
                    {t("catalogAlreadyInstalled")}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    className="h-7"
                    disabled={installing !== null}
                    onClick={() => void install(entry)}
                  >
                    {installing === entry.id ? (
                      <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="mr-1.5 h-3.5 w-3.5" />
                    )}
                    {installing === entry.id
                      ? t("programInstalling")
                      : t("programInstall")}
                  </Button>
                )}
              </div>
            </section>
          ))}
        </div>
      </div>
    </>
  )
}

/** 能力行的跳转：能力在 Berth 的哪个位置用、去哪配。 */
type PointLink = {
  labelKey: "goModelProviders" | "goExperts"
  page: SettingsPageId
}
const POINT_LINKS: Partial<Record<keyof typeof POINT_LABEL_KEYS, PointLink>> = {
  "agent.providerInjection": {
    labelKey: "goModelProviders",
    page: "model-providers",
  },
  "agent.logins": { labelKey: "goModelProviders", page: "model-providers" },
  "agent.capabilityStores": { labelKey: "goExperts", page: "experts" },
}

/** 详情分页：概览（能力与程序）/ 默认启动选项（Agent）/ 给 Agent 的说明 / 开发。 */
function PluginDetailTabs({
  detail,
  enabled,
  onPack,
  onRemove,
}: {
  detail: ToolAssetDetail
  enabled: boolean
  onPack: () => void
  onRemove: () => void
}) {
  const t = useTranslations("ToolsSettings")
  const openLaunchShelf = useStatusBarLaunchStore(
    (state) => state.openLaunchShelf
  )
  const { openSettings } = useOpenWorkbenchPanel()
  const { openFilePreview } = useWorkspaceRuntimeActions()
  const { id, contributes, diagnostics } = detail.summary
  const raw = asRecord(detail.raw)
  const isAgent = contributes.includes("agent")
  const hasLaunchbar = contributes.includes("launchbar")
  const label = (point: keyof typeof POINT_LABEL_KEYS) =>
    t(`points.${POINT_LABEL_KEYS[point]}`, {
      exts: fileExtensions(raw, point),
    })
  const points = [...AGENT_FEATURES, ...FILE_POINTS].filter((point) =>
    contributes.includes(point)
  )
  const empty =
    !isAgent && !contributes.includes("install") && points.length === 0

  return (
    <Tabs
      key={id}
      defaultValue="overview"
      className="flex min-h-0 flex-1 flex-col gap-0"
    >
      <div className="shrink-0 border-b px-2">
        <TabsList variant="line" className="h-10">
          <TabsTrigger value="overview" className="px-3 text-xs">
            {t("tabOverview")}
          </TabsTrigger>
          {hasLaunchbar ? (
            <TabsTrigger value="defaults" className="px-3 text-xs">
              {t("tabDefaults")}
            </TabsTrigger>
          ) : null}
          {detail.usage ? (
            <TabsTrigger value="agent" className="px-3 text-xs">
              {t("tabAgent")}
            </TabsTrigger>
          ) : null}
          <TabsTrigger value="develop" className="px-3 text-xs">
            {t("tabDevelop")}
            {diagnostics.length > 0 ? (
              <AlertTriangle className="ml-1 h-3 w-3 text-amber-500" />
            ) : null}
          </TabsTrigger>
        </TabsList>
      </div>

      <TabsContent
        value="overview"
        className="min-h-0 flex-1 space-y-3 overflow-auto p-4"
      >
        {isAgent ? (
          <Card
            title={t("launchTitle")}
            action={
              <Button
                size="sm"
                disabled={!enabled}
                onClick={() => openLaunchShelf(id)}
              >
                <Rocket className="mr-1.5 h-3.5 w-3.5" />
                {t("openLaunchbar")}
              </Button>
            }
          >
            <p className="text-muted-foreground">
              {enabled ? t("launchNote") : t("launchDisabled")}
            </p>
          </Card>
        ) : null}

        {contributes.includes("install") ? (
          <InstallStatus key={id} toolId={id} />
        ) : null}

        {points.length > 0 ? (
          <Card title={t("capabilitiesTitle")}>
            <ul className="divide-y">
              {points.map((point) => {
                const link = POINT_LINKS[point]
                return (
                  <li
                    key={point}
                    className="flex items-center gap-2 py-2 first:pt-0 last:pb-0"
                  >
                    <Check className="h-4 w-4 shrink-0 text-emerald-600" />
                    <span className="min-w-0 flex-1">{label(point)}</span>
                    {link ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        className="h-7 shrink-0 text-xs"
                        onClick={() => openSettings(link.page)}
                      >
                        {t(link.labelKey)}
                        <ChevronRight className="ml-0.5 h-3.5 w-3.5" />
                      </Button>
                    ) : null}
                  </li>
                )
              })}
            </ul>
          </Card>
        ) : null}

        {empty ? (
          <p className="text-sm text-muted-foreground">
            {t("providesNothing")}
          </p>
        ) : null}
      </TabsContent>

      {hasLaunchbar ? (
        <TabsContent
          value="defaults"
          className="min-h-0 flex-1 overflow-auto p-4"
        >
          <p className="mb-4 text-xs text-muted-foreground">
            {t("defaultsNote")}
          </p>
          <div className="max-w-md">
            <AgentLaunchShelfContent
              agentId={id}
              workingDirectory=""
              onClose={() => undefined}
              defaultsOnly
            />
          </div>
        </TabsContent>
      ) : null}

      {detail.usage ? (
        <TabsContent value="agent" className="min-h-0 flex-1 overflow-auto p-4">
          <p className="mb-3 text-xs text-muted-foreground">
            {isAgent
              ? t("agentGuideAgent")
              : enabled
                ? t("agentGuideOn", { id })
                : t("agentGuideOff")}
          </p>
          <div className="rounded-lg border p-4">
            <MessageResponse className="text-sm">
              {detail.usage}
            </MessageResponse>
          </div>
        </TabsContent>
      ) : null}

      <TabsContent
        value="develop"
        className="min-h-0 flex-1 space-y-3 overflow-auto p-4"
      >
        {diagnostics.length > 0 ? (
          <div className="space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 p-3 text-xs">
            {diagnostics.map((item, index) => (
              <p key={`${item.location}-${index}`}>
                <strong>{item.location}:</strong> {item.message}
              </p>
            ))}
          </div>
        ) : null}
        <Card title={t("packageDir")}>
          <p className="break-all font-mono text-xs text-muted-foreground">
            {detail.directory}
          </p>
          <div className="mt-3 flex flex-wrap gap-2">
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={() => void openPath(detail.directory)}
            >
              <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
              {t("openPackageDir")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={() =>
                void openFilePreview(
                  `${detail.directory.replace(/[\\/]+$/, "")}/tool.json`
                )
              }
            >
              <FileJson className="mr-1.5 h-3.5 w-3.5" />
              {t("openManifest")}
            </Button>
            <Button
              size="sm"
              variant="outline"
              className="h-7"
              onClick={onPack}
            >
              <Package className="mr-1.5 h-3.5 w-3.5" />
              {t("pack")}
            </Button>
          </div>
          <p className="mt-3 text-xs text-muted-foreground">
            {t("contributes")}
          </p>
          <p className="font-mono text-xs">{contributes.join(", ") || "-"}</p>
        </Card>
        <Card title={t("dangerTitle")}>
          <div className="flex items-center gap-3">
            <p className="flex-1 text-xs text-muted-foreground">
              {t("removeBody")}
            </p>
            <Button
              size="sm"
              variant="outline"
              className="h-7 shrink-0 text-destructive hover:text-destructive"
              onClick={onRemove}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              {t("remove")}
            </Button>
          </div>
        </Card>
      </TabsContent>
    </Tabs>
  )
}

export default ToolsSettingsPage
