"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  CloudDownload,
  Download,
  ExternalLink,
  FileInput,
  FileOutput,
  Loader2,
  MoreHorizontal,
  Plus,
  Server,
  Trash2,
  Wallet,
} from "lucide-react"
import { useTranslations } from "next-intl"
import { toast } from "@/lib/notify"
import { toErrorMessage } from "@/lib/app-error"

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
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { ScrollArea } from "@/components/ui/scroll-area"
import { Switch } from "@/components/ui/switch"
import {
  API_LABELS,
  ApiToggles,
  ModelMappingEditor,
} from "@/components/model-provider/model-mapping-editor"
import { useAgentProfiles } from "@/hooks/use-agent-profiles"
import { DecisionPanel } from "@/components/model-provider/decision-panel"
import {
  EndpointList,
  KNOWN_ENDPOINTS,
  endpointError,
  endpointKey,
  type EndpointRow,
  type KnownEndpoint,
} from "@/components/model-provider/endpoint-list"
import { LoginCardDetail } from "@/components/model-provider/login-card-detail"
import {
  createModelProvider,
  deleteModelProvider,
  listModelProviders,
  updateModelProvider,
} from "@/lib/api"
import {
  fetchProviderModels,
  mergeFetchedModels,
  providerDefaultApis,
  modelRecord,
  providerCatalogModels,
  importCcSwitchProviders,
  transferProviders,
  getProxyAccess,
  type ProxyAccess,
  listLoginCards,
  type LoginEntry,
  resolveProviderProtocolUrls,
  serializeModels,
  type ModelApi,
  type ProviderModel,
} from "@/lib/model-provider"
import { fetchProviderBalance, type UsageState } from "@/lib/transport/usage"
import { openFileDialog, openPath, saveFileDialog } from "@/lib/platform"
import { type ModelProviderInfo } from "@/lib/types"
import { cn } from "@/lib/utils"
import { SettingsSplit } from "@/components/settings/settings-split"
import {
  usageWindowParts,
  type UsageTranslator,
} from "@/lib/agent/usage-window"
import {
  extractAppCommandError,
  toLocalizedErrorMessage,
  type AppErrorTranslator,
} from "@/lib/app-error"

/** 该地址不提供模型列表（换下一个协议地址再试）；其余错误应当停下。 */
const LISTING_UNSUPPORTED = new Set([
  "fetchError.notFound",
  "fetchError.notSupported",
  "fetchError.notJson",
  "fetchError.unexpectedShape",
])

function isListingUnsupported(error: unknown): boolean {
  const key = extractAppCommandError(error)?.i18n_key
  return key ? LISTING_UNSUPPORTED.has(key) : false
}

function formatProviderFetchError(
  error: unknown,
  translate: AppErrorTranslator
): string {
  const localized = toLocalizedErrorMessage(error, translate)
  const providerMessage =
    extractAppCommandError(error)?.i18n_params?.providerMessage?.trim()
  if (providerMessage && !localized.includes(providerMessage)) {
    return `${localized} ${translate("fetchError.providerSaid", {
      message: providerMessage,
    })}`
  }
  return localized
}

/**
 * 模型服务商管理（设置页全局名单）：左右布局——左侧全部档案，
 * 右侧详情。一份模型列表，启动栏与各 Agent 共用。
 */
