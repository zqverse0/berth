"use client"

import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useTranslations } from "next-intl"
import {
  collectLaunchbarInputs,
  validateLaunchbarConfig,
} from "@/components/launchbar/registry"
import type {
  LaunchbarConfig,
  LaunchbarItem,
} from "@/components/launchbar/types"
import { useAgentProfiles } from "@/hooks/use-agent-profiles"
import { toErrorMessage } from "@/lib/app-error"
import { listModelProviders, resolveProjectAgentSession } from "@/lib/api"
import {
  fetchLoginModels,
  isProviderVisibleForLaunchbar,
  listLoginCards,
  type LoginEntry,
  modelUsableBy,
  providerDefaultApis,
  providerCatalogModels,
  type ProviderModel,
} from "@/lib/model-provider"
import { useWorkspaceRuntimeActions } from "@/hooks/workspace/use-workspace-runtime"
import { useProjectAgentSessions } from "@/sessions/project/use-project-agent-sessions"
import { createAndOpenPrimaryTerminalDetailed } from "@/lib/terminal/create-and-open-primary-terminal"
import { reportAgentLaunchAlert } from "@/lib/terminal/report-agent-launch-alert"
import { launchbar as loadLaunchbarFile } from "@/lib/transport/launchbar"
import type { AgentType, ModelProviderInfo } from "@/lib/types"
import { WORKSPACE_FILE_SAVED_EVENT } from "@/lib/workspace/workspace-file-events"

export const LAUNCHBAR_VALUES_STORAGE_PREFIX = "berth:launchbar-values:"
export const LAUNCHBAR_MODEL_PREF_STORAGE_PREFIX = "berth:launchbar-model-pref:"

export function getLaunchbarStorageKey(agentId: string): string {
  return `${LAUNCHBAR_VALUES_STORAGE_PREFIX}${agentId}`
}

export function getLaunchbarModelPrefStorageKey(agentId: string): string {
  return `${LAUNCHBAR_MODEL_PREF_STORAGE_PREFIX}${agentId}`
}

export interface StoredModelPreference {
  providerId: number | null
  modelId: string
  /** 选中的登录凭证卡（tool.json `logins`）；有值时 providerId 为 null。 */
  loginId?: string | null
}

export function loadStoredModelPreference(
  agentId: string
): StoredModelPreference | null {
  if (typeof window === "undefined") return null
  try {
    const raw = window.localStorage.getItem(
      getLaunchbarModelPrefStorageKey(agentId)
    )
    if (!raw) return null
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const providerId =
        typeof parsed.providerId === "number"
          ? parsed.providerId
          : parsed.providerId === null
            ? null
            : undefined
      const modelId = typeof parsed.modelId === "string" ? parsed.modelId : ""
      const loginId = typeof parsed.loginId === "string" ? parsed.loginId : null
      if (providerId !== undefined) {
        return { providerId, modelId, loginId }
      }
    }
  } catch {
    // 忽略异常，降级为空
  }
  return null
}

export function saveStoredModelPreference(
  agentId: string,
  preference: StoredModelPreference
): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(
      getLaunchbarModelPrefStorageKey(agentId),
      JSON.stringify(preference)
    )
  } catch {
    // 存储满或被禁用时忽略
  }
}

export function loadStoredLaunchbarValues(
  agentId: string
): Record<string, string> {
  if (typeof window === "undefined") return {}
  try {
    const raw = window.localStorage.getItem(getLaunchbarStorageKey(agentId))
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const result: Record<string, string> = {}
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === "string") {
          result[k] = v
        }
      }
      return result
    }
  } catch {
    // 忽略异常，降级为空
  }
  return {}
}

export function saveStoredLaunchbarValues(
  agentId: string,
  values: Record<string, string>
): void {
  if (typeof window === "undefined") return
  try {
    window.localStorage.setItem(
      getLaunchbarStorageKey(agentId),
      JSON.stringify(values)
    )
  } catch {
    // 存储满或被禁用时忽略
  }
}

