import type { JsonValue } from "./agent-contract/model"
import type { PrimaryTab } from "@/lib/workspace/primary-tabs"

/**
 * Agent 类型标识。**文件驱动，无白名单**：任何 tool.json Agent 扩展的
 * `projectType` 都是合法值，联合成员只作 IDE 补全提示，不用于准入过滤。
 */
export type AgentType =
  | "claude_code"
  | "codex"
  | "open_code"
  | "gemini"
  | "open_claw"
  | "cline"
  | "hermes"
  | "code_buddy"
  | "kimi_code"
  | "pi"
  | "grok"
  | "antigravity"
  | "cursor"
  | (string & {})

export type {
  ActionContribution,
  AgentContractDetail,
  AgentContractDiagnostic,
  AgentContractIdentity,
  AgentContractListResponse,
  AgentContractModel,
  AgentContractPresentation,
  AgentContractRuntime,
  AgentContractSummary,
  ConfigurationContribution,
  ConfigurationFieldProjection,
  ConfigurationScopeProjection,
  ConfigurationScopeState,
  ConfigurationState,
  ConfigurationStatus,
  JsonValue,
  PresentationGroup,
  ProjectAgentFileEntry,
  ProjectAgentFileGroup,
  RegistryAgentSummary,
  ResourceContribution,
  ResourceItem,
  ResourceList,
  RuntimeCapability,
  RuntimeEmitterSpec,
  RuntimeEntry,
  AgentContractsResponse,
} from "./agent-contract/model"

export type AppErrorCode =
  | "invalid_input"
  | "configuration_missing"
  | "configuration_invalid"
  | "not_found"
  | "not_a_git_repository"
  | "already_exists"
  | "permission_denied"
  | "dependency_missing"
  | "network_error"
  | "authentication_failed"
  | "database_error"
  | "io_error"
  | "external_command_failed"
  | "window_operation_failed"
  | "task_execution_failed"
  | "terminal_not_found"
  | "terminal_instance_expired"
  | "terminal_exited"
  | "terminal_limit_reached"
  | "invalid_working_directory"
  | "shell_not_found"
  | "input_out_of_order"
  | "sequence_gap"
  | "snapshot_unavailable"
  | "terminal_transport_disconnected"
  | (string & {})

export interface RuntimeCapabilities {
  primaryTabsV2: boolean
  personalTerminalV2: boolean
}

export interface AppCommandError {
  code: AppErrorCode
  message: string
  detail?: string | null
  /** Optional dotted i18n key used to render a localized message. */
  i18n_key?: string | null
  /** Optional named parameters substituted into the localized template. */
  i18n_params?: Record<string, string> | null
}

export interface ConversationSummary {
  id: string
  agent_type: AgentType
  folder_path: string | null
  folder_name: string | null
  title: string | null
  started_at: string
  ended_at: string | null
  message_count: number
  model: string | null
  git_branch: string | null
}

export type MessageRole = "user" | "assistant" | "system" | "tool"

export interface AgentToolCall {
  tool_name: string
  input_preview?: string | null
  output_preview?: string | null
  is_error: boolean
}

export interface AgentExecutionStats {
  agent_type?: string | null
  status?: string | null
  total_duration_ms?: number | null
  total_tokens?: number | null
  total_tool_use_count?: number | null
  read_count?: number | null
  search_count?: number | null
  bash_count?: number | null
  edit_file_count?: number | null
  lines_added?: number | null
  lines_removed?: number | null
  other_tool_count?: number | null
  tool_calls?: AgentToolCall[]
}

/**
 * Image payload shared across `ContentBlock::Image` /
 * `ContentBlock::ImageGeneration` / ACP wire `ToolCallImageInfo`. Mirror of
 * Rust `models::message::ImageData`.
 */
export interface ImageData {
  data: string
  mime_type: string
  uri?: string | null
}

export type ContentBlock =
  | { type: "text"; text: string }
  | {
      type: "image"
      data: string
      mime_type: string
      uri?: string | null
    }
  | {
      /**
       * codex-acp v0.14+ image generation. Distinct from `image` because
       * codex-acp positions image generation as a first-class
       * `ToolCall(title="Image generation")` carrying revised_prompt + image.
       * Rendered with the dedicated `<GeneratedImagesBlock>` component, not
       * mixed with regular tool-call cards.
       *
       * Singular `image` (not array): codex-acp emits exactly one image per
       * `ToolCall`. Multi-image turns produce N separate ToolCalls. `null`
       * during the in-flight placeholder window between
       * `ImageGenerationBegin` and `ImageGenerationEnd`.
       *
       * `status` mirrors the underlying ToolCallStatus during live streaming
       * so the renderer can distinguish in-flight vs. failed when no image
       * arrives. Absent on Rust-emitted blocks (JSONL replay only emits
       * blocks with a present image, so absence is treated as success).
       */
      type: "image_generation"
      revised_prompt?: string | null
      image?: ImageData | null
      status?: ToolCallStatus | null
    }
  | {
      type: "tool_use"
      tool_use_id: string | null
      tool_name: string
      input_preview: string | null
      /**
       * Tool-call status when the parser knows it (`undefined` otherwise).
       * Lets the render layer tell a still-unsettled orphan from a completed
       * no-op. See `dropEmptyInFlightToolCalls`.
       */
      status?: string | null
      /**
       * ACP extensibility metadata for this tool call. Opaque pass-through
       * — both the live snapshot (`ToolCallState.meta`) and the persisted
       * message-row variant carry the same shape. Delegation writes
       * `meta["berth.delegation"] = { status, child_connection_id,
       * child_conversation_id, error_code? }` here.
       */
      meta?: Record<string, unknown> | null
    }
  | {
      type: "tool_result"
      tool_use_id: string | null
      output_preview: string | null
      /** 截断前整份结果的估算 token（预览只留前 4000 字）。 */
      output_tokens?: number | null
      is_error: boolean
      agent_stats?: AgentExecutionStats | null
      /**
       * Images returned in a tool result (e.g. Claude Code's `Read` of a
       * PNG/JPEG, or a multi-page PDF read returning one image per page).
       * Mirror of Rust `ContentBlock::ToolResult.images`. The adapter renders
       * these in-position as `generated-image` cards.
       * Absent/empty for the common text-only tool result.
       */
      images?: ImageData[] | null
    }
  | { type: "thinking"; text: string }