export function ModelProviderSettings() {
  const t = useTranslations("ModelProviderSettings")
  const [providers, setProviders] = useState<ModelProviderInfo[]>([])
  const [loading, setLoading] = useState(true)
  /** 选中的档案 id;"new" = 新建空表单;null = 空态。 */
  const [selected, setSelected] = useState<number | "new" | null>(null)
  const [importing, setImporting] = useState(false)
  // 登录凭证卡由 tool.json `logins` 声明生成（不落库），同 loginId 并为一张卡。
  const [loginEntries, setLoginEntries] = useState<LoginEntry[]>([])
  const [loginCheckedAt, setLoginCheckedAt] = useState<Date | null>(null)
  const [loginId, setLoginId] = useState<string | null>(null)
  const loadLogins = useCallback(async () => {
    try {
      setLoginEntries(await listLoginCards())
      setLoginCheckedAt(new Date())
    } catch {
      setLoginEntries([])
    }
  }, [])
  useEffect(() => {
    void loadLogins()
  }, [loadLogins])
  const loginCards = useMemo(() => {
    const cards = new Map<string, LoginEntry[]>()
    for (const entry of loginEntries) {
      cards.set(entry.loginId, [...(cards.get(entry.loginId) ?? []), entry])
    }
    return [...cards.values()]
  }, [loginEntries])
  const selectedLogin = loginCards.find((card) => card[0]?.loginId === loginId)
  const selectProvider = (id: number | "new" | null) => {
    setLoginId(null)
    setSelected(id)
  }

  const loadProviders = useCallback(async () => {
    try {
      const rows = await listModelProviders()
      setProviders(rows)
    } catch (error) {
      toast.error(t("loadFailed"), { description: toErrorMessage(error) })
    } finally {
      setLoading(false)
    }
  }, [t])

  useEffect(() => {
    loadProviders().catch(console.error)
  }, [loadProviders])

  // 选中行被删/被过滤时回落到空态。
  useEffect(() => {
    if (selected === "new") return
    if (selected != null && !providers.some((p) => p.id === selected)) {
      setSelected(null)
    }
  }, [providers, selected])

  const selectedProvider = useMemo(
    () =>
      selected === "new" || selected == null
        ? null
        : (providers.find((p) => p.id === selected) ?? null),
    [providers, selected]
  )

  const handleImportCcSwitch = useCallback(async () => {
    setImporting(true)
    try {
      const summary = await importCcSwitchProviders()
      toast.success(
        t("importCcSwitchDone", {
          imported: summary.imported,
          duplicates: summary.skippedDuplicate,
          incomplete: summary.skippedIncomplete + summary.unsupported,
        })
      )
      await loadProviders()
    } catch (err: unknown) {
      toast.error(
        err instanceof Error ? err.message : t("importCcSwitchFailed")
      )
    } finally {
      setImporting(false)
    }
  }, [loadProviders, t])

  /** 档案备份：导出不含 Key 的 JSON / 从该文件导入（Key 导入后另填）。 */
  const handleTransfer = useCallback(
    async (operation: "export" | "import") => {
      const path =
        operation === "export"
          ? await saveFileDialog({
              defaultPath: "berth-providers.json",
              filters: [{ name: "JSON", extensions: ["json"] }],
            })
          : await openFileDialog({ title: t("transfer.importTitle") })
      if (typeof path !== "string") return
      setImporting(true)
      try {
        const summary = await transferProviders(operation, path)
        if (operation === "export") {
          toast.success(t("transfer.exported", { count: summary.providers }))
        } else {
          toast.success(
            t("transfer.imported", {
              count: summary.providers,
              duplicates: summary.skippedDuplicate,
            })
          )
          await loadProviders()
        }
      } catch (err: unknown) {
        toast.error(err instanceof Error ? err.message : t("transfer.failed"))
      } finally {
        setImporting(false)
      }
    },
    [loadProviders, t]
  )

  const afterSave = useCallback(
    async (id?: number) => {
      await loadProviders()
      setSelected(id ?? null)
    },
    [loadProviders]
  )

  return (
    <div className="flex h-full min-h-0">
      <SettingsSplit
        listClassName="w-52"
        className="p-3"
        list={
          <>
            <div className="space-y-1.5 border-b p-2">
              <div className="flex items-center gap-1.5">
                <Button
                  size="sm"
                  className="h-7 flex-1 text-xs"
                  onClick={() => selectProvider("new")}
                >
                  <Plus className="mr-1 h-3.5 w-3.5" />
                  {t("newProvider")}
                </Button>
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="sm"
                      variant="outline"
                      className="h-7 w-7 shrink-0 px-0"
                      title={t("moreActions")}
                      aria-label={t("moreActions")}
                      disabled={importing}
                    >
                      {importing ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      ) : (
                        <MoreHorizontal className="h-3.5 w-3.5" />
                      )}
                    </Button>
                  </DropdownMenuTrigger>
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onSelect={() => void handleImportCcSwitch()}
                    >
                      <Download className="h-3.5 w-3.5" />
                      {t("importCcSwitch")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => void handleTransfer("import")}
                    >
                      <FileInput className="h-3.5 w-3.5" />
                      {t("transfer.import")}
                    </DropdownMenuItem>
                    <DropdownMenuItem
                      onSelect={() => void handleTransfer("export")}
                    >
                      <FileOutput className="h-3.5 w-3.5" />
                      {t("transfer.export")}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            </div>
            <ScrollArea className="min-h-0 flex-1">
              <div className="space-y-0.5 p-1.5">
                {loginCards.length > 0 ? (
                  <>
                    <div className="px-2.5 pb-0.5 pt-1 text-[11px] text-muted-foreground">
                      {t("loginSection")}
                    </div>
                    {loginCards.map((card) => (
                      <button
                        key={card[0].loginId}
                        type="button"
                        onClick={() => {
                          setSelected(null)
                          setLoginId(card[0].loginId)
                        }}
                        className={cn(
                          "flex w-full items-center rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                          selectedLogin === card
                            ? "bg-muted font-medium text-foreground"
                            : "text-foreground/80 hover:bg-muted/50 hover:text-foreground"
                        )}
                        title={card.map((entry) => entry.agentName).join(" · ")}
                      >
                        <span className="min-w-0 truncate">
                          {card[0].label}
                        </span>
                        <span className="ml-auto shrink-0 pl-2 text-[10px] text-muted-foreground">
                          {card.map((entry) => entry.agentName).join(" · ")}
                        </span>
                      </button>
                    ))}
                    <div className="my-1 border-t" />
                  </>
                ) : null}
                {loading ? (
                  <div className="flex justify-center py-6">
                    <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" />
                  </div>
                ) : providers.length === 0 ? (
                  <div className="flex flex-col items-center gap-1 py-6 text-muted-foreground">
                    <Server className="h-6 w-6 opacity-40" />
                    <span className="text-[11px]">{t("noProviders")}</span>
                  </div>
                ) : (
                  providers.map((provider) => (
                    <button
                      key={provider.id}
                      type="button"
                      onClick={() => selectProvider(provider.id)}
                      className={cn(
                        "flex w-full items-center rounded-md px-2.5 py-2 text-left text-sm transition-colors",
                        selected === provider.id
                          ? "bg-muted font-medium text-foreground"
                          : "text-foreground/80 hover:bg-muted/50 hover:text-foreground"
                      )}
                      title={provider.name}
                    >
                      <span className="min-w-0 truncate">{provider.name}</span>
                    </button>
                  ))
                )}
              </div>
            </ScrollArea>
          </>
        }
      >
        {selectedLogin ? (
          <LoginCardDetail
            key={selectedLogin[0].loginId}
            entries={selectedLogin}
            checkedAt={loginCheckedAt}
            onRecheck={() => void loadLogins()}
          />
        ) : selected === "new" ? (
          <ProviderDetailForm
            onSaved={afterSave}
            onCancel={() => setSelected(null)}
          />
        ) : selectedProvider ? (
          <ProviderDetailForm
            key={selectedProvider.id}
            provider={selectedProvider}
            onSaved={afterSave}
            onCancel={() => setSelected(null)}
          />
        ) : (
          <div className="flex h-full items-center justify-center rounded-lg border text-sm text-muted-foreground">
            {t("selectProviderHint")}
          </div>
        )}
      </SettingsSplit>
    </div>
  )
}

