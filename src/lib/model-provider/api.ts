import { runtimeBridgeOperation } from "@/lib/runtime-bridge"
import { getTransport } from "@/lib/transport"

/**
 * 模型服务商领域(前端)——启动栏两级下拉与设置页共用的绑定/模型发现
 * API。后端领域模块见 `src-tauri/src/model_provider/`。自定义档案是
 * 全局一份名单；官方行仍绑声明它的 Agent。
 */

/** 一个 agent 当前的模型绑定(providerId 为 null = 未绑定,启动不注入)。 */
export interface AgentProviderBinding {
  providerId: number | null
  /** 选中的默认启动模型名(模型下拉);null = 不指定,用 CLI 默认。 */
  modelKey: string | null
}

/** 读取一个 agent 当前的模型服务商绑定。 */
export async function getAgentProviderBinding(
  agentType: string
): Promise<AgentProviderBinding> {
  return getTransport().call("get_agent_provider_binding", { agentType })
}

/** 设置 / 清除绑定(providerId 为 null 即清除)。 */
export async function setAgentProviderBinding(
  agentType: string,
  providerId: number | null,
  modelKey: string | null
): Promise<void> {
  return getTransport().call("set_agent_provider_binding", {
    agentType,
    providerId,
    modelKey,
  })
}

/** 拉取到的模型：上游声明的接口已归一为 `MODEL_APIS`，没声明为空数组。 */
export interface FetchedModel {
  id: string
  apis: string[]
}

/**
 * 按协议 + url/key 拉取模型列表（每次恰好一个请求）。仅在用户于添加/编辑
 * 弹窗里显式点击"获取模型列表"时调用——档案预配置的模型列表是唯一数据源,
 * 不自动请求。
 */
export async function fetchProviderModels(params: {
  protocol: "chat" | "claude" | "gemini"
  apiUrl: string
  apiKey: string
}): Promise<FetchedModel[]> {
  return getTransport().call("fetch_provider_models", params)
}

/** cc-switch 批量导入结果。 */
export interface ImportCcSwitchSummary {
  imported: number
  skippedDuplicate: number
  skippedIncomplete: number
  unsupported: number
}

/** 从 cc-switch(~/.cc-switch/cc-switch.db)批量导入供应商档案;幂等。 */
export async function importCcSwitchProviders(): Promise<ImportCcSwitchSummary> {
  return getTransport().call("import_cc_switch_providers")
}

/** 档案文件导出 / 导入结果。 */
export interface ProviderTransferSummary {
  providers: number
  skippedDuplicate: number
}

/**
 * 档案备份（`berth.providers/1`）：export 写出不含 Key 的 JSON；import 从该
 * 文件新建档案，同名同地址跳过。Key 导入后另行填写。
 */
export async function transferProviders(
  operation: "export" | "import",
  path: string
): Promise<ProviderTransferSummary> {
  return getTransport().call("model_provider_transfer", { operation, path })
}

/** 本实例代理：端点调用地址为 `${baseUrl}/p/<档案 id>/<端点名>`，令牌代替 Key。 */
export interface ProxyAccess {
  baseUrl: string
  listening: boolean
  token: string
}

export async function getProxyAccess(): Promise<ProxyAccess> {
  return getTransport().call("model_provider_proxy_access")
}

/** 一个 Agent 的一个登录来源（tool.json `logins` 声明，不落库）；前端按 loginId 并卡。 */
export interface LoginEntry {
  agentId: string
  agentName: string
  agentType?: string | null
  hasUsage: boolean
  loginId: string
  label: string
  website?: string | null
  /** null = 无法判断。只回答在不在，Berth 不读取或返回凭证内容。 */
  credentialPresent?: boolean | null
  hasModels: boolean
}

export async function listLoginCards(): Promise<LoginEntry[]> {
  return getTransport().call("list_login_cards")
}

