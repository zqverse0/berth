import { getTransport } from "@/lib/transport"

/**
 * 用量与站点余额的 IPC facade(前端)——声明驱动,与后端同名文件对应:
 * `src-tauri/src/model_provider/usage.rs`(用量)、`model_provider/balance.rs`(站点余额)、
 * `model_provider/declared.rs`(通用声明式查询)。wire 类型镜像 Rust serde(camelCase)形状。
 */

/** 执行结果状态(与 Rust `UsageStatus` 一致)。 */
export type UsageStatus = "ready" | "missing" | "unavailable" | "error"

/** 一个用量窗口(百分比 / 余量 / 重置时间,按声明命中的字段才有值)。 */
export interface UsageWindow {
  id: string
  label: string
  usedPercent?: number | null
  /** 绝对值用量（上游只给数值、不给分母时展示）。 */
  used?: number | null
  remaining?: number | null
  unit?: string | null
  windowMinutes?: number | null
  resetsAt?: number | null
}

export interface UsageDiagnostic {
  severity: string
  message: string
}

export interface UsageState {
  /** agent 目录名(tools/<id>),或站点余额模板 id。 */
  subject: string
  status: UsageStatus
  planType?: string | null
  windows: UsageWindow[]
  updatedAt?: number | null
  diagnostics: UsageDiagnostic[]
}

/**
 * 执行 `tools/<agent>/usage.json` 声明的聚合查询(状态栏轮询用)。
 * 坏声明/网络失败折叠为对应 status,正常不 reject。
 */
export async function readAccountUsage(): Promise<UsageState[]> {
  return getTransport().call("read_account_usage")
}

/**
 * 按档案 api_url 匹配内置站点模板查余额(设置页点按查询,不自动调用)。
 */
export async function fetchProviderBalance(params: {
  apiUrl: string
  apiKey: string
}): Promise<UsageState> {
  return getTransport().call("fetch_provider_balance", params)
}

/**
 * 按 Agent 类型与可选的凭证内容查询账户配额与用量。
 */
export async function fetchOfficialAccountUsage(params: {
  agentType: string
  rawCredential?: string | null
}): Promise<UsageState> {
  return getTransport().call("fetch_official_account_usage", {
    agentType: params.agentType,
    rawCredential: params.rawCredential ?? null,
  })
}
