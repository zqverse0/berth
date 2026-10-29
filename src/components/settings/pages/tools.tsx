"use client"

import { useCallback, useEffect, useState, type ReactNode } from "react"
import {
  AlertTriangle,
  Check,
  Download,
  FileJson,
  FolderOpen,
  Loader2,
  Package,
  RefreshCw,
  Rocket,
  Wrench,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { MessageResponse } from "@/components/ai-elements/message"

import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { toErrorMessage } from "@/lib/app-error"
import { toast } from "@/lib/notify"
import { openPath, revealItemInDir, saveFileDialog } from "@/lib/platform"
import {
  toolAssets,
  type ToolAssetDetail,
  type ToolAssetSummary,
} from "@/lib/transport/tool-assets"
import { cn } from "@/lib/utils"
import { SettingsSplit } from "@/components/settings/settings-split"
import { useStatusBarLaunchStore } from "@/stores/agent-launch-store"
import {
  GIT_ACCOUNTS_TOOL_ID,
  programReady,
  useToolsSettingsStore,
} from "@/stores/tools-settings-store"
import { GitAccountsSettings, GitProgramStatus } from "../git-settings"

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

  const reload = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const response = await toolAssets({ type: "list" })
      if (response.type !== "list") throw new Error(t("unexpectedResponse"))
      setTools(response.tools)
      setRoot(response.directory)
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
      <header className="flex shrink-0 items-center justify-between gap-3 border-b px-4 py-3">
        <div className="min-w-0">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <Wrench className="h-4 w-4" />
            {t("title")}
          </h2>
          <p className="truncate text-xs text-muted-foreground">
            {root || t("description")}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => void openPath(root)}
            disabled={!root}
          >
            <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
            {t("openDir")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void checkAllUpdates()}
            disabled={loading || checkingUpdates}
          >
            {checkingUpdates ? (
              <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />
            ) : (
              <Download className="mr-1.5 h-3.5 w-3.5" />
            )}
            {t("checkUpdates")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void reload()}
            disabled={loading}
          >
            <RefreshCw
              className={cn("mr-1.5 h-3.5 w-3.5", loading && "animate-spin")}
            />
            {t("refresh")}
          </Button>
        </div>
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
            {loading && tools.length === 0 ? (
              <p className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                {t("loading")}
              </p>
            ) : null}
            {!loading && tools.length === 0 ? (
              <p className="p-3 text-sm text-muted-foreground">{t("empty")}</p>
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
                    onClick={() => setSelectedId(tool.id)}
                    className={cn(
                      "mb-1 flex w-full flex-col items-start rounded-md px-3 py-2 text-left hover:bg-muted",
                      selectedId === tool.id && "bg-muted",
                      !tool.enabled && "text-muted-foreground"
                    )}
                  >
                    <span className="flex w-full items-center gap-2 text-sm font-medium">
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
                    <span className="mt-0.5 w-full truncate text-xs text-muted-foreground">
                      <ToolStatusLine tool={tool} />
                      {tool.diagnostics.length > 0 ? (
                        <span className="text-amber-600 dark:text-amber-500">
                          {" · "}
                          {t("issueCount", { count: tool.diagnostics.length })}
                        </span>
                      ) : null}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        }
      >
        <main className="flex min-h-0 min-w-0 flex-1 flex-col">
          {detailLoading ? (
            <div className="flex flex-1 items-center justify-center text-muted-foreground">
              <Loader2 className="h-5 w-5 animate-spin" />
            </div>
          ) : null}
          {!detailLoading && detail ? (
            <>
              <div className="shrink-0 border-b px-4 py-3">
                <div className="flex flex-wrap items-center gap-2">
                  <h3 className="text-base font-semibold">
                    {detail.summary.name}
                  </h3>
                  <Badge variant="outline">{detail.summary.id}</Badge>
                  {detail.summary.version ? (
                    <Badge variant="secondary">v{detail.summary.version}</Badge>
                  ) : null}
                  <Button
                    size="sm"
                    variant="outline"
                    className="ml-auto h-7"
                    onClick={() => void pack(detail.summary)}
                  >
                    <Package className="mr-1.5 h-3.5 w-3.5" />
                    {t("pack")}
                  </Button>
                  <label className=" flex items-center gap-2 text-xs text-muted-foreground">
                    {t("enabled")}
                    <Switch
                      checked={selectedEnabled}
                      onCheckedChange={(checked) =>
                        void setEnabled(detail.summary.id, checked)
                      }
                    />
                  </label>
                </div>
                {detail.summary.description ? (
                  <p className="mt-1 text-sm text-muted-foreground">
                    {detail.summary.description}
                  </p>
                ) : null}
                {detail.summary.diagnostics.length > 0 ? (
                  <div className="mt-2 space-y-1 rounded-md border border-amber-500/30 bg-amber-500/5 p-2 text-xs">
                    {detail.summary.diagnostics.map((item, index) => (
                      <p key={`${item.location}-${index}`}>
                        <strong>{item.location}:</strong> {item.message}
                      </p>
                    ))}
                  </div>
                ) : null}
              </div>

              <div className="min-h-0 flex-1 space-y-3 overflow-auto p-4">
                <ToolCards detail={detail} enabled={selectedEnabled} />
              </div>
            </>
          ) : null}
          {!detailLoading && !detail && !loading ? (
            <div className="flex flex-1 items-center justify-center p-6 text-sm text-muted-foreground">
              {t("selectTool")}
            </div>
          ) : null}
        </main>
      </SettingsSplit>
    </div>
  )
}