export type TurnRole = "user" | "assistant" | "system"

export interface TurnUsage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens: number
  cache_read_input_tokens: number
}

export interface SessionStats {
  total_usage: TurnUsage | null
  total_tokens?: number | null
  total_duration_ms: number
  context_window_used_tokens?: number | null
  context_window_max_tokens?: number | null
  context_window_usage_percent?: number | null
}

export interface MessageTurn {
  id: string
  role: TurnRole
  blocks: ContentBlock[]
  /** 来源 Agent 的 sessions.json 声明的原始键值。 */
  fields?: Record<string, unknown>
  timestamp: string
  usage?: TurnUsage | null
  duration_ms?: number | null
  model?: string | null
  /** Wall-clock completion time (ISO). Each Rust parser sets this to its
   * own end-marker (e.g. OpenCode's `time.completed`, or just the event-log
   * `timestamp` for agents that log post-generation). Notably this is NOT
   * `timestamp + duration_ms` — those two fields encode unrelated spans in
   * most parsers. */
  completed_at?: string | null
}

/** 启动时注入给 Agent 的一项上下文（`sessions.json` 的 `context` 声明）。 */
export interface ContextSource {
  /** 声明的来源类别（system / instructions / skills…），宿主不解释。 */
  source: string
  name?: string | null
  /** 来源文件路径，有则可打开。 */
  path?: string | null
  /** 正文的估算 token，只作大小比较。 */
  tokens: number
  text: string
}

export interface ConversationDetail {
  summary: ConversationSummary
  turns: MessageTurn[]
  context?: ContextSource[]
  /** 来源 Agent 声明的会话级键值。 */
  session_fields?: Record<string, unknown>
  session_stats?: SessionStats | null
  /**
   * Byte length of the source transcript this parse consumed (Claude only;
   * absent elsewhere). Retires background-overlay turns whose
   * `background_activity` watermark it has caught up to — see
   * `BackgroundOverlayEntry` in the conversation runtime store.
   */
  transcript_watermark?: number | null
}

export interface AgentConversationCount {
  agent_type: AgentType
  conversation_count: number
}

export interface AgentStats {
  total_conversations: number
  total_messages: number
  by_agent: AgentConversationCount[]
}

export interface FolderDetail {
  id: number
  name: string
  path: string
  git_branch: string | null
  default_agent_type: AgentType | null
  last_opened_at: string
  sort_order: number
  color: string
  /**
   * Root folder this one was created under (worktree folders only); null for
   * top-level folders. Flattened — a worktree of a worktree still points at the
   * original root. Drives the sidebar merge and worktree-branch detection.
   */
  parent_id: number | null
  /**
   * Folder classification. `chat` folders back folderless chat-mode
   * conversations: kept in `allFolders` so cwd / active-folder resolve, but
   * hidden from user-facing folder lists; their conversations route to the
   * sidebar "Chat" group and folder-bound chrome is hidden while one is active.
   */
  kind: FolderKind
  /**
   * User-supplied display alias, or null when unset. When present, the sidebar
   * folder header and conversation header render `alias [name]`
   * (see `formatFolderLabelWithAlias`). Display-only — never used for the
   * folder's real `path`/`id`.
   */
  alias: string | null
  /**
   * When the user pinned this folder. Null/absent means not pinned. The
   * project and folder lists sort pinned folders first by this timestamp.
   */
  pinned_at?: string | null
}

/**
 * Result of `createChatConversation`: the new conversation id plus the hidden
 * chat folder backing it, so the caller can drop the folder straight into
 * `allFolders` (resolving cwd / active-folder) without a refetch.
 */
export interface CreateChatConversationResult {
  conversationId: number
  folderId: number
  folder: FolderDetail
}

/**
 * Result of `createChatDir`: a freshly created chat-mode scratch directory
 * (filesystem only — no DB rows). Used to connect ACP at a real cwd the instant
 * "no-folder mode" is selected; the conversation is still created lazily on the
 * first send, reusing this path.
 */
export interface CreateChatDirResult {
  path: string
}

export interface OpenedTab {
  id: number
  folder_id: number
  conversation_id: number | null
  agent_type: AgentType
  position: number
  is_active: boolean
  is_pinned: boolean
}

export type {
  ConversationTab,
  PrimaryTab,
  TerminalTab,
} from "@/lib/workspace/primary-tabs"

export interface ProjectAgentSessionPageRequest {
  folderId: number
  agentType: AgentType
  cursor?: string | null
  search?: string | null
  limit?: number | null
  refresh?: boolean
}

export type ProjectAgentSessionSource = "native_only" | "both" | "database_only"

export interface ProjectAgentSessionSummary {
  agentType: AgentType
  externalId: string | null
  conversationId: number | null
  conversation: DbConversationSummary | null
  title: string | null
  model: string | null
  gitBranch: string | null
  messageCount: number
  startedAt: string
  updatedAt: string
  source: ProjectAgentSessionSource
  /** null means this bounded page did not inspect the DB row's native source. */
  sourceAvailable: boolean | null
}

