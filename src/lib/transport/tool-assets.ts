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

export type ToolAssetsRequest =
  | { type: "list" }
  | { type: "load"; id: string }
  | { type: "set_enabled"; id: string; enabled: boolean }
  | { type: "pack"; id: string; path: string }

export type ToolAssetsResponse =
  | { type: "list"; tools: ToolAssetSummary[]; directory: string }
  | { type: "detail"; detail: ToolAssetDetail }
  | { type: "packed"; path: string }

export function toolAssets(
  request: ToolAssetsRequest
): Promise<ToolAssetsResponse> {
  return getTransport().call<ToolAssetsResponse>("tool_assets", { request })
}