/**
 * 表单端点行：已知协议按 `resolveProviderProtocolUrls`（没有端点时主地址按 chat）
 * 取值，其余 `endpoints` 键作为「其他」行保留。
 */
function parseEndpoints(
  discoveryJson?: string | null,
  legacyApiUrl?: string | null
): EndpointRow[] {
  const urls = resolveProviderProtocolUrls({
    discovery_json: discoveryJson,
    api_url: legacyApiUrl,
  })
  const rows: EndpointRow[] = KNOWN_ENDPOINTS.filter((kind) => urls[kind]).map(
    (kind) => ({ kind, name: "", apiUrl: urls[kind] })
  )
  try {
    const endpoints = discoveryJson
      ? JSON.parse(discoveryJson)?.endpoints
      : null
    if (endpoints && typeof endpoints === "object") {
      for (const [name, endpoint] of Object.entries(endpoints)) {
        if ((KNOWN_ENDPOINTS as readonly string[]).includes(name)) continue
        const item = endpoint as { apiUrl?: string; api_url?: string } | null
        const apiUrl = String(item?.apiUrl || item?.api_url || "").trim()
        if (apiUrl) rows.push({ kind: "other", name, apiUrl })
      }
    }
  } catch {}
  return rows
}

/** 某类已知端点填写的地址（没有则空串）。 */
function urlOf(rows: EndpointRow[], kind: KnownEndpoint): string {
  return rows.find((row) => row.kind === kind)?.apiUrl.trim() ?? ""
}

export interface KeyGroupItem {
  id: string
  name: string
  key: string
  models: ProviderModel[]
}