/** 侧栏「会话」视图的一行（`list_project_session_overview`）。 */
export interface ProjectSessionOverviewItem {
  /** 工具 id（`tools/<id>`）。 */
  agent: string
  sessionId: string | null
  cwd: string
  /** 最后活动，毫秒。 */
  updatedAt: number
  title: string | null
  /** 群内部名；`groupName` 是群目录名。 */
  group: string
  groupName: string
  groupDir: string
  origin: "berth" | "external" | "unknown"
  /** 在跑时绑定它的群成员名。 */
  liveMember: string | null
}

export interface ProjectSessionOverview {
  items: ProjectSessionOverviewItem[]
  hasMore: boolean
}

export interface ProjectAgentSessionPage {
  items: ProjectAgentSessionSummary[]
  nextCursor: string | null
  scanComplete: boolean
  sourceWarning: string | null
}

export interface ResolveProjectAgentSessionResult {
  conversation: DbConversationSummary | null
  sourceAvailable: boolean
  deleted: boolean
}

export interface DbConversationSummary {
  id: number
  folder_id: number
  title: string | null
  /** True once the user renamed this conversation by hand; the backend then
   *  stops auto-deriving its title from the session file. */
  title_locked: boolean
  agent_type: AgentType
  /** Mirrors `conversation.kind` — drives sidebar visibility and grouping. */
  kind: ConversationKind
  model: string | null
  git_branch: string | null
  external_id: string | null
  message_count: number
  /** Number of direct, non-deleted delegation children (computed by the backend
   *  `fill_child_counts` aggregate). `child_count > 0` means this conversation is
   *  expandable into its sub-session subtree — drives the sidebar chevron. */
  child_count: number
  created_at: string
  updated_at: string
  /** When the user pinned this conversation (ISO string), or null if not pinned.
   *  Drives the sidebar's "Pinned" section (sorted by this descending); a pinned
   *  conversation is shown there instead of in its folder group. */
  pinned_at: string | null
  parent_id?: number | null
  parent_tool_use_id?: string | null
  delegation_call_id?: string | null
}

/** Payload for the global `conversation://changed` side-channel that keeps
 *  every client's conversation metadata in sync across desktop clients.
 *  Mirrors the Rust `ConversationChange` enum (serde `tag = "kind"`). */
export type ConversationChange =
  | { kind: "upsert"; summary: DbConversationSummary }
  | { kind: "deleted"; id: number }

export const CONVERSATION_CHANGED_EVENT = "conversation://changed"

/** Payload for the global `folder://changed` side-channel. A folder created or
 *  updated headlessly — e.g. the automation engine minting a per-run worktree —
 *  reaches every client's workspace list so a conversation produced inside it can
 *  be grouped/rendered in the sidebar. Mirrors the Rust `FolderChange` enum
 *  (serde `tag = "kind"`). Distinct from `folder://open-in-workspace`, whose
 *  listener also opens + focuses a tab. */
export type FolderChange = { kind: "upsert"; folder: FolderDetail }

export const FOLDER_CHANGED_EVENT = "folder://changed"

/** Global side-channel announcing a live-feedback enable/disable (payload is
 *  `FeedbackSettings`). The workspace Settings tab shares a webview with the
 *  conversation surface, but this backend broadcast still keeps auxiliary
 *  windows and other clients converged. Mirrors the Rust
 *  `FEEDBACK_SETTINGS_CHANGED_EVENT`. */
export const FEEDBACK_SETTINGS_CHANGED_EVENT = "feedback-settings://changed"

/** Payload for the global `tabs://changed` side-channel that keeps every
 *  client's open-tab set in sync across desktop + browsers. Mirrors the Rust
 *  `TabsChanged` struct. The full conversation-bound tab set is sent as a
 *  snapshot (idempotent apply); `is_active` marks the focused tab, which is
 *  mirrored across clients. `origin` is echoed so the originator ignores its
 *  own broadcast; the sentinel `"server"` marks cascade changes every client
 *  applies. */
export interface TabsChanged {
  version: number
  origin: string
  tabs: OpenedTab[]
}

/** Authoritative v2 primary-tab collection. Active/tile state is device-local. */
export interface PrimaryTabsSnapshot {
  items: PrimaryTab[]
  version: number
}

export type SavePrimaryTabsRejection = "version_conflict"

export interface SavePrimaryTabsOutcome {
  accepted: boolean
  version: number
  tabs: PrimaryTab[]
  rejection?: SavePrimaryTabsRejection
}

export interface PrimaryTabsChanged {
  version: number
  origin: string
  tabs: PrimaryTab[]
}

export const PRIMARY_TABS_CHANGED_EVENT = "primary-tabs://changed"

/** Mirrors Rust `ScanSessionStatus` — how one locally-discovered session
 *  reconciles against the DB by `(external_id, agent_type)`. `deleted` means
 *  only soft-deleted rows exist; import never resurrects those. */
export type ScanSessionStatus = "new" | "imported" | "deleted"

/** Mirrors Rust `ScanSession`: one locally-discovered agent session in the
 *  import-picker scan. */
export interface ScanSession {
  external_id: string
  agent_type: AgentType
  title: string | null
  started_at: string
  ended_at: string | null
  message_count: number
  model: string | null
  git_branch: string | null
  status: ScanSessionStatus
}

/** Mirrors Rust `ScanFolder`: sessions sharing a normalize-matched cwd, plus
 *  how that path reconciles against the folder table. `exists_in_berth: false`
 *  with a `folder_id` means the row is soft-deleted and import will reopen it. */
export interface ScanFolder {
  path: string
  name: string
  exists_in_berth: boolean
  folder_id: number | null
  agent_types: AgentType[]
  sessions: ScanSession[]
}