export interface LoginModel {
  id: string
  name: string
  /** 用户手动添加的预选项（工具包 login-presets.json）。 */
  preset?: boolean
}

/** 读到的模型 ∪ 预选项；来源读取失败时仍返回预选项，error 说明原因。 */
export interface LoginModels {
  models: LoginModel[]
  error?: string | null
}

/** 按登录声明读模型（本地文件或包内脚本，不联网），并入预选项。 */
export async function fetchLoginModels(
  agentId: string,
  loginId: string
): Promise<LoginModels> {
  return getTransport().call("fetch_login_models", { agentId, loginId })
}

/** 覆盖保存某个登录的预选模型（不落库、不含凭证）。 */
export async function saveLoginPresets(
  agentId: string,
  loginId: string,
  models: LoginModel[]
): Promise<void> {
  return getTransport().call("save_login_presets", {
    agentId,
    loginId,
    models,
  })
}

/**
 * 决策问题（systemone 协议，如 Jev）。`criteria` 就是提示词：choice 为
 * 选项 → 何时选它；score 为 2–10 个有序等级；noul 为是 / 否各自的条件。
 */
export type DecisionQuestion =
  | { type: "choice"; instructions: string; criteria: Record<string, string> }
  | { type: "score"; instructions: string; criteria: string[] }
  | {
      type: "noul"
      instructions: string
      criteria: { true: string; false: string }
    }

export type DecisionAnswer =
  | {
      type: "choice"
      choice: string
      confidence: number
      probabilities: Record<string, number>
    }
  | {
      type: "score"
      /** 等级序号单位，可落在两级之间（如 2.89）。 */
      score: number
      confidence: number
      legend: Record<string, string>
      probabilities: Record<string, number>
    }
  | { type: "noul"; /** 为「是」的概率。 */ noul: number }

export interface DecisionResult {
  model?: string
  answers: Record<string, DecisionAnswer>
  usage?: { input_tokens?: number; output_tokens?: number }
}

/** 用档案的决策端点评估一次；Key 由后端从 keyring 读取，不经前端。 */
export async function evaluateDecision(params: {
  providerId: number
  model: string
  state: unknown
  questions: Record<string, DecisionQuestion>
}): Promise<DecisionResult> {
  return getTransport().call("model_provider_systemone", params)
}

/** Berth 全局决策模型（`~/.berth/decision.json`）：空字符串 = 自动（第一个决策档案 / 档案的第一个模型）。 */
export interface DecisionSettings {
  provider: string
  model: string
}

async function decisionCall<T>(
  method: string,
  params?: Record<string, unknown>
) {
  const response = await runtimeBridgeOperation<T>({ method, params })
  if (!response.ok) throw new Error(response.error.message)
  return response.result
}

export function getDecisionSettings() {
  return decisionCall<{
    settings: DecisionSettings | null
    error: string | null
    profiles: { name: string; models: string[] }[]
  }>("decision.settings")
}

export function saveDecisionSettings(settings: DecisionSettings) {
  return decisionCall<DecisionSettings>("decision.setSettings", { settings })
}

/** 一次 Jev 调用的记录（`decision.calls`）：谁调的、为谁调、完整输入与答案。 */
export interface DecisionCall {
  id: string
  at: string
  /** 调用方，如 `knowledge.classify` */
  caller: string
  subject: { project?: string; session?: string; turn?: number }
  profile: string
  /** 实际作答的模型版本 */
  model: string
  state: unknown
  questions: Record<string, DecisionQuestion>
  /** 出错时没有 */
  answers?: Record<string, DecisionAnswer>
  usage: { input_tokens: number; output_tokens: number }
  ms: number
  error?: string
}

/** 最近的调用，新的在前；`project`（主项目路径）只留这个项目的。 */
export function listDecisionCalls(project?: string, limit = 50) {
  return decisionCall<DecisionCall[]>("decision.calls", { project, limit })
}
