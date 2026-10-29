export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue }

export type ContractDiagnosticDomain =
  | "schema"
  | "normalize"
  | "runtime"
  | "configuration"
  | "resource"
  | "filesystem"
  | "presentation"
  | (string & {})
export type ContractDiagnosticSeverity = "info" | "warning" | "error"
export type ContractDiagnosticRecovery =
  | "retry"
  | "edit-contract"
  | "create"
  | "reload"
  | (string & {})

export interface AgentContractDiagnostic {
  code?: string
  domain?: ContractDiagnosticDomain
  severity?: ContractDiagnosticSeverity
  contractId?: string
  pointer?: string
  messageKey?: string
  details?: Record<string, JsonValue>
  context?: Record<string, JsonValue>
  recovery?: ContractDiagnosticRecovery
  /** Historical wire compatibility fields. */
  file: string
  path: string
  message: string
  line?: number
  column?: number
}

export interface AgentContractSummary {
  id: string
  name: string
  icon?: string
  command: string
  diagnostics: AgentContractDiagnostic[]
  mtime: number
  description?: string
  projectTypes?: string[]
  schemaUri?: string
  version?: string
}

export interface AgentContractIdentity {
  id: string
  name: string
  description?: string
  icon?: string
  homepage?: string
  version?: string
  projectTypes?: string[]
  metadata: JsonValue
}

export interface RuntimeEntry {
  command: string
  baseArgs: string[]
  env: Record<string, string>
}

export interface RuntimeEmitterSpec {
  kind: string
  [key: string]: JsonValue
}

export interface RuntimeCapability {
  id: string
  label: string
  description?: string
  valueSchema: JsonValue
  defaultValue?: JsonValue
  visible: boolean
  configurable: boolean
  requires: string[]
  conflicts: string[]
  presentation?: JsonValue
  emit?: RuntimeEmitterSpec
  supported: boolean
}

export interface AgentContractRuntime {
  entry: RuntimeEntry
  availability?: RuntimeAvailability
  capabilities: RuntimeCapability[]
}

export interface RuntimeAvailability {
  expectedCommand: string
  status: "found" | "unavailable" | "unknown" | (string & {})
  resolvedExecutable?: string
  detectedVersion?: string
  diagnostics: AgentContractDiagnostic[]
}

export interface ConfigurationContribution {
  id: string
  label: string
  description?: string
  kind: string
  /** Legacy contracts may omit scope; the backend defaults it to user. */
  scope?: string
  path: string
  resolvedPath?: string
  available: boolean
  format: string
  valueSchema: JsonValue
  uiSchema?: JsonValue
  create: string
  write: string
  allowRawEdit: boolean
  /** 字段级合并归组键：同 group 的跨作用域 settings 由后端投影合并展示。 */
  group?: string
  /** 外部 schema 引用：本地路径 / ${home}/${workspace} 模板 / https URL（只读缓存）。 */
  schemaRef?: string
  /** 候选读取路径：第一个存在的被读取；缺省回退 path。 */
  locations?: string[]
  /** 写入目标：保存时写这里；缺省回退 path。 */
  writeTarget?: string
  presentation?: JsonValue
  supported: boolean
}

export interface ResourceContribution {
  id: string
  label: string
  description?: string
  kind: string
  /** Legacy resource DTOs may omit scope; normalized contracts default it to user. */
  scope?: string
  path: string
  resolvedPath?: string
  available: boolean
  pattern?: string
  listing?: "files" | "entries" | (string & {})
  maxResults: number
  followSymlinks: boolean
  viewer: string
  itemLabel?: string
  supported: boolean
}

export interface ActionContribution {
  id: string
  label: string
  kind: string
  target?: string
  description?: string
  visible: boolean
  placement?: string
  confirmation: boolean
  supported: boolean
}

export interface PresentationGroup {
  id: string
  label: string
  order: number
  contributions: string[]
  disclosure?: string
}

export interface AgentContractPresentation {
  groups: PresentationGroup[]
  hints: Record<string, JsonValue>
}

export interface AgentContractModel {
  identity: AgentContractIdentity
  runtime?: AgentContractRuntime
  configurations: ConfigurationContribution[]
  resources: ResourceContribution[]
  actions: ActionContribution[]
  presentation: AgentContractPresentation
  metadata: JsonValue
  otherInformation: JsonValue
  consumedPointers: string[]
}

export interface AgentContractDetail extends AgentContractSummary {
  schemaUri?: string
  contractPath: string
  model: AgentContractModel
}

export interface AgentContractListResponse {
  directory: string
  agents: AgentContractSummary[]
}

export interface ProjectAgentFileEntry {
  name: string
  path: string
  relativePath: string
  kind: "file" | "dir"
  format?: string
}

export interface ProjectAgentFileGroup {
  id: string
  label: string
  path: string
  entries: ProjectAgentFileEntry[]
  truncated: boolean
}

export interface RegistryAgentSummary {
  id: string
  name: string
  description?: string
  version: string
}

export type AgentContractsResponse =
  | { type: "list"; directory: string; agents: AgentContractSummary[] }
  | { type: "detail"; agent: AgentContractDetail }
  | { type: "project_agent_files"; groups: ProjectAgentFileGroup[] }
  | { type: "configuration"; state: ConfigurationState }
  | {
      type: "configuration_scope"
      projection: ConfigurationScopeProjection
    }
  | { type: "resources"; resources: ResourceList }
  | { type: "registry_agents"; agents: RegistryAgentSummary[] }
  | { type: "registry_installed"; id: string }

export type ConfigurationStatus =
  | "ready"
  | "missing"
  | "invalid"
  | "unavailable"

export interface ConfigurationState {
  agentId: string
  contributionId: string
  status: ConfigurationStatus
  format: string
  path?: string
  content: string
  value?: JsonValue
  etag?: string
  canCreate: boolean
  canEdit: boolean
  diagnostics: AgentContractDiagnostic[]
  schema?: JsonValue
  uiSchema?: JsonValue
}

export interface ConfigurationScopeState {
  contributionId: string
  scope: string
  status: ConfigurationStatus
  path?: string
  value?: JsonValue
  etag?: string
  canEdit: boolean
  canCreate: boolean
  format: string
}

export interface ConfigurationFieldProjection {
  key: string
  schema: JsonValue
  values: Record<string, JsonValue | null>
  effective: JsonValue
  source: string
}

export interface ConfigurationScopeProjection {
  agentId: string
  group: string
  label: string
  description?: string
  scopes: ConfigurationScopeState[]
  fields: ConfigurationFieldProjection[]
}

export interface ResourceItem {
  id: string
  label: string
  path: string
  viewer: string
  size: number
  modifiedMs: number
}

export type ResourceListStatus = "ready" | "missing" | "unavailable"

export interface ResourceList {
  agentId: string
  contributionId: string
  status?: ResourceListStatus | (string & {})
  root?: string
  items: ResourceItem[]
  truncated: boolean
  diagnostics: AgentContractDiagnostic[]
}