/** Mirrors Rust `ScanResult` — response of `scan_importable_sessions`. */
export interface ScanResult {
  folders: ScanFolder[]
  /** Sessions with no cwd in their transcript — not importable, count only. */
  no_folder_count: number
  total_sessions: number
  importable_count: number
}

/** Mirrors Rust `SelectedSessionKey` (camelCase over the wire): identifies one
 *  scanned session for `import_selected_sessions`. */
export interface SelectedSessionKey {
  agentType: AgentType
  externalId: string
}

/** Mirrors Rust `ImportFolderOutcome`: per-folder tally of one batch import. */
export interface ImportFolderOutcome {
  path: string
  folder_id: number
  created: boolean
  imported: number
  updated: number
  skipped: number
}

/** Mirrors Rust `ImportSelectedResult` — response of
 *  `import_selected_sessions`. */
export interface ImportSelectedResult {
  imported: number
  updated: number
  skipped: number
  not_found: number
  failed: number
  created_folders: number
  folders: ImportFolderOutcome[]
  errors: string[]
}

/** Mirrors Rust `ImportScanProgress` — payload of the per-agent
 *  `import-scan://progress` broadcast while `scan_importable_sessions` walks
 *  the local session stores. */
export interface ImportScanProgress {
  agent_type: AgentType
  done: number
  total: number
  session_count: number
}

/** Payload of the one-shot `conversations://bulk-changed` nudge a batch import
 *  broadcasts on completion. Clients respond with one folder-scoped conversation
 *  refetch (covering inserted rows and refreshed titles alike) instead of
 *  thousands of per-row upserts. */
export interface ConversationsBulkChanged {
  imported: number
  updated: number
  folder_ids: number[]
}

export const CONVERSATIONS_BULK_CHANGED_EVENT = "conversations://bulk-changed"

export interface DbConversationDetail {
  summary: DbConversationSummary
  turns: MessageTurn[]
  context?: ContextSource[]
  /** 从声明式原生会话转发的会话级键值。 */
  session_fields?: Record<string, unknown>
  session_stats?: SessionStats | null
  /** See `ConversationDetail.transcript_watermark` (threaded through the DB
   *  fetch path from the same parser detail). */
  transcript_watermark?: number | null
  /**
   * Id of the persisted user turn the backend identified as the in-flight prompt
   * (present only while a turn is running on this conversation's connection). The
   * timeline uses it to locate — and, while the live reply is in hand, hide — the
   * partial assistant turn some agents (OpenCode, Gemini) persist after the prompt
   * mid-stream, which would otherwise double-render against the live reply.
   */
  in_flight_user_turn_id?: string | null
  /** 读取前的源文件变化标记；与 `getConversationSourceRevision` 不同即有新内容。 */
  source_revision?: string | null
  /** 会话在项目群里的归属；项目没有群或会话不在群目录下时缺省。 */
  group_link?: {
    /** 群的内部名（读写群账本用）。 */
    group: string
    group_name: string
    group_dir: string
    /** 群目录还在；收尾删掉的 worktree 不能再在里面启动 Agent。 */
    group_dir_exists: boolean
    /** 主项目目录（主项目群里有知识库专家）。 */
    main_dir: string
    origin: ProjectSessionOverviewItem["origin"]
    live_member: string | null
  } | null
}

/** Mirrors Rust `ConversationKind` (src-tauri/src/db/entities/conversation.rs).
 *  `loop` rows belong to the Loop Engineering workbench and never appear in
 *  the sidebar list; `delegate` rows nest under their parent's tool-call view. */
export type ConversationKind = "regular" | "chat" | "loop" | "delegate"

/** Mirrors Rust `FolderKind` (src-tauri/src/db/entities/folder.rs).
 *  `loop_worktree` is reserved for M2+ — add it here when the variant lands. */
export type FolderKind = "regular" | "chat"

export const ALL_AGENT_TYPES: AgentType[] = [
  "claude_code",
  "codex",
  "open_code",
  "gemini",
  "open_claw",
  "cline",
  "hermes",
  "code_buddy",
  "kimi_code",
  "pi",
  "grok",
  "antigravity",
  "cursor",
]

/**
 * How a Hermes provider's credentials are supplied:
 * - `apiKey`: codeg writes the key to `~/.hermes/.env`.
 * - `oauth`: set through the terminal `--setup` flow (no API-key field).
 * - `aws`: resolved from the AWS SDK credential chain (no API-key field).
 */
export type HermesProviderKind = "apiKey" | "oauth" | "aws"

/**
 * Curated Hermes providers the settings panel edits via structured fields.
 * Mirrors the backend `HERMES_PROVIDERS` table (commands/acp.rs), whose ids and
 * `.env` key vars come from Hermes' own `hermes_cli/auth.py` PROVIDER_REGISTRY.
 * The provider choice drives the linkage between the API key (~/.hermes/.env)
 * and the general config (~/.hermes/config.yaml `model.provider`/`base_url`).
 */
export interface HermesProviderOption {
  /** Canonical `model.provider` id written to config.yaml. */
  id: string
  /** Brand display name shown in the provider dropdown (not localized). */
  label: string
  /** Whether the provider takes a user-supplied base URL (OpenAI-compatible). */
  needsBaseUrl: boolean
  kind: HermesProviderKind
}

