/**
 * 模型服务商领域(前端)。
 *
 * 绑定读写、模型列表发现与 cc-switch 导入的 transport 封装。档案按
 * agent 栏(与设置页一致)归属,启动栏两级下拉(服务商 → 默认启动模型)
 * 消费本模块。后端领域模块见 `src-tauri/src/model_provider/`。
 */

export {
  archivedModels,
  isOfficialProvider,
  formatTokens,
  mergeFetchedModels,
  parseModelEntry,
  parseTokens,
  providerDefaultApis,
  MODEL_APIS,
  modelApis,
  modelUsableBy,
  type ModelApi,
  type ProviderModel,
} from "./models"
export {
  isProviderVisibleForLaunchbar,
  resolveProviderProtocolUrls,
  type LaunchbarProviderFilter,
  type ProtocolKind,
  type ProviderProtocolUrls,
} from "./visibility"
export { modelRecord, providerCatalogModels, serializeModels } from "./overlays"
export {
  getAgentProviderBinding,
  setAgentProviderBinding,
  fetchProviderModels,
  type FetchedModel,
  evaluateDecision,
  getDecisionSettings,
  listDecisionCalls,
  saveDecisionSettings,
  type DecisionSettings,
  type DecisionCall,
  type DecisionAnswer,
  type DecisionQuestion,
  type DecisionResult,
  listLoginCards,
  fetchLoginModels,
  saveLoginPresets,
  type LoginEntry,
  type LoginModel,
  type LoginModels,
  importCcSwitchProviders,
  transferProviders,
  getProxyAccess,
  type ProxyAccess,
  type ProviderTransferSummary,
  type AgentProviderBinding,
  type ImportCcSwitchSummary,
} from "./api"