/** 详情：每种接入点一张可操作的卡片，最后是收起的「高级」。 */
function ToolCards({
  detail,
  enabled,
}: {
  detail: ToolAssetDetail
  enabled: boolean
}) {
  const t = useTranslations("ToolsSettings")
  const openLaunchShelf = useStatusBarLaunchStore(
    (state) => state.openLaunchShelf
  )
  const { id, contributes } = detail.summary
  const raw = asRecord(detail.raw)
  const isAgent = contributes.includes("agent")
  const label = (point: keyof typeof POINT_LABEL_KEYS) =>
    t(`points.${POINT_LABEL_KEYS[point]}`, {
      exts: fileExtensions(raw, point),
    })
  const agentFeatures = AGENT_FEATURES.filter((point) =>
    contributes.includes(point)
  )
  const filePoints = FILE_POINTS.filter((point) => contributes.includes(point))
  const usage = detail.usage ? (
    <details className="mt-2">
      <summary className="cursor-pointer text-xs text-muted-foreground hover:text-foreground">
        {t("showUsage")}
      </summary>
      <div className="mt-2 max-h-[28rem] overflow-auto rounded-md bg-muted/30 p-3">
        <MessageResponse className="text-sm">{detail.usage}</MessageResponse>
      </div>
    </details>
  ) : null
  const empty =
    !isAgent &&
    !contributes.includes("install") &&
    !detail.usage &&
    filePoints.length === 0

  return (
    <>
      {contributes.includes("install") ? (
        <InstallStatus
          key={id}
          toolId={id}
          extra={id === GIT_ACCOUNTS_TOOL_ID ? <GitProgramStatus /> : null}
        />
      ) : null}

      {isAgent ? (
        <Card
          title={t("launchTitle")}
          action={
            <Button
              size="sm"
              variant="outline"
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
          {agentFeatures.length > 0 ? (
            <ul className="mt-2 grid gap-1 sm:grid-cols-2">
              {agentFeatures.map((point) => (
                <li key={point} className="flex items-start gap-2 text-xs">
                  <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-emerald-600" />
                  {label(point)}
                </li>
              ))}
            </ul>
          ) : null}
          {usage}
        </Card>
      ) : null}

      {!isAgent && detail.usage ? (
        <Card title={t("agentGuideTitle")}>
          <p className="text-muted-foreground">
            {enabled ? t("agentGuideOn", { id }) : t("agentGuideOff")}
          </p>
          {usage}
        </Card>
      ) : null}

      {filePoints.length > 0 ? (
        <Card title={t("filesTitle")}>
          <ul className="space-y-1">
            {filePoints.map((point) => (
              <li key={point} className="flex items-start gap-2">
                <Check className="mt-0.5 h-4 w-4 shrink-0 text-emerald-600" />
                {label(point)}
              </li>
            ))}
          </ul>
        </Card>
      ) : null}

      {id === GIT_ACCOUNTS_TOOL_ID ? (
        <Card title={t("gitAccountsTitle")}>
          <p className="mb-3 text-xs text-muted-foreground">
            {t("gitAccountsNote")}
          </p>
          <GitAccountsSettings />
        </Card>
      ) : null}

      {empty ? (
        <p className="text-sm text-muted-foreground">{t("providesNothing")}</p>
      ) : null}

      <details className="rounded-lg border px-4 py-3 text-sm">
        <summary className="cursor-pointer font-semibold">
          {t("advanced")}
        </summary>
        <p className="mt-3 text-xs text-muted-foreground">{t("packageDir")}</p>
        <p className="break-all font-mono text-xs">{detail.directory}</p>
        <p className="mt-3 text-xs text-muted-foreground">{t("contributes")}</p>
        <p className="font-mono text-xs">{contributes.join(", ") || "-"}</p>
        <p className="mt-3 flex items-center gap-1 text-xs text-muted-foreground">
          <FileJson className="h-3.5 w-3.5" />
          {t("raw")}
        </p>
        <pre className="mt-1 max-h-[28rem] overflow-auto whitespace-pre-wrap break-all rounded-md bg-muted/30 p-3 text-xs">
          {JSON.stringify(detail.raw, null, 2)}
        </pre>
      </details>
    </>
  )
}

export default ToolsSettingsPage