export const HERMES_PROVIDERS: HermesProviderOption[] = [
  // API-key providers — codeg writes the key var to ~/.hermes/.env.
  {
    id: "openrouter",
    label: "OpenRouter",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "openai-api",
    label: "OpenAI / Compatible",
    needsBaseUrl: true,
    kind: "apiKey",
  },
  // Hermes' built-in `custom` provider: a user-supplied OpenAI-compatible
  // endpoint. Unlike `openai-api` (key in ~/.hermes/.env), `custom` stores its
  // key + endpoint INLINE in config.yaml (`model.api_key`/`model.base_url`);
  // the backend routes them there. Shows both API Key + API URL fields.
  {
    id: "custom",
    label: "Custom (OpenAI-compatible)",
    needsBaseUrl: true,
    kind: "apiKey",
  },
  {
    id: "anthropic",
    label: "Anthropic",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "gemini",
    label: "Google AI Studio",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "xai",
    label: "xAI Grok",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "zai",
    label: "Z.AI / GLM",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "minimax",
    label: "MiniMax",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "minimax-cn",
    label: "MiniMax (China)",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "kimi-coding",
    label: "Kimi / Moonshot",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "kimi-coding-cn",
    label: "Kimi / Moonshot (China)",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "nvidia",
    label: "NVIDIA NIM",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "alibaba",
    label: "Qwen (DashScope)",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "alibaba-coding-plan",
    label: "Alibaba Coding Plan",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "copilot",
    label: "GitHub Copilot",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "lmstudio",
    label: "LM Studio",
    needsBaseUrl: true,
    kind: "apiKey",
  },
  {
    id: "azure-foundry",
    label: "Azure Foundry",
    needsBaseUrl: true,
    kind: "apiKey",
  },
  {
    id: "stepfun",
    label: "StepFun",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "arcee",
    label: "Arcee AI",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "gmi",
    label: "GMI Cloud",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "huggingface",
    label: "Hugging Face",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "kilocode",
    label: "Kilo Code",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "opencode-zen",
    label: "OpenCode Zen",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "opencode-go",
    label: "OpenCode Go",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "xiaomi",
    label: "Xiaomi MiMo",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "tencent-tokenhub",
    label: "Tencent TokenHub",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "ollama-cloud",
    label: "Ollama Cloud",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  {
    id: "novita",
    label: "Novita AI",
    needsBaseUrl: false,
    kind: "apiKey",
  },
  // OAuth / external providers — credentials set via the terminal `--setup` flow.
  {
    id: "nous",
    label: "Nous Portal",
    needsBaseUrl: false,
    kind: "oauth",
  },
  {
    id: "openai-codex",
    label: "OpenAI Codex",
    needsBaseUrl: false,
    kind: "oauth",
  },
  {
    id: "minimax-oauth",
    label: "MiniMax",
    needsBaseUrl: false,
    kind: "oauth",
  },
  {
    id: "xai-oauth",
    label: "xAI Grok",
    needsBaseUrl: false,
    kind: "oauth",
  },
  {
    id: "qwen-oauth",
    label: "Qwen",
    needsBaseUrl: false,
    kind: "oauth",
  },
  {
    id: "google-gemini-cli",
    label: "Gemini CLI",
    needsBaseUrl: false,
    kind: "oauth",
  },
  {
    id: "copilot-acp",
    label: "GitHub Copilot ACP",
    needsBaseUrl: false,
    kind: "oauth",
  },
  // AWS Bedrock — credentials from the AWS SDK chain.
  {
    id: "bedrock",
    label: "AWS Bedrock",
    needsBaseUrl: false,
    kind: "aws",
  },
]

export const AGENT_LABELS: Record<AgentType, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  open_code: "OpenCode",
  gemini: "Gemini CLI",
  open_claw: "OpenClaw",
  cline: "Cline",
  hermes: "Hermes Agent",
  code_buddy: "CodeBuddy",
  kimi_code: "Kimi Code",
  pi: "Pi",
  grok: "Grok",
  antigravity: "Antigravity",
  cursor: "Cursor",
}

export const AGENT_COLORS: Record<AgentType, string> = {
  claude_code: "bg-[#D97757]",
  codex: "bg-[#7A9DFF]",
  open_code: "bg-black",
  gemini: "bg-[#3186FF]",
  open_claw: "bg-emerald-600",
  cline: "bg-purple-500",
  hermes: "bg-amber-500",
  code_buddy: "bg-[#0052D9]",
  kimi_code: "bg-[#1783FF]",
  pi: "bg-[#0D9488]",
  grok: "bg-neutral-900",
  antigravity: "bg-[#1A73E8]",
  cursor: "bg-zinc-800",
}

export type PromptInputBlock =
  | { type: "text"; text: string }
  | {
      type: "image"
      data: string
      mime_type: string
      uri?: string | null
    }
  | {
      type: "resource"
      uri: string
      mime_type?: string | null
      text?: string | null
      blob?: string | null
    }
  | {
      type: "resource_link"
      uri: string
      name: string
      mime_type?: string | null
      description?: string | null
    }

export interface PromptDraft {
  blocks: PromptInputBlock[]
  displayText: string
}

// --- ask_user_question (mirror of Rust `crate::mcp::question`) ---

/** One selectable choice in an `ask_user_question` (mirror of `QuestionOption`). */
export interface QuestionOption {
  label: string
  description: string
}

/** A single multiple-choice question (mirror of Rust `QuestionSpec`). `id` is
 *  the backend-minted correlation key the answer is submitted against. */
export interface QuestionSpec {
  id: string
  question: string
  header: string
  multi_select: boolean
  options: QuestionOption[]
}

/** Awaiting-answer question set on the session (mirror of `PendingQuestionState`). */
export interface PendingQuestionState {
  question_id: string
  questions: QuestionSpec[]
  created_at: string
}

/** One question's answer submitted to `acp_answer_question`. `labels` carries
 *  the selected option labels plus any free-text "Other" the user typed. */
