import type { ModelProviderInfo } from "@/lib/types"

/** `systemone` 是决策协议（如 Jev），不对应任何 Agent，启动栏不会声明它。 */
export type ProtocolKind = "claude" | "chat" | "gemini" | "systemone"

export type ProviderProtocolUrls = Record<ProtocolKind, string>

const EMPTY_URLS: ProviderProtocolUrls = {
  claude: "",
  chat: "",
  gemini: "",
  systemone: "",
}

function readEndpointUrls(discoveryJson?: string | null): ProviderProtocolUrls {
  if (!discoveryJson) return { ...EMPTY_URLS }
  try {
    const parsed = JSON.parse(discoveryJson)
    const ep = parsed?.endpoints
    if (!ep || typeof ep !== "object") return { ...EMPTY_URLS }
    return {
      claude: String(ep.claude?.apiUrl || ep.claude?.api_url || "").trim(),
      chat: String(ep.chat?.apiUrl || ep.chat?.api_url || "").trim(),
      gemini: String(ep.gemini?.apiUrl || ep.gemini?.api_url || "").trim(),
      systemone: String(
        ep.systemone?.apiUrl || ep.systemone?.api_url || ""
      ).trim(),
    }
  } catch {
    return { ...EMPTY_URLS }
  }
}

/**
 * 解析各协议 URL（设置页与启动栏共用同一套有效值）：`discovery_json.endpoints`；
 * 没有端点的档案（只填了主地址）按 OpenAI 兼容（`chat`）。旧的 Agent 名单已由
 * 迁移 `m20261027_000001_model_provider_endpoints` 改写成端点，这里不按品牌推协议。
 *
 * 规则：哪个协议 URL 有内容，支持该协议的 Agent 启动栏就显示这份服务商。
 */
export function resolveProviderProtocolUrls(provider: {
  discovery_json?: string | null
  api_url?: string | null
}): ProviderProtocolUrls {
  const fromEndpoints = readEndpointUrls(provider.discovery_json)
  if (Object.values(fromEndpoints).some(Boolean)) {
    return fromEndpoints
  }
  const url = provider.api_url?.trim() || ""
  return url ? { ...EMPTY_URLS, chat: url } : { ...EMPTY_URLS }
}

export type LaunchbarProviderFilter = {
  /** 启动栏 `providerVendor.protocols`。未声明则不显示任何服务商。 */
  protocols?: readonly ProtocolKind[] | null
  /**
   * 当前这份 launchbar 所属 Agent 自己写下的身份（目录 id、tool.json
   * 里的字段）。只用来认领官方卡，Berth 不维护 Agent 名单。
   */
  ownerIds?: readonly string[] | null
}

/**
 * 启动栏服务商：只看 launchbar.json 声明的协议。
 *
 * 与设置页协议栏**共用同一条取值规则**（`resolveProviderProtocolUrls`）：
 * `discovery_json.endpoints` 优先，缺失时主地址按 `chat`。
 * 所以「设置页能配、启动栏选不到」不再出现两套答案。
 * 未声明协议恒为空；官方卡没有协议 URL，用该 Agent 自己的身份字段认领，
 * 不用品牌分支。
 */
export function isProviderVisibleForLaunchbar(
  provider: ModelProviderInfo,
  filter: LaunchbarProviderFilter
): boolean {
  const protocols = (filter.protocols ?? []).filter(Boolean)
  if (protocols.length === 0) return false

  if (provider.kind === "official") {
    const owners = new Set(
      (filter.ownerIds ?? []).map((id) => id.trim()).filter(Boolean)
    )
    return owners.has(provider.agent_type)
  }

  const urls = resolveProviderProtocolUrls(provider)
  return protocols.some((protocol) => Boolean(urls[protocol]))
}
