import { getTransport } from "@/lib/transport"

export type ToolAssetDiagnostic = {
  location: string
  message: string
}

export type ToolAssetSummary = {
  id: string
  name: string
  description?: string | null
  /** `tool.json` 的 `version`（旧包为 `revision`）。 */
  version?: string | null
  protocol?: string | null
  /** 接入了宿主哪些位置（与 `berth tools check` 同源）。 */
  contributes: string[]
  enabled: boolean
  diagnostics: ToolAssetDiagnostic[]
}

export type ToolAssetDetail = {
  summary: ToolAssetSummary
  directory: string
  raw: unknown
  usage?: string | null
}

/** 官方插件仓库里的一个插件。 */
export type ToolCatalogEntry = {
  /** 传给 `install` 的来源。 */
  source: string
  id: string
  name: string
  description?: string | null
  version?: string | null
  /** 包内 `icon.svg|icon.png` 的 data URL。 */
  icon?: string | null
  installed: boolean
}

export type ToolAssetsRequest =
  | { type: "list" }
  | { type: "load"; id: string }
  | { type: "set_enabled"; id: string; enabled: boolean }
  | { type: "pack"; id: string; path: string }
  | { type: "catalog" }
  | { type: "install"; source: string }
  | { type: "remove"; id: string }

export type ToolAssetsResponse =
  | { type: "list"; tools: ToolAssetSummary[]; directory: string }
  | { type: "detail"; detail: ToolAssetDetail }
  | { type: "packed"; path: string }
  | { type: "catalog"; repository: string; plugins: ToolCatalogEntry[] }

export function toolAssets(
  request: ToolAssetsRequest
): Promise<ToolAssetsResponse> {
  return getTransport().call<ToolAssetsResponse>("tool_assets", { request })
}