export interface QuestionAnswerItem {
  questionId: string
  labels: string[]
}

/** The full submission to `acp_answer_question`. `declined` is set when the
 *  user dismissed the card without choosing. */
export interface QuestionAnswer {
  answers: QuestionAnswerItem[]
  declined: boolean
}

export interface PlanEntryInfo {
  content: string
  priority: string
  status: string
}

/**
 * Wire-level image attached to a tool call (e.g. codex image generation).
 * Mirrors Rust's `ToolCallImageInfo`. Reused by snapshot endpoints and
 * live `tool_call(_update)` events.
 */
export interface ToolCallImageWire {
  data: string
  mime_type: string
  uri?: string | null
}

// Tool-call display types shared by historical transcript rendering.

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed"

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "other"

export type ToolCallOutput =
  | { kind: "text"; content: string }
  | { kind: "error"; message: string }
  | { kind: "json"; value: unknown }

export interface ToolCallState {
  id: string
  kind: ToolKind
  label: string
  status: ToolCallStatus
  input: unknown | null
  output: ToolCallOutput | null
  content: string | null
  locations: unknown | null
  meta: Record<string, unknown> | null
  images?: ToolCallImageWire[]
}

export interface PreviewToolInfo {
  installed: boolean
  version: string | null
  path: string | null
  // Set when the binary file is present (`installed = true`) but running it
  // failed — e.g. a missing system library (libicu) on a slim Linux server.
  // Carries an actionable diagnostic; null when the provider runs fine.
  runtimeError: string | null
  /** The plugin ships an install script, so Berth can install the program. */
  installScript: boolean
  /** Installed and updatable: the program's own update command, or re-running the install script. */
  canUpdate: boolean
}

/** Latest published version (from the plugin's `latest` source) vs the installed one. */
export interface ToolUpdateCheck {
  latest: string
  updateAvailable: boolean
}

export interface SystemProxySettings {
  enabled: boolean
  proxy_url: string | null
}

export type AppLocale = "en" | "zh_cn"
export type LanguageMode = "system" | "manual"

export interface SystemLanguageSettings {
  mode: LanguageMode
  language: AppLocale
}

export interface SystemTerminalSettings {
  default_shell: string | null
}

export interface TerminalShellOption {
  id: string
  label_key: string
  value: string | null
  exists: boolean
  accepts_custom_path: boolean
}

export interface AvailableTerminalShells {
  options: TerminalShellOption[]
  resolved_shell: string
}

export interface SystemRenderingSettings {
  disable_hardware_acceleration: boolean
}

export type {
  LogLevel,
  LogRecord,
  LogSettings,
  LogSettingsView,
  SpanInfo,
  TargetDirective,
} from "./domain-types/logging"

// --- Version Control ---

export interface GitCredentials {
  username: string
  password: string
}

export interface GitDetectResult {
  installed: boolean
  version: string | null
  path: string | null
}

export interface GitSettings {
  custom_path: string | null
}

export interface GitHubAccount {
  id: string
  server_url: string
  username: string
  scopes: string[]
  avatar_url: string | null
  is_default: boolean
  created_at: string
}

export interface GitHubAccountsSettings {
  accounts: GitHubAccount[]
}

export interface GitHubTokenValidation {
  success: boolean
  username: string | null
  scopes: string[]
  avatar_url: string | null
  message: string | null
}

export interface GithubStarredOwner {
  login: string
  avatar_url: string
}

export interface GithubStarredRepo {
  id: number
  name: string
  full_name: string
  description: string | null
  html_url: string
  clone_url: string | null
  stargazers_count: number
  forks_count: number
  language: string | null
  created_at: string | null
  updated_at: string | null
  pushed_at: string | null
  starred_at: string | null
  owner: GithubStarredOwner
  topics: string[]
  license: string | null
  archived: boolean
}

export interface GithubStarredResult {
  repos: GithubStarredRepo[]
  synced_at: string | null
  account_id: string | null
  readme: string | null
  rate_limit_remaining: number | null
}

export type TrendingTimeRange = "daily" | "weekly" | "monthly"

export interface GithubTrendingOwner {
  login: string
  avatar_url: string
}

export interface GithubTrendingRepo {
  rank: number
  name: string
  full_name: string
  description: string | null
  html_url: string
  stargazers_count: number | null
  forks_count: number | null
  language: string | null
  license?: string | null
  owner: GithubTrendingOwner
}

export interface GithubTrendingResult {
  repos: GithubTrendingRepo[]
  fetched_at: string
  time_range: TrendingTimeRange
  rate_limit_remaining: number | null
}

export interface FolderCommand {
  id: number
  folder_id: number
  name: string
  command: string
  category?: "agent" | "development" | "custom"
  executable?: string | null
  args?: string[]
  env?: Record<string, string>
  resume_policy?: "none" | "native-picker" | "native-last" | null
  is_favorite?: boolean
  sort_order: number
  created_at: string
  updated_at: string
}

export interface QuickMessage {
  id: number
  title: string
  content: string
  sort_order: number
  created_at: string
  updated_at: string
}

export interface GitStatusEntry {
  status: string
  file: string
}

export type GitResetMode = "soft" | "mixed" | "hard" | "keep"

export interface GitBranchList {
  local: string[]
  remote: string[]
  worktree_branches: string[]
}

/**
 * State of a working tree's HEAD (mirrors Rust `GitHeadInfo`). Distinguishes a
 * non-repo, a detached HEAD, and being on a branch — the branch-only
 * `getGitBranch` contract collapsed the last two into `null`, hiding git
 * operations for detached repos (issue #279).
 */