function parseKeyGroups(
  discoveryJson?: string | null,
  fallbackApiKey?: string | null,
  fallbackModels?: ProviderModel[]
): KeyGroupItem[] {
  if (discoveryJson) {
    try {
      const parsed = JSON.parse(discoveryJson)
      const groups = parsed?.keyGroups || parsed?.groupKeys
      if (Array.isArray(groups) && groups.length > 0) {
        return groups.map(
          (
            item: {
              id?: string
              name?: string
              key?: string
              models?: ProviderModel[]
            },
            idx: number
          ) => ({
            id: item.id || String(idx + 1),
            name: item.name || (idx === 0 ? "default" : `group-${idx + 1}`),
            key: item.key || "",
            models: Array.isArray(item.models)
              ? item.models
              : idx === 0 && fallbackModels && fallbackModels.length > 0
                ? fallbackModels
                : [],
          })
        )
      }
    } catch {}
  }
  return [
    {
      id: "1",
      name: "default",
      key: fallbackApiKey?.trim() || "",
      models: fallbackModels && fallbackModels.length > 0 ? fallbackModels : [],
    },
  ]
}

/** 档案是否开启「经 Berth 代理」（`discovery_json.viaProxy`，后端同名字段）。 */
function parseViaProxy(discoveryJson?: string | null): boolean {
  if (!discoveryJson) return false
  try {
    return JSON.parse(discoveryJson)?.viaProxy === true
  } catch {
    return false
  }
}

function serializeDiscoveryConfig(
  endpoints: EndpointRow[],
  keyGroups: KeyGroupItem[],
  viaProxy: boolean,
  defaultApis: ModelApi[] | undefined,
  existingDiscoveryJson?: string | null
): string | null {
  let base: Record<string, unknown> = {}
  if (existingDiscoveryJson) {
    try {
      base = JSON.parse(existingDiscoveryJson) || {}
    } catch {}
  }
  const cleanEndpoints: Record<string, { apiUrl?: string }> = {}
  for (const row of endpoints) {
    const url = row.apiUrl.trim()
    const key = endpointKey(row)
    if (url && key) {
      cleanEndpoints[key] = { apiUrl: url }
    }
  }
  if (Object.keys(cleanEndpoints).length > 0) {
    base.endpoints = cleanEndpoints
  } else {
    delete base.endpoints
  }

  const cleanKeyGroups = keyGroups
    .map((item) => ({
      id: item.id,
      name: item.name.trim() || "default",
      key: item.key.trim(),
      models: item.models.filter((m) => m.id.trim() !== "").map(modelRecord),
    }))
    .filter((item) => item.name || item.key || item.models.length > 0)

  if (cleanKeyGroups.length > 0) {
    base.keyGroups = cleanKeyGroups
  } else {
    delete base.keyGroups
  }
  // 旧版本双写的同义字段；读取侧仍兼容旧档案，保存时清掉。
  delete base.groupKeys

  if (viaProxy) {
    base.viaProxy = true
  } else {
    delete base.viaProxy
  }
  if (defaultApis?.length) {
    base.defaultApis = defaultApis
  } else {
    delete base.defaultApis
  }

  return Object.keys(base).length > 0 ? JSON.stringify(base) : null
}