/** 会话选择不进 localStorage，避免下次误续接。 */
export function omitEphemeralLaunchbarValues(
  items: readonly LaunchbarItem[],
  values: Record<string, string>
): Record<string, string> {
  const skip = new Set(
    items
      .filter((item) => item.optionsFrom === "projectSessions")
      .map((item) => item.id)
  )
  if (skip.size === 0) return values
  const next: Record<string, string> = {}
  for (const [key, value] of Object.entries(values)) {
    if (!skip.has(key)) next[key] = value
  }
  return next
}

// 服务商下拉的值：`login:<id>` = 登录凭证卡（不注入，CLI 用自己的登录）；
// 数字串 = API 服务商档案 id；空串 = 未选。
const LOGIN_PREFIX = "login:"
function vendorFromPreference(pref: StoredModelPreference | null): string {
  if (pref?.loginId) return `${LOGIN_PREFIX}${pref.loginId}`
  return pref?.providerId != null ? String(pref.providerId) : ""
}
function loginIdOf(vendor: string): string | null {
  return vendor.startsWith(LOGIN_PREFIX)
    ? vendor.slice(LOGIN_PREFIX.length)
    : null
}
function providerIdOf(vendor: string): number | null {
  return /^\d+$/.test(vendor) ? Number(vendor) : null
}

// 登录凭证模型会话内缓存（刷新启动栏时清空）；只缓存成功结果，失败下次重试。
// 取不到按空列表（交给 CLI 默认）。
const loginModelCache = new Map<string, Promise<ProviderModel[]>>()
function loadLoginModels(
  agentId: string,
  loginId: string
): Promise<ProviderModel[]> {
  const key = `${agentId}\u0000${loginId}`
  let pending = loginModelCache.get(key)
  if (!pending) {
    pending = fetchLoginModels(agentId, loginId).then(({ models }) => models)
    loginModelCache.set(key, pending)
    pending.catch(() => loginModelCache.delete(key))
  }
  return pending.catch(() => [])
}

function formatSessionOptionTime(value: string): string | null {
  const timestamp = Date.parse(value)
  if (Number.isNaN(timestamp)) return null
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "short",
    timeStyle: "short",
  }).format(timestamp)
}

export interface UseLaunchbarOptions {
  workingDirectory: string
  folderId?: number | null
  agentId: string | null
  agentType?: AgentType | null
  /** 预选的专家：填进 `optionsFrom: "experts"` 那一项，盖过上次记住的值。 */
  expert?: string | null
  onLaunched?: () => void
  /** 启动前的前置步骤（如新建协作先建频道），返回追加的启动输入；抛错即中止启动。 */
  prepareLaunch?: () => Promise<Record<string, string | boolean>>
}