export interface GitHeadInfo {
  is_repo: boolean
  /** Branch name when on a branch (incl. unborn); null when detached or non-repo. */
  branch: string | null
  detached: boolean
  /** Short commit hash, present when detached. */
  short_sha: string | null
  /** 链接 worktree 指纹；变化即说明 git 侧增删了 worktree，需要对账。 */
  worktrees_fingerprint?: string | null
}

/**
 * Where a branch is checked out, resolved against registered folders (mirrors
 * Rust `WorktreeResolution`). `path` is the canonical worktree/main-tree path
 * hosting the branch, or null when it is not checked out in any worktree.
 * `folder_id` is the registered folder owning that path, or null for an
 * external/unregistered worktree. Drives the branch selector's navigate-vs-
 * checkout decision.
 */
export interface WorktreeResolution {
  path: string | null
  folder_id: number | null
}

export interface GitConflictInfo {
  has_conflicts: boolean
  conflicted_files: string[]
  operation: string
  upstream_commit?: string | null
}

export interface GitPullResult {
  updated_files: number
  conflict?: GitConflictInfo | null
}

export interface CurrentDocumentSelection {
  text: string
  location?: string | null
}

export type SetCurrentDocumentContextRequest = (
  | { scope?: "conversation"; conversationId: number }
  | { scope: "workspace"; conversationId?: never }
) & {
  /** Clear the document for the selected scope. */
  clear?: boolean
  kind: string
  title?: string
  path?: string | null
  url?: string | null
  mime?: string | null
  /** Bounded viewer snapshot, used for dirty editors and live WebViews. */
  content?: string | null
  /** Deliberately remove a previous viewer snapshot when no new snapshot exists. */
  clearContent?: boolean
  revision?: string | null
  selection?: CurrentDocumentSelection | null
  /** Explicitly clear a previous selection instead of preserving it. */
  clearSelection?: boolean
}

/** Mirrors Rust `TranslateTextRequest` (camelCase over the wire). */
export interface TranslateTextRequest {
  text: string
  sourceLang?: string | null
  targetLang?: string | null
  provider?: string | null
  apiKey?: string | null
  baseUrl?: string | null
  region?: string | null
  model?: string | null
}

/** Mirrors Rust `TranslateTextResult`. */
export interface TranslateTextResult {
  text: string
  provider: string
  targetLang: string
}

/** Mirrors Rust `TranslateProviderConfig` (get 不回传明文 key). */
export interface TranslateProviderConfig {
  baseUrl: string
  region: string
  model: string
  apiKey?: string | null
  hasKey: boolean
}

/** Mirrors Rust `TranslateSettings`. */
export interface TranslateSettings {
  provider: string
  targetLang: string
  providerConfigs: Record<string, TranslateProviderConfig>
}

export interface GitPushResult {
  pushed_commits: number
  upstream_set: boolean
}

export interface GitPushInfo {
  branch: string
  remotes: GitRemote[]
  tracking_remote: string | null
}

export interface GitMergeResult {
  merged_commits: number
  conflict?: GitConflictInfo | null
}

export interface GitRebaseResult {
  message: string
  conflict?: GitConflictInfo | null
}

export interface GitConflictFileVersions {
  base: string
  ours: string
  theirs: string
  merged: string
}

export interface GitCommitResult {
  committed_files: number
}

export interface GitRemote {
  name: string
  url: string
}

export interface GitStashEntry {
  index: number
  message: string
  branch: string
  date: string
  ref_name: string
}

export type FileTreeNode =
  | {
      kind: "file"
      name: string
      path: string
      /** Present only when the node itself is a symlink (raw readlink target). */
      linkTarget?: string | null
      /** 被 .gitignore / .git/info/exclude 忽略（后端按 git 语义判定）。 */
      ignored?: boolean
    }
  | {
      kind: "dir"
      name: string
      path: string
      children: FileTreeNode[]
      /** Present only when the node itself is a symlink (raw readlink target). */
      linkTarget?: string | null
      /** 目录自身是 git 仓库根（嵌套仓库 / submodule / linked worktree）。 */
      isRepo?: boolean
      /** 同文件节点；被忽略目录下的条目也带此标记。 */
      ignored?: boolean
    }

/** Flat gitignore-aware workspace entry returned by `list_workspace_files`. */
export interface WorkspaceFileEntry {
  name: string
  /** Path relative to the workspace root, always forward-slashed. */
  path: string
  kind: "file" | "dir"
}

/** One resolved match from `resolve_workspace_reference` (pointer open action). */
export interface WorkspaceReferenceMatch {
  kind: "file" | "dir"
  /** Absolute path (forward-slashed) for open/preview surfaces. */
  abs_path: string
  /** Path relative to the workspace root; equals abs_path when outside it. */
  rel_path: string
}

export interface DirectoryEntry {
  name: string
  path: string
  hasChildren: boolean
}

export interface FilePreviewContent {
  path: string
  content: string
}

export interface FileEditContent {
  path: string
  content: string
  etag: string
  mtime_ms: number | null
  readonly: boolean
  line_ending: "lf" | "crlf" | "mixed" | "none"
}

export interface FileSaveResult {
  path: string
  etag: string
  mtime_ms: number | null
  readonly: boolean
  line_ending: "lf" | "crlf" | "mixed" | "none"
}

export interface WorkspaceGitEntry {
  path: string
  status: string
  additions: number
  deletions: number
}

export type WorkspaceDelta =
  | { kind: "tree_replace"; nodes: FileTreeNode[] }
  | { kind: "git_replace"; entries: WorkspaceGitEntry[] }
  | { kind: "meta"; reason: string }

export interface WorkspaceDeltaEnvelope {
  seq: number
  kind: "fs_delta" | "git_delta" | "meta" | "resync_hint" | string
  payload: WorkspaceDelta[]
  requires_resync: boolean
  changed_paths?: string[]
}