/** 档案详情表单(新建/编辑统一共用)。 */
function ProviderDetailForm({
  provider,
  onSaved,
  onCancel,
}: {
  provider?: ModelProviderInfo
  onSaved: (id?: number) => Promise<void>
  onCancel: () => void
}) {
  const t = useTranslations("ModelProviderSettings")
  const [name, setName] = useState(provider?.name ?? "")
  const [website, setWebsite] = useState(provider?.website ?? "")
  // API 模式专属状态
  const [endpoints, setEndpoints] = useState<EndpointRow[]>(() => {
    const rows = parseEndpoints(provider?.discovery_json, provider?.api_url)
    return rows.length > 0 ? rows : [{ kind: "chat", name: "", apiUrl: "" }]
  })
  const [proxyAccess, setProxyAccess] = useState<ProxyAccess | null>(null)
  useEffect(() => {
    let alive = true
    getProxyAccess()
      .then((access) => alive && setProxyAccess(access))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  const [keyGroups, setKeyGroups] = useState<KeyGroupItem[]>(() =>
    parseKeyGroups(
      provider?.discovery_json,
      provider?.api_key,
      provider ? providerCatalogModels(provider) : []
    )
  )
  const [viaProxy, setViaProxy] = useState(() =>
    parseViaProxy(provider?.discovery_json)
  )
  const [defaultApis, setDefaultApis] = useState(() =>
    providerDefaultApis(provider)
  )
  // 档位选项来自各 Agent 的 tool.json providerInjection.slots（并集），不认 Agent 名字。
  const { agents } = useAgentProfiles()
  const modelDetails = useMemo(
    () => ({
      slotOptions: [
        ...new Set(agents.flatMap((agent) => agent.providerSlots ?? [])),
      ],
      defaultApis,
    }),
    [agents, defaultApis]
  )
  const [fetchingGroupId, setFetchingGroupId] = useState<string | null>(null)
  // 决策入口看已保存的档案：面板请求用后端存的地址与 Key，未保存的编辑不生效。
  const canDecide = Boolean(
    provider && resolveProviderProtocolUrls(provider).systemone
  )
  const [decisionModel, setDecisionModel] = useState<string | null>(null)

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [groupBalances, setGroupBalances] = useState<
    Record<string, UsageState>
  >({})
  const [groupBalanceLoading, setGroupBalanceLoading] = useState<
    Record<string, boolean>
  >({})

  /**
   * 按已填协议地址依次获取，每个协议只发一次请求。只有「该地址不提供列表」
   * 才换下一个协议；鉴权失败、限流、网络错误立即停，免得一次点击连发多次
   * 失败请求触发网关风控。
   */
  const handleFetchGroupModels = useCallback(
    async (group: KeyGroupItem) => {
      const attempts = (["chat", "claude", "gemini"] as const)
        .map((protocol) => ({
          protocol,
          apiUrl: urlOf(endpoints, protocol),
        }))
        .filter((attempt) => attempt.apiUrl)

      if (attempts.length === 0) {
        setError(t("protocolUrlRequired"))
        return
      }

      setFetchingGroupId(group.id)
      setError(null)
      let lastError: unknown = null
      let sawEmpty = false
      try {
        for (const attempt of attempts) {
          try {
            const fetched = await fetchProviderModels({
              protocol: attempt.protocol,
              apiUrl: attempt.apiUrl,
              apiKey: group.key.trim(),
            })
            if (fetched.length > 0) {
              const newModels = mergeFetchedModels(group.models, fetched)
              setKeyGroups((prev) =>
                prev.map((g) =>
                  g.id === group.id ? { ...g, models: newModels } : g
                )
              )
              toast.success(
                t("fetchGroupModelsSuccess", {
                  name: group.name || "default",
                  count: newModels.length,
                })
              )
              return
            }
            sawEmpty = true
          } catch (err: unknown) {
            lastError = err
            if (!isListingUnsupported(err)) break
          }
        }
        if (sawEmpty) {
          // 至少有一个地址返回了合法空目录,优先于其它地址的失败。
          setError(t("fetchModelsEmpty"))
        } else if (lastError) {
          setError(
            formatProviderFetchError(
              lastError,
              t as unknown as AppErrorTranslator
            )
          )
        }
      } finally {
        setFetchingGroupId(null)
      }
    },
    [endpoints, t]
  )

  /** API 模式下针对指定分组的密钥与已填写的协议 URL 查询余额 */
  const handleQueryGroupBalance = useCallback(
    async (group: KeyGroupItem) => {
      const effectiveUrl =
        urlOf(endpoints, "chat") ||
        urlOf(endpoints, "claude") ||
        urlOf(endpoints, "gemini")
      if (!effectiveUrl) {
        setError(t("protocolUrlRequired"))
        return
      }
      if (!group.key.trim()) {
        setError(t("apiKeyRequired"))
        return
      }

      setError(null)
      setGroupBalanceLoading((prev) => ({ ...prev, [group.id]: true }))
      try {
        const result = await fetchProviderBalance({
          apiUrl: effectiveUrl,
          apiKey: group.key.trim(),
        })
        setGroupBalances((prev) => ({ ...prev, [group.id]: result }))
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : t("balance.error"))
      } finally {
        setGroupBalanceLoading((prev) => ({ ...prev, [group.id]: false }))
      }
    },
    [endpoints, t]
  )

  const handleAddKeyGroup = useCallback(() => {
    setKeyGroups((prev) => [
      ...prev,
      {
        id: String(Date.now()),
        name: `group-${prev.length + 1}`,
        key: "",
        models: [],
      },
    ])
  }, [])

  const handleDeleteKeyGroup = useCallback((id: string) => {
    setKeyGroups((prev) => {
      if (prev.length <= 1) return prev
      return prev.filter((g) => g.id !== id)
    })
  }, [])

  const handleUpdateKeyGroupName = useCallback(
    (id: string, newName: string) => {
      setKeyGroups((prev) =>
        prev.map((g) => (g.id === id ? { ...g, name: newName } : g))
      )
    },
    []
  )

  const handleUpdateKeyGroupKey = useCallback((id: string, newKey: string) => {
    setKeyGroups((prev) =>
      prev.map((g) => (g.id === id ? { ...g, key: newKey } : g))
    )
  }, [])

  const handleUpdateKeyGroupModels = useCallback(
    (id: string, newModels: ProviderModel[]) => {
      setKeyGroups((prev) =>
        prev.map((g) => (g.id === id ? { ...g, models: newModels } : g))
      )
    },
    []
  )

  const handleSubmit = useCallback(async () => {
    if (!name.trim()) {
      setError(t("nameRequired"))
      return
    }
    // 旧 api_url 列存首个地址（已知协议优先），供旧读法回退。
    const effectiveUrl =
      KNOWN_ENDPOINTS.map((kind) => urlOf(endpoints, kind)).find(Boolean) ||
      endpoints.map((row) => row.apiUrl.trim()).find(Boolean)
    if (!effectiveUrl) {
      setError(t("protocolUrlRequired"))
      return
    }
    const endpointProblem = endpointError(endpoints)
    if (endpointProblem) {
      setError(t(endpointProblem))
      return
    }

    // 聚合所有分组模型
    const seen = new Set<string>()
    const allModels: ProviderModel[] = []
    for (const g of keyGroups) {
      for (const m of g.models) {
        const trimmedId = m.id.trim()
        if (trimmedId && !seen.has(trimmedId)) {
          seen.add(trimmedId)
          allModels.push(m)
        }
      }
    }
    const modelPayload = serializeModels(allModels)
    // 首个有效 key 保存在主 api_key 供向后兼容
    const effectiveApiKey =
      keyGroups.find((g) => g.key.trim().length > 0)?.key.trim() ?? ""
    const discoveryJsonValue = serializeDiscoveryConfig(
      endpoints,
      keyGroups,
      viaProxy,
      defaultApis,
      provider?.discovery_json
    )
    // 哪个 Agent 能用这份档案由端点 × 模型接口决定（启动档案按 tool.json apis 匹配），
    // 不再按 Agent 写白名单与逐 Agent 的模型副本；空 overlays 清掉旧版本留下的副本。
    const websiteValue = website.trim() || null
    const kindValue = "custom"

    setSaving(true)
    setError(null)
    try {
      if (provider) {
        const { affectedRunningSessions } = await updateModelProvider({
          id: provider.id,
          name: name.trim() !== provider.name ? name.trim() : undefined,
          apiUrl: effectiveUrl,
          apiKey: effectiveApiKey,
          agentType: "",
          website:
            (websiteValue ?? "") !== (provider.website ?? "")
              ? (websiteValue ?? "")
              : undefined,
          model: modelPayload,
          agentAllowlist: [],
          overlays: [],
          kind: kindValue,
          discoveryJson: discoveryJsonValue,
        })
        toast.success(t("editSuccess"))
        if (affectedRunningSessions > 0) {
          toast.info(
            t("affectedRunningSessions", { count: affectedRunningSessions })
          )
        }
        await onSaved(provider.id)
      } else {
        const created = await createModelProvider({
          name: name.trim(),
          apiUrl: effectiveUrl,
          apiKey: effectiveApiKey,
          agentType: "",
          website: websiteValue,
          model: modelPayload || null,
          agentAllowlist: [],
          kind: kindValue,
          overlays: [],
          discoveryJson: discoveryJsonValue,
        })
        toast.success(t("createSuccess"))
        await onSaved(created.id)
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : t("saveFailed"))
    } finally {
      setSaving(false)
    }
  }, [
    name,
    endpoints,
    keyGroups,
    viaProxy,
    defaultApis,
    website,
    provider,
    t,
    onSaved,
  ])

  const handleDelete = useCallback(async () => {
    if (!provider) return
    try {
      await deleteModelProvider(provider.id)
      toast.success(t("deleteSuccess"))
      setConfirmDelete(false)
      await onSaved()
    } catch (err: unknown) {
      const raw = err as Record<string, unknown>
      const msg =
        typeof raw?.message === "string"
          ? raw.message
          : err instanceof Error
            ? err.message
            : String(err)
      const prefix = "PROVIDER_IN_USE:"
      // 库里已删、前端仍缓存旧行时：当作删除成功并刷新名单
      if (/model provider not found/i.test(msg)) {
        toast.success(t("deleteSuccess"))
        setConfirmDelete(false)
        await onSaved()
        return
      }
      if (msg.includes(prefix)) {
        const agentNames = msg.substring(msg.indexOf(prefix) + prefix.length)
        toast.error(t("deleteBlockedByAgent", { agents: agentNames }))
      } else {
        toast.error(msg)
      }
    }
  }, [provider, onSaved, t])

  const websiteUrl = website.trim() || null

  return (
    <div className="flex h-full min-h-0 flex-col rounded-lg border">
      {provider && decisionModel ? (
        <DecisionPanel
          providerId={provider.id}
          providerName={provider.name}
          model={decisionModel}
          open
          onOpenChange={(open) => {
            if (!open) setDecisionModel(null)
          }}
        />
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        <div className="space-y-4 p-4">
          <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
            <div className="space-y-1.5">
              <label htmlFor="mp-name" className="text-xs font-medium">
                {t("providerName")}
              </label>
              <Input
                id="mp-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={t("providerNamePlaceholder")}
              />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="mp-website" className="text-xs font-medium">
                {t("website")}
              </label>
              <div className="flex items-center gap-1.5">
                <Input
                  id="mp-website"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  placeholder={t("websitePlaceholder")}
                />
                {websiteUrl ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-8 w-8 shrink-0"
                    aria-label={t("website")}
                    onClick={() => void openPath(websiteUrl)}
                  >
                    <ExternalLink className="h-3.5 w-3.5" aria-hidden />
                  </Button>
                ) : null}
              </div>
            </div>
          </div>

          <div className="space-y-4">
            {/* 接口地址（按协议）：直接平铺，按需选填 */}
            <div className="space-y-2.5 rounded-lg border bg-muted/20 p-3">
              <div>
                <span className="text-xs font-medium text-foreground/90">
                  {t("protocolUrls")}
                </span>
                <p className="text-[11px] text-muted-foreground">
                  {t("protocolUrlsHint")}
                </p>
              </div>
              <EndpointList
                rows={endpoints}
                onChange={setEndpoints}
                providerId={provider?.id}
                access={proxyAccess}
              />
              <div className="space-y-1 border-t pt-2.5">
                <span className="text-xs font-medium text-foreground/90">
                  {t("defaultApis")}
                </span>
                <ApiToggles
                  value={defaultApis}
                  label={(api) =>
                    t("defaultApiToggle", { api: API_LABELS[api] })
                  }
                  onChange={setDefaultApis}
                />
                <p className="text-[11px] text-muted-foreground">
                  {t("defaultApisHint")}
                </p>
              </div>
            </div>

            {/* 经 Berth 代理启动：Agent 只拿到本机代理地址与占位令牌 */}
            <div className="flex items-center justify-between gap-3 rounded-lg border bg-muted/20 p-3">
              <div>
                <label
                  htmlFor="mp-via-proxy"
                  className="text-xs font-medium text-foreground/90"
                >
                  {t("viaProxy")}
                </label>
                <p className="text-[11px] text-muted-foreground">
                  {t("viaProxyHint")}
                </p>
              </div>
              <Switch
                id="mp-via-proxy"
                checked={viaProxy}
                onCheckedChange={setViaProxy}
              />
            </div>

            {/* 分组密钥与模型列表 */}
            <div className="space-y-3">
              <div>
                <div className="flex items-center justify-between">
                  <span className="text-xs font-medium text-foreground/90">
                    {t("keyGroupsSectionTitle")}
                  </span>
                </div>
                <p className="text-[11px] text-muted-foreground">
                  {t("keyGroupsSectionHint")}
                </p>
              </div>

              <div className="space-y-3">
                {keyGroups.map((group) => (
                  <div
                    key={group.id}
                    className="space-y-3 rounded-lg border bg-muted/15 p-3"
                  >
                    {/* 分组卡片顶部：名称与删除 */}
                    <div className="flex items-center justify-between gap-2 border-b pb-2">
                      <Input
                        value={group.name}
                        onChange={(e) =>
                          handleUpdateKeyGroupName(group.id, e.target.value)
                        }
                        placeholder={t("groupName")}
                        aria-label={t("groupName")}
                        className="h-7 w-40 text-xs"
                      />
                      {keyGroups.length > 1 ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                          onClick={() => handleDeleteKeyGroup(group.id)}
                          title={t("deleteGroup")}
                        >
                          <Trash2 className="mr-1 h-3.5 w-3.5" />
                          {t("deleteGroup")}
                        </Button>
                      ) : null}
                    </div>

                    {/* 分组 API 密钥与余额查询 */}
                    <div className="space-y-1">
                      <div className="flex items-center justify-between">
                        <label className="text-xs font-medium text-foreground/90">
                          {t("groupKey")}
                        </label>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[11px]"
                          disabled={
                            groupBalanceLoading[group.id] || !group.key.trim()
                          }
                          onClick={() => void handleQueryGroupBalance(group)}
                        >
                          {groupBalanceLoading[group.id] ? (
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          ) : (
                            <Wallet className="mr-1 h-3 w-3" />
                          )}
                          {groupBalanceLoading[group.id]
                            ? t("balance.querying")
                            : t("balance.query")}
                        </Button>
                      </div>
                      <Input
                        value={group.key}
                        onChange={(e) =>
                          handleUpdateKeyGroupKey(group.id, e.target.value)
                        }
                        placeholder={t("apiKeyPlaceholder")}
                        className="h-8 font-mono text-xs"
                      />
                      {groupBalances[group.id] ? (
                        <div className="pt-0.5">
                          {groupBalances[group.id].status === "ready" &&
                          groupBalances[group.id].windows.length > 0 ? (
                            <div className="text-xs text-muted-foreground">
                              {groupBalances[group.id].windows.map((window) => {
                                const parts = usageWindowParts(
                                  window,
                                  t as unknown as UsageTranslator
                                )
                                return (
                                  <span key={window.id} className="mr-3">
                                    {parts.usage}
                                    {parts.reset ? ` · ${parts.reset}` : ""}
                                  </span>
                                )
                              })}
                            </div>
                          ) : groupBalances[group.id].status ===
                            "unavailable" ? (
                            <p className="text-[11px] text-muted-foreground">
                              {groupBalances[group.id].diagnostics[0]
                                ?.message || t("balance.unsupported")}
                            </p>
                          ) : groupBalances[group.id].status === "missing" ? (
                            <p className="text-[11px] text-muted-foreground">
                              {t("balance.notSignedIn")}
                            </p>
                          ) : (
                            <p className="text-[11px] text-red-400">
                              {groupBalances[group.id].diagnostics
                                .map((d) => d.message)
                                .join(" ") || t("balance.error")}
                            </p>
                          )}
                        </div>
                      ) : null}
                    </div>

                    {/* 分组专属模型列表 */}
                    <div className="space-y-1.5">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <label className="text-xs font-medium text-foreground/90">
                            {t("groupModelList")}
                          </label>
                          <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                            {t("modelsCount", { count: group.models.length })}
                          </span>
                        </div>
                        <Button
                          type="button"
                          variant="ghost"
                          size="sm"
                          className="h-6 px-2 text-[11px]"
                          disabled={fetchingGroupId === group.id}
                          onClick={() => void handleFetchGroupModels(group)}
                        >
                          {fetchingGroupId === group.id ? (
                            <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                          ) : (
                            <CloudDownload className="mr-1 h-3 w-3" />
                          )}
                          {t("fetchModels")}
                        </Button>
                      </div>
                      <ModelMappingEditor
                        details={modelDetails}
                        value={group.models}
                        onChange={(m) =>
                          handleUpdateKeyGroupModels(group.id, m)
                        }
                        onDecide={
                          canDecide
                            ? (model) => setDecisionModel(model.id.trim())
                            : undefined
                        }
                      />
                    </div>
                  </div>
                ))}

                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="h-8 w-full border-dashed gap-1 text-xs"
                  onClick={handleAddKeyGroup}
                >
                  <Plus className="h-3.5 w-3.5" />
                  {t("addGroupKey")}
                </Button>
              </div>
            </div>
          </div>
        </div>
      </ScrollArea>

      {/* 放在滚动区外：在顶部点「获取模型」失败也看得到 */}
      {error ? (
        <div
          role="alert"
          className="mx-3 mt-2 shrink-0 rounded-md border border-red-500/30 bg-red-500/5 px-3 py-2 text-xs text-red-400"
        >
          {error}
        </div>
      ) : null}

      <div className="flex shrink-0 items-center justify-between gap-2 border-t p-3">
        {provider ? (
          <Button
            variant="ghost"
            size="sm"
            className="h-7 text-xs text-destructive hover:text-destructive"
            onClick={() => setConfirmDelete(true)}
          >
            <Trash2 className="mr-1 h-3.5 w-3.5" />
            {t("delete")}
          </Button>
        ) : (
          <span />
        )}
        <div className="flex items-center gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={onCancel}
            disabled={saving}
          >
            {t("cancel")}
          </Button>
          <Button
            size="sm"
            onClick={() => void handleSubmit()}
            disabled={saving}
          >
            {saving && <Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />}
            {provider ? t("save") : t("create")}
          </Button>
        </div>
      </div>

      <AlertDialog open={confirmDelete} onOpenChange={setConfirmDelete}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("deleteConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("deleteConfirmMessage", { name: provider?.name ?? "" })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t("cancel")}</AlertDialogCancel>
            <AlertDialogAction onClick={() => void handleDelete()}>
              {t("delete")}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