export function useLaunchbar({
  workingDirectory,
  folderId,
  agentId,
  agentType,
  expert,
  onLaunched,
  prepareLaunch,
}: UseLaunchbarOptions) {
  const tTerminal = useTranslations("Folder.terminal")
  const tProviders = useTranslations("ModelProviderSettings")
  const tProjectSessions = useTranslations("Folder.projectSessions")
  const { openTranscriptTab } = useWorkspaceRuntimeActions()
  const { agents: profileAgents, refresh: refreshProfiles } = useAgentProfiles()

  const [launchingCli, setLaunchingCli] = useState(false)
  const [launchingTerminal, setLaunchingTerminal] = useState(false)

  const selectedProfile = useMemo(
    () => profileAgents.find((agent) => agent.id === agentId) ?? null,
    [profileAgents, agentId]
  )
  const selectedName = selectedProfile?.name ?? null
  const launchAgentId = selectedProfile?.id ?? null
  const effectiveAgentType =
    (selectedProfile?.projectType as AgentType | undefined) ??
    agentType ??
    (launchAgentId as AgentType | null)

  const [launchbarItems, setLaunchbarItems] = useState<LaunchbarItem[] | null>(
    null
  )
  const [launchbarValues, setLaunchbarValues] = useState<
    Record<string, string>
  >({})
  const [launchbarDiagnostics, setLaunchbarDiagnostics] = useState<string[]>([])
  const launchbarLoadSequence = useRef(0)

  // 窗格模型偏好持久化（按 Agent 全局记忆）：
  // 仅在前端通过 localStorage 记忆，不写数据库 agent_setting。
  const [providers, setProviders] = useState<ModelProviderInfo[]>([])
  const [logins, setLogins] = useState<LoginEntry[]>([])
  const [paneVendor, setPaneVendor] = useState<string>(() =>
    launchAgentId
      ? vendorFromPreference(loadStoredModelPreference(launchAgentId))
      : ""
  )
  const paneLoginId = loginIdOf(paneVendor)
  const paneProviderId = providerIdOf(paneVendor)
  const [paneModelId, setPaneModelId] = useState<string>(() => {
    if (!launchAgentId) return ""
    return loadStoredModelPreference(launchAgentId)?.modelId ?? ""
  })
  const lastAgentIdRef = useRef<string | null>(launchAgentId)
  const providerAgentType = selectedProfile?.providerAgentType ?? null
  const providerItem = useMemo(
    () =>
      launchbarItems?.find((item) => item.optionsFrom === "providerVendor") ??
      null,
    [launchbarItems]
  )

  useEffect(() => {
    let cancelled = false
    if (!providerItem) {
      setProviders([])
      setLogins([])
      return
    }
    void (async () => {
      try {
        const [all, loginEntries] = await Promise.all([
          listModelProviders(false).catch((error) => {
            if (!cancelled) {
              reportAgentLaunchAlert(
                tProviders("loadFailed"),
                toErrorMessage(error)
              )
            }
            return [] as ModelProviderInfo[]
          }),
          listLoginCards().catch(() => [] as LoginEntry[]),
        ])
        if (cancelled) return
        const visible = all.filter((provider) =>
          isProviderVisibleForLaunchbar(provider, {
            protocols: providerItem.protocols,
            ownerIds: [
              launchAgentId,
              providerAgentType,
              selectedProfile?.projectType,
            ].filter((id): id is string => Boolean(id)),
          })
        )
        const ownLogins = loginEntries.filter(
          (entry) => entry.agentId === launchAgentId
        )
        setProviders(visible)
        setLogins(ownLogins)

        const agentChanged = lastAgentIdRef.current !== launchAgentId
        lastAgentIdRef.current = launchAgentId
        const storedPref = launchAgentId
          ? loadStoredModelPreference(launchAgentId)
          : null
        const available = new Set([
          ...ownLogins.map((entry) => `${LOGIN_PREFIX}${entry.loginId}`),
          ...visible.map((provider) => String(provider.id)),
        ])

        // 偏好 → 当前值 → 首个登录凭证 → 首个 API 服务商；旧官方行 id 不在可见集里自然回落。
        setPaneVendor((current) => {
          const stored = vendorFromPreference(storedPref)
          if (available.has(stored)) return stored
          if (!agentChanged && available.has(current)) return current
          return [...available][0] ?? ""
        })
      } catch (error) {
        if (!cancelled) {
          setProviders([])
          setLogins([])
          reportAgentLaunchAlert(
            tProviders("loadFailed"),
            toErrorMessage(error)
          )
        }
      }
    })()
    return () => {
      cancelled = true
    }
  }, [
    providerItem,
    launchAgentId,
    providerAgentType,
    selectedProfile?.projectType,
    tProviders,
  ])

  const selectedProvider = useMemo(
    () => providers.find((provider) => provider.id === paneProviderId) ?? null,
    [providers, paneProviderId]
  )
  const [loginModels, setLoginModels] = useState<ProviderModel[]>([])
  const loginSelected = paneLoginId != null
  useEffect(() => {
    if (!launchAgentId || !paneLoginId) {
      setLoginModels([])
      return
    }
    let cancelled = false
    void loadLoginModels(launchAgentId, paneLoginId).then((models) => {
      if (!cancelled) setLoginModels(models)
    })
    return () => {
      cancelled = true
    }
  }, [launchAgentId, paneLoginId])
  const providerApis = selectedProfile?.providerApis ?? null
  const providerModels = useMemo(() => {
    if (loginSelected) return loginModels
    if (!selectedProvider) return []
    // 只列这个 CLI 会说其接口的模型（tool.json providerInjection.apis）；模型没单独设
    // 接口时按档案默认接口算，与启动档案的选法一致，免得选得到却启动失败。
    const defaultApis = providerDefaultApis(selectedProvider)
    return providerCatalogModels(
      selectedProvider,
      providerAgentType ?? undefined
    )
      .map((model) =>
        model.apis?.length || !defaultApis
          ? model
          : { ...model, apis: defaultApis }
      )
      .filter((model) => modelUsableBy(model, providerApis))
  }, [
    loginSelected,
    loginModels,
    selectedProvider,
    providerAgentType,
    providerApis,
  ])
  const modelItemId = useMemo(
    () =>
      launchbarItems?.find(
        (item) => item.optionsFrom === "providerModels" || item.id === "model"
      )?.id ?? null,
    [launchbarItems]
  )

  useEffect(() => {
    if (!modelItemId) return
    const storedPref = launchAgentId
      ? loadStoredModelPreference(launchAgentId)
      : null
    const officialDefault = providerModels[0]?.id ?? ""

    let targetModel = officialDefault
    if (
      storedPref &&
      vendorFromPreference(storedPref) === paneVendor &&
      storedPref.modelId &&
      providerModels.some((m) => m.id === storedPref.modelId)
    ) {
      targetModel = storedPref.modelId
    } else if (
      paneModelId &&
      providerModels.some((m) => m.id === paneModelId)
    ) {
      targetModel = paneModelId
    }

    if (paneModelId !== targetModel) {
      setPaneModelId(targetModel)
    }
    setLaunchbarValues((current) => {
      if (current[modelItemId] === targetModel) return current
      const next = { ...current, [modelItemId]: targetModel }
      if (launchAgentId) {
        saveStoredLaunchbarValues(
          launchAgentId,
          omitEphemeralLaunchbarValues(launchbarItems ?? [], next)
        )
      }
      return next
    })

    if (launchAgentId && targetModel && paneVendor) {
      if (
        !storedPref ||
        vendorFromPreference(storedPref) !== paneVendor ||
        storedPref.modelId !== targetModel
      ) {
        saveStoredModelPreference(launchAgentId, {
          providerId: paneProviderId,
          loginId: paneLoginId,
          modelId: targetModel,
        })
      }
    }
  }, [
    modelItemId,
    providerModels,
    paneModelId,
    paneVendor,
    paneProviderId,
    paneLoginId,
    launchAgentId,
    launchbarItems,
  ])

  const handleModelChange = async (value: string) => {
    if (!modelItemId) return
    setPaneModelId(value)
    setLaunchbarValues((current) => {
      const next = { ...current, [modelItemId]: value }
      if (launchAgentId) {
        saveStoredLaunchbarValues(
          launchAgentId,
          omitEphemeralLaunchbarValues(launchbarItems ?? [], next)
        )
      }
      return next
    })
    if (launchAgentId) {
      saveStoredModelPreference(launchAgentId, {
        providerId: paneProviderId,
        loginId: paneLoginId,
        modelId: value,
      })
    }
  }

  const handleVendorChange = (vendor: string) => {
    setPaneVendor(vendor)
    setPaneModelId("")
    if (launchAgentId) {
      saveStoredModelPreference(launchAgentId, {
        providerId: providerIdOf(vendor),
        loginId: loginIdOf(vendor),
        modelId: "",
      })
    }
  }

  const refreshLaunchbar = useCallback(async () => {
    const sequence = ++launchbarLoadSequence.current
    void refreshProfiles()
    loginModelCache.clear()
    if (!launchAgentId) {
      setLaunchbarItems(null)
      setLaunchbarValues({})
      setLaunchbarDiagnostics([])
      return
    }
    try {
      const response = await loadLaunchbarFile({
        type: "load",
        agent: launchAgentId,
      })
      if (sequence !== launchbarLoadSequence.current) return
      if (response.type !== "file") {
        throw new Error("unexpected launchbar response")
      }
      const config = response.file.config as LaunchbarConfig | null
      if (!config || !Array.isArray(config.items)) {
        setLaunchbarItems(null)
        setLaunchbarValues({})
        setLaunchbarDiagnostics(
          response.file.diagnostics
            .filter((item) => item.severity === "error")
            .map((item) => item.message)
        )
        return
      }
      const { items, diagnostics } = validateLaunchbarConfig(config)
      setLaunchbarItems(items)
      setLaunchbarDiagnostics(
        diagnostics.map((item) => `${item.itemId}: ${item.message}`)
      )

      const stored = launchAgentId
        ? loadStoredLaunchbarValues(launchAgentId)
        : {}
      const initial: Record<string, string> = {}
      for (const item of items) {
        let val = ""
        if (item.component === "select") {
          val = item.defaultValue ?? ""
        } else if (item.defaultValue != null) {
          val = item.defaultValue
        } else if (item.component === "switch") {
          val = "false"
        }

        const savedVal = stored[item.id]
        if (savedVal !== undefined && item.optionsFrom !== "projectSessions") {
          if (item.component === "select") {
            const staticOptions = item.options ?? []
            if (
              savedVal === "" ||
              item.optionsFrom != null ||
              staticOptions.some((opt) => opt.value === savedVal)
            ) {
              val = savedVal
            }
          } else if (item.component === "switch") {
            if (savedVal === "true" || savedVal === "false") {
              val = savedVal
            }
          } else {
            val = savedVal
          }
        }
        if (expert && item.optionsFrom === "experts") val = expert
        initial[item.id] = val
      }
      setLaunchbarValues((current) => {
        const next = { ...initial }
        for (const item of items) {
          if (
            item.optionsFrom === "projectSessions" &&
            current[item.id] &&
            current[item.id] !== ""
          ) {
            next[item.id] = current[item.id]
          }
        }
        return next
      })
    } catch (cause: unknown) {
      if (sequence !== launchbarLoadSequence.current) return
      setLaunchbarItems(null)
      setLaunchbarDiagnostics([toErrorMessage(cause)])
    }
  }, [launchAgentId, refreshProfiles, expert])

  useEffect(() => {
    void refreshLaunchbar()
  }, [refreshLaunchbar])

  useEffect(() => {
    const refresh = () => void refreshLaunchbar()
    window.addEventListener("focus", refresh)
    window.addEventListener(WORKSPACE_FILE_SAVED_EVENT, refresh)
    return () => {
      window.removeEventListener("focus", refresh)
      window.removeEventListener(WORKSPACE_FILE_SAVED_EVENT, refresh)
    }
  }, [refreshLaunchbar])

  const handleLaunchValueChange = (id: string, value: string) => {
    setLaunchbarValues((current) => {
      const next = { ...current, [id]: value }
      if (launchAgentId) {
        saveStoredLaunchbarValues(
          launchAgentId,
          omitEphemeralLaunchbarValues(launchbarItems ?? [], next)
        )
      }
      return next
    })
  }

  const wantsProjectSessions = Boolean(
    launchbarItems?.some((item) => item.optionsFrom === "projectSessions")
  )
  const projectSessions = useProjectAgentSessions({
    folderId: folderId ?? 0,
    agentType: wantsProjectSessions ? (effectiveAgentType ?? null) : null,
    query: "",
    enabled: Boolean(folderId && wantsProjectSessions && effectiveAgentType),
  })

  const projectSessionItemIds = useMemo(
    () =>
      (launchbarItems ?? [])
        .filter((item) => item.optionsFrom === "projectSessions")
        .map((item) => item.id)
        .join("\0"),
    [launchbarItems]
  )

  useEffect(() => {
    if (!projectSessionItemIds) return
    const ids = projectSessionItemIds.split("\0")
    setLaunchbarValues((current) => {
      let changed = false
      const next = { ...current }
      for (const id of ids) {
        if (next[id]) {
          next[id] = ""
          changed = true
        }
      }
      return changed ? next : current
    })
  }, [folderId, launchAgentId, projectSessionItemIds])

  const handleInspectSession = useCallback(
    async (externalId: string) => {
      if (!folderId || !effectiveAgentType || !externalId) return
      try {
        const result = await resolveProjectAgentSession({
          folderId,
          agentType: effectiveAgentType,
          externalId,
        })
        if (result.deleted || !result.sourceAvailable || !result.conversation) {
          reportAgentLaunchAlert(tProjectSessions("sourceUnavailable"))
          return
        }
        const conversation = result.conversation
        openTranscriptTab({
          folderId: conversation.folder_id,
          conversationId: conversation.id,
          agentType: conversation.agent_type,
          title: conversation.title ?? String(conversation.id),
        })
      } catch (error) {
        reportAgentLaunchAlert(
          tProjectSessions("agentLoadFailed", {
            error: toErrorMessage(error),
          }),
          toErrorMessage(error)
        )
      }
    },
    [effectiveAgentType, folderId, openTranscriptTab, tProjectSessions]
  )

  const handleLaunchTerminal = async () => {
    setLaunchingTerminal(true)
    try {
      const result = await createAndOpenPrimaryTerminalDetailed({
        cwd: workingDirectory,
        folderId,
      })
      if (!result.terminalId) {
        throw new Error(tTerminal("createFailed"))
      }
      onLaunched?.()
    } catch (error) {
      reportAgentLaunchAlert(tTerminal("launchFailed"), toErrorMessage(error))
    } finally {
      setLaunchingTerminal(false)
    }
  }

  const handleLaunchCli = async () => {
    if (!launchAgentId || !selectedName) return
    setLaunchingCli(true)
    try {
      const agentLaunchInputs = {
        ...collectLaunchbarInputs(launchbarItems ?? [], launchbarValues),
        ...(await prepareLaunch?.()),
      }
      const result = await createAndOpenPrimaryTerminalDetailed({
        cwd: workingDirectory,
        folderId,
        title: selectedName,
        agentType: effectiveAgentType ?? undefined,
        agentContractId: launchAgentId,
        agentLaunchInputs,
        providerId: paneProviderId,
        modelId: paneModelId || launchbarValues[modelItemId ?? ""] || null,
      })
      if (!result.terminalId) {
        throw new Error(tTerminal("createFailed"))
      }
      onLaunched?.()
    } catch (error) {
      reportAgentLaunchAlert(
        tTerminal("launchFailedNamed", { name: selectedName }),
        toErrorMessage(error)
      )
    } finally {
      setLaunchingCli(false)
    }
  }

  const renderedItems = useMemo(() => {
    const items = (launchbarItems ?? []).map((item) => {
      if (item.optionsFrom === "providerVendor") {
        return {
          ...item,
          options: [
            ...logins.map((entry) => ({
              value: `${LOGIN_PREFIX}${entry.loginId}`,
              label: entry.label,
            })),
            ...providers.map((provider) => ({
              value: String(provider.id),
              label: provider.name,
            })),
          ],
        }
      }
      if (item.optionsFrom === "providerModels" || item.id === "model") {
        return {
          ...item,
          options: providerModels.map((model) => ({
            value: model.id,
            label: model.id,
          })),
        }
      }
      if (item.optionsFrom === "projectSessions") {
        const history = projectSessions.items
          .filter((row) => row.externalId)
          .map((row) => {
            const title = row.title?.trim() || tProjectSessions("untitledAgent")
            const when = formatSessionOptionTime(row.updatedAt)
            return {
              value: row.externalId as string,
              label: when ? `${title} · ${when}` : title,
            }
          })
        return {
          ...item,
          options: [
            {
              value: "",
              label: tProjectSessions("launchbarNewSession"),
            },
            ...history,
          ],
        }
      }
      return item
    })
    return items.length > 0 ? items : null
  }, [
    launchbarItems,
    logins,
    providers,
    providerModels,
    projectSessions.items,
    tProjectSessions,
  ])

  return {
    profileAgents,
    selectedProfile,
    selectedName,
    launchAgentId,
    effectiveAgentType,
    binding: {
      providerId: paneProviderId,
      loginId: paneLoginId,
      vendor: paneVendor,
      modelKey: paneModelId || null,
    },
    providers,
    providerModels,
    renderedItems,
    launchbarValues,
    launchbarDiagnostics,
    launchingCli,
    launchingTerminal,
    busy: launchingCli || launchingTerminal,
    showLaunchButton: Boolean(launchAgentId && selectedName),
    handleValueChange: handleLaunchValueChange,
    handleVendorChange,
    handleModelChange,
    handleInspectSession,
    handleLaunchTerminal,
    handleLaunchCli,
    refreshLaunchbar,
  }
}