export interface WorkspaceStateEvent {
  root_path: string
  seq: number
  version: number
  kind: "fs_delta" | "git_delta" | "meta" | "resync_hint" | string
  payload: WorkspaceDelta[]
  requires_resync: boolean
  changed_paths?: string[]
}

export interface WorkspaceSnapshotResponse {
  root_path: string
  seq: number
  version: number
  full: boolean
  tree_snapshot: FileTreeNode[] | null
  git_snapshot: WorkspaceGitEntry[] | null
  deltas: WorkspaceDeltaEnvelope[]
  degraded: boolean
  is_git_repo: boolean
}

export interface GitLogResult {
  entries: GitLogEntry[]
  has_upstream: boolean
}

export interface GitLogEntry {
  hash: string
  full_hash: string
  author: string
  date: string
  message: string
  files: GitLogFileChange[]
  pushed: boolean | null
}

export interface GitLogFileChange {
  path: string
  status: string
  additions: number
  deletions: number
}

// Terminal types
export type TerminalStatus = "running" | "exited" | "failed"

export interface TerminalDescriptor {
  terminalId: string
  backendInstanceId: string
  folderId: number | null
  /** 旧宿主缺少此字段时归属未证明，不能按 cwd 或标题补成项目终端。 */
  ownership?: "project" | "legacy_unresolved" | "independent"
  title: string
  initialCwd: string
  shell: string
  status: TerminalStatus
  processId: number | null
  createdAt: string
  exitedAt: string | null
  /** Agent 工具 id：启动 argv 或前台进程名匹配 tool.json；普通 shell 为 null。 */
  agentId?: string | null
  /** termd 报告的 Agent 协议状态；旧 daemon 不报告时为 null。 */
  agentSignal?: TerminalAgentSignal | null
  /** 前台进程名；与 shell 不同即终端在跑命令。 */
  foregroundCommand?: string | null
  /** launch.js 启动时启动栏选中的输入（专家、模型等）；手动启动为空。 */
  launchInputs?: Record<string, unknown> | null
  /** pane 前台进程的当前目录；用于归到所在 worktree。 */
  cwd?: string | null
  /** 仅在 `getTerminalSession(id, { tailLines })` 时返回的尾部纯文本。 */
  tail?: string
  /** pane 的 target ref，与 CLI 输出和频道 joined 事件逐字节相同。 */
  targetRef?: string
}

/** termd 格式变量 `pane_agent_*` / `pane_pb_*` 的投影。 */
export interface TerminalAgentSignal {
  state: "attention" | "working" | "idle"
  notification: string | null
  /** 协议层状态最近一次变化的 Unix 秒。 */
  stateChangedAt: number | null
  progressState: string
  progress: number
}

export interface CreateTerminalSessionRequest {
  terminalId?: string | null
  cwd: string
  shell?: string | null
  initialCommand?: string | null
  /** Structured managed-command path; bypasses shell parsing. */
  executable?: string | null
  args?: string[]
  env?: Record<string, string>
  /** 启动时重新解析的文件定义 Agent 契约稳定 id。 */
  agentId?: string | null
  /** 根据启动前重新读取的 Agent 契约解析的模式 id。 */
  agentModeId?: string | null
  /** Berth 记忆的额外结构化 argv，绝不写回契约文件。 */
  agentExtraArgs?: string[]
  /** Contract capability values; never an arbitrary command or argv. */
  agentCapabilityValues?: Record<string, JsonValue>
  /** tool.json launch action 的语义输入；后端共用计划解析重建 argv。 */
  agentLaunchInputs?: Record<string, JsonValue> | null
  /** 当次启动选中的服务商；缺省不注入。 */
  providerId?: number | null
  /** 当次启动选中的模型 id。 */
  modelId?: string | null
  folderId?: number | null
  rows: number
  cols: number
  clientId?: string | null
}

export interface TerminalEvent {
  terminal_id: string
  /** Authoritative session sequence when present (personal-terminal path). */
  sequence?: number
}

// Preflight check types
export type FixActionKind = "open_url" | "open_agents_settings" | "install_uv"

export type PreviewInstallEventKind = "started" | "log" | "completed" | "failed"

export interface PreviewInstallEvent {
  task_id: string
  kind: PreviewInstallEventKind
  payload: string
}

export interface ProviderOverlayInfo {
  agent_type: string
  models: string
}

export interface ModelProviderInfo {
  id: number
  name: string
  api_url: string
  api_key: string
  api_key_masked: string
  agent_type: AgentType | ""
  /**
   * 模型映射(JSON 字符串数组,`[{"name","id","slot"?}]`;name = Agent
   * 内显示名,id = 发送给上游的模型 ID,slot = 可选标签,供 tool.json
   * 声明层按 `$model:<slot>` 占位符引用)。启动栏下拉按"名称 · ID"
   * 展示并请求 ID。
   */
  model: string | null
  /** 供应商官网(详情页展示;null = 未填)。 */
  website: string | null
  /** `custom` = 中转站档案;`official` = 官方登录(不注入)。 */
  kind: "custom" | "official" | string
  flavor?: string
  discovery_json?: string | null
  agent_allowlist?: string[]
  overlays?: ProviderOverlayInfo[]
  created_at: string
  updated_at: string
}

/** Result of `updateModelProvider` (mirror of Rust `UpdateModelProviderResult`):
 *  the updated provider plus how many running sessions the credential/model
 *  cascade left on stale (launch-time) config — for the settings-side
 *  "N sessions need restart" toast. */
export interface UpdateModelProviderResult {
  provider: ModelProviderInfo
  affectedRunningSessions: number
}
